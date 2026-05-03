# Steward on Railway — Deployment Guide

> Deploy Steward as Eliza Cloud's self-hosted auth + wallet service on Railway.

---

## Prerequisites

- [Railway account](https://railway.app) + CLI installed (`npm i -g @railway/cli`)
- A Neon Postgres connection string **or** use Railway's managed Postgres add-on
- Secrets ready to generate (master password, JWT secret, platform keys)
- (Optional) [Resend](https://resend.com) API key for magic-link emails
- (Optional) Google / Discord OAuth credentials

---

## 1. Initialize the Project

```bash
cd /path/to/steward-fi

# Login to Railway
railway login

# Create a new Railway project
railway init
# → Select "Empty Project" when prompted
# → Name it something like "steward" or "eliza-auth"
```

### Connect GitHub for auto-deploy (recommended)

```bash
# Link to your GitHub repo
railway link
```

Or do it in the Railway dashboard: **Project → Settings → Connect Repo → select steward-fi**.

Set the deploy branch (e.g. `develop` or `main`) under **Settings → Deploy → Branch**.

---

## 2. Add Services

### Option A: Railway Managed Postgres + Redis (easiest)

In the Railway dashboard:

1. Click **+ New** → **Database** → **PostgreSQL**
2. Click **+ New** → **Database** → **Redis**

Railway auto-provisions `DATABASE_URL` and `REDIS_URL` as shared variables. Reference them in your service env vars with `${{Postgres.DATABASE_URL}}` and `${{Redis.REDIS_URL}}`.

### Option B: External Neon Postgres + Railway Redis

If using Neon:

1. Create a `steward` database in your Neon project (or use the default `neondb`)
2. Grab the connection string: `postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/steward?sslmode=require`
3. Add Railway Redis as above for rate limiting

---

## 3. Set Environment Variables

In the Railway dashboard, go to your **steward-api** service → **Variables** tab.

Add all of these:

```bash
# ─── Server ───────────────────────────────────────────────────────────────────
PORT=3200
NODE_ENV=production
STEWARD_BIND_HOST=0.0.0.0

# ─── Database ─────────────────────────────────────────────────────────────────
# If using Railway Postgres:
DATABASE_URL=${{Postgres.DATABASE_URL}}
# If using third-party Neon:
# DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/steward?sslmode=require

# ─── Security (generate these — do NOT reuse across environments) ─────────────
# Generate each with: openssl rand -hex 32
STEWARD_MASTER_PASSWORD=<openssl rand -hex 32>
STEWARD_SESSION_SECRET=<openssl rand -hex 32>
STEWARD_PLATFORM_KEYS=<openssl rand -hex 32>

# Optional: separate JWT secret (defaults to MASTER_PASSWORD if unset)
# STEWARD_JWT_SECRET=<openssl rand -hex 32>

# ─── Redis ────────────────────────────────────────────────────────────────────
# If using Railway Redis:
REDIS_URL=${{Redis.REDIS_URL}}
# If third-party: REDIS_URL=redis://:password@host:6379

# ─── EVM / Blockchain ────────────────────────────────────────────────────────
RPC_URL=https://mainnet.base.org
CHAIN_ID=8453

# ─── Auth — Email (Magic Links) ──────────────────────────────────────────────
RESEND_API_KEY=<from resend.com, or leave blank for console-only mode>
EMAIL_FROM=login@yourdomain.com
APP_URL=https://your-steward.up.railway.app

# ─── Auth — Passkeys (WebAuthn) ──────────────────────────────────────────────
PASSKEY_RP_NAME=ElizaCloud
PASSKEY_RP_ID=your-steward.up.railway.app
PASSKEY_ORIGIN=https://your-app.com

# ─── Auth — OAuth (optional) ─────────────────────────────────────────────────
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# DISCORD_CLIENT_ID=
# DISCORD_CLIENT_SECRET=
# TWITTER_CLIENT_ID=
# TWITTER_CLIENT_SECRET=

# ─── Migrations ──────────────────────────────────────────────────────────────
SKIP_MIGRATIONS=false
```

### Generate secrets locally

```bash
# Run these and paste the output into Railway's variable editor
echo "STEWARD_MASTER_PASSWORD=$(openssl rand -hex 32)"
echo "STEWARD_SESSION_SECRET=$(openssl rand -hex 32)"
echo "STEWARD_PLATFORM_KEYS=$(openssl rand -hex 32)"
```

**Save `STEWARD_PLATFORM_KEYS` somewhere safe** — you'll need it to create tenants.

---

## 4. Configure Build & Deploy

Railway auto-detects the `Dockerfile`. Verify these settings in **Service → Settings**:

| Setting | Value |
|---------|-------|
| **Builder** | Dockerfile |
| **Dockerfile Path** | `./Dockerfile` |
| **Watch Paths** | `/` (default, or scope to `packages/` + root configs) |

### Health Check

Under **Service → Settings → Deploy → Health Check**:

- **Path:** `/health`
- **Port:** `3200`
- **Timeout:** `45s` (Steward runs migrations on first boot, may take a moment)

### Start Command

Leave blank — the Dockerfile's `CMD` handles it:
```
CMD ["bun", "packages/api/src/index.ts"]
```

---

## 5. Deploy

### Via GitHub (auto-deploy)

Push to your configured branch:

```bash
git push origin develop
```

Railway picks it up automatically. Watch the build in the dashboard.

### Via CLI (manual)

```bash
railway up
```

### First deploy

The first deploy will:
1. Build the multi-stage Docker image (~2-3 min)
2. Start the API server on port 3200
3. Run database migrations automatically (unless `SKIP_MIGRATIONS=true`)
4. Pass the health check at `/health`

Watch logs:
```bash
railway logs
```

---

## 6. Custom Domain Setup

### Default Railway URL

After deploy, Railway gives you a URL like:
```
https://steward-production-xxxx.up.railway.app
```

### Add custom domain (e.g. `steward.elizacloud.ai`)

1. In Railway dashboard: **Service → Settings → Networking → Custom Domain**
2. Add: `steward.elizacloud.ai`
3. Railway shows the CNAME target (something like `xxxx.up.railway.app`)

### Update DNS

Add a CNAME record at your DNS provider:

```
steward.elizacloud.ai  CNAME  xxxx.up.railway.app
```

### Update environment variables to match

```bash
# Update these after the custom domain is live:
APP_URL=https://steward.elizacloud.ai
PASSKEY_RP_ID=steward.elizacloud.ai
PASSKEY_ORIGIN=https://steward.elizacloud.ai
```

Railway handles SSL automatically.

---

## 7. Post-Deploy Verification

```bash
# Set your base URL
export BASE="https://steward.elizacloud.ai"  # or your Railway URL

# Health check
curl -sf "$BASE/health"
# → {"status":"ok","version":"0.3.0","uptime":...}

# Deep readiness check (verifies DB + migrations + vault)
curl -sf "$BASE/ready"
# → {"status":"ok","db":"ok","migrations":"ok","vault":"ok"}

# List available auth providers
curl -sf "$BASE/auth/providers"
# → {"providers":["email","wallet","passkey",...]}
```

### Create the initial tenant

```bash
export PLATFORM_KEY="<your STEWARD_PLATFORM_KEYS value>"

# Create the eliza-cloud tenant
curl -sf -X POST "$BASE/platform/tenants" \
  -H "Content-Type: application/json" \
  -H "X-Steward-Platform-Key: $PLATFORM_KEY" \
  -d '{"id": "eliza-cloud", "name": "Eliza Cloud"}'
# → {"ok":true,"data":{"id":"eliza-cloud","name":"Eliza Cloud","apiKey":"stwd_..."}}
```

**Save the returned `apiKey`** — this is the tenant API key for Eliza Cloud's backend to authenticate with Steward.

### Smoke test: create a test agent

```bash
export TENANT_KEY="<apiKey from above>"

# Create agent
curl -sf -X POST "$BASE/agents" \
  -H "Content-Type: application/json" \
  -H "X-Steward-Tenant: eliza-cloud" \
  -H "X-Steward-Key: $TENANT_KEY" \
  -d '{"id": "test-agent", "name": "Railway Smoke Test"}'

# Get JWT
TOKEN=$(curl -sf -X POST "$BASE/agents/test-agent/token" \
  -H "X-Steward-Tenant: eliza-cloud" \
  -H "X-Steward-Key: $TENANT_KEY" | jq -r '.data.token')

# Check balance
curl -sf "$BASE/agents/test-agent/balance" \
  -H "Authorization: Bearer $TOKEN"

# Clean up
curl -sf -X DELETE "$BASE/agents/test-agent" \
  -H "X-Steward-Tenant: eliza-cloud" \
  -H "X-Steward-Key: $TENANT_KEY"
```

---

## 8. Connect to Eliza Cloud (Vercel)

In your Eliza Cloud Vercel project, set these environment variables:

```bash
# Steward API URL (server-side)
STEWARD_API_URL=https://steward.elizacloud.ai

# Steward API URL (client-side, for browser auth flows)
NEXT_PUBLIC_STEWARD_API_URL=https://steward.elizacloud.ai

# Session secret — MUST match the value set in Railway
STEWARD_SESSION_SECRET=<same value as Railway's STEWARD_SESSION_SECRET>

# Tenant API key (from tenant creation step above)
STEWARD_AGENT_TOKEN=<tenant apiKey from step 7>
```

Redeploy the Vercel app after setting these.

### Verify the integration

1. Visit your Eliza Cloud frontend
2. Try logging in (email magic link, wallet, or passkey)
3. Auth requests should hit `steward.elizacloud.ai` and return tokens
4. Check Railway logs for incoming requests: `railway logs`

---

## 9. CI/CD

### Auto-deploy on push (recommended)

Railway auto-deploys when you push to the connected branch:

```bash
# Deploys automatically
git push origin develop
```

Configure the branch in **Service → Settings → Source → Deploy Branch**.

### Manual deploy via CLI

```bash
# Deploy current directory
railway up

# Deploy with a specific environment
railway up --environment production
```

### Rollback

In the Railway dashboard: **Deployments → click a previous successful deploy → Rollback**.

---

## 10. Deploying the Proxy (Optional)

If you need the credential-injection proxy (for managing API keys on behalf of agents), deploy it as a second Railway service in the same project:

1. **+ New** → **Service** → connect same GitHub repo
2. Name it `steward-proxy`
3. Set the **Start Command** override:
   ```
   bun packages/proxy/src/index.ts
   ```
4. Set environment variables (same DB + Redis, different port):
   ```bash
   STEWARD_PROXY_PORT=8080
   PORT=8080
   NODE_ENV=production
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   STEWARD_MASTER_PASSWORD=<same as API service>
   STEWARD_SESSION_SECRET=<same as API service>
   REDIS_URL=${{Redis.REDIS_URL}}
   ```
5. Health check: **Path:** `/health`, **Port:** `8080`
6. Custom domain: `proxy.elizacloud.ai` (optional)

---

## Troubleshooting

### Build fails

```bash
# Check build logs in dashboard or:
railway logs --build
```

Common issues:
- **bun.lock out of sync** — run `bun install` locally and commit `bun.lock`
- **Missing workspace package.json** — all packages in `packages/` must exist

### App crashes on startup

```bash
railway logs
```

Common issues:
- **Missing `STEWARD_MASTER_PASSWORD`** — required, app won't start without it
- **Bad `DATABASE_URL`** — verify the connection string, check SSL (`?sslmode=require` for Neon)
- **Migration failure** — check logs for SQL errors, may need to create the database manually

### Health check fails

- Ensure `PORT=3200` is set (Railway uses this to route traffic)
- Ensure `STEWARD_BIND_HOST=0.0.0.0` (not `127.0.0.1`)
- The `/ready` endpoint does a deep check (DB + migrations + vault). Use `/health` for the Railway health check (lighter)

### "Tenant not found" errors

```bash
# List all tenants
curl -sf "$BASE/platform/tenants" \
  -H "X-Steward-Platform-Key: $PLATFORM_KEY"
```

### Connection refused from Vercel

- Verify `STEWARD_API_URL` doesn't have a trailing slash
- Verify the Railway service is public (Settings → Networking → Public Networking enabled)
- Check Railway's firewall / WAF isn't blocking Vercel's IPs

---

## Environment Variable Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3200` | API listen port |
| `STEWARD_BIND_HOST` | No | `127.0.0.1` | Bind host. **Set `0.0.0.0` on Railway** |
| `NODE_ENV` | No | — | Set `production` |
| `DATABASE_URL` | **Yes** | — | Postgres connection string |
| `STEWARD_MASTER_PASSWORD` | **Yes** | — | Vault encryption + fallback JWT signing |
| `STEWARD_SESSION_SECRET` | Recommended | Falls back to master password | User session JWT signing secret |
| `STEWARD_JWT_SECRET` | No | Falls back to master password | Agent JWT signing secret |
| `STEWARD_PLATFORM_KEYS` | **Yes** | — | Platform admin key(s), comma-separated |
| `STEWARD_DEFAULT_TENANT_KEY` | No | — | Default tenant key for single-tenant mode |
| `RPC_URL` | No | `https://sepolia.base.org` | EVM RPC endpoint |
| `CHAIN_ID` | No | `84532` | Default chain ID |
| `REDIS_URL` | No | — | Redis for rate limiting + spend tracking |
| `RESEND_API_KEY` | No | — | Resend key for magic link emails |
| `EMAIL_FROM` | No | `login@steward.fi` | Magic link sender address |
| `APP_URL` | No | `https://steward.fi` | Base URL for magic link callbacks |
| `PASSKEY_RP_NAME` | No | `Steward` | WebAuthn relying party display name |
| `PASSKEY_RP_ID` | No | `steward.fi` | WebAuthn relying party ID (your domain) |
| `PASSKEY_ORIGIN` | No | `https://steward.fi` | Allowed origin for passkey operations |
| `GOOGLE_CLIENT_ID` | No | — | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | No | — | Google OAuth client secret |
| `DISCORD_CLIENT_ID` | No | — | Discord OAuth client ID |
| `DISCORD_CLIENT_SECRET` | No | — | Discord OAuth client secret |
| `TWITTER_CLIENT_ID` | No | — | Twitter/X OAuth client ID |
| `TWITTER_CLIENT_SECRET` | No | — | Twitter/X OAuth client secret |
| `AGENT_TOKEN_EXPIRY` | No | `24h` | Agent JWT token lifetime |
| `SKIP_MIGRATIONS` | No | `false` | Skip auto-migrations on startup |
| `STEWARD_PROXY_PORT` | No | `8080` | Proxy service listen port |
