const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');

function harness(search = '') {
  let now = 100000, id = 0;
  const timers = new Map(), listeners = {}, sockets = [], requests = [], elements = new Map();
  const fetches = [];
  let fetchExplorer = async () => ({ ok: false, status: 404 });
  let fetchMempool = async () => ({ ok: true, json: async () => [] });
  const context = vm.createContext({
    console, URLSearchParams, AbortSignal, AbortController, innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1,
    location: { search }, performance: { now: () => now },
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, delay) { timers.set(++id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, delay) { timers.set(++id, { fn, at: now + delay, interval: delay }); return id; },
    clearInterval(id) { timers.delete(id); }, requestAnimationFrame() {},
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    document: { querySelector() { return { getBoundingClientRect: () => ({ bottom: 54 }) }; }, getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        textContent: '', innerHTML: '', style: {}, classList: { add() {}, remove() {} },
        getBoundingClientRect: () => ({ bottom: 200 }),
        addEventListener() {}, getContext: () => ({ setTransform() {} }),
      });
      return elements.get(id);
    } },
    async fetch(url, options) {
      requests.push(url); fetches.push({ url, options });
      if (url === mempoolUrl) return fetchMempool(options);
      if (url.startsWith('https://backend.mainnet.alephium.org/transactions/')) return fetchExplorer(url, options);
      throw new Error('Explorer unavailable');
    },
    WebSocket: class {
      constructor(url) { this.url = url; this.sent = []; sockets.push(this); }
      send(data) { this.sent.push(JSON.parse(data)); }
      close() { this.closed = true; }
      open() { this.onopen?.(); }
      message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'live-feed.js'), 'utf8'), context);
  async function tick(ms) {
    // Let event handlers finish their existing promise chains before advancing time.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const target = now + ms;
    while (true) {
      const next = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at;
      if (next[1].interval) timers.set(next[0], { ...next[1], at: now + next[1].interval });
      await next[1].fn();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    }
    now = target;
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
  return { context, sockets, requests, fetches, elements, tick, listeners,
    setExplorer(handler) { fetchExplorer = handler; },
    setMempool(handler) { fetchMempool = handler; },
    run(code) { return vm.runInContext(code, context); },
    load(file) {
      const html = fs.readFileSync(path.join(root, file), 'utf8');
      for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(match[1], context);
    },
  };
}

function block(n = 1, transactions = [coinbase]) {
  return { hash: n.toString(16).padStart(64, '0'), chainFrom: 1, chainTo: 2, height: n,
    timestamp: 1791360000000, transactions };
}
const coinbase = { unsigned: { txId: 'a'.repeat(64), inputs: [], fixedOutputs: [{ attoAlphAmount: '500000000000000000' }] }, contractInputs: [] };
function pendingTx(n = 11) {
  return { unsigned: { txId: n.toString(16).padStart(64, '0'), inputs: [{ outputRef: { hint: 1 } }],
    fixedOutputs: [{ hint: 0x301, address: 'recipient', attoAlphAmount: '1000000000000000000', tokens: [{ id: 'token', amount: '1' }] },
      { hint: 1, address: 'change', attoAlphAmount: '7000000000000000000' }], scriptOpt: 'script' } };
}
const txNotification = tx => ({ method: 'subscription', params: { type: 'Tx', result: tx } });
const notification = b => ({ method: 'subscription', params: { type: 'Block', result: { block: b } } });
const mempoolUrl = 'https://lb-fullnode-alephium.notrustverify.ch/mempool/transactions';
const snapshot = (tx = pendingTx(), fromGroup = 1, toGroup = 2) => [{ fromGroup, toGroup, transactions: [tx] }];
const response = data => ({ ok: true, json: async () => data });
function start(h) {
  h.run('globalThis.txs = []; globalThis.blocks = []; globalThis.health = null; globalThis.healthReports = []; globalThis.feed = startLiveFeed({ onBlock: b => blocks.push(b), onTransaction: (tx, route) => txs.push({ tx, route }), onState() {}, onHealth: value => { health = value; healthReports.push(value); } });');
  h.sockets[0].open();
}

test('snapshots poll every second after subscribing, use explicit routes, and merge with tx events', async () => {
  const h = harness();
  h.setMempool(async () => {
    assert.deepEqual(h.sockets[0].sent.map(m => m.params[0]), ['block', 'tx']);
    return response(snapshot(pendingTx(), 3, 0));
  });
  start(h); await h.tick(0);
  assert.equal(h.run('txs.length'), 1);
  assert.equal(h.run('txs[0].route.chainFrom'), 3);
  assert.equal(h.run('txs[0].route.chainTo'), 0);
  h.sockets[0].message(txNotification(pendingTx()));
  await h.tick(2000);
  assert.equal(h.requests.length, 3);
  assert.equal(h.run('txs.length'), 1);
  assert.equal(h.run('health.mempoolFeed'), 'active');
  assert.equal(h.run('health.mempoolCount'), 1);
  assert.equal(h.fetches[0].options.cache, 'no-store');
  h.sockets[0].message(notification(block(1, [pendingTx(), coinbase])));
  await h.tick(1000);
  assert.equal(h.run('txs.length'), 1, 'a stale snapshot cannot re-add a mined passenger');
});

test('blocks arriving during a snapshot prevent stale transactions from becoming pending', async () => {
  const h = harness(); let resolve;
  h.setMempool(() => new Promise(done => { resolve = done; }));
  start(h);
  h.sockets[0].message(notification(block(1, [pendingTx(), coinbase])));
  resolve(response(snapshot())); await h.tick(0);
  assert.equal(h.run('txs.length'), 0);
  assert.equal(h.run('blocks.length'), 1);
  assert.equal(h.run('health.mempoolFeed'), 'active');
});

test('slow polls never overlap, time out, and recover on the next tick', async () => {
  const h = harness();
  h.setMempool(({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  start(h); await h.tick(7999);
  assert.equal(h.requests.length, 1);
  h.setMempool(async () => response(snapshot()));
  await h.tick(1);
  assert.equal(h.run('healthReports.some(h => h.mempoolError === "Mempool request timed out")'), true);
  assert.equal(h.fetches[0].options.signal.aborted, true);
  assert.equal(h.requests.length, 2);
  assert.equal(h.run('health.mempoolFeed'), 'active');
  assert.equal(h.run('health.mempoolError'), '');
  assert.equal(h.run('txs.length'), 1);
});

test('disconnect and pagehide abort polls; reconnect and bfcache restoration fetch fresh snapshots', async () => {
  const h = harness(); let resolve;
  h.setMempool(() => new Promise(done => { resolve = done; }));
  start(h); h.sockets[0].onclose();
  assert.equal(h.fetches[0].options.signal.aborted, true);
  resolve(response(snapshot())); await h.tick(0);
  assert.equal(h.run('txs.length'), 0, 'responses from an old connection are ignored');
  await h.tick(1500);
  assert.equal(h.requests.filter(url => url === mempoolUrl).length, 1, 'no polling while disconnected');
  h.setMempool(async () => response(snapshot()));
  h.sockets.at(-1).open(); await h.tick(0);
  assert.equal(h.requests.filter(url => url === mempoolUrl).length, 2);
  assert.equal(h.run('txs.length'), 1);
  h.listeners.pagehide[0](); await h.tick(3000);
  assert.equal(h.requests.filter(url => url === mempoolUrl).length, 2);
  h.listeners.pageshow[0]({ persisted: true });
  h.sockets.at(-1).open(); await h.tick(0);
  assert.equal(h.requests.filter(url => url === mempoolUrl).length, 3);
  h.run('feed.stop()'); await h.tick(3000);
  assert.equal(h.requests.filter(url => url === mempoolUrl).length, 3);
});

test('HTTP and malformed snapshot errors leave block events working and recover cleanly', async () => {
  const h = harness(); h.setMempool(async () => ({ ok: false, status: 503 }));
  start(h); await h.tick(0);
  assert.equal(h.run('health.mempoolError'), 'Mempool: HTTP 503');
  h.sockets[0].message(notification(block()));
  assert.equal(h.run('blocks.length'), 1);
  for (const invalid of [{}, snapshot(pendingTx(), 4, 0), [{ fromGroup: 0, toGroup: 0, transactions: [{}] }]]) {
    h.setMempool(async () => response(invalid)); await h.tick(1000);
    assert.equal(h.run('health.mempoolError'), 'Mempool: Invalid mempool response');
    assert.equal(h.run('txs.length'), 0);
  }
  h.setMempool(async () => response([])); await h.tick(1000);
  assert.equal(h.run('health.mempoolFeed'), 'active');
  assert.equal(h.run('health.mempoolCount'), 0);
  assert.equal(h.run('health.mempoolError'), '');
});

test('a transaction disappearing and returning in snapshots is neither confirmed nor duplicated', async () => {
  const h = harness(); h.setMempool(async () => response(snapshot()));
  start(h); await h.tick(0);
  h.setMempool(async () => response([])); await h.tick(1000);
  assert.equal(h.run('blocks.length'), 0);
  assert.equal(h.run('health.mempoolCount'), 0);
  assert.equal(h.run('streamTransactionInfo(txs[0].tx).status'), 'pending');
  h.setMempool(async () => response(snapshot())); await h.tick(1000);
  assert.equal(h.run('txs.length'), 1);
});

test('subscribes, validates messages, deduplicates blocks, and forwards tx events', async () => {
  const h = harness();
  h.run('globalThis.blocks = []; globalThis.states = []; globalThis.txs = 0; startLiveFeed({ onBlock: b => blocks.push(b), onState: s => states.push(s), onTransaction: () => txs++ });');
  const ws = h.sockets[0]; ws.open();
  assert.deepEqual(ws.sent.map(m => m.params[0]), ['block', 'tx']);
  assert.equal(ws.url, 'wss://ws.fullnode.alephium.notrustverify.ch/events');
  for (const value of [null, {}, { method: 'subscription', params: { type: 'Block' } }, notification({ ...block(), chainFrom: 4 })]) ws.message(value);
  ws.onmessage({ data: 'invalid json' });
  assert.equal(h.run('blocks.length'), 0);
  ws.message(notification(block())); ws.message(notification(block()));
  assert.equal(h.run('blocks.length'), 1);
  assert.equal(h.run('blocks[0].txNumber'), 1);
  ws.message(txNotification(pendingTx()));
  ws.message(txNotification(pendingTx()));
  ws.message(txNotification({}));
  assert.equal(h.run('txs'), 1);
  assert.equal(h.run('states.at(-1)'), 'live');
});

test('retries failed and stalled connections, falls back to demo, and recovers', async () => {
  const h = harness();
  h.run('globalThis.states = []; startLiveFeed({ onBlock() {}, onTransaction() {}, onState: s => states.push(s) });');
  h.sockets[0].open(); h.sockets[0].onerror();
  assert.equal(h.sockets[0].closed, true);
  await h.tick(15000);
  assert.equal(h.run('states.at(-1)'), 'demo');
  const ws = h.sockets.at(-1); ws.open(); ws.message(notification(block()));
  assert.equal(h.run('states.at(-1)'), 'live');
  await h.tick(30000);
  assert.equal(ws.closed, true);
  assert.equal(h.run('states.at(-1)'), 'retry');
  h.listeners.pagehide[0]();
  const count = h.sockets.length;
  await h.tick(60000);
  assert.equal(h.sockets.length, count);
  h.listeners.pageshow[0]({ persisted: true });
  assert.equal(h.sockets.length, count + 1);
});

test('streamed transactions derive routes and include all output values and metadata', () => {
  const h = harness();
  h.context.tx = pendingTx();
  assert.equal(h.run('streamTransactionRoute(tx).chainFrom'), 1);
  assert.equal(h.run('streamTransactionRoute(tx).chainTo'), 2);
  assert.equal(h.run('streamTransactionInfo(tx).alph'), 8);
  assert.equal(h.run('streamTransactionInfo(tx).tokens'), true);
  assert.equal(h.run('streamTransactionInfo(tx).contract'), true);
  assert.equal(h.run('streamTransactionInfo(tx).dests.join(",")'), 'recipient,change');
  h.context.tx.unsigned.fixedOutputs[0].hint = 1;
  assert.equal(h.run('streamTransactionRoute(tx).chainTo'), 1);
  h.context.tx.unsigned.inputs[0].outputRef.hint = -2147483645; // XOR byte group 3
  assert.equal(h.run('streamTransactionRoute(tx).chainFrom'), 3);
  h.context.tx.unsigned.inputs = [];
  assert.equal(h.run('streamTransactionRoute(tx)'), null);
});

test('health reports subscription failures, rolling real traffic, and reconnects', async () => {
  const h = harness();
  h.run('globalThis.health = null; startLiveFeed({ onBlock() {}, onTransaction() {}, onState() {}, onHealth: value => health = value });');
  const ws = h.sockets[0]; ws.open();
  ws.message({ id: 1, result: 'blocks' });
  ws.message({ id: 2, error: { message: 'rejected' } });
  assert.equal(h.run('health.blockFeed'), 'active');
  assert.equal(h.run('health.txFeed'), 'error');
  assert.equal(h.run('health.lastError'), 'Transaction subscription failed');
  ws.message(notification(block(1, [pendingTx(), coinbase])));
  ws.message(notification(block(1, [pendingTx(), coinbase])));
  assert.equal(h.run('health.blocks'), 1);
  assert.equal(h.run('health.transactions'), 1);
  assert.equal(h.run('health.lastBlockAt'), 100000);
  ws.onclose();
  assert.equal(h.run('health.transport'), 'reconnecting');
  assert.equal(h.run('health.reconnects'), 1);
  await h.tick(60000);
  assert.equal(h.run('health.blocks'), 0);
  assert.equal(h.run('health.transactions'), 0);
});

test('execution success requires an explicit mined result; pending and failed stay distinct', () => {
  const h = harness(); h.context.tx = pendingTx();
  assert.equal(h.run('streamTransactionInfo(tx).status'), 'pending');
  assert.equal(h.run('streamTransactionInfo(tx, { mined: true }).status'), 'mined');
  h.context.tx.scriptExecutionOk = true;
  assert.equal(h.run('streamTransactionInfo(tx, { mined: true }).status'), 'succeeded');
  assert.equal(h.run('streamTransactionInfo(tx).status'), 'pending');
  h.context.tx.scriptExecutionOk = false;
  assert.equal(h.run('streamTransactionInfo(tx, { mined: true }).status'), 'failed');
  h.context.tx.scriptExecutionOk = 'false';
  assert.equal(h.run('validStreamTransaction(tx)'), false);
});

for (const file of ['index.html', 'map.html']) {
  test(`${file}: failed transactions are displayed and counted separately`, async () => {
    const h = harness(); h.load(file);
    const ws = h.sockets[0]; ws.open();
    const failed = { ...pendingTx(), scriptExecutionOk: false };
    ws.message(notification(block(1, [failed, coinbase])));
    await h.tick(700);
    assert.match(h.elements.get('rows').innerHTML, /1 failed/);
    assert.equal(h.elements.get('healthFailedTx').textContent, 1);
    if (file === 'index.html') assert.equal(h.run('people[0].status'), 'failed');
  });
}

for (const file of ['index.html', 'map.html']) {
  test(`${file}: blocks use WebSocket data and mempool polling avoids the explorer backend`, async () => {
    const h = harness(); h.load(file);
    const ws = h.sockets[0]; ws.open(); ws.message(notification(block()));
    await h.tick(600);
    assert.equal(h.elements.get('mode').textContent, '● LIVE mainnet');
    assert.match(h.elements.get('rows').innerHTML, /#1/);
    const userTx = pendingTx();
    ws.message(txNotification(userTx)); ws.message(txNotification(userTx));
    if (file === 'index.html') {
      assert.equal(h.run('people.length'), 1);
      assert.equal(h.run('people[0].f'), 1);
      assert.equal(h.run('people[0].to'), 2);
      assert.equal(h.run('people[0].alph'), 8);
      assert.equal(h.run('platforms[1].queue[0].miner.alph'), 0.5);
    } else assert.equal(h.run('waiting[1][2]'), 1);
    const minedTx = { ...userTx, generatedOutputs: [{ address: 'contract recipient', attoAlphAmount: '2000000000000000000' }] };
    ws.message(notification(block(2, [minedTx, coinbase])));
    await h.tick(600);
    if (file === 'index.html') {
      assert.equal(h.run('platforms[1].queue[1].riders[0]'), userTx.unsigned.txId);
      assert.equal(h.run('platforms[1].queue[1].alph'), 10);
      assert.equal(h.run('people[0].alph'), 10);
      assert.equal(h.run('history[1].alph'), 10);
    } else assert.equal(h.run('waiting[1][2]'), 0);
    ws.message(txNotification(userTx));
    if (file === 'map.html') assert.equal(h.run('waiting[1][2]'), 0);
    // Exercise recurring UI/price timers, reconnect, and demo fallback too.
    await h.tick(60000);
    assert.equal(h.requests.filter(url => url.includes('backend.mainnet.alephium.org')).length, 0);
    assert.ok(h.requests.includes(mempoolUrl));
    if (file === 'map.html') assert.ok(h.requests.every(url => url === mempoolUrl));
  });

  test(`${file}: forced demo does not connect to the WebSocket`, () => {
    const h = harness('?demo'); h.load(file);
    assert.equal(h.sockets.length, 0);
    assert.equal(h.requests.filter(url => url === mempoolUrl).length, 0);
    assert.equal(h.elements.get('mode').textContent, '● DEMO (simulated)');
    assert.equal(h.elements.get('sMempool').textContent, '–');
  });
}

for (const file of ['index.html', 'map.html']) {
  test(`${file}: snapshot passengers board only their exact block and recover from demo`, async () => {
    const h = harness(); h.setMempool(async () => response(snapshot())); h.load(file);
    let ws = h.sockets[0]; ws.open(); await h.tick(0);
    assert.equal(h.elements.get('mode').textContent, '● LIVE mainnet');
    const count = () => h.run(file === 'index.html' ? 'people.filter(p => p.hash).length' : 'waiting[1][2]');
    assert.equal(count(), 1);
    await h.tick(2000); assert.equal(count(), 1);
    assert.equal(h.elements.get('healthMempoolFeed').textContent, 'active');
    assert.equal(h.elements.get('sMempool').textContent, '1');
    ws.onclose(); await h.tick(15000);
    assert.equal(h.elements.get('mode').textContent, '● DEMO (simulated)');
    ws = h.sockets.at(-1); ws.open(); await h.tick(0);
    assert.equal(h.elements.get('mode').textContent, '● LIVE mainnet');
    assert.equal(count(), 1, 'known pending passengers survive demo recovery');
    ws.message(notification(block(2, [{ ...pendingTx(), scriptExecutionOk: true }, coinbase])));
    await h.tick(600);
    if (file === 'index.html') {
      assert.equal(h.run('platforms[1].queue[0].riders[0]'), pendingTx().unsigned.txId);
      assert.equal(h.run('people[0].status'), 'succeeded');
    } else assert.equal(count(), 0);
    await h.tick(1000);
    if (file === 'map.html') assert.equal(count(), 0);
    else assert.equal(count(), 1, 'stale snapshot does not spawn another passenger');
  });
}

const accepted = (tx = pendingTx(), result) => ({ hash: tx.unsigned.txId, type: 'Accepted',
  blockHash: 'd'.repeat(64), ...(result === undefined ? {} : { scriptExecutionOk: result }) });
for (const file of ['index.html', 'map.html']) {
  test(`${file}: missed inclusion recovers after reconnect and stale snapshots cannot resurrect it`, async () => {
    const h = harness(); h.setMempool(async () => response(snapshot())); h.load(file);
    h.sockets[0].open(); await h.tick(0);
    const count = () => h.run(file === 'index.html' ? 'people.filter(p => p.hash && p.status === "pending").length' : 'pendingTransactions.size');
    assert.equal(count(), 1);
    h.sockets[0].onclose(); h.setMempool(async () => response([]));
    h.setExplorer(async () => response(accepted(pendingTx(), false)));
    await h.tick(1500); h.sockets.at(-1).open(); await h.tick(0);
    assert.equal(count(), 0);
    assert.equal(h.elements.get('healthBlocks').textContent, 0, 'recovery is not an observed block');
    h.setMempool(async () => response(snapshot())); await h.tick(2000);
    assert.equal(count(), 0);
  });
}

test('three missing snapshots check inclusion; pending, 404, malformed and HTTP errors preserve passengers', async () => {
  const h = harness(); h.setMempool(async () => response(snapshot()));
  h.run('globalThis.confirmed = []; globalThis.feed = startLiveFeed({ onBlock() {}, onTransaction() {}, onState() {}, onConfirmed: (id, tx) => confirmed.push(tx) });');
  h.sockets[0].open(); await h.tick(0); h.setMempool(async () => response([]));
  h.setExplorer(async () => response({ hash: pendingTx().unsigned.txId, type: 'Pending' }));
  await h.tick(2000); assert.equal(h.requests.filter(url => url.includes('/transactions/')).length, 0);
  await h.tick(1000); assert.equal(h.requests.filter(url => url.includes('/transactions/')).length, 1);
  assert.equal(h.run('confirmed.length'), 0);
  let height = 10;
  async function advance(ms) {
    while (ms > 0) {
      h.sockets.at(-1).message(notification(block(height++)));
      const step = Math.min(ms, 10000); await h.tick(step); ms -= step;
    }
  }
  for (const value of [{ ok: false, status: 404 }, { ok: false, status: 429 }, response({ ...accepted(), hash: 'e'.repeat(64) }), response({ ...accepted(), blockHash: 'bad' })]) {
    h.setExplorer(async () => value);
    const before = h.requests.filter(url => url.includes('/transactions/')).length;
    await advance(31000);
    assert.ok(h.requests.filter(url => url.includes('/transactions/')).length > before);
    assert.equal(h.run('confirmed.length'), 0);
  }
  h.setExplorer(async () => response(accepted()));
  await advance(31000);
  assert.equal(h.run('confirmed.length'), 1);
  assert.equal(h.run('confirmed[0].status'), 'mined', 'no execution result is invented');
});

test('block inclusion and pagehide win over delayed confirmation responses', async () => {
  for (const stop of [false, true]) {
    const h = harness(); h.setMempool(async () => response(snapshot()));
    h.run('globalThis.confirmed = []; startLiveFeed({ onBlock() {}, onTransaction() {}, onState() {}, onConfirmed: id => confirmed.push(id) });');
    h.sockets[0].open(); await h.tick(0); h.setMempool(async () => response([]));
    let resolve, signal;
    h.setExplorer((url, options) => { signal = options.signal; return new Promise(r => { resolve = r; }); });
    await h.tick(3000); assert.ok(resolve);
    if (stop) h.listeners.pagehide[0]();
    else h.sockets[0].message(notification(block(2, [pendingTx(), coinbase])));
    resolve(response(accepted())); await h.tick(0);
    assert.equal(h.run('confirmed.length'), 0);
    if (stop) assert.equal(signal.aborted, true);
  }
});

test('minute sweep checks passengers even in stale fullnode snapshots, serially', async () => {
  const h = harness(); const other = pendingTx(12);
  h.setMempool(async () => response([{ fromGroup: 1, toGroup: 2, transactions: [pendingTx(), other] }]));
  h.run('globalThis.confirmed = []; startLiveFeed({ onBlock() {}, onTransaction() {}, onState() {}, onConfirmed: (id, tx) => confirmed.push(tx) });');
  h.sockets[0].open(); await h.tick(0);
  let resolve, signal;
  h.setExplorer((url, options) => { signal = options.signal; return new Promise(r => { resolve = r; }); });
  for (let i = 0; i < 6; i++) { h.sockets[0].message(notification(block(i + 10))); await h.tick(10000); }
  assert.equal(h.requests.filter(url => url.includes('/transactions/')).length, 1);
  await h.tick(2000);
  assert.equal(h.requests.filter(url => url.includes('/transactions/')).length, 1, 'requests do not overlap');
  resolve(response(accepted(pendingTx(), true))); await h.tick(0);
  assert.equal(h.run('confirmed[0].status'), 'succeeded');
  h.setExplorer(async () => response(accepted(other, false))); await h.tick(1000);
  assert.equal(h.run('confirmed[1].status'), 'failed');
  assert.equal(signal.aborted, false);
});

test('confirmation timeout keeps passenger pending and permits a later retry', async () => {
  const h = harness(); h.setMempool(async () => response(snapshot()));
  h.run('globalThis.confirmed = []; globalThis.health = null; startLiveFeed({ onBlock() {}, onTransaction() {}, onState() {}, onConfirmed: id => confirmed.push(id), onHealth: value => health = value });');
  h.sockets[0].open(); await h.tick(0); h.setMempool(async () => response([]));
  let signal;
  h.setExplorer((url, options) => { signal = options.signal; return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')))); });
  await h.tick(11000);
  assert.equal(signal.aborted, true);
  assert.equal(h.run('confirmed.length'), 0);
  assert.equal(h.run('health.confirmationError'), 'Confirmation request timed out');
  h.setExplorer(async () => response(accepted()));
  for (let i = 0; i < 4; i++) { h.sockets[0].message(notification(block(i + 10))); await h.tick(10000); }
  assert.equal(h.run('confirmed.length'), 1);
  assert.equal(h.run('health.confirmationError'), '');
});

test('station keeps the observed block train when the socket closes during its arrival delay', async () => {
  const h = harness(); h.setMempool(async () => response(snapshot())); h.load('index.html');
  const ws = h.sockets[0]; ws.open(); await h.tick(0);
  ws.message(notification(block(2, [{ ...pendingTx(), scriptExecutionOk: true }, coinbase])));
  ws.onclose(); await h.tick(600);
  assert.equal(h.run('people[0].status'), 'succeeded');
  assert.equal(h.run('platforms[1].queue.length'), 1, 'mined passenger must retain its train during reconnect');
  h.run('stepTrains(1000)');
  assert.equal(h.run('people[0].state'), 'board');
});

test('backend validation continues while WebSocket remains disconnected', async () => {
  const h = harness(); h.setMempool(async () => response(snapshot()));
  h.run('globalThis.confirmed = []; startLiveFeed({ onBlock() {}, onTransaction() {}, onState() {}, onConfirmed: (id, tx) => confirmed.push(tx) });');
  const ws = h.sockets[0]; ws.open(); await h.tick(0); ws.onclose();
  h.setExplorer(async () => response(accepted(pendingTx(), true)));
  await h.tick(6000);
  assert.equal(h.run('confirmed.length'), 1);
});

test('a 404 for one passenger does not pause validation of other passengers', async () => {
  const h = harness(), other = pendingTx(12);
  h.setMempool(async () => response([{ fromGroup: 1, toGroup: 2, transactions: [pendingTx(), other] }]));
  h.run('globalThis.confirmed = []; startLiveFeed({ onBlock() {}, onTransaction() {}, onState() {}, onConfirmed: id => confirmed.push(id) });');
  h.sockets[0].open(); await h.tick(0); h.setMempool(async () => response([]));
  h.setExplorer(async url => url.endsWith(pendingTx().unsigned.txId) ? { ok: false, status: 404 } : response(accepted(other, true)));
  await h.tick(4000);
  assert.equal(h.run('confirmed.length'), 1);
  assert.equal(h.run('confirmed[0]'), other.unsigned.txId);
});

test('reported station transaction clears using its actual backend Accepted response despite a stale fullnode snapshot', async () => {
  const mined = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/mined-transaction.json'), 'utf8'));
  const tx = pendingTx(); tx.unsigned.txId = mined.hash;
  const h = harness(); h.setMempool(async () => response(snapshot(tx)));
  h.setExplorer(async url => { assert.equal(url, `https://backend.mainnet.alephium.org/transactions/${mined.hash}`); return response(mined); });
  h.load('index.html'); h.sockets[0].open(); await h.tick(0);
  assert.equal(h.run('people.some(p => p.hash === "' + mined.hash + '")'), true);
  for (let i = 0; i < 6; i++) { h.sockets[0].message(notification(block(i + 10))); await h.tick(10000); }
  assert.equal(h.run('people.some(p => p.hash === "' + mined.hash + '")'), false);
  assert.equal(h.elements.get('sMempool').textContent, '1', 'mempool count remains the fullnode snapshot count');
  await h.tick(2000);
  assert.equal(h.run('people.some(p => p.hash === "' + mined.hash + '")'), false);
});

test('minute sweep recovers a station passenger absent from the feed pending list', async () => {
  const mined = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/mined-transaction.json'), 'utf8'));
  const h = harness(); h.setExplorer(async () => response(mined)); h.load('index.html');
  const ws = h.sockets[0]; ws.open(); await h.tick(0);
  // Reproduce a mined animation orphan: visible in the view, absent from feed pending state.
  h.context.orphan = { hash: mined.hash, status: 'succeeded' };
  h.run('spawnPerson(1, 2, orphan)');
  for (let i = 0; i < 5; i++) { ws.message(notification(block(i + 20))); await h.tick(10000); }
  assert.equal(h.requests.filter(url => url.includes('/transactions/')).length, 0);
  ws.message(notification(block(25))); await h.tick(10000);
  assert.equal(h.requests.filter(url => url.includes('/transactions/')).length, 1);
  assert.equal(h.run('people.some(p => p.hash === orphan.hash)'), false);
});

test('WebSocket disconnect does not abort an in-flight backend confirmation', async () => {
  const h = harness(); h.setMempool(async () => response(snapshot()));
  h.run('globalThis.confirmed = []; startLiveFeed({ onBlock() {}, onTransaction() {}, onState() {}, onConfirmed: id => confirmed.push(id) });');
  const ws = h.sockets[0]; ws.open(); await h.tick(0); h.setMempool(async () => response([]));
  let resolve, signal;
  h.setExplorer((url, options) => { signal = options.signal; return new Promise(r => { resolve = r; }); });
  await h.tick(3000); ws.onclose();
  assert.equal(signal.aborted, false);
  resolve(response(accepted(pendingTx(), true))); await h.tick(0);
  assert.equal(h.run('confirmed.length'), 1);
});
