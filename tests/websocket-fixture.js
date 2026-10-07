// Controlled, local-only browser harness. Never loaded by either production view.
(() => {
  let online = true, current, height = 1;
  const pending = new Map();
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (url, ...args) => url === 'https://lb-fullnode-alephium.notrustverify.ch/mempool/transactions'
    ? Promise.resolve(new Response(JSON.stringify(pending.size ? [{ fromGroup: 1, toGroup: 2, transactions: [...pending.values()] }] : []), { headers: { 'Content-Type': 'application/json' } }))
    : nativeFetch(url, ...args);
  const miner = { unsigned: { txId: 'a'.repeat(64), inputs: [], fixedOutputs: [{ address: 'miner', attoAlphAmount: '500000000000000000' }] }, scriptExecutionOk: true };
  const tx = id => ({ unsigned: { txId: id.repeat(64), inputs: [{ outputRef: { hint: 1 } }], fixedOutputs: [{ hint: 769, address: 'recipient', attoAlphAmount: '2000000000000000000', tokens: [] }] } });
  const send = message => current?.onmessage?.({ data: JSON.stringify(message) });
  const block = transactions => {
    transactions.forEach(tx => pending.delete(tx.unsigned.txId));
    send({ method: 'subscription', params: { type: 'Block', result: { block: { hash: (height++).toString(16).padStart(64, '0'), height, chainFrom: 1, chainTo: 2, timestamp: Date.now(), transactions } } } });
  };
  const nativeTimeout = window.setTimeout;
  // Shorten network timeout/backoff waits while preserving animation timings.
  window.setTimeout = (fn, delay, ...args) => nativeTimeout(fn, delay === 15000 ? 1000 : delay === 30000 ? 6000 : delay >= 1000 && delay <= 30500 ? 100 : delay, ...args);
  window.WebSocket = class {
    constructor() { current = this; nativeTimeout(() => { if (!online) this.onclose?.(); else this.onopen?.(); }, 20); }
    send(data) {
      const message = JSON.parse(data);
      send({ id: message.id, result: message.params[0], jsonrpc: '2.0' });
      if (message.id === 2) block([miner]);
    }
    close() {}
  };
  addEventListener('DOMContentLoaded', () => {
    const panel = document.createElement('div');
    panel.style = 'position:fixed;bottom:80px;left:16px;right:16px;z-index:99;background:#101020;padding:8px';
    const actions = {
      'Test pending': () => { const value = tx('b'); pending.set(value.unsigned.txId, value); send({ method: 'subscription', params: { type: 'Tx', result: value } }); },
      'Test snapshot': () => { const value = tx('d'); pending.set(value.unsigned.txId, value); },
      'Test snapshot mined': () => block([{ ...tx('d'), scriptExecutionOk: true }, miner]),
      'Test success': () => block([{ ...tx('b'), scriptExecutionOk: true }, miner]),
      'Test failure': () => block([{ ...tx('c'), scriptExecutionOk: false }, miner]),
      'Test disconnect': () => { online = false; current.onclose?.(); },
      'Test recover': () => { online = true; },
    };
    for (const [name, action] of Object.entries(actions)) {
      const button = document.createElement('button'); button.textContent = name; button.onclick = action; panel.append(button);
    }
    document.body.append(panel);
  });
})();
