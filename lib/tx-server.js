let express = require('express')
let { json } = require('body-parser')
let { parse, stringify } = require('./json.js')
let axios = require('axios')
let encodeTx = require('./tx-encoding.js').encode
let proxy = require('express-http-proxy')
let encodeQuery = require('./query-encoding.js').encode
let decodeQuery = require('./query-encoding.js').decode
let getRoot = require('./get-root.js')

module.exports = function({
  port,
  tendermintPort,
  txEndpoints,
  appState,
  nodeInfo,
  txCache,
  txStats
}) {
  let app = express()
  app.use(json({ type: '*/*' }))
  app.post('/txs', async (req, res) => {
    // encode transaction bytes, send it to tendermint node
    let nonce = Math.floor(Math.random() * (2 << 12))
    let txBytes = '0x' + encodeTx(req.body, nonce).toString('hex')
    let result = await axios.get(
      `http://localhost:${tendermintPort}/broadcast_tx_commit`,
      {
        params: {
          tx: txBytes
        }
      }
    )
    let response = {
      result: result.data.result,
      state: appState
    }
    setTimeout(() => {
      res.json(response)
    }, 2000)
  })

  app.get('/txs', (req, res) => {
    // todo: streaming response instead of buffering
    let rs = txCache.createReadStream({
      keys: false,
      values: true,
      valueEncoding: 'json'
    })

    let result = []
    rs.on('data', data => {
      result.push(data)
    })
    rs.on('end', () => {
      res.json(result)
    })
  })

  let txEndpointStacks = {}
  txEndpoints.forEach(endpoint => {
    if (!txEndpointStacks[endpoint.path]) {
      txEndpointStacks[endpoint.path] = []
    }
    txEndpointStacks[endpoint.path].push(endpoint.middleware)
  })

  // compile middleware stacks into a single function
  for (let key in txEndpointStacks) {
    app.post('/txs' + key, async (req, res) => {
      // run custom tx encoding stack for this endpoint
      let customEncodedTx = compileStack(txEndpointStacks[key])(
        req.body,
        nodeInfo
      )
      // submit encoded tx to normal /txs endpoint
      let result = await axios.post(
        `http://localhost:${port}/txs`,
        customEncodedTx
      )

      res.json(result.data)
    })
  }

  app.get('/info', (req, res) => {
    res.json(nodeInfo)
  })
  app.use('/tendermint', proxy('http://localhost:' + tendermintPort))

  app.get(['/state', '/query'], async (req, res) => {
    let response = await axios.post('http://localhost:' + port + '/query', {})
    res.json(response.data)
  })

  app.post('/query', async (req, res) => {
    let encodedQuery = encodeQuery(req.body)

    let queryResponse = await axios.get(
      `http://localhost:${tendermintPort}/abci_query?data=0x${encodedQuery.toString('hex')}&prove=false`
    )
    let resp = queryResponse.data.result.response
    let value = parse(Buffer.from(resp.value, 'hex').toString())

    // get target root for this height
    let targetRoot = await axios
      .get(`http://localhost:${tendermintPort}/commit?height=${resp.height}`)
      .then(r => {
        return r.data.result.header.app_hash.toLowerCase()
      })

    let appStateHash = getRoot(value).toString('hex')
    // let proof = parse(Buffer.from(resp.proof, 'hex').toString())
    if (appStateHash === targetRoot) {
      res.json(value)
    } else {
      res.status(200).send({ error: 'invalid abci query response' })
    }
  })
  return app
}

function compileStack(stack) {
  return (tx, nodeInfo) => {
    let lastEncodedTx = tx
    stack.forEach(middleware => {
      lastEncodedTx = middleware(lastEncodedTx, nodeInfo)
    })

    return lastEncodedTx
  }
}
