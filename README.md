# ℵ Central Station

Alephium, live, as a pixel-art train station. Open `index.html` (station) or `map.html` (neon metro map). No build step; host anywhere static, including the shared `live-feed.js` file.

- 4 platforms = Alephium's 4 groups; a train's destination = the block's `chainTo` (16 routes)
- Every block is a train; every transaction is a passenger who boards it
- Live passengers are real transactions: they appear from the mempool, and the exact ones in a block board that train. Click one to see its tx and open it in the explorer
- 🐋 Whales (≥10,000 ALPH in outputs, including change), token carriers (green bag), contract callers (juggling gears), ⛏ a miner in the cab of every train (the block's coinbase/mining-reward tx; click a train to see the reward), miner-only expresses for blocks with no user txs, gold rush-hour trains for 25+ txs
- Live ALPH price (CoinGecko, polled every 60s) with 24h change; dollar values on passengers, trains, whales, search results and the outputs/min stat
- Mempool size in the main stats: transaction count across all routes from the latest successful snapshot, refreshed every second; separate from waiting passengers observed by this view
- Search box: paste a tx hash or address (≥4 chars) and your passenger gets a green arrow
- Announcements ticker, optional chimes (🔇/🔊), pigeons, braking sparks, rain, shooting stars, sky follows your local time of day
- Network-health panel in both views: observed blocks/min and mined user tx/min, failed executions/min, separate subscription status, mempool polling status/count/age, last-block age, and reconnect count. Mobile starts collapsed; demo traffic is excluded.
- Transaction outcomes: pending events stay pending; mined transactions show execution success/failure only when `scriptExecutionOk` explicitly reports it. Missing results stay unknown. Failed executions are marked on departures and station passengers. These are full-node observations, not a finality check.

## Data

Both views connect to `wss://ws.fullnode.alephium.notrustverify.ch/events` and send JSON-RPC `subscribe` requests for `block` and `tx`. Block notifications immediately drive trains, with duplicate hashes ignored. The stream includes transactions and mining rewards; it shows blocks as the full node observes them, rather than the explorer's indexed main-chain snapshot. Missed blocks during a disconnection are not replayed.

After sending the WebSocket subscriptions, both views immediately fetch `https://lb-fullnode-alephium.notrustverify.ch/mempool/transactions` and poll it every second while connected. Slow requests never overlap; each has an 8s timeout. Polling stops on disconnect/pagehide and starts with a fresh snapshot after reconnect/pageshow. Errors appear in network health without interrupting block events.

Snapshots supply explicit `fromGroup`/`toGroup` routes. WebSocket pending notifications also create passengers, deriving routes from input/output hints. Both sources deduplicate by transaction ID; exact IDs in block payloads board the train and record execution results. Recently mined IDs cannot be resurrected by a delayed snapshot. Disappearance from a snapshot alone never marks a transaction mined, successful, or failed; waiting passengers remain unconfirmed until inclusion is observed in a block or confirmed by the explorer. Missed blocks are recovered through targeted explorer transaction checks after reconnect, after three successful snapshots omit an ID, or after a passenger waits 60 seconds. Checks are serial (at most one per second), with a 30-second per-ID retry interval and global cooldown on errors. Inclusion removes the passenger without inventing a train or changing observed-block metrics; pending, missing, malformed, and failed requests leave it waiting. Pagehide/disconnect abort checks and stale responses cannot override block events.

This flow follows the official node's [WebSocket protocol](https://github.com/alephium/alephium/blob/master/ws/src/main/scala/org/alephium/ws/WsProtocol.scala) and [mempool API model](https://github.com/alephium/alephium/blob/master/api/src/main/scala/org/alephium/api/model/MempoolTransactions.scala). WebSocket subscriptions provide live arrivals, not an existing-mempool listing.

The stream lacks enriched sender addresses, so address watches match output addresses and displayed amounts are ALPH output totals including change, rather than net amounts sent. Contract-generated outputs appear when the transaction is mined.

The public explorer API `https://backend.mainnet.alephium.org` is used for targeted confirmation recovery in all views and user-triggered transaction/address searches in the station view. CoinGecko price updates still poll every 60s.

The WebSocket reconnects automatically with exponential backoff, detects stalled streams, and falls back to a clearly labeled simulated demo after 15s without a working feed. A valid block or pending transaction restores live mode, clears demo traffic, and restores known waiting transactions. Force simulation with `?demo` (no WebSocket or mempool requests).

Run the feed and view integration checks with `node --test tests/live-feed.test.cjs` (no dependencies required).

For repeatable Chromium checks, run `npm ci`, `npx playwright install chromium`, then `npm run test:browser`. These cover desktop/mobile layouts, one-second mempool snapshots and size stats, exact passenger boarding, failed execution indicators, reconnect/demo recovery, and targeted explorer confirmation recovery. Set `ALPH_LIVE_BROWSER=1` to also check the public WebSocket and mempool endpoints and save screenshots to `artifacts/browser/`.

For interactive checks in an existing Chrome browser, serve the repo locally and open `tests/browser-harness.html`. Its station/metro views use controlled WebSocket payloads, with buttons for pending transactions, successful/failed execution, disconnect, and recovery. The production views never load this fixture.

## Train wraps (community art & sponsors)

About 1 in 5 trains is painted with a design from `wraps/`. Clicking a wrapped train credits the artist ("🎨 Art by …"), or "📢 Sponsored by …" for ads, with an optional https link on the card (never on the image itself). `special` wraps only run on milestone blocks.

To add one: start from `wraps/template.png` (104 × 60 px; the red box at x 42–61, y 8–55 is the door, which is hidden while it's open, so keep text and key details outside it), put a **104 × 60 px PNG** per car side in `wraps/` (2–6 panels for a design that spans the train) and add an entry to `wraps/wraps.js` (id, type `art`/`ad`/`special`, panels, credit, optional link, weight, active dates). Images live in the repo and every wrap is reviewed by hand before it goes live.
