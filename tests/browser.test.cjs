const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.join(__dirname, '..');
let server, browser, base;
before(async () => {
  server = http.createServer(async (req, res) => {
    const file = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
    if (!['index.html', 'map.html', 'live-feed.js', 'og.png', 'og-map.png'].includes(file)) { res.writeHead(404).end(); return; }
    const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'image/png';
    res.writeHead(200, { 'Content-Type': type }); res.end(await fs.readFile(path.join(root, file)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });

const coinbase = { unsigned: { txId: 'a'.repeat(64), inputs: [], fixedOutputs: [{ attoAlphAmount: '500000000000000000', address: 'miner' }] } };
const userTx = { unsigned: { txId: 'b'.repeat(64), inputs: [{ outputRef: { hint: 1 } }],
  fixedOutputs: [{ hint: 0x301, attoAlphAmount: '2000000000000000000', address: 'recipient', tokens: [] }] } };
const block = (height = 1, transactions = [coinbase]) => ({ jsonrpc: '2.0', method: 'subscription',
  params: { type: 'Block', result: { block: { hash: height.toString(16).padStart(64, '0'), chainFrom: 1,
    chainTo: 2, height, timestamp: Date.now(), transactions } } } });

function monitor(page) {
  const errors = [], backend = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('backend.mainnet.alephium.org')) backend.push(request.url()); });
  return { errors, backend };
}

for (const file of ['index.html', 'map.html']) for (const width of [1440, 390]) {
  test(`${file} at ${width}px: health, exact boarding, reconnect, demo, and no backend traffic`, async () => {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
    try {
      const page = await context.newPage(), observed = monitor(page);
      await page.route('https://api.coingecko.com/**', route => route.abort());
      await page.clock.install();
      let mempool = [userTx], mempoolRequests = 0;
      await page.route('https://lb-fullnode-alephium.notrustverify.ch/mempool/transactions', route => {
        mempoolRequests++;
        return route.fulfill({ json: mempool.length ? [{ fromGroup: 1, toGroup: 2, transactions: mempool }] : [] });
      });
      let online = true;
      const connections = [];
      await page.routeWebSocket('**/events', ws => {
        connections.push(ws);
        if (!online) { ws.close(); return; }
        ws.onMessage(data => {
          const message = JSON.parse(data);
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.params[0] }));
          if (message.id === 2) ws.send(JSON.stringify(block()));
        });
      });
      await page.goto(`${base}/${file}`);
      await page.waitForFunction(() => document.getElementById('healthBlockFeed').textContent === 'active');
      await page.clock.runFor(700);
      assert.equal(await page.locator('#healthBlocks').textContent(), '1');
      assert.equal(await page.locator('#healthTxFeed').textContent(), 'active');
      await page.waitForFunction(() => document.getElementById('sMempool').textContent === '1');
      assert.equal(await page.locator('#healthMempoolFeed').textContent(), 'active');
      if (width === 390) await page.locator('#networkHealth summary').click();
      assert.equal(await page.locator('#networkHealth').getAttribute('open'), '');
      const panel = await page.locator('#networkHealth').boundingBox();
      assert.ok(panel.x >= 0 && panel.x + panel.width <= width);
      const head = await page.locator('header').boundingBox();
      assert.ok(panel.y >= head.y + head.height, 'health panel clears the header');
      if (file === 'map.html' && width === 390) {
        await page.clock.runFor(50);
        const board = await page.locator('#board').boundingBox();
        assert.ok(board.y >= panel.y + panel.height, 'mobile departures clear the health panel');
      }
      const ws = connections.at(-1);
      ws.send(JSON.stringify({ method: 'subscription', params: { type: 'Tx', result: userTx } }));
      await page.clock.runFor(1000);
      assert.equal(await page.locator('#sWait').textContent(), '1');
      assert.ok(mempoolRequests >= 2, 'mempool is fetched initially and every second');
      ws.send(JSON.stringify(block(2, [{ ...userTx, scriptExecutionOk: true }, coinbase])));
      mempool = [];
      await page.clock.runFor(5000);
      assert.equal(await page.locator('#healthBlocks').textContent(), '2');
      assert.equal(await page.locator('#healthTx').textContent(), '1');
      assert.equal(await page.locator('#sWait').textContent(), '0');
      await page.waitForFunction(() => document.getElementById('sMempool').textContent === '0');
      const failedTx = { ...userTx, unsigned: { ...userTx.unsigned, txId: 'c'.repeat(64) }, scriptExecutionOk: false };
      ws.send(JSON.stringify(block(3, [failedTx, coinbase])));
      await page.clock.runFor(1000);
      assert.equal(await page.locator('#healthFailedTx').textContent(), '1');
      assert.match(await page.locator('#rows').textContent(), /1 failed/);
      online = false; ws.close();
      await page.clock.runFor(50);
      assert.match(await page.locator('#healthConnection').textContent(), /reconnecting/);
      await page.clock.fastForward(16000);
      assert.match(await page.locator('#mode').textContent(), /DEMO/);
      assert.match(await page.locator('#healthNote').textContent(), /Simulated traffic excluded/);
      assert.equal(await page.locator('#sMempool').textContent(), '–');
      online = true;
      await page.clock.fastForward(30000);
      await page.clock.runFor(1000);
      assert.match(await page.locator('#mode').textContent(), /LIVE/);
      assert.ok(Number(await page.locator('#healthReconnects').textContent()) >= 1);
      assert.deepEqual(observed.errors, []);
      assert.deepEqual(observed.backend, []);
    } finally { await context.close(); }
  });
}

for (const file of ['index.html', 'map.html']) {
  test(`${file}: live endpoint renders in Chromium and makes zero automatic backend requests`, { skip: process.env.ALPH_LIVE_BROWSER !== '1', timeout: 90000 }, async () => {
    const context = await browser.newContext({ viewport: { width: file === 'index.html' ? 1440 : 390, height: 900 } });
    try {
      const page = await context.newPage(), observed = monitor(page);
      await page.goto(`${base}/${file}`);
      await page.waitForFunction(() => Number(document.getElementById('healthBlocks').textContent) >= 3, { timeout: 60000 });
      await page.waitForFunction(() => document.getElementById('healthMempoolFeed').textContent === 'active', { timeout: 15000 });
      await page.locator('#networkHealth').evaluate(panel => { panel.open = true; });
      await page.waitForFunction(() => document.getElementById('rows').children.length >= 1);
      await fs.mkdir(path.join(root, 'artifacts/browser'), { recursive: true });
      await page.screenshot({ path: path.join(root, `artifacts/browser/${file === 'index.html' ? 'station_desktop' : 'metro_mobile'}_live.png`) });
      assert.equal(await page.locator('#healthBlockFeed').textContent(), 'active');
      assert.equal(await page.locator('#healthTxFeed').textContent(), 'active');
      assert.deepEqual(observed.errors, []);
      assert.deepEqual(observed.backend, []);
    } finally { await context.close(); }
  });
}
