// Alternative station view: the same block feed, arranged as four vertical platforms.
(() => {
  'use strict';
  const COLORS = ['#ff5d8f', '#5dd6ff', '#ffd25d', '#a08bff'];
  const NAMES = ['Rose Quarter', 'Harbour', 'Old Town', 'Violet Heights'];
  const SKINS = ['#f1c7a5', '#d9a07a', '#a86b48', '#6e4630', '#f5d6b8'];
  const EXPLORER = 'https://explorer.alephium.org';
  const pending = new Map(), departures = [], history = [];
  const scenes = COLORS.map((color, group) => ({ group, color, canvas: document.getElementById('street' + group), people: new Map(), trains: [], last: 0, hits: [], width: 0, height: 0 }));
  const forcedDemo = new URLSearchParams(location.search).has('demo');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let mode = 'retry', paused = false, demoTimer, lastBlockAt = 0, query = '', lastUiAt = 0;
  let demoId = 0, previous = performance.now(), animationTime = 0, lastTownPaint = 0, hovered = null, inspected = null, reconciliation;
  const demoHeights = Array.from({ length: 16 }, (_, i) => 4200000 + i * 731);
  const $ = id => document.getElementById(id);
  const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => n.toLocaleString('en', { maximumFractionDigits: 2 });
  const short = s => s.slice(0, 8) + '…' + s.slice(-6);
  const hashNumber = hash => parseInt(hash.slice(-8), 16) || 1;
  const matches = p => query.length >= 4 && (p.hash.toLowerCase().includes(query) || p.dests.some(address => address.toLowerCase().includes(query)));
  const today = new Date().toISOString().slice(0, 10);
  const wrapsActive = (globalThis.WRAPS || []).filter(w => w.panels?.length && (!w.active?.from || w.active.from <= today) && (!w.active?.to || today <= w.active.to));
  const wrapImages = {};
  wrapsActive.forEach(w => w.panels.forEach(file => { const image = new Image(); image.src = 'wraps/' + file; wrapImages[file] = image; }));
  function pickWrap(height) {
    const special = height % 10000 === 0 ? wrapsActive.filter(w => w.type === 'special') : [];
    const pool = special.length ? special : Math.random() < .2 ? wrapsActive.filter(w => w.type !== 'special') : [];
    let weight = Math.random() * pool.reduce((sum, wrap) => sum + (wrap.weight || 1), 0);
    return pool.find(wrap => (weight -= wrap.weight || 1) < 0) || null;
  }
  const safeLink = link => typeof link === 'string' && /^https:\/\/[^\s"'<>]+$/.test(link) ? link : null;

  function resize() {
    for (const scene of scenes) {
      const rect = scene.canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
      scene.width = rect.width; scene.height = rect.height;
      scene.canvas.width = Math.round(rect.width * dpr); scene.canvas.height = Math.round(rect.height * dpr);
      scene.ctx = scene.canvas.getContext('2d'); scene.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      scene.ctx.imageSmoothingEnabled = false;
    }
    drawTown();
  }
  new ResizeObserver(resize).observe($('districts'));
  addEventListener('resize', resize); resize();

  function addPerson(info, from, to, demo = false) {
    const existing = scenes.flatMap(s => [...s.people.values()]).find(p => p.hash === info.hash);
    if (existing) return existing;
    const seed = hashNumber(info.hash);
    const p = { ...info, f: from, to, demo, seed, observedAt: Date.now(), progress: 0, boarding: null, x: 0, y: 0, dests: info.dests || [] };
    scenes[from].people.set(p.hash, p);
    return p;
  }
  function receiveTransaction(tx, route) {
    if (mode !== 'live') return;
    const p = addPerson(streamTransactionInfo(tx), route.chainFrom, route.chainTo);
    if (p.boarding || p.status !== 'pending') return;
    pending.set(p.hash, p); updateUi();
  }
  function receiveBlock(block, demo = false) {
    if (!demo && mode !== 'live') return;
    const scene = scenes[block.chainFrom];
    const miner = block.transactions.find(tx => tx.unsigned.inputs.length === 0 && !tx.unsigned.scriptOpt && !tx.contractInputs?.length);
    const txs = block.transactions.filter(tx => tx !== miner);
    const riders = [];
    for (const tx of txs) {
      const info = streamTransactionInfo(tx, { mined: true });
      pending.delete(info.hash);
      let p = scenes.flatMap(s => [...s.people.values()]).find(p => p.hash === info.hash);
      if (p && p.f !== block.chainFrom) { scenes[p.f].people.delete(p.hash); scene.people.set(p.hash, p); }
      // Keep every pending record, but bound the number of animated figures per block.
      if (p || riders.length < 36) {
        p ||= addPerson(info, block.chainFrom, block.chainTo, demo);
        Object.assign(p, info, { f: block.chainFrom, to: block.chainTo, boarding: block.hash });
        riders.push(p);
      }
    }
    const train = { hash: block.hash, height: block.height, f: block.chainFrom, to: block.chainTo, demo, wrap: pickWrap(block.height),
      pax: txs.length, failed: txs.filter(tx => tx.scriptExecutionOk === false).length,
      alph: txs.reduce((sum, tx) => sum + streamTransactionInfo(tx, { mined: true }).alph, 0),
      miner: miner ? { ...streamTransactionInfo(miner, { mined: true }), f: block.chainFrom, to: block.chainTo, demo, miner: true, seed: hashNumber(miner.unsigned.txId), blockHash: block.hash } : null,
      riders, phase: 'arriving', progress: 0, dwell: 0, y: 0, cars: Math.min(4, 2 + Math.floor(txs.length / 12)) };
    scene.trains.push(train); scene.last = lastBlockAt = Date.now();
    // If a tab was inactive for a long time, skip old animation backlogs while retaining the counters.
    if (scene.trains.length > 20) {
      const old = scene.trains.splice(1, scene.trains.length - 20);
      for (const t of old) for (const p of t.riders) if (p.boarding === t.hash) scene.people.delete(p.hash);
    }
    departures.unshift(train); departures.length = Math.min(departures.length, 7);
    history.push({ at: Date.now(), pax: txs.length }); renderDepartures(); updateUi();
  }
  function renderDepartures() {
    $('rows').innerHTML = departures.length ? departures.map(t => `<tr>
      <td><span class="route"><i style="background:${COLORS[t.f]}"></i>${t.f}<span>→</span>${t.to}<i style="background:${COLORS[t.to]}"></i></span></td>
      <td>${t.demo ? '#' + t.height : `<a href="${EXPLORER}/blocks/${t.hash}" target="_blank" rel="noopener">#${t.height} ↗</a>`}</td>
      <td>${t.pax}${t.failed ? `<span class="failed-count">${t.failed} failed</span>` : ''}</td></tr>`).join('')
      : '<tr><td colspan="3" class="empty">The first train is on its way.<small>New blocks will appear here.</small></td></tr>';
  }
  function clearTraffic() {
    pending.clear(); departures.length = history.length = 0; lastBlockAt = 0;
    scenes.forEach(scene => { scene.people.clear(); scene.trains.length = 0; scene.last = 0; }); renderDepartures();
    $('inspector').close(); inspected = null;
  }
  function setMode(next) {
    const wasDemo = mode === 'demo';
    mode = next;
    $('mode').className = 'mode ' + next;
    $('mode').textContent = { live: 'LIVE mainnet', retry: 'Reconnecting…', demo: 'DEMO · simulated' }[next];
    $('sceneNote').textContent = next === 'demo' ? 'Simulated passengers & trains' : next === 'live' ? 'Live observations · not a finality check' : 'Waiting for the network';
    if (next === 'demo') startDemo();
    else { clearInterval(demoTimer); demoTimer = null; if (wasDemo) clearTraffic(); }
    updateUi();
  }
  function updateUi() {
    const now = Date.now();
    while (history.length && history[0].at <= now - 60000) history.shift();
    $('sBlocks').textContent = history.length;
    $('sTx').textContent = history.reduce((sum, item) => sum + item.pax, 0);
    $('sWait').textContent = pending.size;
    $('sLast').textContent = lastBlockAt ? Math.floor((now - lastBlockAt) / 1000) + 's' : '–';
    $('statsNote').textContent = mode === 'demo' ? 'Simulated activity' : lastBlockAt ? 'Since the last observed block' : 'Waiting for the first train';
    let matchCount = 0;
    scenes.forEach(scene => {
      $('waiting' + scene.group).textContent = [...pending.values()].filter(p => p.f === scene.group).length + ' waiting';
      $('last' + scene.group).textContent = scene.last ? Math.floor((now - scene.last) / 1000) + 's since last train' : 'Awaiting a train';
      for (const p of platformPeople(scene)) if (matches(p)) matchCount++;
      if (scene.trains[0]?.miner && matches(scene.trains[0].miner)) matchCount++;
    });
    $('searchCount').textContent = query.length >= 4 ? matchCount + ' match' + (matchCount === 1 ? '' : 'es') : '';
    $('footerNote').textContent = mode === 'demo' ? 'Demo mode · no real transactions shown.' : 'Observed since connecting · not a full mempool snapshot.';
    if ($('inspector').open && inspected) renderInspector(inspected);
  }

  // Pixel rectangles are snapped to the grid, even on high-density screens.
  function rect(ctx, x, y, w, h, color) { ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); }
  function text(ctx, label, x, y, size, color, align = 'left') { ctx.fillStyle = color; ctx.font = `${size}px ui-monospace,monospace`; ctx.textAlign = align; ctx.fillText(label, Math.round(x), Math.round(y)); }
  function windowLit(x, y, seed = 0) {
    const key = Math.abs(Math.round(x) * 31 + Math.round(y) * 47 + seed * 137);
    const period = 18000 + key % 7 * 6000, offset = key * 997 % period;
    // Each window follows its own slow cycle; the town never flashes in unison.
    return ((reducedMotion ? 0 : animationTime) + offset) % period < period * .67;
  }
  function building(ctx, x, y, w, h, group, shop = false) {
    rect(ctx, x + 4, y + 5, w, h, '#080912'); rect(ctx, x, y, w, h, ['#242035', '#1c2937', '#2b2630', '#25223d'][group]);
    rect(ctx, x - 2, y, w + 4, 4, '#48445b'); rect(ctx, x + w - 5, y + 4, 5, h - 4, '#111322');
    for (let wy = 12; wy < h - 19; wy += 19) for (let wx = 7; wx < w - 8; wx += 13) {
      const lit = windowLit(x + wx, y + wy, group);
      rect(ctx, x + wx, y + wy, 6, 9, lit ? '#a89765' : '#101625');
      if (lit) rect(ctx, x + wx + 2, y + wy, 1, 9, '#65563e');
    }
    if (shop) {
      rect(ctx, x - 3, y + h - 24, w + 6, 7, COLORS[group]);
      for (let dx = 1; dx < w; dx += 10) rect(ctx, x + dx, y + h - 24, 5, 7, '#e8ecff');
      rect(ctx, x + w * .42, y + h - 17, 12, 17, '#0a0b13');
      rect(ctx, x + w * .42 + 2, y + h - 15, 8, 12, '#ffe2a0');
    } else rect(ctx, x + w * .4, y + h - 17, 10, 17, '#0a0b13');
  }
  function tree(ctx, x, y, size) {
    rect(ctx, x - 1, y, 3, 13, '#4f3940'); rect(ctx, x - size / 2, y - size, size, size, '#243b39');
    rect(ctx, x - size / 2 + 3, y - size + 2, size - 6, size - 5, '#335046'); rect(ctx, x - size / 2 + 3, y - size + 2, 4, size / 2, '#47634e');
  }
  function drawTown() {
    const canvas = $('townSkyline'), bounds = canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
    const W = bounds.width, H = bounds.height;
    const pixelWidth = Math.round(W * dpr), pixelHeight = Math.round(H * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.imageSmoothingEnabled = false;
    const localTime = new Date(), hour = localTime.getHours(), day = hour >= 7 && hour < 17, dusk = hour >= 5 && hour < 7 || hour >= 17 && hour < 20;
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, day ? '#2f6fd1' : dusk ? '#24184f' : '#080b1d');
    sky.addColorStop(1, day ? '#9fd0ff' : dusk ? '#dd795f' : '#292247');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    if (!day && !dusk) for (let i = 0; i < W / 18; i++) rect(ctx, (i * 97 + 13) % W, (i * 23 + 4) % 60, i % 9 ? 1 : 2, 1, '#b0a4c6');
    const body = localSkyPosition(localTime), bodyX = W * body.x - 8, bodyY = H * body.y - 8;
    rect(ctx, bodyX, bodyY, 16, 16, body.daylight ? '#ffdf9a' : '#dedcf2');
    if (!body.daylight) { ctx.fillStyle = sky; ctx.fillRect(Math.round(bodyX + 6), Math.round(bodyY - 3), 13, 13); }
    canvas.setAttribute('aria-label', `Central Station at ${localTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} local time · ${body.daylight ? 'sun' : 'moon'} over the town`);
    // A single skyline spans all four platforms; buildings vary across the town.
    for (let x = -12, i = 0; x < W; x += 43, i++) {
      const h = 18 + (i * 17 % 41);
      rect(ctx, x, H - 31 - h, 39, h, '#25253c');
      rect(ctx, x + 5, H - 34 - h, 21, 4, '#25253c');
      for (let y = H - 24 - h; y < H - 35; y += 10) for (let wx = 7; wx < 35; wx += 9)
        if (windowLit(x + wx, y, i)) rect(ctx, x + wx, y, 3, 4, '#9a8466');
    }
    for (let x = -16, i = 0; x < W; x += 109, i++) {
      const h = 32 + i * 13 % 25;
      building(ctx, x, H - h, 73 + i % 3 * 7, h, i % 4, i % 3 === 0);
    }
    // One central station hall and clock tower serve the entire town.
    const hallW = Math.min(430, W * .56), hallX = (W - hallW) / 2, hallY = H - 55;
    rect(ctx, hallX - 8, hallY - 5, hallW + 16, 8, '#6e6579');
    rect(ctx, hallX, hallY + 3, hallW, 49, '#393549');
    for (let x = hallX + 9; x < hallX + hallW - 8; x += 26) {
      rect(ctx, x, hallY + 14, 17, 23, windowLit(x, hallY, 11) ? '#ffdfa3' : '#292b41'); rect(ctx, x + 7, hallY + 14, 2, 23, '#5a4b45');
      rect(ctx, x - 2, hallY + 12, 21, 3, '#73646c');
    }
    const towerX = W / 2 - 19;
    rect(ctx, towerX, hallY - 34, 38, 36, '#4b4359');
    rect(ctx, towerX - 4, hallY - 39, 46, 6, '#796b83');
    rect(ctx, towerX + 10, hallY - 27, 18, 18, '#e8dcc1');
    const hand = (angle, length) => { for (let n = 0; n < length; n++) rect(ctx, W / 2 + Math.sin(angle) * n, hallY - 18 - Math.cos(angle) * n, 2, 2, '#39313f'); };
    hand((hour % 12 + localTime.getMinutes() / 60) * Math.PI / 6, 5);
    hand(localTime.getMinutes() * Math.PI / 30, 7);
    rect(ctx, W / 2 - 75, H - 19, 150, 17, '#131521');
    text(ctx, 'ℵ CENTRAL STATION', W / 2, H - 7, 10, '#ffcf7a', 'center');
    rect(ctx, 0, H - 2, W, 2, '#716478');
  }
  setInterval(drawTown, 60000);
  function drawStation(scene) {
    const { ctx, width: W, height: H, group } = scene;
    const curb = W * .61, track = W * .78;
    rect(ctx, 0, 0, W, H, '#171a2a');
    // The concourse crosses all platforms without card borders or separate skies.
    rect(ctx, 0, 0, W, 46, '#252638'); rect(ctx, 0, 42, W, 4, '#454052');
    for (let x = 0; x < W; x += 18) rect(ctx, x, 21, 1, 21, '#2e3044');
    rect(ctx, 0, 46, curb, H - 46, '#171a2a');
    for (let y = 47; y < H; y += 18) for (let x = 0; x < curb; x += 18) {
      rect(ctx, x + 1, y + 1, 16, 16, (Math.floor(x / 18) + Math.floor(y / 18)) % 2 ? '#191c2e' : '#1c1f31');
    }
    rect(ctx, curb - 3, 46, 4, H - 46, '#555369'); rect(ctx, curb - 6, 46, 2, H - 46, '#e8c547');
    rect(ctx, curb + 2, 46, W - curb, H - 46, '#090a11');
    for (let y = 49; y < H; y += 13) rect(ctx, track - 20, y, 40, 4, '#373444');
    rect(ctx, track - 14, 46, 2, H - 46, '#9294a3'); rect(ctx, track + 13, 46, 2, H - 46, '#9294a3');
    rect(ctx, track - 12, 46, 1, H - 46, '#444855'); rect(ctx, track + 12, 46, 1, H - 46, '#444855');
    // Signal and route board above the track.
    rect(ctx, track - 1, 0, 2, 31, '#424353'); rect(ctx, track - 21, 5, 42, 17, '#161726');
    text(ctx, 'P' + group + ' ↑', track, 17, 9, COLORS[group], 'center');
    rect(ctx, curb + 7, 26, 8, 19, '#272b38');
    rect(ctx, curb + 9, 29, 4, 4, scene.trains[0]?.phase === 'boarding' ? '#ff7a7a' : '#5dffa8');
    rect(ctx, curb + 9, 37, 4, 4, '#484439');
    const bw = Math.max(38, W * .27);
    if (group === 0) {
      // A ticket kiosk, rather than a separate town on every platform.
      rect(ctx, 9, 83, bw - 5, 54, '#373345'); rect(ctx, 5, 79, bw + 3, 5, '#6c5b72');
      rect(ctx, 16, 94, bw - 19, 21, '#f2d49b'); text(ctx, 'TICKETS', bw / 2 + 7, 127, 7, '#d1bfd2', 'center');
    } else if (group === 1) {
      tree(ctx, 22, 104, 25); tree(ctx, bw - 4, 126, 20);
      rect(ctx, 14, 136, bw - 12, 4, '#7b626a');
    } else if (group === 2) {
      // A little fountain in the station plaza.
      rect(ctx, 14, 117, bw - 13, 18, '#56546b'); rect(ctx, 17, 120, bw - 19, 10, '#397283');
      rect(ctx, bw / 2 + 3, 95, 4, 27, '#839bac'); rect(ctx, bw / 2 - 4, 109, 18, 4, '#72b5c3');
      const drop = reducedMotion ? 0 : Math.floor(animationTime / 180) % 8;
      rect(ctx, bw / 2 - 4, 114 + drop, 2, 2, '#9dd2db'); rect(ctx, bw / 2 + 12, 119 - drop, 2, 2, '#9dd2db');
    } else {
      rect(ctx, 15, 100, 3, 39, '#766379'); rect(ctx, bw - 12, 100, 3, 39, '#766379');
      rect(ctx, 10, 82, bw - 15, 26, '#514a60'); rect(ctx, 6, 78, bw - 7, 5, '#8a7a8d');
      text(ctx, 'ℵ', bw / 2 + 1, 102, 16, '#bcb0d2', 'center');
    }
    // A tiny glowing platform sign, bench, lamps and shrubs.
    rect(ctx, 6, 53, bw + 6, 13, '#0a0b13'); text(ctx, 'PLATFORM ' + group, 9, 63, 7, COLORS[group]);
    rect(ctx, 9, H * .84, 27, 5, '#54495b'); rect(ctx, 12, H * .84 + 5, 3, 7, '#30293b'); rect(ctx, 30, H * .84 + 5, 3, 7, '#30293b');
    tree(ctx, bw * .65, H * .43, 17); tree(ctx, 19, H - 29, 18);
    for (const y of [H * .38, H * .8]) {
      rect(ctx, curb - 18, y, 2, 25, '#656276'); rect(ctx, curb - 22, y - 2, 10, 4, '#ffe6a4');
      rect(ctx, curb - 24, y + 3, 14, 16, '#ffdc8110');
    }
    text(ctx, '16 ROUTES', 9, H - 8, 6, '#575b7d');
  }
  function drawPerson(scene, p, x, y, alpha, now) {
    const ctx = scene.ctx, u = scene.width >= 260 ? 1.6 : 1.35, s = p.alph >= 10000 ? u * 1.35 : u;
    const stride = p.progress < 1 ? Math.sin(now / 110 + p.seed) * s : 0;
    ctx.globalAlpha = alpha;
    rect(ctx, x - s, y - 3 * s, s, 3 * s - Math.max(0, stride), '#2b2c40');
    rect(ctx, x + s * .2, y - 3 * s, s, 3 * s + Math.min(0, stride), '#2b2c40');
    rect(ctx, x - 1.5 * s, y - 7 * s, 3 * s, 4 * s, p.miner ? '#ff8c1a' : p.alph >= 10000 ? '#e9b949' : COLORS[p.to]);
    rect(ctx, x - s, y - 9.5 * s, 2 * s, 2.5 * s, SKINS[p.seed % SKINS.length]);
    rect(ctx, x - s, y - 10 * s, 2 * s, s, p.seed % 3 ? '#3b2835' : '#74614f');
    if (p.miner) {
      rect(ctx, x - 1.4 * s, y - 10.6 * s, 2.8 * s, 1.3 * s, '#ffcc00');
      rect(ctx, x - 1.2 * s, y - 6 * s, 2.4 * s, .6 * s, '#ffe14d');
      rect(ctx, x + s, y - 10.3 * s, .7 * s, .7 * s, '#fffbe0');
      rect(ctx, x - 2.6 * s, y - 9 * s, .6 * s, 5 * s, '#8a5a2b');
      rect(ctx, x - 3.8 * s, y - 9.4 * s, 3 * s, .7 * s, '#b8bfd6');
    }
    if (p.tokens) rect(ctx, x + 1.5 * s, y - 5 * s, 1.5 * s, 2 * s, '#5dffa8');
    if (p.alph >= 10000) { rect(ctx, x - 1.3 * s, y - 10.3 * s, 2.6 * s, s, '#111'); rect(ctx, x - .9 * s, y - 12 * s, 1.8 * s, 1.8 * s, '#111'); }
    if (p.contract) text(ctx, '⚙', x, y - 14 * s, 9, '#ffd25d', 'center');
    if (p.status === 'failed') text(ctx, '×', x, y - 14 * s, 10, '#ff7a7a', 'center');
    else if (p.boarding) text(ctx, '✓', x, y - 14 * s, 8, '#5dffa8', 'center');
    if (matches(p)) { text(ctx, '↓', x, y - 17 * s, 13, '#5dffa8', 'center'); rect(ctx, x - 4 * s, y + s, 8 * s, 1, '#5dffa8'); }
    if (hovered === p) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(Math.round(x - 4 * s), Math.round(y - 13 * s), Math.round(8 * s), Math.round(14 * s)); }
    ctx.globalAlpha = 1;
    if (alpha > .25) scene.hits.push({ x: x - 7, y: y - 19, w: 14, h: 22, value: p, type: 'person' });
  }
  function trainLength(train) { return (42 + train.cars * 53) * (train.scale || 1); }
  function drawTrain(scene, train) {
    const { ctx, width: W } = scene, scale = train.scale;
    const originX = Math.round(W * .78 - 17 * scale), originY = Math.round(train.y), x = 0, y = 0;
    ctx.save(); ctx.translate(originX, originY); ctx.scale(scale, scale);
    const rush = train.pax >= 25, body = rush ? '#e9b949' : '#d9dcea';
    const color = COLORS[train.to], length = trainLength(train) / scale;
    rect(ctx, x + 3, y + 4, 36, length + 3, '#0008');
    // Leading engine: square nose, headlights, striped livery and a miner in the cab.
    rect(ctx, x + 3, y, 28, 4, body); rect(ctx, x, y + 4, 34, 36, body);
    rect(ctx, x + 1, y + 5, 4, 2, '#fff8c0'); rect(ctx, x + 29, y + 5, 4, 2, '#fff8c0');
    rect(ctx, x + 4, y + 11, 26, 13, '#32384f');
    rect(ctx, x + 11, y + 14, 5, 5, '#d9a07a'); rect(ctx, x + 10, y + 12, 7, 3, '#ffcc00');
    rect(ctx, x + 2, y + 28, 30, 4, color); rect(ctx, x + 10, y + 34, 14, 4, '#9098aa');
    for (let c = 0; c < train.cars; c++) {
      const cy = y + 44 + c * 53;
      rect(ctx, x + 14, cy - 4, 6, 5, '#595e72'); rect(ctx, x, cy, 34, 48, body);
      rect(ctx, x + 7, cy + 5, 20, 35, '#bec4d1');
      for (const wx of [x + 2, x + 28]) for (let k = 0; k < 4; k++) rect(ctx, wx, cy + 7 + k * 9, 4, 6, '#fff3c4');
      rect(ctx, x, cy + 40, 34, 3, color); rect(ctx, x + 11, cy + 17, 12, 10, '#8f97ab');
      const panel = train.wrap && wrapImages[train.wrap.panels[c % train.wrap.panels.length]];
      if (panel?.complete && panel.naturalWidth) {
        // Use the station's existing side panels, turned to follow the vertical track.
        ctx.save(); ctx.translate(x + 34, cy); ctx.rotate(Math.PI / 2);
        ctx.imageSmoothingEnabled = false; ctx.drawImage(panel, 0, 0, 48, 34); ctx.restore();
        ctx.strokeStyle = '#0007'; ctx.lineWidth = .5; ctx.strokeRect(x + 3, cy + 19, 28, 10);
        if (train.phase === 'boarding') rect(ctx, x + 3, cy + 20, 28, 8, '#ffe89a');
        rect(ctx, x, cy + 45, 34, 3, color);
      }
      if (train.phase === 'boarding') rect(ctx, x, cy + 21, 5, 10, '#ffe89a');
    }
    rect(ctx, x - 8, y - 27, 50, 23, '#07080f');
    text(ctx, '#' + train.height, x + 17, y - 17, 6, '#e8ecff', 'center');
    text(ctx, 'G' + train.f + '→G' + train.to, x + 17, y - 6, 7, color, 'center');
    if (train.phase === 'boarding') {
      text(ctx, train.pax + ' pax', x + 17, y + length + 13, 8, '#e8ecff', 'center');
      if (train.failed) text(ctx, '× ' + train.failed, x + 17, y + length + 24, 8, '#ff7a7a', 'center');
    }
    ctx.restore();
    scene.hits.push({ x: originX, y: originY, w: 34 * scale, h: length * scale, value: train, type: 'train' });
    if (train.miner) {
      scene.hits.push({ x: originX + 7 * scale, y: originY + 10 * scale, w: 20 * scale, h: 17 * scale, value: train.miner, type: 'person' });
      if (matches(train.miner)) text(ctx, '↓', originX + 17 * scale, originY + 6 * scale, 15, '#5dffa8', 'center');
    }
  }
  function drawScene(scene, dt, now) {
    const { width: W, height: H } = scene;
    if (!W || !H) return;
    scene.hits.length = 0; drawStation(scene);
    const train = scene.trains[0], stop = 87;
    if (train) {
      // A platform must keep up with live blocks; queued trains accelerate its animation.
      const trainDt = dt * Math.max(1, scene.trains.length * .8);
      train.scale = W >= 260 ? 2 : 1.5;
      if (reducedMotion && !paused) { train.phase = 'boarding'; train.dwell += trainDt; train.y = stop; }
      else if (train.phase === 'arriving') { train.progress = Math.min(1, train.progress + trainDt / 1100); train.y = H + 20 + (stop - H - 20) * (1 - (1 - train.progress) ** 2); if (train.progress === 1) { train.phase = 'boarding'; train.progress = 0; } }
      else if (train.phase === 'boarding') { train.dwell += trainDt; train.y = stop; if (train.dwell > 1700) { train.phase = 'leaving'; train.progress = 0; } }
      else { train.progress += trainDt / 1400; train.y = stop - train.progress ** 2 * (H + trainLength(train)); }
      if ((reducedMotion && train.dwell > 1700) || train.progress >= 1 && train.phase === 'leaving') {
        for (const p of train.riders) if (p.boarding === train.hash) scene.people.delete(p.hash);
        scene.trains.shift();
      } else drawTrain(scene, train);
    }
    const all = platformPeople(scene);
    const people = query.length >= 4 ? [...all.filter(matches), ...all.filter(p => !matches(p))].slice(0, 48) : all.slice(0, 48);
    people.forEach((p, i) => {
      p.progress = Math.min(1, p.progress + dt / (p.status === 'pending' ? 1100 : 550));
      const col = i % 3, row = Math.floor(i / 3), targetX = W * .52 - col * 10;
      const targetY = Math.min(H - 18, 154 + row * 14), startX = W * .16 + (p.seed % 7) * 3, startY = p.seed % 2 ? H * .72 : 167;
      let x = startX + (targetX - startX) * p.progress, y = startY + (targetY - startY) * p.progress, alpha = 1;
      if (train?.phase === 'boarding' && p.boarding === train.hash) {
        const board = Math.min(1, Math.max(0, (train.dwell - (i % 12) * 55) / 650));
        x += (W * .71 - x) * board; y += (train.y + 70 - y) * board; alpha = 1 - board;
      } else if (train?.phase === 'leaving' && p.boarding === train.hash) alpha = 0;
      p.x = x; p.y = y; drawPerson(scene, p, x, y, alpha, now);
    });
    if (train?.miner && train.phase !== 'leaving') {
      const board = train.phase === 'boarding' ? Math.min(1, train.dwell / 650) : 0;
      const arrival = train.phase === 'arriving' ? train.progress : 1;
      const x = W * (.13 + .4 * arrival) + W * .25 * board;
      const y = 177 + (train.y + 36 - 177) * board;
      train.miner.x = x; train.miner.y = y; train.miner.progress = board || arrival;
      drawPerson(scene, train.miner, x, y, 1 - board, now);
    }
    const extra = all.length - people.length;
    if (extra > 0) text(scene.ctx, '+' + extra + ' more', W * .36, H - 9, 7, '#8b93b8');
  }
  function platformPeople(scene) {
    const train = scene.trains[0];
    // Confirmed riders belong to their train, not to the pending platform queue.
    return [...scene.people.values()].filter(p => !p.boarding || p.boarding === train?.hash && train.phase !== 'leaving');
  }
  function frame(now) {
    const dt = paused ? 0 : Math.min(100, Math.max(0, now - previous)); previous = now;
    animationTime += dt;
    if (!paused && !reducedMotion && animationTime - lastTownPaint >= 750) { drawTown(); lastTownPaint = animationTime; }
    for (const scene of scenes) drawScene(scene, dt, animationTime);
    if (now - lastUiAt > 500) { lastUiAt = now; updateUi(); }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function renderInspector(hit) {
    const p = hit.value, isTrain = hit.type === 'train';
    $('inspectTitle').textContent = isTrain ? 'Train #' + p.height : p.miner ? 'Miner · mining reward' : p.alph >= 10000 ? 'Whale passenger' : p.contract ? 'Contract passenger' : 'Passenger';
    const route = `<div class="journey-route"><i style="background:${COLORS[p.f]}"></i>G${p.f}<span>→</span><i style="background:${COLORS[p.to]}"></i>G${p.to} · ${NAMES[p.to]}</div>`;
    const row = (label, value) => `<div class="inspect-row"><span>${label}</span><span>${esc(value)}</span></div>`;
    const wrap = isTrain && p.wrap, creditLink = wrap && safeLink(wrap.link);
    const credit = wrap ? (wrap.type === 'ad' ? 'Sponsored by ' : 'Art by ') + (wrap.credit || 'anonymous') : '';
    const status = isTrain ? p.demo ? 'Simulated block' : 'Block observed · not a finality check' : p.demo ? 'Simulated transaction' : transactionStatusLabel(p.status);
    $('inspectBody').innerHTML = route + row('Status', status) + row(isTrain ? 'Block hash' : 'Transaction', short(p.hash))
      + (isTrain ? row('Passengers', p.pax + (p.miner ? ' + 1 miner' : ' · miner unavailable')) + row('Failed executions', p.failed) + row('Miner reward', p.miner ? fmt(p.miner.alph) + ' ALPH' : 'Unavailable')
        + (p.miner ? row('Miner transaction', short(p.miner.hash)) : '') : row('Tokens', p.tokens ? 'Yes' : 'No') + row('Contract', p.contract ? 'Yes' : 'No'))
      + row('ALPH in outputs', fmt(p.alph)) + '<p class="inspect-note">Output totals include change. Observations come from the full-node stream.</p>'
      + (wrap ? `<p class="inspect-note wrap-credit">${creditLink ? `<a href="${esc(creditLink)}" target="_blank" rel="noopener sponsored">${esc(credit)} ↗</a>` : esc(credit)}</p>` : '')
      + (p.checkMessage ? `<p class="inspect-note">${esc(p.checkMessage)}</p>` : '')
      + (p.demo ? '<p class="inspect-note">This journey is simulated and has no explorer record.</p>' : `<a class="explorer-link" href="${EXPLORER}/${isTrain ? 'blocks' : 'transactions'}/${p.hash}" target="_blank" rel="noopener">Open in Alephium explorer ↗</a>`)
      + (isTrain && p.miner && !p.demo ? `<a class="explorer-link miner-link" href="${EXPLORER}/transactions/${p.miner.hash}" target="_blank" rel="noopener">Open mining-reward transaction ↗</a>` : '')
      + (!isTrain && !p.demo && pending.has(p.hash) ? '<button id="checkTransaction" class="text-button">Check confirmation now</button>' : '');
    if ($('checkTransaction')) $('checkTransaction').onclick = () => reconciliation?.check(p);
  }
  function inspect(hit) {
    inspected = hit; renderInspector(hit);
    if (!$('inspector').open) $('inspector').showModal();
  }
  $('closeInspector').onclick = () => $('inspector').close();
  $('inspector').addEventListener('click', e => { if (e.target === $('inspector')) { const r = e.target.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close(); } });
  for (const scene of scenes) {
    const hitAt = e => { const r = scene.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top; return [...scene.hits].reverse().find(hit => x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h); };
    scene.canvas.addEventListener('mousemove', e => { const hit = hitAt(e); hovered = hit?.value || null; scene.canvas.style.cursor = hit ? 'pointer' : 'default'; });
    scene.canvas.addEventListener('mouseleave', () => { hovered = null; });
    scene.canvas.addEventListener('click', e => { const hit = hitAt(e); if (hit) inspect(hit); });
  }
  $('find').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); updateUi(); });
  $('pause').onclick = () => { paused = !paused; $('pause').setAttribute('aria-pressed', String(paused)); $('pause').textContent = paused ? '▶ Resume' : 'Ⅱ Pause'; };

  function demoTransaction(from, to, miner = false) {
    const id = (++demoId).toString(16).padStart(64, '0');
    return { unsigned: { txId: id, inputs: miner ? [] : [{ outputRef: { hint: from } }],
      fixedOutputs: [{ hint: to, address: 'Demo recipient', attoAlphAmount: String(BigInt(miner ? 50 : demoId % 29 === 0 ? 1000000 : demoId % 700 + 1) * 10n ** 16n), tokens: !miner && demoId % 9 === 0 ? [{ id: 'demo-token', amount: '1' }] : [] }],
      ...(!miner && demoId % 13 === 0 ? { scriptOpt: 'demo' } : {}) } };
  }
  function demoStep(seed = false) {
    for (let f = 0; f < 4; f++) {
      const count = seed ? 9 + f * 3 : 1 + Math.floor(Math.random() * 3);
      for (let n = 0; n < count; n++) { const to = Math.floor(Math.random() * 4), tx = demoTransaction(f, to), p = addPerson(streamTransactionInfo(tx), f, to, true); p.demoTx = tx; pending.set(p.hash, p); }
      if (seed || Math.random() < .65) {
        const to = Math.floor(Math.random() * 4), riders = [...pending.values()].filter(p => p.f === f && p.to === to).slice(0, 18);
        const transactions = [demoTransaction(f, to, true), ...riders.map(p => ({ ...p.demoTx, scriptExecutionOk: p.seed % 17 !== 0 }))];
        const height = ++demoHeights[f * 4 + to];
        receiveBlock({ chainFrom: f, chainTo: to, height, hash: ('d' + height.toString(16)).padStart(64, '0'), transactions }, true);
      }
    }
    updateUi();
  }
  function startDemo() {
    if (demoTimer) return;
    clearTraffic(); demoStep(true); demoTimer = setInterval(() => demoStep(), 2000);
  }
  if (forcedDemo) {
    $('demoSwitch').textContent = 'Go live ↗'; $('demoSwitch').href = 'yard.html';
    setMode('demo');
    renderNetworkHealth({ mode: 'demo', transport: 'disconnected', blockFeed: 'disabled', txFeed: 'disabled' });
    $('networkHealth').classList.add('panel');
  } else {
    reconciliation = startTransactionReconciliation({
      getPending: () => [...pending.values()], isActive: () => mode === 'live',
      onConfirmed: (p, tx) => {
        pending.delete(p.hash); scenes[p.f].people.delete(p.hash);
        p.status = tx.scriptExecutionOk === true ? 'succeeded' : tx.scriptExecutionOk === false ? 'failed' : 'mined';
        p.blockHash = tx.blockHash; updateUi();
      },
      onCheck: (p, message) => { p.checkMessage = message; if ($('inspector').open && inspected?.value === p) renderInspector(inspected); },
      onHealth: renderConfirmationHealth,
    });
    startLiveFeed({ onBlock: receiveBlock, onTransaction: receiveTransaction, onState: setMode,
      onHealth: health => { renderNetworkHealth(health); $('networkHealth').classList.add('panel'); } });
  }
  addEventListener('pagehide', () => { clearInterval(demoTimer); demoTimer = null; });
  addEventListener('pageshow', event => { if (event.persisted && mode === 'demo') startDemo(); });
})();
