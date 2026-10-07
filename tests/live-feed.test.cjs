const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');

function harness(search = '') {
  let now = 100000, id = 0;
  const timers = new Map(), listeners = {}, sockets = [], requests = [], elements = new Map();
  const context = vm.createContext({
    console, URLSearchParams, AbortSignal, innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1,
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
    async fetch(url) { requests.push(url); throw new Error('Explorer unavailable'); },
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
      await Promise.resolve();
    }
    now = target;
    await Promise.resolve();
  }
  return { context, sockets, requests, elements, tick, listeners,
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
  test(`${file}: blocks and pending passengers use only WebSocket data`, async () => {
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
    if (file === 'map.html') assert.equal(h.requests.length, 0);
  });

  test(`${file}: forced demo does not connect to the WebSocket`, () => {
    const h = harness('?demo'); h.load(file);
    assert.equal(h.sockets.length, 0);
    assert.equal(h.elements.get('mode').textContent, '● DEMO (simulated)');
  });
}
