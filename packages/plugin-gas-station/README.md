# @elizaos/plugin-gas-station

> Solve the **cold-start gas problem** for AI agents: swap USDC for native gas (POL/ETH) in one action.

[![npm](https://img.shields.io/npm/v/@elizaos/plugin-gas-station)](https://npmjs.com/package/@elizaos/plugin-gas-station)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## The Problem

An AI agent (or new wallet) wants to interact with Polygon but has **zero native gas**.  
It has USDC (from a bridge, API payment, or transfer) — but can't spend it because every transaction requires POL.

Existing solutions fail:
| Solution | Problem |
|---|---|
| Relay.link | No guaranteed execution |
| Gelato Relay | $70/month + ERC-4337 overhead |
| Public faucets | Rate-limited, unreliable |

**GasStation** fills this gap: a trustless Solidity contract that accepts USDC and returns native gas atomically.

---

## Solution

This plugin adds a **`BUY_GAS`** action to your ElizaOS agent. The agent can now say:

> *"Swapping 2 USDC for gas on Polygon..."* → calls `buyGas()` on-chain → receives POL.

The underlying contract ([GasStation.sol](https://github.com/pino12033/gas-station-sol)):
- Accepts USDC (ERC-20)
- Returns native POL/ETH at a configurable rate
- Charges a small fee (default 3%) to the contract operator
- Supports gasless EIP-2612 Permit flow

---

## Installation

```bash
bun add @elizaos/plugin-gas-station
# or
npm install @elizaos/plugin-gas-station
```

---

## Quick Start

```ts
import { AgentRuntime } from "@elizaos/core";
import { gasStationPlugin } from "@elizaos/plugin-gas-station";

const runtime = new AgentRuntime({
  plugins: [gasStationPlugin],
  // ... other config
});

await runtime.initialize();
```

---

## Configuration

Set these in your agent's `.env` or character settings:

| Variable | Description | Default |
|---|---|---|
| `GAS_STATION_ADDRESS` | Deployed contract address (Polygon) | *(empty → mock mode)* |
| `GAS_STATION_PRIVATE_KEY` | Agent wallet private key (`0x...`) | *(empty → mock mode)* |
| `GAS_STATION_RPC_URL` | Polygon JSON-RPC endpoint | `https://polygon-rpc.com` |
| `GAS_STATION_USDC` | USDC token address on Polygon | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` |
| `GAS_STATION_MOCK` | Force mock mode (`"true"`) | auto when no address set |

### Mock Mode (default)

When `GAS_STATION_ADDRESS` is not set, the plugin runs in **mock mode** — it simulates the swap and returns an informative response. Useful for development and testing without a deployed contract.

### Live Mode

1. Deploy [GasStation.sol](https://github.com/pino12033/gas-station-sol) on Polygon
2. Fund the contract with POL (recommended: $25–50 worth)
3. Set `GAS_STATION_ADDRESS` and `GAS_STATION_PRIVATE_KEY`

---

## Usage

The agent triggers `BUY_GAS` automatically when the user asks things like:

- `"buy gas for 2 USDC"`
- `"I need gas, use 5 USDC"`
- `"swap USDC for POL"`
- `"get me native tokens with 1 USDC"`

### Programmatic

```ts
// The LLM extracts parameters automatically from natural language.
// You can also trigger it via processActions():
await runtime.processActions(message, [
  {
    name: "BUY_GAS",
    parameters: { amount_usdc: 2, recipient: "0xYourAddress" },
  },
]);
```

---

## Action: `BUY_GAS`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `amount_usdc` | `number` | ✅ | USDC to spend (0.01–50) |
| `recipient` | `string` (address) | ❌ | Who receives gas (default: agent wallet) |

**Response (mock mode):**
```
🔧 GasStation (Mock Mode)

Simulated swap: 2 USDC → 19.4000 POL
Fee: 0.0600 USDC (3%)

⚠️ MOCK MODE — contract not deployed yet...
```

**Response (live mode):**
```
✅ Gas purchased successfully!

- Spent: 2 USDC
- Received: 19.4 POL
- Recipient: 0xAbCd...
- Tx: 0x1234...
- View on PolygonScan
```

---

## HTTP Route

The plugin also exposes a status endpoint (when the agent has HTTP routes enabled):

```
GET /gas-station/status
```

```json
{
  "mode": "live",
  "contractAddress": "0x...",
  "liquidityPol": "542.0",
  "polygonScan": "https://polygonscan.com/address/0x..."
}
```

---

## Contract

Source: [pino12033/gas-station-sol](https://github.com/pino12033/gas-station-sol)

```
User/Agent → approve(USDC, amount) → buyGas(amount, recipient) → receives POL
```

**Gasless flow** (EIP-2612 — no gas required from user):
```
User signs permit off-chain → Relayer calls buyGasWithPermit() → User receives POL
```

---

## Economics (Polygon, March 2026)

| Funding | POL | Available tx (1 USDC each) |
|---|---|---|
| $10 | ~108 POL | ~10 transactions |
| $25 | ~271 POL | ~27 transactions |
| $50 | ~542 POL | ~54 transactions |

Revenue: 3% fee on all USDC purchases. At 100 tx/month × 2 USDC = **$6/month**.  
At ElizaOS scale: potentially **$100–1,000/month** in operator fees.

---

## Development

```bash
# Install dependencies
bun install

# Build
bun run build

# Type check
bun run typecheck

# Test
bun run test
```

---

## Roadmap

- [x] `BUY_GAS` action with mock + live modes
- [x] `/status` HTTP route
- [ ] Live deployment on Polygon mainnet
- [ ] `GET_QUOTE` action (read-only price check)
- [ ] AgentKit (Coinbase CDP) companion action
- [ ] Multi-chain support (Base, Arbitrum, Optimism)
- [ ] Automatic rate refresh via oracle

---

## License

MIT — see [LICENSE](../../LICENSE)

---

## Related

- [GasStation.sol](https://github.com/pino12033/gas-station-sol) — the underlying smart contract
- [Nosana × ElizaOS Bounty](https://nosana.io) — $3,000 bounty for AI agent × blockchain integrations
