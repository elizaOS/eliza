# ElizaOK Release Runbook

## Current Status

### Done

- ElizaOS-native `elizaOK_BSC` app boot and dashboard server
- BNB memecoin discovery, scoring, memo generation, history, watchlist, and portfolio views
- Live buy execution lane with Four.meme/Pancake preflight, dry-run/live modes, and trade ledger
- Wallet-backed portfolio reconciliation and treasury lifecycle overlays
- KOL gate with public smart-money collector fallback
- Goo operator lane connected into execution budgeting through `gooLane`
- Distribution holder snapshot, recipient manifest, publication artifact, sender ledger, pending queue, and manual run trigger
- Distribution asset auto-selection from qualified live treasury positions

### Not Done

- Goo live CTO execution is still not automated; Goo currently affects treasury priority and budget only
- Sell strategy remains deferred by product choice
- Moltbook posting is not reliable enough to treat as production-critical because the remote API has been unstable
- On-chain multisig / role separation for treasury and airdrop wallets is not implemented inside this app
- Production-grade alerting, external monitoring, and backup rotation are not set up yet

## Release Modes

### Safe Demo Mode

- `ELIZAOK_EXECUTION_ENABLED=true`
- `ELIZAOK_EXECUTION_DRY_RUN=true`
- `ELIZAOK_EXECUTION_MODE=live_buy_only`
- `ELIZAOK_DISTRIBUTION_ENABLED=true`
- `ELIZAOK_DISTRIBUTION_EXECUTION_ENABLED=true`
- `ELIZAOK_DISTRIBUTION_EXECUTION_DRY_RUN=true`

Use this for VPS validation, dashboard demos, and checking candidate quality without sending live trades or airdrops.

### Live Buy Mode

- `ELIZAOK_EXECUTION_ENABLED=true`
- `ELIZAOK_EXECUTION_DRY_RUN=false`
- `ELIZAOK_EXECUTION_MODE=live_buy_only`
- `ELIZAOK_EXECUTION_LIVE_CONFIRM=I_UNDERSTAND_ELIZAOK_LIVE`

### Live Distribution Mode

- `ELIZAOK_DISTRIBUTION_ENABLED=true`
- `ELIZAOK_DISTRIBUTION_EXECUTION_ENABLED=true`
- `ELIZAOK_DISTRIBUTION_EXECUTION_DRY_RUN=false`
- `ELIZAOK_DISTRIBUTION_LIVE_CONFIRM=I_UNDERSTAND_ELIZAOK_AIRDROP_LIVE`

## Required Env

### Core

- `OPENAI_API_KEY`
- `PGLITE_DATA_DIR=.elizadb/elizaokbsc`
- `ELIZAOK_BSC_RPC_URL`
- `ELIZAOK_DASHBOARD_PORT`

### Live Trading

- `ELIZAOK_EXECUTION_WALLET_ADDRESS`
- `ELIZAOK_EXECUTION_PRIVATE_KEY`
- `ELIZAOK_MAX_BUY_BNB`
- `ELIZAOK_MAX_DAILY_DEPLOY_BNB`
- `ELIZAOK_MAX_SLIPPAGE_BPS`

### Goo

- `ELIZAOK_GOO_SCAN_ENABLED=true`
- `ELIZAOK_GOO_RPC_URL`
- `ELIZAOK_GOO_REGISTRY_ADDRESS`

### Distribution

- `ELIZAOK_DISTRIBUTION_SNAPSHOT_PATH`
- `ELIZAOK_DISTRIBUTION_TOKEN_ADDRESS` if using on-chain holder snapshot
- `ELIZAOK_DISTRIBUTION_START_BLOCK` if using on-chain holder snapshot
- `ELIZAOK_DISTRIBUTION_WALLET_ADDRESS`
- `ELIZAOK_DISTRIBUTION_PRIVATE_KEY`

### Optional Manual Override

- `ELIZAOK_DISTRIBUTION_ASSET_TOKEN_ADDRESS`
- `ELIZAOK_DISTRIBUTION_ASSET_TOTAL_AMOUNT`

If these two are empty and auto-selection is enabled, the app will choose a qualified live treasury position automatically.

## Recommended Distribution Policy

- `ELIZAOK_DISTRIBUTION_EXECUTION_AUTO_SELECT_ASSET=true`
- `ELIZAOK_DISTRIBUTION_REQUIRE_VERIFIED_WALLET=true`
- `ELIZAOK_DISTRIBUTION_REQUIRE_POSITIVE_PNL=true`
- `ELIZAOK_DISTRIBUTION_REQUIRE_TAKE_PROFIT_HIT=false`
- `ELIZAOK_DISTRIBUTION_MIN_WALLET_QUOTE_USD=10`
- `ELIZAOK_DISTRIBUTION_MIN_PORTFOLIO_SHARE_PCT=5`

## VPS Start Flow

### 1. Install Dependencies

```bash
cd /root/eliza
bun install
bun run build:core
```

### 2. Prepare Env

```bash
cp apps/elizaokbsc/.env.example apps/elizaokbsc/.env
nano apps/elizaokbsc/.env
```

### 3. Typecheck Before Launch

```bash
cd /root/eliza/apps/elizaokbsc
bunx tsc --noEmit
```

### 4. Start With PM2

```bash
cd /root/eliza
pm2 start apps/elizaokbsc/ecosystem.config.cjs
pm2 save
```

### 5. Validate

```bash
curl http://127.0.0.1:4048/health
curl http://127.0.0.1:4048/api/elizaok/execution
curl http://127.0.0.1:4048/api/elizaok/distribution
curl http://127.0.0.1:4048/api/elizaok/goo
```

## Manual Operations

### Trigger One Distribution Run Now

```bash
curl -X POST http://127.0.0.1:4048/api/elizaok/distribution/run
```

### Check Distribution Sender State

```bash
curl http://127.0.0.1:4048/api/elizaok/distribution/execution
curl http://127.0.0.1:4048/api/elizaok/distribution/ledger
curl http://127.0.0.1:4048/api/elizaok/distribution/pending
```

## Launch Decision

### Ready To Deploy Now

- Discovery dashboard
- Dry-run execution
- Goo budgeting lane
- Dry-run distribution sender
- Manual distribution runs

### Only Deploy Live After Final Env Review

- Live buy execution
- Live ERC20 airdrop sending

The correct rollout order is:

1. Bring VPS up in dry-run mode.
2. Verify dashboard, execution, Goo, and distribution APIs.
3. Enable live buy mode first.
4. Verify wallet-backed positions and distribution asset auto-selection.
5. Enable live distribution mode last.
