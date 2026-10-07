# ℵ Central Station / ℵ Metro

Alephium, live, drawn as a metro map. Open `index.html` (station view) or `map.html` (neon metro map) in a browser; no build step.

- 4 districts = Alephium's 4 groups; 16 lines = its 16 chains (4 loop lines, 12 express lines through the central ℵ station)
- Every block is a train leaving on its chain's line; every transaction is a passenger
- Empty blocks are ghost trains 👻
- Live data comes from the public explorer API (`backend.mainnet.alephium.org`): `/blocks` for trains, `/unconfirmed-transactions` for waiting passengers
- If the API can't be reached, it switches to a simulated demo (~2 blocks/s, like post-Danube mainnet). Force it with `?demo`
