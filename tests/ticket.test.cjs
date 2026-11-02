const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ticket.js only needs a few globals from index.html; with no #ticket element it skips all the UI wiring.
function load() {
  const context = vm.createContext({
    document: { getElementById: () => null },
    DEST: ['Rose Quarter', 'Harbour', 'Old Town', 'Violet Hts'],
    ago: () => '5s ago',
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ticket.js'), 'utf8'), context);
  return context;
}
const ALPH = n => (BigInt(Math.round(n * 1e4)) * 10n ** 14n).toString();
// hints 0-3 map to groups 0-3 (XOR of the bytes, modulo 4)
const input = (address, hint) => ({ outputRef: { hint, key: 'k' }, address, attoAlphAmount: ALPH(10) });
const output = (address, hint, alph, extra = {}) => ({ type: 'AssetOutput', hint, address, attoAlphAmount: ALPH(alph), ...extra });
const tx = extra => ({ type: 'Accepted', hash: 'a'.repeat(64), blockHash: 'b'.repeat(64), timestamp: 1, gasAmount: 20000, gasPrice: '100000000000',
  inputs: [input('alice', 0)], outputs: [output('bob', 2, 1.5), output('alice', 0, 8.4)], scriptExecutionOk: true, ...extra });

test('a pending cross-group transaction waits, with its route taken from the hints', () => {
  const c = load();
  const t = c.ticketInfo(tx({ type: 'Pending', blockHash: undefined }), null);
  assert.equal(t.mined, false);
  assert.deepEqual([t.from, t.to], [0, 2]);
  assert.equal(t.sent, 1.5);                    // change back to the sender doesn't count as the fare
  assert.equal(t.receiver, 'bob');
  const s = c.ticketStory(t);
  assert.equal(s.stamp, 'WAITING');
  assert.match(s.why, /Trips between two groups ride their own line \(G0 → G2\)/);
});

test('a mined local transaction arrives on the train from its block', () => {
  const c = load();
  const t = c.ticketInfo(tx({ outputs: [output('bob', 0, 2), output('alice', 0, 7.9)] }), { chainFrom: 0, chainTo: 0, height: 4200 });
  assert.equal(t.mined, true);
  assert.equal(t.height, 4200);
  assert.equal(t.fee, 0.002);
  const s = c.ticketStory(t);
  assert.equal(s.stamp, 'ARRIVED');
  assert.equal(s.why, '');                      // local trips need no explanation
  assert.match(s.line, /Nothing more to wait for/);
});

test('a failed contract call is marked failed, not arrived', () => {
  const c = load();
  const t = c.ticketInfo(tx({ scriptExecutionOk: false, scriptOpt: 'script' }), { chainFrom: 1, chainTo: 1, height: 9 });
  assert.equal(t.failed, true);
  assert.equal(t.contract, true);
  assert.equal(c.ticketStory(t).stamp, 'FAILED');
});

test('a pending transaction is never failed, even if the explorer says scriptExecutionOk false', () => {
  const c = load();
  const t = c.ticketInfo(tx({ type: 'Pending', blockHash: undefined, scriptExecutionOk: false }), null);
  assert.equal(t.failed, false);
  assert.equal(c.ticketStory(t).stamp, 'WAITING');
});

test('miner rewards and sends-to-self get their own wording', () => {
  const c = load();
  const reward = c.ticketInfo(tx({ coinbase: true, inputs: [], outputs: [output('miner', 1, 0.25)] }), { chainFrom: 1, chainTo: 2, height: 77 });
  assert.equal(reward.coinbase, true);
  assert.equal(reward.fee, 0);
  assert.equal(c.ticketStory(reward).stamp, 'MINER');
  assert.equal(vm.runInContext('routeLabel', c)(reward), 'Rode the G1 → G2 line');
  const self = c.ticketInfo(tx({ outputs: [output('alice', 0, 9.99)] }), { chainFrom: 0, chainTo: 0, height: 5 });
  assert.equal(self.toSelf, true);
  assert.equal(self.sent, 9.99);
});

test('tokens sent to someone else are counted once per token', () => {
  const c = load();
  const tok = [{ id: 't1', amount: '5' }, { id: 't2', amount: '1' }];
  const t = c.ticketInfo(tx({ outputs: [output('bob', 2, 0.001, { tokens: tok }), output('bob', 2, 0.001, { tokens: [tok[0]] }), output('alice', 0, 9)] }), null);
  assert.equal(t.tokens, 2);
});

test('the journey only lights up steps the explorer has reported', () => {
  const c = load(); c.short = h => h.slice(0, 4);
  const states = t => vm.runInContext('ticketJourney', c)(t).map(([cls, label]) => `${cls || '-'}:${label}`).join(' ');
  assert.equal(states(null), '-:Sent -:Boarded -:Arrived');
  const waiting = c.ticketInfo(tx({ type: 'Pending', blockHash: undefined }), null);
  assert.equal(states(waiting), 'done:Sent now:Boarding -:Arrived');
  const arrived = c.ticketInfo(tx(), { chainFrom: 0, chainTo: 2, height: 4200 });
  assert.equal(states(arrived), 'done:Sent done:Boarded ok:Arrived');
  const failed = c.ticketInfo(tx({ scriptExecutionOk: false }), { chainFrom: 0, chainTo: 0, height: 9 });
  assert.equal(states(failed), 'done:Sent done:Boarded bad:Contract said no');
  const reward = c.ticketInfo(tx({ coinbase: true, inputs: [], outputs: [output('miner', 1, 0.25)] }), { chainFrom: 1, chainTo: 2, height: 77 });
  assert.equal(states(reward), 'done:Reward done:Boarded ok:Arrived');
});

test('every status is one short line', () => {
  const c = load();
  const lines = [
    c.ticketInfo(tx({ type: 'Pending', blockHash: undefined }), null),
    c.ticketInfo(tx(), { chainFrom: 0, chainTo: 2, height: 1 }),
    c.ticketInfo(tx({ scriptExecutionOk: false }), { chainFrom: 0, chainTo: 0, height: 1 }),
    c.ticketInfo(tx({ coinbase: true, inputs: [], outputs: [output('miner', 1, 0.25)] }), { chainFrom: 1, chainTo: 2, height: 77 }),
  ].map(t => c.ticketStory(t).line);
  for (const l of lines) assert.ok(l.length <= 70, `too long: ${l}`);
});
