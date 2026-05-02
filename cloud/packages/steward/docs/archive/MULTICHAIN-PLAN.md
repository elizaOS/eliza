# Steward.fi — Multi-Chain + Real Use Cases Plan
**Created:** 2026-03-14 03:40 MDT

---

## Chains to Support

| Chain | ID | Symbol | Use Case | RPC |
|-------|----|--------|----------|-----|
| BSC | 56 | BNB | Primary — waifu.fun agents, token launches | bsc-dataseed.binance.org |
| Polygon | 137 | POL | Polymarket prediction markets | polygon-rpc.com |
| Ethereum | 1 | ETH | High-value DeFi, ENS | eth.llamarpc.com |
| Base | 8453 | ETH | Aerodrome DEX, on-chain identity | mainnet.base.org |
| Arbitrum | 42161 | ETH | Hyperliquid perps | arb1.arbitrum.io/rpc |
| Solana | — | SOL | Future (non-EVM, separate adapter) |

**Note:** Solana is non-EVM. Stub it in types/constants but don't implement signing yet. Mention in submission as roadmap.

---

## Agent Personas (replace all seed data)

### 1. `treasury-ops` — Platform Treasury Manager
- **Role:** Manages waifu.fun platform treasury on BSC
- **Chain:** BSC (56)
- **Policies:**
  - spending-limit: 2 BNB/tx, 10 BNB/day
  - approved-addresses: PancakeSwap router, team multisig, Eliza Cloud payment address
  - auto-approve: under 0.5 BNB
  - rate-limit: 20 tx/day
- **Tx history:** Mix of approved payroll transfers, rejected unknown address, queued large withdrawal

### 2. `dex-trader` — AMM Trading Agent
- **Role:** Swaps tokens on PancakeSwap (BSC) and Aerodrome (Base)
- **Chains:** BSC (56), Base (8453)
- **Policies:**
  - spending-limit: 1 BNB/tx, 5 BNB/day
  - approved-addresses: PancakeSwap V3 router, Aerodrome router
  - auto-approve: under 0.2 BNB
  - time-window: trading hours UTC 6:00-22:00, Mon-Fri
  - rate-limit: 50 tx/day
- **Tx history:** Auto-approved small swaps, rejected off-hours trade, queued large swap

### 3. `prediction-agent` — Polymarket Trader
- **Role:** Places bets on prediction markets via Polygon
- **Chain:** Polygon (137)
- **Policies:**
  - spending-limit: 100 USDC/tx (in wei equivalent), 500 USDC/day
  - approved-addresses: Polymarket CTF Exchange, USDC contract
  - auto-approve: under 20 USDC
  - rate-limit: 30 tx/day
- **Tx history:** Auto-approved small bets, human-approved large position, rejected unapproved market

### 4. `perp-trader` — Hyperliquid Perpetuals Agent
- **Role:** Trades perpetual futures on Arbitrum
- **Chain:** Arbitrum (42161)
- **Policies:**
  - spending-limit: 0.5 ETH/tx, 2 ETH/day
  - approved-addresses: Hyperliquid bridge contract
  - auto-approve: under 0.05 ETH (tight — perps are risky)
  - rate-limit: 100 tx/day (high-frequency)
- **Tx history:** Many auto-approved small trades, several queued large positions, one rejected (exceeded daily limit)

### 5. `hosting-payer` — Cloud Hosting Payment Agent
- **Role:** Pays eliza-cloud/Eliza Cloud compute bills from agent revenue
- **Chain:** BSC (56)
- **Policies:**
  - spending-limit: 0.5 BNB/tx, 2 BNB/month
  - approved-addresses: Eliza Cloud payment address ONLY
  - auto-approve: under 0.1 BNB
  - rate-limit: 5 tx/day
- **Tx history:** Regular auto-approved hosting payments, one rejected (wrong address), one queued (large bill)

---

## Real Contract Addresses (for seed data realism)

### BSC (56)
- PancakeSwap V3 Router: `0x13f4EA83D0bd40E75C8222255bc855a974568Dd4`
- WBNB: `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c`
- BUSD: `0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56`

### Base (8453)
- Aerodrome Router: `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43`
- WETH: `0x4200000000000000000000000000000000000006`

### Polygon (137)
- Polymarket CTF Exchange: `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`
- USDC: `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`

### Arbitrum (42161)
- Hyperliquid Bridge: `0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7`
- WETH: `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`

### Ethereum (1)
- Uniswap V3 Router: `0xE592427A0AEce92De3Edee1F18E0157C05861564`
- WETH: `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`

---

## Workers

### Worker A: Multi-Chain Vault + Shared Types
- Add Polygon (137), Arbitrum (42161), Ethereum (1) to vault CHAINS map
- Add default RPCs for each
- Update SUPPORTED_CHAINS in shared types
- Add chain metadata helper (name, symbol, explorer URL, explorer tx URL)
- Dashboard should display chain name + explorer links per chain

### Worker B: New Seed Script
- Completely rewrite seed with the 5 agent personas above
- Real contract addresses in approved-addresses policies
- Realistic tx histories with proper timestamps (spread over last 7 days)
- Real-looking tx hashes (but mark as seed data — don't claim they're on-chain)
- Pending approvals that tell a story (large trade awaiting review, etc.)
- Generate real encrypted keypairs for each agent

### Worker C: Dashboard Chain Support
- Chain name/icon display on transactions and approvals pages
- Explorer links per chain (basescan, bscscan, polygonscan, arbiscan, etherscan)
- Chain badge/pill on agent detail page
- Update settings page code snippets
- Any UI adjustments for multi-chain context

### Worker D: Deploy + Seed Prod
- After A, B, C commit: pull, build, deploy API to eliza VPS
- Run new seed script against prod postgres
- Deploy web to Vercel
- Full E2E verification
