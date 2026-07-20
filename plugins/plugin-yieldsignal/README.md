# @elizaos/plugin-yieldsignal

Real-time, risk-weighted USDC/WETH lending APY signal across Aave, Compound, Morpho, Moonwell, Euler and Fluid on Base — paid per call ($0.01 USDC) via the [x402](https://x402.org) protocol through [YieldSignal](https://yieldsignal.vercel.app).

## Purpose / role

Adds a single buyer-side action, `GET_YIELD_SIGNAL`, that lets an elizaOS agent proactively call and pay for an external x402-protected API. This is distinct from `@elizaos/plugin-x402` (seller-side middleware for protecting this agent's *own* HTTP routes) — there's currently no overlap, since that package registers no actions/providers/services of its own.

Every response from YieldSignal is signed (EIP-712 typed data) by the payment-receiving address, which also holds an on-chain [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) agent identity ([`/agent-card.json`](https://yieldsignal.vercel.app/agent-card.json)) and periodically publishes [EAS](https://base.easscan.org) attestations of past readings on Base mainnet ([`/track-record`](https://yieldsignal.vercel.app/track-record)).

## Plugin surface

| Kind | Name | What it does |
|------|------|--------------|
| Action | `GET_YIELD_SIGNAL` | Fetches the current best lending protocol and risk-weighted APY (bps) for USDC or WETH on Base. Parses `USDC`/`WETH` from the triggering message text (defaults to USDC). |

## Layout

```
src/
  index.ts                     Plugin entry; exports yieldSignalPlugin
  client.ts                    x402 payment + fetch (CdpX402Client + @x402/fetch)
  actions/
    get-yield-signal.ts        GET_YIELD_SIGNAL action handler
  get-yield-signal.test.ts     Unit tests (no network — validates registration/shape)
```

## Config / env vars

| Env var | Required | Purpose |
|---------|----------|---------|
| `CDP_API_KEY_ID` | Required | Coinbase CDP API key ID — provisions the plugin's own payment wallet |
| `CDP_API_KEY_SECRET` | Required | Coinbase CDP API key secret |
| `CDP_WALLET_SECRET` | Required | Coinbase CDP wallet secret |

The plugin's wallet needs a small amount of USDC on Base ($0.01 per call).

## Usage

```typescript
import { yieldSignalPlugin } from "@elizaos/plugin-yieldsignal";

const character = {
  // ...
  plugins: [yieldSignalPlugin],
};
```

## Why a dedicated wallet instead of the agent's own signer?

x402 payment signing (`@x402/fetch` + `@coinbase/cdp-sdk/x402`) is independent of whatever wallet/signing setup the agent otherwise uses — this plugin pays for the call the same way it's already proven against production (see [`scripts/testPaidCall.mts`](https://github.com/Stakemate369/yieldsignal/blob/main/scripts/testPaidCall.mts) in the service's own repo), rather than adapting a second signing path into the agent's primary wallet integration.
