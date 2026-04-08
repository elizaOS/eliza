# ElizaOK

ElizaOK is an ElizaOS-native BNB Chain operator for early memecoin discovery, risk-gated buy execution, treasury tracking, distribution planning, and Goo-enhanced portfolio operations.

This app is built inside the `eliza` monorepo and is designed for:

- hackathon demos with a live product-style dashboard
- open-source users who want to run the stack locally
- operators who want to deploy the app on a VPS with `pm2`

## What It Does

- scans BNB Chain memecoin opportunities on a schedule
- scores candidates and produces operator memos
- supports Four.meme execution with dry-run and live-buy modes
- tracks portfolio, treasury, execution, and distribution state in one dashboard
- supports Privy-based user sign-in with Google, X, and email OTP
- integrates **ElizaCloud** for dashboard identity, models, and credits (SIWE, CLI login, or hosted app auth)
- includes Goo and distribution lanes for broader treasury workflows

## Current Scope

### Ready now

- discovery, scoring, memo generation, watchlist, and history
- dashboard UI for portfolio, execution, distribution, and Goo visibility
- Four.meme buy lane with budget and guardrail controls
- Privy sign-in flow in the dashboard
- VPS deployment through `pm2`

### Still operator-managed

- live treasury wallets and private keys
- production Moltbook posting reliability
- Goo live CTO automation
- full sell automation
- production monitoring / alerts / backups

## Repository Layout

This app lives at:

```text
apps/elizaokbsc
```

Important files:

- `apps/elizaokbsc/src/index.ts`: app entrypoint
- `apps/elizaokbsc/src/memecoin/server.ts`: dashboard server and UI
- `apps/elizaokbsc/src/memecoin/elizacloud-api.ts`: ElizaCloud v1 client (auth headers, credits parsers, 429 retry)
- `apps/elizaokbsc/docs/elizacloud-integration.md`: **why** the Cloud client works the way it does (URLs, headers, merges)
- `apps/elizaokbsc/.env.example`: public environment template
- `apps/elizaokbsc/ecosystem.config.cjs`: `pm2` production entry
- `apps/elizaokbsc/RUNBOOK_RELEASE_VPS.md`: release checklist and VPS notes
- `apps/elizaokbsc/CHANGELOG.md`: app-level notable changes
- `apps/elizaokbsc/ROADMAP.md`: planned integration and product follow-ups

## Prerequisites

- Node.js 23+
- `bun`
- a model API key such as `OPENAI_API_KEY`
- optional: BNB wallet + private key for live execution
- optional: Privy app for website sign-in

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/elizaOS/eliza.git
cd eliza
bun install
```

Use your fork URL if you are not working from the upstream elizaOS repo.

### 2. Prepare env

```bash
cp apps/elizaokbsc/.env.example apps/elizaokbsc/.env
```

Edit:

```bash
nano apps/elizaokbsc/.env
```

Minimum local setup:

```env
OPENAI_API_KEY=your_key_here
ELIZAOK_BSC_RPC_URL=https://bsc-dataseed.binance.org/
ELIZAOK_DASHBOARD_PORT=4048
```

### 3. Start the app

From the monorepo root:

```bash
bun run apps/elizaokbsc/src/index.ts
```

Or use the package script:

```bash
cd apps/elizaokbsc
bun run start
```

### 4. Open the dashboard

```text
http://localhost:4048
```

If you changed `ELIZAOK_DASHBOARD_PORT`, use that port instead.

## Recommended Local Modes

### Safe demo mode

Use this when you want discovery and dashboard visibility without sending live trades:

```env
ELIZAOK_EXECUTION_ENABLED=true
ELIZAOK_EXECUTION_DRY_RUN=true
ELIZAOK_EXECUTION_MODE=live_buy_only
ELIZAOK_DISTRIBUTION_ENABLED=false
ELIZAOK_GOO_SCAN_ENABLED=false
```

### Live buy mode

Only enable after wallet review and tiny-size testing:

```env
ELIZAOK_EXECUTION_ENABLED=true
ELIZAOK_EXECUTION_DRY_RUN=false
ELIZAOK_EXECUTION_MODE=live_buy_only
ELIZAOK_EXECUTION_LIVE_CONFIRM=I_UNDERSTAND_ELIZAOK_LIVE
```

## Environment Overview

### Core app

- `OPENAI_API_KEY`
- `PGLITE_DATA_DIR`
- `ELIZAOK_BSC_RPC_URL`
- `ELIZAOK_DASHBOARD_PORT`

### Privy

- `ELIZAOK_PRIVY_APP_ID`
- `ELIZAOK_PRIVY_CLIENT_ID`
- `ELIZAOK_PRIVY_URL`

### Discovery

- `ELIZAOK_DISCOVERY_ENABLED`
- `ELIZAOK_DISCOVERY_INTERVAL_MS`
- `ELIZAOK_DISCOVERY_MAX_CANDIDATES`
- `ELIZAOK_MEMO_TOP_COUNT`

### Execution

- `ELIZAOK_EXECUTION_ENABLED`
- `ELIZAOK_EXECUTION_DRY_RUN`
- `ELIZAOK_EXECUTION_MODE`
- `ELIZAOK_EXECUTION_WALLET_ADDRESS`
- `ELIZAOK_EXECUTION_PRIVATE_KEY`
- `ELIZAOK_FOURMEME_CLI_COMMAND`
- `ELIZAOK_FOURMEME_BUY_TEMPLATE`
- `ELIZAOK_MAX_BUY_BNB`
- `ELIZAOK_MAX_DAILY_DEPLOY_BNB`

### Distribution

- `ELIZAOK_DISTRIBUTION_ENABLED`
- `ELIZAOK_DISTRIBUTION_SNAPSHOT_PATH`
- `ELIZAOK_DISTRIBUTION_EXECUTION_ENABLED`
- `ELIZAOK_DISTRIBUTION_WALLET_ADDRESS`
- `ELIZAOK_DISTRIBUTION_PRIVATE_KEY`

### Goo

- `ELIZAOK_GOO_SCAN_ENABLED`
- `ELIZAOK_GOO_RPC_URL`
- `ELIZAOK_GOO_REGISTRY_ADDRESS`

### Moltbook

- `MOLTBOOK_API_KEY`
- `MOLTBOOK_AGENT_NAME`
- `MOLTBOOK_AUTO_REGISTER`
- `MOLTBOOK_AUTO_ENGAGE`

### ElizaCloud (dashboard identity and credits)

**Why two variables:** ElizaCloud often splits **marketing / SIWE / CLI** entrypoints from the **`/api/v1/*` API host**. ElizaOK calls SIWE on `ELIZAOK_ELIZA_CLOUD_URL` but loads models, user, and credits from `ELIZAOK_ELIZA_CLOUD_API_URL`. They must refer to the **same logical environment** (e.g. both prod or both staging), or API keys and JWTs will not validate.

| Variable | Role |
|----------|------|
| `ELIZAOK_ELIZA_CLOUD_URL` | SIWE nonce/verify, CLI session, hosted login links |
| `ELIZAOK_ELIZA_CLOUD_API_URL` | `/api/v1/models`, `/api/v1/user`, `/api/v1/credits/*` |
| `ELIZAOK_ELIZA_CLOUD_APP_ID` | Hosted app auth |
| `ELIZAOK_ELIZA_CLOUD_AUTHORIZE_URL` / `LOGIN_URL` / `CALLBACK_URL` | Optional overrides |

**Why you might see “credits syncing”:** Credits endpoints can return **403** if the Cloud account has no organization, while `/api/v1/user` may still return **200**. See comments in `.env.example` and [docs/elizacloud-integration.md](docs/elizacloud-integration.md).

**Tests for the Cloud client:**

```bash
cd apps/elizaokbsc && bun test
```

## Security Notes

- never commit your real `.env`
- keep `ELIZAOK_EXECUTION_PRIVATE_KEY` and distribution wallet keys only on trusted machines or your VPS
- keep `ELIZAOK_EXECUTION_DRY_RUN=true` until you have verified routing, balance, and risk limits
- use very small BNB size first when testing live mode

## VPS Deployment

### 1. Copy env

```bash
cp apps/elizaokbsc/.env.example apps/elizaokbsc/.env
nano apps/elizaokbsc/.env
```

### 2. Start with `pm2`

```bash
cd /root/eliza
pm2 start apps/elizaokbsc/ecosystem.config.cjs --only elizaokbsc
pm2 save
```

### 3. Update after new pushes

```bash
cd /root/eliza
git pull origin develop
pm2 restart elizaokbsc --update-env
pm2 save
```

### 4. Quick health checks

```bash
curl http://127.0.0.1:4048/health
curl http://127.0.0.1:4048/api/elizaok/execution
curl http://127.0.0.1:4048/api/elizaok/distribution
curl http://127.0.0.1:4048/api/elizaok/goo
```

## Open Source Usage Notes

If you are forking this repository:

- start with `.env.example`
- run in dry-run mode first
- leave execution and distribution keys blank until you are ready
- configure your own Privy app if you want dashboard sign-in
- review `RUNBOOK_RELEASE_VPS.md` before production deployment

## Related Docs

- `apps/elizaokbsc/docs/elizacloud-integration.md` — ElizaCloud auth, URLs, and session merge rationale
- `apps/elizaokbsc/CHANGELOG.md` — app-level changes
- `apps/elizaokbsc/ROADMAP.md` — planned improvements
- `apps/elizaokbsc/RUNBOOK_RELEASE_VPS.md`
- `apps/elizaokbsc/.env.example`

## License

This app is part of the broader `eliza` repository and follows the repository license.
