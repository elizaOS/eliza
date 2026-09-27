# plugin-automaton-token-safety

Token-safety intelligence for **ElizaOS** agents on **Base**, paid per call with **x402** in USDC.
The agent signs one EIP-3009 `TransferWithAuthorization` per paid call; the CDP facilitator settles
it and **sponsors the gas** — the agent needs a few cents of USDC and **no ETH**.

| Action | Route | Price | Input |
|---|---|---|---|
| `AUTOMATON_SCAN` | `GET /v2/security/scan` | $0.001 | `{ address }` |
| `AUTOMATON_SENTINEL_LATEST` | `GET /v2/sentinel/latest` | $0.001 | `{ limit?, maxRisk?, minRisk?, dex?, since? }` |
| `AUTOMATON_APPROVAL_RISK` | `POST /v2/token/approval-risk` | $0.01 | `{ token, owner, spenders? }` |
| `AUTOMATON_SIMULATE` | `POST /v2/token/simulate` | $0.01 | `{ token, side: "buy"\|"sell", amount, wallet }` |
| `AUTOMATON_LIQUIDITY_RISK` | `POST /v2/token/liquidity-risk` | $0.01 | `{ token, pair? }` |

Every action validates its input with Zod before any network call. Prices are informational; the
402 challenge returned at call time is authoritative.

## Install

```bash
npm install plugin-automaton-token-safety zod ethers
```

```ts
import automatonPlugin from 'plugin-automaton-token-safety';

export const character = {
  name: 'SafetyAgent',
  plugins: [automatonPlugin],
};
```

## Configuration (agent `.env`)

| Setting | Default | Meaning |
|---|---|---|
| `AUTOMATON_SIGNER_KEY` | *(unset)* | Key used **only** to sign EIP-3009 authorizations. Unset = unpaid calls (free trial or a reported 402). |
| `AUTOMATON_MAX_UNITS` | `10000` | Per-call cap in USDC base units ($0.01). A larger challenge is refused before signing. |
| `AUTOMATON_API_BASE` | `https://api.automaton-sovereign.workers.dev` | API base URL. |
| `AUTOMATON_DRY_RUN` | *(unset)* | `1` = sign the authorization but do not send the paid request. |

Use a dedicated wallet holding only a small USDC balance on Base.

## Safety properties

- The only power exercised with the key is signing **one** `TransferWithAuthorization` per paid call,
  for at most `AUTOMATON_MAX_UNITS`, payable **only** to `0x71DEAc098914A009E3720524642A6bE6F65EE528`,
  on Base (`eip155:8453`), in native USDC.
- The plugin never builds, signs or broadcasts a transaction and never reads keys from disk.

## Passing input

Actions read their input from `options.params` or `message.content.params`:

```ts
await action.handler(runtime, { content: { params: { token: '0x…', side: 'buy', amount: '0.01', wallet: '0x…' } } } as any, undefined, {}, callback);
```

## Build

```bash
npm install      # dev dependencies: typescript, @elizaos/core, zod, ethers
npm run build    # tsc -> dist/
```

## Registry assets

`images/logo.jpg` (400×400, ≤500 KB) and `images/banner.jpg` (1280×640, ≤1 MB) are required by the
ElizaOS registry and must be supplied before publishing — see `images/README.md`.

## Also in this folder

`plugin.cjs` / `example.cjs` are the CommonJS variant used by the Automaton agent kit
(`services/distribution/`); the published package is built from `src/`.
