# Steward Deployment + Integration Plan

**Date:** 2026-04-10
**Goal:** Get steward from "code on develop" to "real users authenticating through real apps"

---

## Wave 1: Production Deploy (No new code, just ship what's built)

### Worker K — Migration + Deploy Script
**Branch:** `chore/deploy-prep`
**Depends on:** Nothing

**Tasks:**
1. **Create `scripts/migrate.sh`** — runs all migrations 0008-0012 against a target DATABASE_URL
   - Idempotent (all migrations use IF NOT EXISTS)
   - Dry-run mode (print SQL without executing)
   - Logs each migration applied
   - Works with Neon Postgres (requires `sslmode=require`)

2. **Create `scripts/deploy.sh`** — single-command deploy to a node
   - Args: `./deploy.sh <node-ip> [--migrate] [--restart]`
   - rsync source (excluding .git, node_modules, web, .turbo)
   - bun install on remote
   - Optionally run migrations
   - Restart steward + steward-proxy services
   - Health check after restart
   - Works for both `milady` (89.167.63.246) and core-1 through core-6

3. **Create `scripts/deploy-all.sh`** — deploy to all 7 nodes
   - Deploy to milady (primary) first, verify health
   - Then parallel deploy to core-1 through core-6
   - Summary at the end

4. **Update `.env.example`** with ALL env vars needed for auth:
   - REDIS_URL, RESEND_API_KEY, EMAIL_FROM
   - GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
   - DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET
   - TWITTER_CLIENT_ID, TWITTER_CLIENT_SECRET (from revlentless's PR)
   - PASSKEY_RP_NAME, PASSKEY_RP_ID, PASSKEY_ORIGIN
   - APP_URL

### Worker L — E2E Auth Test Script
**Branch:** `test/auth-e2e`
**Depends on:** Nothing (tests against a running instance)

**Tasks:**
1. **Create `scripts/e2e-auth-test.ts`** — validates auth endpoints on a live instance
   - Args: `STEWARD_URL=https://api.steward.fi bun run scripts/e2e-auth-test.ts`
   - Tests:
     - `GET /auth/providers` — returns expected shape
     - `POST /auth/email/send` — returns ok (or expected error without RESEND_API_KEY)
     - `POST /auth/passkey/register/options` — returns WebAuthn options
     - `GET /auth/oauth/google/authorize` — returns redirect URL (or 503 if not configured)
     - Token refresh flow
     - User tenant APIs (`GET /user/me/tenants`)
     - Cross-tenant join flow
   - Colored pass/fail output
   - Exit code 0 if all critical paths work

2. **Extend existing `scripts/e2e-integration-test.ts`** to include auth checks

---

## Wave 2: Credential Setup + First Real Deploy

### Worker M — OAuth + Email Credential Setup
**This is a manual/scripted task, not code**

**Tasks:**
1. **Google OAuth:**
   - Create project at console.cloud.google.com
   - Create OAuth 2.0 credentials (Web application)
   - Authorized redirect URI: `https://api.steward.fi/auth/oauth/google/callback`
   - Get CLIENT_ID + CLIENT_SECRET

2. **Discord OAuth:**
   - Create app at discord.com/developers/applications
   - Add OAuth2 redirect: `https://api.steward.fi/auth/oauth/discord/callback`
   - Get CLIENT_ID + CLIENT_SECRET

3. **Resend (email):**
   - Verify `send.steward.fi` domain (DNS already configured with SES records)
   - Get API key from resend.com
   - Test sending from `login@steward.fi`

4. **Update prod env on milady (89.167.63.246):**
   ```bash
   # Add to /opt/steward/.env:
   REDIS_URL=redis://localhost:6379
   RESEND_API_KEY=re_...
   EMAIL_FROM=login@steward.fi
   APP_URL=https://api.steward.fi
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   DISCORD_CLIENT_ID=...
   DISCORD_CLIENT_SECRET=...
   PASSKEY_RP_NAME=Steward
   PASSKEY_RP_ID=steward.fi
   PASSKEY_ORIGIN=https://steward.fi
   ```

5. **Run deploy script** to milady first (canary), verify, then all nodes

### Worker N — Fix Docker Workflow (GHCR)
**Branch:** `fix/docker-workflow`

**Tasks:**
1. Fix GHCR authentication in `.github/workflows/docker.yml`
   - May need to configure package permissions in repo settings
   - Or use a PAT instead of GITHUB_TOKEN
2. Verify image builds and pushes to `ghcr.io/steward-fi/steward`
3. Tag: `:develop` on branch push, `:vX.Y.Z` + `:latest` on version tags

---

## Wave 3: Dashboard + Self-Service

### Worker O — Dashboard Polish
**Branch:** `feat/dashboard-polish`
**Package:** `web/`

**Tasks:**
1. **Verify dashboard builds and runs** with current auth system
2. **Login page** — wire `<StewardLogin />` from `@stwd/react`
3. **Tenant management page** — create tenant, configure CORS, get API key
4. **Member management** — invite users, change roles
5. **Agent overview** — list agents, balances, recent transactions
6. Deploy to Vercel (steward.fi)

### Worker P — API Documentation Sync
**Branch:** `docs/api-reference`
**Package:** `docs/`

**Tasks:**
1. **Update Mintlify docs** at docs.steward.fi
2. Add auth endpoints to API reference
3. Add OAuth setup guide
4. Add cross-tenant identity docs
5. Add self-hosting guide
6. Push to docs repo / reconnect Mintlify

---

## Wave 4: Milady Integration (The Big One)

### Worker Q — Milady Auth Integration
**Repo:** `milady-ai/milady` (or `elizaOS/cloud`)
**Branch:** `feat/steward-auth`

**Tasks:**
1. Add `@stwd/react` to milady frontend
2. Wire `<StewardLogin />` into milady's login flow
3. Create steward tenant per milady organization
4. User wallet provisioning on login
5. Session management through steward JWTs
6. Replace/supplement existing elizacloud OAuth

### Worker R — Cloud Container Auth Injection
**Repo:** `elizaOS/cloud`
**Branch:** `feat/steward-container-auth`

**Tasks:**
1. Steward runs as sidecar in docker-compose (PR #437 started this)
2. Container provisioner creates steward agent + gets JWT
3. Agent containers receive STEWARD_* env vars
4. Agent SDK authenticates via steward JWT
5. All API calls go through steward proxy (credential injection)

---

## Dependency Graph

```
Wave 1 (parallel):
  Worker K (deploy scripts)  ──┐
  Worker L (auth e2e tests)  ──┤
                               ├──> Wave 2
Wave 2 (sequential):           │
  Worker M (credentials)     ──┤  (manual, needs Google/Discord/Resend accounts)
  Worker N (Docker fix)      ──┘  (independent)
                               │
                               ├──> Wave 3 (parallel)
Wave 3:                        │
  Worker O (dashboard)       ──┤
  Worker P (docs)            ──┤
                               │
                               ├──> Wave 4 (parallel)
Wave 4:                        │
  Worker Q (milady auth)     ──┘
  Worker R (cloud containers)
```

## Timeline Estimate

| Wave | Duration | Blocker |
|------|----------|---------|
| Wave 1 | 1 session | None, pure code |
| Wave 2 | 1 session | Need Google/Discord/Resend accounts |
| Wave 3 | 1-2 sessions | Wave 2 deployed |
| Wave 4 | 2-3 sessions | Waves 1-3 complete |

**Total: ~5-7 sessions to full production with milady integration**
