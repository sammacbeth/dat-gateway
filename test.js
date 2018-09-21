/* global describe it beforeEach afterEach */

const assert = require('assert')
const http = require('http')
const DatGateway = require('.')
const rimraf = require('rimraf')
const hyperdrive = require('hyperdrive')
const ram = require('random-access-memory')
const websocket = require('websocket-stream')

const dir = 'fixtures'
const ttl = 4000
const period = 1000
const max = 1

describe('dat-gateway', function () {
  this.timeout(0)
  // Key for gardos.hashbase.io
  const key = 'c33bc8d7c32a6e905905efdbf21efea9ff23b00d1c3ee9aea80092eaba6c4957'

  beforeEach(function () {
    this.gateway = new DatGateway({dir, max})
    return this.gateway.load().then(() => {
      return this.gateway.listen(5917)
    })
  })

  afterEach(function () {
    return this.gateway.close().then(() => {
      rimraf.sync(dir)
    })
  })

  it('should exist', function () {
    assert.ok(this.gateway.ar)
  })

  it('should handle requests', function () {
    return new Promise((resolve) => {
      const req = http.get('http://localhost:5917/garbados.hashbase.io/icons/favicon.ico', resolve)
      req.on('error', console.log)
    }).then((res) => {
      // should display empty index, s.t. an attacker cannot determine
      assert.equal(res.statusCode, 200)
    }).catch((e) => {
      console.error(e)
      throw e
    })
  })

  it('should handle requests for dead addresses', function () {
    return new Promise((resolve) => {
      http.get('http://localhost:5917/af75142d92dd1e456cf2a7e58a37f891fe42a1e49ce2a5a7859de938e38f4642', resolve)
    }).then((res) => {
      // show blank index
      assert.equal(res.statusCode, 404)
    }).catch((e) => {
      console.error(e)
      throw e
    })
  })

  it('should handle websockets for replication', function () {
    const url = `ws://localhost:5917/${key}`

    let socket = null

    return new Promise((resolve, reject) => {
      const archive = hyperdrive(ram, Buffer.from(key, 'hex'))
      archive.once('error', reject)
      archive.once('ready', () => {
        socket = websocket(url)

        socket.pipe(archive.replicate({
          live: true
        })).pipe(socket)

        setTimeout(() => {
          archive.readFile('/icons/favicon.ico', (e, content) => {
            if (e) reject(e)
            else resolve(content)
          })
        }, 3000)
      })
    }).then((content) => {
      socket.end()
    }, (e) => {
      socket.end()
      console.error(e.message)
      throw e
    })
  })

  describe('add', function () {
    it('adds an archive to the gateway and returns it', async function () {
      const dat = await this.gateway.add(key)
      assert.equal(dat.archive.key.toString('hex'), key)
      assert.ok(this.gateway.dats.has(key))
    })
  })

  describe('remove', function () {
    beforeEach(async function () {
      await this.gateway.add(key)
    })

    it('unloads an archive from the gateway', async function () {
      await this.gateway.remove(key)
      assert.ok(!this.gateway.dats.has(key))
    })

    it('can be reloaded after removal', async function () {
      await this.gateway.remove(key)
      const dat = await this.gateway.add(key)
      assert.equal(dat.archive.key.toString('hex'), key)
      assert.ok(this.gateway.dats.has(key))
    })

    it('gateway works after removal', async function () {
      await this.gateway.remove(key)

      return new Promise((resolve) => {
        const req = http.get(`http://localhost:5917/${key}/icons/favicon.ico`, resolve)
        req.on('error', console.log)
      }).then((res) => {
        // should display empty index, s.t. an attacker cannot determine
        assert.equal(res.statusCode, 200)
      }).catch((e) => {
        console.error(e)
        throw e
      })
    })
  })

  it('reloads previous state from disk', async function () {
    await this.gateway.add(key)
    await this.gateway.close()
    this.gateway = new DatGateway({dir, ttl, period})
    const dat = await this.gateway.get(key)
    assert.equal(dat.archive.key.toString('hex'), key)
    assert.ok(this.gateway.dats.has(key))
  })

  it('removes least recently used once max is reached', async function () {
    await this.gateway.addIfNew(key)
    assert.ok(this.gateway.dats.has(key))
    await this.gateway.addIfNew('datproject.org')
    assert.ok(!this.gateway.dats.has(key))
  })
})
