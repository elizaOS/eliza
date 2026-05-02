# Steward.fi — Sprint Plan (March 13-22, 2026)

## Current State
- Backend: API + vault + policy engine + DB + SDK + auth + webhooks (all functional)
- Frontend: Unified landing + dashboard deployed to Vercel at steward.fi
- Repo: 85 files, ~9,300 lines, 15 commits on develop

## Active Workers

### Worker 1: Demo Seed + CLI (`feat/demo-seed`)
- Create `packages/cli/` — lightweight CLI for managing Steward instances
- `steward seed` — seeds DB with demo tenants, agents, policies, transactions
- `steward status` — shows instance status
- Demo data: 2 tenants (eliza-cloud, waifu-fun), 4 agents each, realistic policies, mix of tx statuses
- This makes the dashboard come alive for demos

### Worker 2: API Hardening + Deploy Script (`feat/api-deploy`)
- Add health check endpoint (`GET /health`)
- Add CORS config for steward.fi origin
- Create `deploy/` directory with:
  - `docker-compose.yml` (api + postgres)
  - `Dockerfile` for the API
  - `.env.example` with all required vars
  - `deploy.sh` — script to set up on VPS (systemd service or docker)
- Wire up webhook dispatcher to API (currently separate package, needs integration)
- Add rate limiting middleware

### Worker 3: waifu.fun Integration Layer (`feat/waifu-integration`)
- Create `packages/integrations/waifu/` 
- Integration adapter: when a waifu.fun agent launches a token, auto-create Steward wallet
- Webhook handler: receives waifu.fun events (token_launched, trade_executed, fee_earned)
- Maps waifu.fun agent IDs to Steward agent IDs
- Default policies for waifu agents (spending limit per trade, approved DEX addresses)
- This is the demo story: "agent launches token → earns fees → pays hosting → all visible in dashboard"

### Worker 4: Cleanup + Polish (`feat/cleanup`)
- Delete `packages/dashboard/` (superseded by web/dashboard)
- Clean up monorepo: remove stale lockfiles, fix workspace references
- Add README.md to root with architecture diagram (ASCII), quick start, SDK examples
- Add LICENSE (MIT)
- Add .env.example to root
- Update package.json descriptions across all packages
- Ensure `bun install && bun run build` works clean from fresh clone

## After Workers Complete
1. Merge all branches into develop
2. Deploy API to VPS (using Worker 2's deploy script)
3. Run seed data (using Worker 1's CLI)
4. Verify dashboard shows real data from live API
5. Record demo flow (optional)

## Stretch Goals (if time)
- ERC-8004 identity contracts on Base (stub + deploy script)
- Multi-chain support (Base Sepolia for testnet demo)
- API docs page at steward.fi/docs (auto-generated from Hono routes)
- GitHub Actions CI (lint + build + test)
