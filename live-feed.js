// Shared by both views; classic scripts also work when opened directly from disk.
function startLiveFeed({ onBlock, onTransaction, onState, onHealth = () => {}, onConfirmed = () => {}, onCheck = () => {}, getWaitingTransactions = () => [] }) {
  const url = 'wss://ws.fullnode.alephium.notrustverify.ch/events';
  const mempoolUrl = 'https://lb-fullnode-alephium.notrustverify.ch/mempool/transactions';
  const seen = new Set();
  const pendingTransactions = new Map();
  const minedTransactions = new Set();
  const confirmationCandidates = new Map();
  let socket, retryTimer, watchdog, demoTimer, attempt = 0, stopped = false, state;
  let healthTimer, transport = 'connecting', blockFeed = 'pending', txFeed = 'pending', reconnects = 0;
  let lastBlockAt = 0, lastTxAt = 0, lastError = '';
  let mempoolTimer, mempoolRequest, mempoolTimeout, mempoolEpoch = 0;
  let mempoolFeed = 'pending', lastMempoolAt = 0, mempoolCount = 0, mempoolError = '';
  const samples = [];
  let confirmationRequest, confirmationTimeout, nextConfirmationAt = 0;
  let confirmationError = '', recoveredTransactions = 0, confirmationEpoch = 0;
  let nextSweepAt = Date.now() + 60000;

  function rememberMined(id) {
    pendingTransactions.delete(id);
    confirmationCandidates.delete(id);
    minedTransactions.add(id);
    if (minedTransactions.size > 20000) {
      for (const hash of [...minedTransactions].slice(0, 10000)) minedTransactions.delete(hash);
    }
  }
  function stopConfirmation() {
    confirmationEpoch++;
    clearTimeout(confirmationTimeout);
    confirmationRequest?.abort();
    confirmationRequest = null;
  }
  async function checkTransaction(id) {
    const record = confirmationCandidates.get(id), now = Date.now();
    if (!record || stopped || confirmationRequest || now < nextConfirmationAt) return;
    const controller = new AbortController();
    confirmationRequest = controller;
    const epoch = confirmationEpoch;
    record.nextCheckAt = now + 15000;
    nextConfirmationAt = now + 1000;
    confirmationTimeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`https://backend.mainnet.alephium.org/transactions/${id}`, {
        cache: 'no-store', signal: controller.signal,
      });
      if (response.status === 404) {
        if (stopped || epoch !== confirmationEpoch || confirmationCandidates.get(id) !== record) return;
        confirmationError = '';
        onCheck(id, 'Not indexed by the explorer yet');
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const tx = await response.json();
      if (stopped || epoch !== confirmationEpoch || confirmationCandidates.get(id) !== record) return;
      if (!tx || tx.hash !== id || (tx.scriptExecutionOk !== undefined && typeof tx.scriptExecutionOk !== 'boolean')) {
        throw new Error('Invalid transaction response');
      }
      confirmationError = '';
      // Pending, missing, and unknown results never prove inclusion.
      if (tx.type === 'Pending' || tx.type === 'PendingTransaction') {
        onCheck(id, 'Not confirmed by the explorer yet');
        return;
      }
      if (!['Accepted', 'AcceptedTransaction'].includes(tx.type) || !/^[0-9a-f]{64}$/i.test(tx.blockHash)) {
        throw new Error('Invalid accepted transaction response');
      }
      if (tx.conflicted === true) { onCheck(id, 'Explorer reports a conflicted transaction'); return; }
      rememberMined(id);
      recoveredTransactions++;
      onConfirmed(id, { ...tx, status: tx.scriptExecutionOk === true ? 'succeeded'
        : tx.scriptExecutionOk === false ? 'failed' : 'mined' });
      onCheck(id, 'Inclusion recovered from the explorer');
    } catch (error) {
      if (stopped || epoch !== confirmationEpoch || confirmationCandidates.get(id) !== record) return;
      confirmationError = controller.signal.aborted ? 'Confirmation request timed out' : `Confirmation: ${error.message}`;
      // Global cooldown protects the explorer when unavailable or rate limited.
      nextConfirmationAt = Date.now() + 30000;
      onCheck(id, confirmationError);
    } finally {
      if (confirmationRequest === controller) {
        clearTimeout(confirmationTimeout);
        confirmationRequest = null;
        reportHealth();
      }
    }
  }
  function reconcile() {
    if (stopped || confirmationRequest || Date.now() < nextConfirmationAt) return;
    const now = Date.now();
    let candidate;
    for (const entry of confirmationCandidates) {
      const record = entry[1];
      if (now < record.nextCheckAt || !(record.recheck || record.missingSnapshots >= 3 || now - record.observedAt >= 60000)) continue;
      if (!candidate || record.nextCheckAt < candidate[1].nextCheckAt) candidate = entry;
    }
    if (candidate) { candidate[1].recheck = false; void checkTransaction(candidate[0]); }
  }

  function sweepWaitingTransactions() {
    // The view is authoritative about who is still visibly waiting. This also
    // catches passengers whose block was observed but whose animation was lost.
    if (state !== 'demo') {
      const waitingIds = new Set(getWaitingTransactions());
      for (const id of confirmationCandidates.keys()) {
        if (!pendingTransactions.has(id) && !waitingIds.has(id)) confirmationCandidates.delete(id);
      }
      for (const id of waitingIds) {
        if (!/^[0-9a-f]{64}$/i.test(id)) continue;
        if (!confirmationCandidates.has(id)) {
          confirmationCandidates.set(id, { observedAt: Date.now(), missingSnapshots: 0, nextCheckAt: 0 });
        }
      }
    }
    for (const record of confirmationCandidates.values()) {
      record.recheck = true;
      record.nextCheckAt = Math.min(record.nextCheckAt, Date.now());
    }
  }
  function tickHealth() {
    if (Date.now() >= nextSweepAt) { nextSweepAt = Date.now() + 60000; sweepWaitingTransactions(); }
    reportHealth();
    reconcile();
  }

  function reportHealth() {
    const now = Date.now();
    while (samples.length && samples[0].at <= now - 60000) samples.shift();
    onHealth({ mode: state, transport, blockFeed, txFeed, reconnects, lastBlockAt, lastTxAt, lastError,
      mempoolFeed, lastMempoolAt, mempoolCount, mempoolError, confirmationError, recoveredTransactions,
      blocks: samples.length, transactions: samples.reduce((sum, sample) => sum + sample.transactions, 0),
      failedTransactions: samples.reduce((sum, sample) => sum + sample.failed, 0) });
  }

  function setState(next) {
    if (next === state) return;
    const previous = state;
    state = next;
    onState(next);
    // Views clear simulated traffic on recovery. Restore real waiting passengers.
    if (previous === 'demo' && next === 'live') {
      for (const { tx, route } of pendingTransactions.values()) onTransaction(tx, route);
    }
    reportHealth();
  }
  function establishLive() {
    attempt = 0;
    clearTimeout(demoTimer); demoTimer = null;
    setState('live');
  }
  function publishTransaction(tx, route) {
    const id = tx.unsigned.txId;
    if (!route || minedTransactions.has(id)) return;
    establishLive();
    if (pendingTransactions.has(id)) return;
    const record = { tx, route, observedAt: Date.now(), missingSnapshots: 0, nextCheckAt: 0 };
    pendingTransactions.set(id, record);
    confirmationCandidates.set(id, record);
    onTransaction(tx, route);
  }
  function stopMempool() {
    mempoolEpoch++;
    clearInterval(mempoolTimer);
    clearTimeout(mempoolTimeout);
    mempoolRequest?.abort();
    mempoolRequest = null;
    mempoolFeed = 'disconnected';
  }
  async function pollMempool() {
    if (stopped || transport !== 'connected' || mempoolRequest) return;
    const epoch = mempoolEpoch;
    const controller = new AbortController();
    mempoolRequest = controller;
    mempoolTimeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(mempoolUrl, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const snapshot = await response.json();
      if (stopped || epoch !== mempoolEpoch) return;
      // Official API: MempoolTransactions(fromGroup, toGroup, transactions).
      if (!Array.isArray(snapshot) || !snapshot.every(entry =>
        [entry?.fromGroup, entry?.toGroup].every(g => Number.isInteger(g) && g >= 0 && g < 4)
        && Array.isArray(entry.transactions) && entry.transactions.every(validStreamTransaction))) {
        throw new Error('Invalid mempool response');
      }
      const ids = new Set();
      for (const entry of snapshot) {
        const route = { chainFrom: entry.fromGroup, chainTo: entry.toGroup };
        for (const tx of entry.transactions) {
          ids.add(tx.unsigned.txId);
          // Blocks received while this request was in flight win over stale snapshots.
          publishTransaction(tx, route);
        }
      }
      for (const [id, record] of pendingTransactions) {
        record.missingSnapshots = ids.has(id) ? 0 : record.missingSnapshots + 1;
      }
      // Disappearance triggers a status lookup, never an assumed confirmation.
      mempoolCount = ids.size;
      lastMempoolAt = Date.now(); mempoolFeed = 'active'; mempoolError = '';
      reconcile();
    } catch (error) {
      if (stopped || epoch !== mempoolEpoch) return;
      mempoolFeed = 'error';
      mempoolError = controller.signal.aborted ? 'Mempool request timed out' : `Mempool: ${error.message}`;
    } finally {
      if (epoch === mempoolEpoch) {
        clearTimeout(mempoolTimeout);
        mempoolRequest = null;
        reportHealth();
      }
    }
  }
  function startMempool() {
    stopMempool();
    mempoolFeed = 'pending';
    // Subscribe first, then snapshot. Skip ticks while a previous request is pending.
    void pollMempool();
    mempoolTimer = setInterval(() => { void pollMempool(); }, 1000);
  }
  function detach() {
    clearTimeout(watchdog);
    stopMempool();
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    socket.close();
    socket = null;
  }
  function retry() {
    if (stopped) return;
    detach();
    transport = 'reconnecting';
    for (const record of confirmationCandidates.values()) { record.recheck = true; record.nextCheckAt = Math.min(record.nextCheckAt, Date.now()); }
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
      for (const record of confirmationCandidates.values()) record.recheck = true;
      startMempool();
      reconcile();
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
        publishTransaction(tx, route);
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
      if (seen.has(block.hash)) { establishLive(); reportHealth(); return; }
      seen.add(block.hash);
      block.transactions.forEach(tx => rememberMined(tx.unsigned.txId));
      establishLive();
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
    stopConfirmation();
  }
  addEventListener('pagehide', stop);
  addEventListener('pageshow', event => {
    if (event.persisted) {
      stopped = false;
      healthTimer = setInterval(tickHealth, 1000);
      if (state !== 'demo') setState('retry');
      demoTimer = setTimeout(() => { demoTimer = null; setState('demo'); }, 15000);
      connect();
    }
  });
  setState('retry');
  healthTimer = setInterval(tickHealth, 1000);
  demoTimer = setTimeout(() => { demoTimer = null; setState('demo'); }, 15000);
  connect();
  return { stop, checkTransaction };
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
  const recovered = document.getElementById('recoveredTx');
  if (recovered) recovered.textContent = health.recoveredTransactions || 0;
  const recovery = document.getElementById('reconciliationStatus');
  if (recovery) recovery.textContent = health.mode === 'demo' ? 'Off in demo'
    : health.confirmationError || 'Automatic explorer checks';
  set('healthConnection', health.mode === 'demo' ? 'demo · ' + health.transport : health.transport);
  set('healthBlocks', health.blocks || 0);
  set('healthTx', health.transactions || 0);
  set('healthFailedTx', health.failedTransactions || 0);
  set('healthBlockFeed', health.blockFeed || 'disabled');
  set('healthTxFeed', health.txFeed || 'disabled');
  const mempoolSize = document.getElementById('sMempool');
  if (mempoolSize) {
    mempoolSize.textContent = health.mode !== 'demo' && health.lastMempoolAt ? String(health.mempoolCount) : '–';
    mempoolSize.title = health.lastMempoolAt
      ? `Latest successful mempool snapshot · ${((Date.now() - health.lastMempoolAt) / 1000).toFixed(1)}s ago`
      : 'Waiting for a successful mempool snapshot';
  }
  // Additional views may use only the original health fields.
  const mempool = document.getElementById('healthMempoolFeed');
  if (mempool) {
    mempool.textContent = health.mempoolFeed || 'disabled';
    set('healthMempoolCount', health.lastMempoolAt ? health.mempoolCount : '–');
    set('healthLastMempool', health.lastMempoolAt ? ((Date.now() - health.lastMempoolAt) / 1000).toFixed(1) + 's ago' : '–');
  }
  set('healthLastBlock', health.lastBlockAt ? ((Date.now() - health.lastBlockAt) / 1000).toFixed(1) + 's ago' : '–');
  set('healthReconnects', health.reconnects || 0);
  set('healthNote', health.mode === 'demo' ? 'Simulated traffic excluded from network metrics' : 'Observed in the last 60s · rewards excluded');
  const error = document.getElementById('healthError');
  error.textContent = [health.lastError, health.mempoolError, health.confirmationError].filter(Boolean).join(' · ');
  error.hidden = !error.textContent;
}

function transactionStatusLabel(status) {
  return { pending: '⏳ Pending', mined: 'Mined · execution result unavailable',
    succeeded: '✓ Mined · execution succeeded', failed: '✕ Mined · execution failed' }[status] || 'Simulated transaction';
}
