// 🎫 Transaction tickets: ?ticket=<tx id> shows one transaction's trip through the station in plain words.
// Uses the public explorer API (API, EXPLORER and the helpers come from index.html's main script).
// Pending trips are checked again every 4 seconds until they board a train; nothing runs unless a ticket is open.

const TICKET_ID = /^[0-9a-f]{64}$/i;

// Same rule as the full node: XOR the four hint bytes, modulo 4.
const ticketGroup = hint => ((hint >>> 24) ^ (hint >>> 16) ^ (hint >>> 8) ^ hint) & 3;
const ticketAlph = s => { try { return Number(BigInt(s || '0') / 10n ** 14n) / 1e4; } catch { return 0; } };

// Explorer transaction (+ its block once mined) → everything the ticket shows. Pure, so it can be tested.
function ticketInfo(tx, block) {
  const inputs = tx.inputs || [], outputs = tx.outputs || [];
  const mined = tx.type !== 'Pending' && tx.type !== 'PendingTransaction' && !!tx.blockHash;
  const coinbase = !!tx.coinbase || (mined && !inputs.length);
  let from, to;
  if (block && Number.isInteger(block.chainFrom)) { from = block.chainFrom; to = block.chainTo; }
  else {
    const hint = inputs[0]?.outputRef?.hint;
    from = Number.isInteger(hint) ? ticketGroup(hint) : null;
    const out = outputs.find(o => Number.isInteger(o.hint) && ticketGroup(o.hint) !== from);
    to = out ? ticketGroup(out.hint) : from;
  }
  const sender = inputs.find(i => i.address)?.address || null;
  const away = outputs.filter(o => o.address && o.address !== sender);
  const contract = !!tx.scriptOpt || inputs.some(i => i.contractInput) || outputs.some(o => o.type === 'ContractOutput');
  const tokens = new Set(away.flatMap(o => (o.tokens || []).map(t => t.id))).size;
  return {
    hash: tx.hash, from, to, mined, coinbase, contract, tokens, sender,
    receiver: away[0]?.address || sender,
    toSelf: !coinbase && !away.length,
    sent: (away.length ? away : outputs).reduce((s, o) => s + ticketAlph(o.attoAlphAmount), 0),
    fee: coinbase ? 0 : ticketAlph((BigInt(tx.gasAmount || 0) * BigInt(tx.gasPrice || '0')).toString()),
    failed: mined && tx.scriptExecutionOk === false,
    height: block?.height ?? null,
    time: mined ? tx.timestamp : null,
  };
}

// The trip in plain words: one short line per state, plus a "why" for cross-group trips (shown on demand).
function ticketStory(t) {
  const why = t.from != null && t.from !== t.to && !t.coinbase
    ? `Alephium splits addresses into 4 groups. Trips between two groups ride their own line (G${t.from} → G${t.to}). That's normal, nothing is stuck.`
    : '';
  if (t.coinbase) return { stamp: 'MINER', headline: '⛏ Miner reward', line: `Block reward for the miner of train #${t.height}.`, why };
  if (!t.mined) return { stamp: 'WAITING', headline: '⏳ Waiting on the platform', line: `Waiting for the next train to ${DEST[t.to] ?? 'its stop'}. This updates by itself.`, why };
  if (t.failed) return { stamp: 'FAILED', headline: '❌ The contract call failed', line: 'The contract said no. The network fee was still charged.', why };
  return { stamp: 'ARRIVED', headline: '✅ Arrived', line: 'In a block on mainnet. Nothing more to wait for.', why };
}

const routeLabel = t => t.from == null ? '' : t.coinbase ? `Rode the G${t.from} → G${t.to} line`
  : `Group ${t.from} → Group ${t.to}${t.from !== t.to ? ' · cross-group' : ' · local'}`;

const ticket = { id: null, info: null, timer: null, tries: 0, seq: 0 };
const ticketEl = document.getElementById('ticket');

const fareUsd = t => t.sent * alphUsd >= 0.01 ? usd(t.sent) : '';
const fareUnit = t => t.coinbase ? 'ALPH reward' : t.toSelf ? 'ALPH to itself' : `ALPH${t.tokens ? ` + ${t.tokens} token${t.tokens > 1 ? 's' : ''}` : ''}`;
const fareText = t => `${fmt(t.sent)} ${fareUnit(t)}`;
const feeAmount = t => t.fee >= 1 ? fmt(t.fee) : String(+t.fee.toFixed(6));
const feeText = t => t.coinbase ? '—' : `${feeAmount(t)} ALPH`;

function ticketRows(t) {
  return [
    ['Passenger', short(t.hash)],
    ['From', t.sender ? short(t.sender) : '—'],
    ['To', t.coinbase || !t.receiver ? '—' : short(t.receiver)],
    ['Fare', fareText(t) + (fareUsd(t) ? ` (≈ ${fareUsd(t)})` : '')],
    ['Fee', feeText(t)],
    ['Train', t.height ? `#${t.height}` : 'next one'],
  ];
}

// Sent → Boarded → Arrived. Each step only lights up on a state the explorer has actually reported.
function ticketJourney(t) {
  if (!t) return [['', 'Sent', '—'], ['', 'Boarded', '—'], ['', 'Arrived', '—']];
  const first = t.coinbase ? ['done', 'Reward', 'to the miner'] : ['done', 'Sent', short(t.hash)];
  if (!t.mined) return [first, ['now', 'Boarding', 'next train'], ['', 'Arrived', '—']];
  const boarded = ['done', 'Boarded', `train #${t.height}`];
  if (t.failed) return [first, boarded, ['bad', 'Contract said no', 'fee charged']];
  return [first, boarded, ['ok', 'Arrived', t.time ? ago(t.time) : 'in a block']];
}

// Decorative barcode from the tx hash: same hash, same bars.
const ticketBars = h => [...(h || '')].map(ch => { const n = parseInt(ch, 16) || 0; return [(n % 3) + 1, ((n >> 2) % 2) + 1]; });

function renderTicket() {
  const t = ticket.info, card = ticketEl.querySelector('.tk-card');
  const c = t?.from == null ? '#a08bff' : COLORS[t.from], stripe = t?.to == null ? c : COLORS[t.to];
  card.style.setProperty('--c', c); card.style.setProperty('--stripe', stripe);
  const live = !t || !t.mined;
  const scene = `<div class="tk-scene" aria-hidden="true"><div class="sleepers"></div><div class="rail"></div>
    ${t && !t.mined ? '<div class="tk-pax"></div>' : ''}${t && t.mined ? '<div class="tk-train"><div class="tk-car"></div><div class="tk-car"></div></div>' : ''}</div>`;
  const journey = `<div class="tk-journey">${ticketJourney(t).map(([cls, label, sub]) =>
    `<div class="tk-step ${cls}"><span class="sq"></span>${label}<b>${esc(sub)}</b></div>`).join('')}</div>`;
  let body;
  if (!t) {
    const gaveUp = ticket.tries > 30;
    body = `<div class="tk-lbl">Ticket for ${short(ticket.id)}</div>
      <div class="tk-route">${gaveUp ? 'No ticket found' : 'Looking for your passenger…'}</div>${journey}
      <p class="tk-empty">${forceDemo ? "The station is in demo mode (<code>?demo</code>), so it doesn't look anything up." : gaveUp
        ? "This transaction isn't on Alephium mainnet. Double-check the ID, or try again once it's been sent."
        : ticket.tries ? 'Not found yet. If it was sent just now, give it a few seconds. Checking again…' : 'Checking the explorer…'}</p>`;
  } else {
    const s = ticketStory(t);
    body = `<div class="tk-route">${t.from == null ? 'Platform ?' : `<span class="p">P${t.from}</span><span class="arr">→</span><span>${DEST[t.to]}</span>`}</div>
      <div class="tk-sub">${t.coinbase ? routeLabel(t) : t.from == null ? '' : `Group ${t.from} → Group ${t.to}${s.why
        ? `<details class="tk-why"><summary>CROSS-GROUP <span aria-hidden="true">?</span></summary><p>${s.why}</p></details>` : '<i>LOCAL</i>'}`}${t.contract ? '<i>⚙ CONTRACT</i>' : ''}</div>
      ${journey}
      <p class="tk-story">${s.line}</p>
      <div class="tk-grid">
        <div class="tk-cell big"><div class="tk-lbl">Fare</div><div class="v">${fmt(t.sent)} <small>${fareUnit(t)}${fareUsd(t) ? ' · ' + fareUsd(t) : ''}</small></div></div>
        <div class="tk-cell big"><div class="tk-lbl">Fee</div><div class="v">${t.coinbase ? '—' : `${feeAmount(t)} <small>ALPH</small>`}</div></div>
        <div class="tk-cell"><div class="tk-lbl">From</div><div class="v">${t.sender ? esc(short(t.sender)) : '—'}</div></div>
        <div class="tk-cell"><div class="tk-lbl">To</div><div class="v">${t.coinbase || !t.receiver ? '—' : esc(short(t.receiver))}</div></div>
      </div>
      <div class="tk-code" aria-hidden="true">${ticketBars(t.hash).map(([w, m]) => `<span style="width:${w}px;margin-right:${m}px"></span>`).join('')}</div>
      <div class="tk-actions">
        <a class="fill" href="https://x.com/intent/post?text=${encodeURIComponent(shareText(t))}&url=${encodeURIComponent(ticketUrl())}" target="_blank" rel="noopener">Share ticket</a>
        <button data-act="copy">Copy link</button><button data-act="save">Save</button>
        <a href="${EXPLORER}/transactions/${t.hash}" target="_blank" rel="noopener">Explorer ↗</a>
      </div>`;
  }
  card.innerHTML = `<div class="tk-top"><b>ℵ Central Station</b><span>Ticket · ${live ? 'live' : 'mainnet'}<button class="tk-x" data-act="close" aria-label="Close ticket">✕</button></span></div>
    ${scene}<div class="tk-body">${body}</div>`;
}

const ticketUrl = () => `${location.origin}${location.pathname}?ticket=${ticket.id}`;
function shareText(t) {
  if (!t.mined) return `🎫 My Alephium transaction is waiting on platform ${t.from} for the next train to ${DEST[t.to]} 🚂`;
  return `🎫 My Alephium transaction caught train #${t.height} from platform ${t.from} to ${DEST[t.to]} 🚂`;
}

async function checkTicket() {
  const seq = ticket.seq;
  clearTimeout(ticket.timer);
  if (forceDemo) { renderTicket(); return; }
  try {
    const tx = await getJSON(`/transactions/${ticket.id}`);
    const mined = tx.type !== 'Pending' && tx.type !== 'PendingTransaction' && !!tx.blockHash;
    const block = mined ? await getJSON(`/blocks/${tx.blockHash}`) : null;
    if (seq !== ticket.seq) return;
    ticket.info = ticketInfo(tx, block);
  } catch (e) {
    if (seq !== ticket.seq) return;
    if (String(e.message) !== '404' && ticket.info) { ticket.timer = setTimeout(checkTicket, 8000); return; }   // keep what we have
  }
  ticket.tries++;
  renderTicket();
  if ((!ticket.info && ticket.tries <= 30) || (ticket.info && !ticket.info.mined)) ticket.timer = setTimeout(checkTicket, 4000);
}

function openTicket(id) {
  if (!TICKET_ID.test(id)) return;
  ticket.id = id.toLowerCase(); ticket.info = null; ticket.tries = 0; ticket.seq++;
  window.history.replaceState(null, '', `?ticket=${ticket.id}`);
  findEl.value = ticket.id; findQuery = ticket.id;                     // green arrow on the passenger while it waits
  people.forEach(p => { p.found = matches(p); });
  tip.style.display = 'none';
  ticketEl.hidden = false;
  renderTicket(); checkTicket();
}
function closeTicket() {
  ticket.seq++; clearTimeout(ticket.timer); ticketEl.hidden = true;
  const q = new URLSearchParams(location.search); q.delete('ticket');
  window.history.replaceState(null, '', location.pathname + (q.size ? '?' + q : ''));
}

// A 1200×630 picture of the ticket (the same Night Pass), sized for X / Telegram previews.
function ticketImage(t) {
  const cv = document.createElement('canvas'); cv.width = 1200; cv.height = 630;
  const g = cv.getContext('2d'), col = t.from == null ? '#a08bff' : COLORS[t.from], stripe = t.to == null ? col : COLORS[t.to];
  const F = (wt, px) => `${wt} ${px}px ui-monospace,Consolas,monospace`, INK = '#f0ede6', MUTE = '#a5a2b8', DIM = '#5d5a72', LINE = 'rgba(240,237,230,.14)';
  const hline = (x1, x2, yy) => { g.fillStyle = LINE; g.fillRect(x1, yy, x2 - x1, 2); };
  g.fillStyle = '#05060d'; g.fillRect(0, 0, 1200, 630);
  g.fillStyle = 'rgba(255,255,255,.06)';
  for (let yy = 11; yy < 630; yy += 22) for (let xx = 11; xx < 1200; xx += 22) g.fillRect(xx, yy, 2, 2);   // dot grid
  const x = 70, y = 40, w = 1060, h = 550;
  g.fillStyle = '#0d0e1c'; g.beginPath(); g.roundRect(x, y, w, h, 22); g.fill();
  g.save(); g.beginPath(); g.roundRect(x, y, w, h, 22); g.clip();
  g.fillStyle = col; g.fillRect(x, y, 8, h);                                                          // platform edge
  // top bar
  g.textBaseline = 'middle'; g.fillStyle = INK; g.font = F('bold', 22); g.fillText('ℵ CENTRAL STATION', x + 40, y + 36);
  g.textAlign = 'right'; g.fillStyle = MUTE; g.font = F('', 20); g.fillText(`TICKET · ${t.mined ? 'MAINNET' : 'LIVE'}`, x + w - 36, y + 36); g.textAlign = 'left';
  // pixel scene
  const sy = y + 72, sh = 120, grad = g.createLinearGradient(0, sy, 0, sy + sh);
  grad.addColorStop(0, '#121331'); grad.addColorStop(1, '#0a0b18'); g.fillStyle = grad; g.fillRect(x + 8, sy, w - 8, sh);
  hline(x + 8, x + w, sy); hline(x + 8, x + w, sy + sh);
  g.fillStyle = '#ffd25d'; g.fillRect(x + 8, sy + sh - 26, w - 8, 4);
  g.fillStyle = '#3a3f5c'; for (let xx = x + 8; xx < x + w; xx += 30) g.fillRect(xx, sy + sh - 14, 18, 5);
  if (t.mined) for (let k = 0; k < 3; k++) {                                                           // the train it boarded
    const cx = x + w - 380 + k * 116, cy = sy + sh - 74;
    g.fillStyle = '#e9ecf5'; g.beginPath(); g.roundRect(cx, cy, 110, 46, k ? 6 : [22, 6, 6, 6]); g.fill();
    g.fillStyle = '#fff3b8'; for (let ww = 0; ww < 4; ww++) g.fillRect(cx + 14 + ww * 22, cy + 10, 16, 12);
    g.fillStyle = stripe; g.fillRect(cx, cy + 32, 110, 6);
  } else {                                                                                             // still waiting on the platform
    const px = x + 300, py = sy + sh - 54;
    g.fillStyle = stripe; g.fillRect(px, py, 12, 28); g.fillStyle = '#f1c27d'; g.fillRect(px, py - 12, 12, 12);
    g.fillStyle = '#5dffa8'; g.font = F('', 22); g.fillText('▼', px - 2, py - 30);
  }
  // route
  let ty = sy + sh + 52;
  g.font = F('bold', 54); g.fillStyle = col; const pl = t.from == null ? 'P?' : `P${t.from}`; g.fillText(pl, x + 40, ty);
  let tx = x + 40 + g.measureText(pl).width + 18;
  g.fillStyle = DIM; g.font = F('', 54); g.fillText('→', tx, ty); tx += g.measureText('→').width + 18;
  g.fillStyle = INK; g.font = F('bold', 54); g.fillText(t.to == null ? '?' : DEST[t.to], tx, ty);
  g.fillStyle = MUTE; g.font = F('', 22); g.fillText(routeLabel(t), x + 40, ty + 46);
  // journey
  const jy = ty + 84, cw = (w - 80) / 3;
  hline(x + 40, x + w - 40, jy); hline(x + 40, x + w - 40, jy + 76);
  // a shared picture outlives "3m ago", so it carries the actual time
  const when = t.time ? new Date(t.time).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
  ticketJourney(t).map(([cls, label, sub]) => [cls, label, cls === 'ok' && when ? when : sub]).forEach(([cls, label, sub], i) => {
    const cx = x + 40 + i * cw, colr = { done: MUTE, now: '#ffd25d', ok: '#5dffa8', bad: '#ff7a7a' }[cls] || DIM;
    if (i) { g.fillStyle = LINE; g.fillRect(cx - 14, jy, 2, 76); }
    g.fillStyle = colr; g.fillRect(cx, jy + 18, 14, 14);
    g.font = F('bold', 18); g.fillText(label.toUpperCase(), cx + 24, jy + 26);
    g.fillStyle = cls === 'ok' || cls === 'bad' ? colr : INK; g.font = F('bold', 22); g.fillText(sub, cx, jy + 56);
  });
  // fare and fee
  const fy = jy + 124;
  g.fillStyle = MUTE; g.font = F('', 18); g.fillText('FARE', x + 40, fy - 22); g.fillText('FEE', x + 40 + cw * 1.5, fy - 22);
  g.fillStyle = INK; g.font = F('bold', 40); const fare = fmt(t.sent), farew = g.measureText(fare).width; g.fillText(fare, x + 40, fy + 16);
  g.fillStyle = MUTE; g.font = F('', 22); g.fillText(fareUnit(t) + (fareUsd(t) ? ' · ' + fareUsd(t) : ''), x + 54 + farew, fy + 18);
  g.fillStyle = INK; g.font = F('bold', 40); const fee = t.coinbase ? '—' : feeAmount(t); g.fillText(fee, x + 40 + cw * 1.5, fy + 16);
  if (!t.coinbase) { const fw = g.measureText(fee).width; g.fillStyle = MUTE; g.font = F('', 22); g.fillText('ALPH', x + 54 + cw * 1.5 + fw, fy + 18); }
  g.restore();
  g.textAlign = 'center'; g.fillStyle = DIM; g.font = F('', 18);
  g.fillText(`tx ${short(t.hash)} · ${location.host}${location.pathname.replace(/index\.html$/, '')}`, 600, 612);
  return cv;
}

if (ticketEl) {
  ticketEl.addEventListener('click', async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (e.target === ticketEl || act === 'close') closeTicket();
    else if (act === 'copy') {
      try { await navigator.clipboard.writeText(ticketUrl()); e.target.textContent = '✅ Copied'; } catch { prompt('Copy this link:', ticketUrl()); }
    } else if (act === 'save' && ticket.info) {
      const a = document.createElement('a');
      a.href = ticketImage(ticket.info).toDataURL('image/png'); a.download = `alephium-ticket-${ticket.id.slice(0, 8)}.png`; a.click();
    }
  });
  addEventListener('keydown', e => { if (e.key === 'Escape' && !ticketEl.hidden) closeTicket(); });
  addEventListener('pagehide', () => clearTimeout(ticket.timer));
  // "🎫 ticket" links in the search panel and passenger cards open here instead of reloading the page
  document.addEventListener('click', e => {
    const a = e.target.closest?.('a[data-ticket]');
    if (a) { e.preventDefault(); openTicket(a.dataset.ticket); }
  });
  const fromUrl = new URLSearchParams(location.search).get('ticket');
  if (fromUrl) openTicket(fromUrl);
}
