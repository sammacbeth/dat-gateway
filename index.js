'use strict'

const hyperdrive = require('hyperdrive')
const archiver = require('hypercore-archiver')
const swarm = require('hypercore-archiver/swarm')
const dns = require('dat-dns')()
const ram = require('random-access-memory')
const fs = require('fs')
const http = require('http')
const hyperdriveHttp = require('hyperdrive-http')
const path = require('path')
const Websocket = require('websocket-stream')
const url = require('url')
const hexTo32 = require('hex-to-32')

const BASE_32_KEY_LENGTH = 52
const ERR_404 = 'Not found'
const ERR_500 = 'Server error'

function log () {
  let msg = arguments[0]
  arguments[0] = '[dat-gateway] ' + msg
  if (process.env.DEBUG || process.env.LOG) {
    console.log.apply(console, arguments)
  }
}

module.exports =
class DatGateway {
  constructor ({ dir, max, period, ttl, redirect }) {
    this.ar = archiver(dir)
    this.dats = new Map()
    this.adding = new Map()
    this.redirect = redirect
    this.max = max
    this.ttl = ttl
    this.period = period
    this.lru = {}
    // make a hyperdrive and hyperdriveHttp for every archive added to the archiver
    this.ar.on('add-archive', (metadata, content) => {
      const key = metadata.key.toString('hex')
      const drive = hyperdrive(ram, key, {
        metadata,
        content
      })
      drive.key = metadata.key
      const dat = {
        archive: drive
      }

      drive.ready(() => {
        dat.onrequest = hyperdriveHttp(drive, { live: false, exposeHeaders: true })
        this.dats.set(key, dat)
        this.lru[key] = Date.now()
        if (this.adding.has(key)) {
          this.adding.get(key)(dat)
          this.adding.delete(key)
        }
      })
    })
  }

  load () {
    log('Setting up...')
    return this.getHandler().then((handler) => {
      log('Setting up server...')
      this.server = http.createServer(handler)
      const websocketHandler = this.getWebsocketHandler()
      this.websocketServer = Websocket.createServer({
        perMessageDeflate: false,
        server: this.server
      }, websocketHandler)
      swarm(this.ar)
    })
  }

  async get (key) {
    if (this.dats.has(key)) {
      return this.dats.get(key)
    } else if (this.adding.has(key)) {
      return this.adding.get(key)
    }
    const loading = new Promise((resolve) => {
      this.ar.add(key)
      this.adding.set(key, resolve)
    })
    this.lru[key] = Date.now()
    return loading
  }

  remove (key) {
    return new Promise((resolve, reject) => {
      const dat = this.dats.get(key)
      dat.archive.close()
      this.dats.delete(key)
      this.ar.remove(key, (err) => {
        if (err) {
          return reject(err)
        }
        resolve()
      })
    }).catch((err) => {
      console.error('error removing', key, err)
    })
  }

  list () {
    return [...this.dats.keys()]
  }

  get keys () {
    return this.list()
  }

  /**
   * Promisification of server.listen()
   * @param  {Number} port Port to listen on.
   * @return {Promise}     Promise that resolves once the server has started listening.
   */
  listen (port) {
    return new Promise((resolve, reject) => {
      this.server.listen(port, (err) => {
        if (err) return reject(err)
        else return resolve()
      })
    })
  }

  close () {
    if (this.cleaner) clearInterval(this.cleaner)
    return new Promise((resolve) => {
      if (this.server) this.server.close(resolve)
      else resolve()
    })
  }

  getIndexHtml () {
    return new Promise((resolve, reject) => {
      let filePath = path.join(__dirname, 'index.html')
      fs.readFile(filePath, 'utf-8', (err, html) => {
        if (err) return reject(err)
        else return resolve(html)
      })
    })
  }

  getWebsocketHandler () {
    return (stream, req) => {
      stream.on('error', function (e) {
        log('getWebsocketHandler has error: ' + e)
      })
      const urlParts = req.url.split('/')
      const address = urlParts[1]
      if (!address) {
        stream.end('Must provide archive key')
        return Promise.resolve()
      }
      const replication = this.ar.replicate({
        live: true
      })

      // Relay error events
      replication.on('error', function (e) {
        stream.emit('error', e)
      })
      stream.pipe(replication).pipe(stream)

      return this.addIfNew(address).catch((e) => {
        console.error('error adding', e.message)
        stream.end(e.message)
      })
    }
  }

  getHandler () {
    return this.getIndexHtml().then((welcome) => {
      return (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        const start = Date.now()
        // TODO redirect /:key to /:key/
        let requestURL = `http://${req.headers.host}${req.url}`
        let urlParts = url.parse(requestURL)
        let pathParts = urlParts.pathname.split('/').slice(1)
        let hostnameParts = urlParts.hostname.split('.')

        let subdomain = hostnameParts[0]
        let isRedirecting = this.redirect && (subdomain.length === BASE_32_KEY_LENGTH)

        let address = isRedirecting ? hexTo32.decode(subdomain) : pathParts[0]
        let path = (isRedirecting ? pathParts : pathParts.slice(1)).join('/')

        const logError = (err, end) => log('[%s] %s %s | ERROR %s [%i ms]', address, req.method, path, err.message, end - start)
        log('[%s] %s %s', address, req.method, path)

        // return index
        if (!isRedirecting && !address) {
          res.writeHead(200)
          res.end(welcome)
          return Promise.resolve()
        }

        // redirect to subdomain
        if (!isRedirecting && this.redirect) {
          return dns.resolveName(address).then((resolvedAddress) => {
            // TODO: Detect DatDNS addresses
            let encodedAddress = hexTo32.encode(resolvedAddress)
            let redirectURL = `http://${encodedAddress}.${urlParts.host}/${path}${urlParts.search || ''}`

            log('Redirecting %s to %s', address, redirectURL)
            res.setHeader('Location', redirectURL)
            res.writeHead(302)
            res.end()
          }).catch((e) => {
            const end = Date.now()
            logError(e, end)
            res.writeHead(500)
            res.end(ERR_500)
          })
        }

        // Return a Dat DNS entry without fetching it from the archive
        if (path === '.well-known/dat') {
          return dns.resolveName(address).then((resolvedAddress) => {
            log('Resolving address %s to %s', address, resolvedAddress)
            this.addIfNew(resolvedAddress).catch(e => console.error('error adding', address, e))
            res.writeHead(200)
            res.end(`dat://${resolvedAddress}\nttl=3600`)
          }).catch((e) => {
            const end = Date.now()
            logError(e, end)
            res.writeHead(500)
            res.end(ERR_500)
          })
        }

        // return the archive
        const timeout = new Promise((resolve, reject) => {
          setTimeout(() => {
            reject(new Error('not found'))
          }, 5000)
        })

        return Promise.race([timeout, this.addIfNew(address)]).then((dat) => {
          // handle it!!
          const end = Date.now()
          log('[%s] %s %s | OK [%i ms]', address, req.method, path, end - start)
          req.url = `/${path}`
          dat.onrequest(req, res)
        }).catch((e) => {
          const end = Date.now()
          logError(e, end)
          if (e.message.indexOf('not found') > -1) {
            res.writeHead(404)
            res.end(ERR_404)
          } else {
            res.writeHead(500)
            res.end(ERR_500)
          }
        })
      }
    })
  }

  addIfNew (address) {
    return dns.resolveName(address).then((key) => {
      if (!this.dats.has(key)) {
        return this.add(key)
      } else {
        return this.get(key)
      }
    })
  }

  clearOldest () {
    const sortOldestFirst = Object.keys(this.lru).sort((a, b) => {
      return this.lru[a] - this.lru[b]
    })
    const oldest = sortOldestFirst[0]
    return this.remove(oldest)
  }

  add (key) {
    if (this.dats.size >= this.max) {
      // Delete the oldest item when we reach capacity and try again
      return this.clearOldest().then(() => this.get(key))
    }
    return this.get(key)
  }
}
