// Shared by both views; classic scripts also work when opened directly from disk.
function startLiveFeed({ onBlock, onTransaction, onState, onHealth = () => {} }) {
  const url = 'wss://ws.fullnode.alephium.notrustverify.ch/events';
  const seen = new Set();
  const seenTransactions = new Set();
  let socket, retryTimer, watchdog, demoTimer, attempt = 0, stopped = false, state;
  let healthTimer, transport = 'connecting', blockFeed = 'pending', txFeed = 'pending', reconnects = 0;
  let lastBlockAt = 0, lastTxAt = 0, lastError = '';
  const samples = [];

  function reportHealth() {
    const now = Date.now();
    while (samples.length && samples[0].at <= now - 60000) samples.shift();
    onHealth({ mode: state, transport, blockFeed, txFeed, reconnects, lastBlockAt, lastTxAt, lastError,
      blocks: samples.length, transactions: samples.reduce((sum, sample) => sum + sample.transactions, 0),
      failedTransactions: samples.reduce((sum, sample) => sum + sample.failed, 0) });
  }

  function setState(next) {
    if (next === state) return;
    state = next;
    onState(next);
    reportHealth();
  }
  function detach() {
    clearTimeout(watchdog);
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    socket.close();
    socket = null;
  }
  function retry() {
    if (stopped) return;
    detach();
    transport = 'reconnecting';
    if (blockFeed !== 'error') blockFeed = 'disconnected';
    if (txFeed !== 'error') txFeed = 'disconnected';
    reconnects++;
    clearTimeout(retryTimer);
    if (state !== 'demo') setState('retry');
    if (!demoTimer) demoTimer = setTimeout(() => { demoTimer = null; setState('demo'); }, 15000);
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)) + Math.random() * 500;
    retryTimer = setTimeout(connect, delay);
    reportHealth();
  }
  function armWatchdog(ms) {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      lastError = transport === 'connecting' ? 'Connection timed out' : 'No blocks received for 30s';
      retry();
    }, ms);
  }
  function connect() {
    if (stopped) return;
    transport = 'connecting'; blockFeed = txFeed = 'pending';
    reportHealth();
    try { socket = new WebSocket(url); } catch { retry(); return; }
    armWatchdog(10000);
    socket.onopen = () => {
      transport = 'connected';
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'subscribe', params: ['block'] }));
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'subscribe', params: ['tx'] }));
      armWatchdog(30000);
      reportHealth();
    };
    socket.onmessage = ({ data }) => {
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (!message || typeof message !== 'object') return;
      if (message.id === 1 || message.id === 2) {
        const feed = message.error ? 'error' : typeof message.result === 'string' ? 'active' : 'pending';
        if (message.id === 1) blockFeed = feed;
        else txFeed = feed;
        if (message.error) lastError = `${message.id === 1 ? 'Block' : 'Transaction'} subscription failed`;
        reportHealth();
        if (message.id === 1 && message.error) retry();
        return;
      }
      const params = message.params;
      if (message.method === 'subscription' && params?.type === 'Tx') {
        const tx = params.result;
        if (!validStreamTransaction(tx)) return;
        const route = streamTransactionRoute(tx);
        txFeed = 'active'; lastTxAt = Date.now();
        reportHealth();
        if (!route || seenTransactions.has(tx.unsigned.txId)) return;
        seenTransactions.add(tx.unsigned.txId);
        if (seenTransactions.size > 5000) for (const hash of [...seenTransactions].slice(0, 2500)) seenTransactions.delete(hash);
        // A validated transaction can also establish that the feed is live.
        attempt = 0;
        clearTimeout(demoTimer); demoTimer = null;
        setState('live');
        onTransaction(tx, route);
        return;
      }
      const block = message.method === 'block_notify' ? params
        : message.method === 'subscription' && params?.type === 'Block' ? params.result?.block : null;
      if (!block || !/^[0-9a-f]{64}$/i.test(block.hash) || !Array.isArray(block.transactions)
        || !block.transactions.length || !block.transactions.every(validStreamTransaction)
        || !Number.isInteger(block.height) || !Number.isFinite(block.timestamp)
        || ![block.chainFrom, block.chainTo].every(g => Number.isInteger(g) && g >= 0 && g < 4)) return;
      armWatchdog(30000);
      blockFeed = 'active'; lastBlockAt = Date.now();
      if (txFeed !== 'error') lastError = '';
      attempt = 0;
      clearTimeout(demoTimer); demoTimer = null;
      setState('live');
      if (seen.has(block.hash)) return;
      seen.add(block.hash);
      block.transactions.forEach(tx => seenTransactions.add(tx.unsigned.txId));
      if (seenTransactions.size > 5000) for (const hash of [...seenTransactions].slice(0, 2500)) seenTransactions.delete(hash);
      if (seen.size > 2000) for (const hash of [...seen].slice(0, 1500)) seen.delete(hash);
      samples.push({ at: Date.now(), transactions: Math.max(0, block.transactions.length - 1),
        failed: block.transactions.filter(tx => tx.scriptExecutionOk === false).length });
      reportHealth();
      onBlock({ ...block, txNumber: block.transactions.length });
    };
    socket.onerror = () => { lastError = 'Connection failed'; retry(); };
    socket.onclose = () => { lastError = 'Connection closed'; retry(); };
  }
  function stop() {
    stopped = true;
    clearInterval(healthTimer);
    transport = 'disconnected';
    clearTimeout(retryTimer); clearTimeout(demoTimer); demoTimer = null;
    detach();
  }
  addEventListener('pagehide', stop);
  addEventListener('pageshow', event => {
    if (event.persisted) {
      stopped = false;
      healthTimer = setInterval(reportHealth, 1000);
      if (state !== 'demo') setState('retry');
      demoTimer = setTimeout(() => { demoTimer = null; setState('demo'); }, 15000);
      connect();
    }
  });
  setState('retry');
  healthTimer = setInterval(reportHealth, 1000);
  demoTimer = setTimeout(() => { demoTimer = null; setState('demo'); }, 15000);
  connect();
  return { stop };
}

function validStreamTransaction(tx) {
  return !!tx?.unsigned && /^[0-9a-f]{64}$/i.test(tx.unsigned.txId)
    && (tx.scriptExecutionOk === undefined || typeof tx.scriptExecutionOk === 'boolean')
    && Array.isArray(tx.unsigned.inputs) && Array.isArray(tx.unsigned.fixedOutputs);
}

// Alephium's groupFromHint XORs the four hint bytes, then takes modulo 4.
// https://github.com/alephium/alephium-web3/blob/master/packages/web3/src/address/address.ts
function streamTransactionRoute(tx) {
  const group = hint => ((hint >>> 24) ^ (hint >>> 16) ^ (hint >>> 8) ^ hint) & 3;
  const hint = tx.unsigned.inputs[0]?.outputRef?.hint;
  if (!Number.isInteger(hint)) return null;
  const chainFrom = group(hint);
  // The first output outside the input group determines the destination.
  // https://github.com/alephium/alephium/blob/master/protocol/src/main/scala/org/alephium/protocol/model/UnsignedTransaction.scala
  const output = tx.unsigned.fixedOutputs.find(o => Number.isInteger(o.hint) && group(o.hint) !== chainFrom);
  return { chainFrom, chainTo: output ? group(output.hint) : chainFrom };
}

function streamTransactionInfo(tx, { mined = false } = {}) {
  const outputs = [...tx.unsigned.fixedOutputs, ...(tx.generatedOutputs || [])];
  const total = outputs.reduce((sum, output) => {
    try { return sum + BigInt(output.attoAlphAmount || '0'); } catch { return sum; }
  }, 0n);
  return {
    hash: tx.unsigned.txId, from: '', dests: outputs.map(o => o.address).filter(Boolean),
    alph: Number(total) / 1e18, tokens: outputs.some(o => o.tokens?.length),
    contract: !!tx.unsigned.scriptOpt || !!tx.contractInputs?.length,
    status: !mined ? 'pending' : tx.scriptExecutionOk === true ? 'succeeded' : tx.scriptExecutionOk === false ? 'failed' : 'mined',
  };
}

function setupNetworkHealth() {
  const panel = document.getElementById('networkHealth');
  panel.open = innerWidth >= 700;
  function position() {
    panel.style.top = document.querySelector('header').getBoundingClientRect().bottom + 10 + 'px';
    if (innerWidth < 700 && !document.getElementById('find')) {
      document.getElementById('board').style.top = panel.getBoundingClientRect().bottom + 10 + 'px';
    }
  }
  panel.addEventListener('toggle', position);
  addEventListener('resize', position);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(position).observe(document.querySelector('header'));
  position();
}

function renderNetworkHealth(health) {
  const set = (id, text) => { document.getElementById(id).textContent = text; };
  const panel = document.getElementById('networkHealth');
  panel.className = 'network-health ' + (health.transport || 'connecting');
  set('healthConnection', health.mode === 'demo' ? 'demo · ' + health.transport : health.transport);
  set('healthBlocks', health.blocks || 0);
  set('healthTx', health.transactions || 0);
  set('healthFailedTx', health.failedTransactions || 0);
  set('healthBlockFeed', health.blockFeed || 'disabled');
  set('healthTxFeed', health.txFeed || 'disabled');
  set('healthLastBlock', health.lastBlockAt ? ((Date.now() - health.lastBlockAt) / 1000).toFixed(1) + 's ago' : '–');
  set('healthReconnects', health.reconnects || 0);
  set('healthNote', health.mode === 'demo' ? 'Simulated traffic excluded from network metrics' : 'Observed in the last 60s · rewards excluded');
  const error = document.getElementById('healthError');
  error.textContent = health.lastError || '';
  error.hidden = !health.lastError;
}

function transactionStatusLabel(status) {
  return { pending: '⏳ Pending', mined: 'Mined · execution result unavailable',
    succeeded: '✓ Mined · execution succeeded', failed: '✕ Mined · execution failed' }[status] || 'Simulated transaction';
}
