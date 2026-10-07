# ℵ Central Station

Alephium, live, as a pixel-art train station. Open `index.html` (station) or `map.html` (neon metro map). No build step; host anywhere static.

- 4 platforms = Alephium's 4 groups; a train's destination = the block's `chainTo` (16 routes)
- Every block is a train; every transaction is a passenger who boards it
- Live passengers are real transactions: they appear from the mempool, and the exact ones in a block board that train. Click one to see its tx and open it in the explorer
- 🐋 Whales (≥10,000 ALPH sent), token carriers (green bag), contract callers (juggling gears), ⛏ a miner in the cab of every train (the block's coinbase/mining-reward tx; click a train to see the reward), miner-only expresses for blocks with no user txs, gold rush-hour trains for 25+ txs
- Live ALPH price (CoinGecko, polled every 60s) with 24h change; dollar values on passengers, trains, whales, search results and the moved/min stat
- Search box: paste a tx hash or address (≥4 chars) and your passenger gets a green arrow
- Announcements ticker, optional chimes (🔇/🔊), pigeons, braking sparks, rain, shooting stars, sky follows your local time of day

## Data

Public explorer API `https://backend.mainnet.alephium.org`:
- `GET /blocks?page=1&limit=40` every 4s (main-chain blocks only)
- `GET /blocks/{hash}/transactions` for each new block with transactions
- `GET /mempool/transactions?page=1&limit=100` every 3s

If the API can't be reached it falls back to a simulated demo (~2 blocks/s, like post-Danube mainnet). Force it with `?demo`.
