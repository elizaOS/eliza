# Steward — Deployment Guide

Two processes, two ports:
- **steward-api** — REST API + vault on `:3200`
- **steward-proxy** — Credential injection gateway on `:8080`

---

## Quick Start: Docker Compose (Recommended)

Includes Postgres 16 and Redis 7 — nothing else to install.

```bash
# 1. Clone and enter the repo
git clone git@github.com:Steward-Fi/steward.git
cd steward

# 2. Configure environment
cp .env.example .env
$EDITOR .env   # fill in required vars (see table below)

# 3. Start everything
docker compose up -d

# 4. Tail logs
docker compose logs -f steward-api

# 5. Verify
curl http://localhost:3200/health   # {"status":"ok",...}
curl http://localhost:3200/ready    # {"status":"ready",...} once migrations done
curl http://localhost:8080/health   # {"ok":true,"service":"steward-proxy",...}
```

### First-run: create a tenant

```bash
# Replace with your STEWARD_PLATFORM_KEYS value
PLATFORM_KEY="your_platform_key"

curl -s -X POST http://localhost:3200/platform/tenants \
  -H "Content-Type: application/json" \
  -H "X-Steward-Platform-Key: $PLATFORM_KEY" \
  -d '{"id": "default", "name": "Default Tenant"}' | jq .

# Save the returned apiKey — that is your tenant API key
```

### Upgrade

```bash
git pull
docker compose build --no-cache steward-api
docker compose up -d steward-api steward-proxy
```

---

## Development: Hot Reload

Mounts your local source, skips Postgres (uses embedded PGLite), skips Redis (in-memory fallback). No rebuilds needed when editing source files.

```bash
# First time
cp .env.example .env
# STEWARD_MASTER_PASSWORD is the only required var for dev

docker compose -f docker-compose.yml -f docker-compose.dev.yml up

# Shortcut alias (add to your shell profile):
alias dcd="docker compose -f docker-compose.yml -f docker-compose.dev.yml"
dcd up
dcd logs -f steward-api
```

---

## Bare Metal: Systemd (Milady VPS Nodes)

The current production deployment on milady-core-1 through milady-core-6 uses systemd + bare Bun for faster iteration.

### Prerequisites

```bash
# Install Bun (as root or your deploy user)
curl -fsSL https://bun.sh/install | bash
# Restart shell or:  source ~/.bashrc

# Create steward user + directories
sudo useradd -r -m -s /bin/bash steward
sudo mkdir -p /opt/steward /etc/steward
sudo chown steward:steward /opt/steward
```

### Step 1: Sync source

```bash
NODE_IP="<node-ip>"
rsync -az --delete \
  --exclude='.git' --exclude='node_modules' --exclude='.next' \
  --exclude='web' --exclude='.turbo' \
  /path/to/steward/ root@${NODE_IP}:/opt/steward/

ssh root@${NODE_IP} "cd /opt/steward && sudo -u steward bun install"
```

### Step 2: Configure environment

```bash
ssh root@${NODE_IP} "cat > /etc/steward/env" << 'EOF'
PORT=3200
STEWARD_BIND_HOST=0.0.0.0
NODE_ENV=production

# Database
DATABASE_URL=postgresql://steward:password@your-db-host/steward?sslmode=require

# Vault encryption — 32+ random bytes, hex-encoded
STEWARD_MASTER_PASSWORD=<run: openssl rand -hex 32>

# Auth
STEWARD_SESSION_SECRET=<run: openssl rand -hex 32>
STEWARD_PLATFORM_KEYS=<run: openssl rand -hex 32>

# RPC
RPC_URL=https://mainnet.base.org
CHAIN_ID=8453

# Redis (optional — enables persistent rate limiting + spend tracking)
# REDIS_URL=redis://localhost:6379

# Proxy
STEWARD_PROXY_PORT=8080
EOF

ssh root@${NODE_IP} "chmod 600 /etc/steward/env && chown steward:steward /etc/steward/env"
```

### Step 3: Install systemd units

```bash
ssh root@${NODE_IP} "bash -s" << 'EOF'
cp /opt/steward/deploy/steward.service       /etc/systemd/system/steward.service
cp /opt/steward/deploy/steward-proxy.service /etc/systemd/system/steward-proxy.service
systemctl daemon-reload
systemctl enable --now steward steward-proxy
EOF
```

### Step 4: Verify

```bash
ssh root@${NODE_IP} "
  systemctl status steward steward-proxy
  curl -sf http://localhost:3200/health
  curl -sf http://localhost:8080/health
"
```

### Updating

```bash
NODE_IP="<node-ip>"
rsync -az --delete \
  --exclude='.git' --exclude='node_modules' --exclude='.next' \
  --exclude='web' --exclude='.turbo' \
  /path/to/steward/ root@${NODE_IP}:/opt/steward/

ssh root@${NODE_IP} "
  cd /opt/steward && sudo -u steward bun install
  systemctl restart steward steward-proxy
  sleep 3
  curl -sf http://localhost:3200/health
"
```

---

## Nginx Reverse Proxy (TLS Termination)

The `deploy/nginx.conf` proxies `api.steward.fi → :3200` and `proxy.steward.fi → :8080`.

```bash
# On the node with nginx installed
sudo apt-get install -y nginx certbot python3-certbot-nginx

# Copy config
sudo cp deploy/nginx.conf /etc/nginx/sites-available/steward
sudo ln -s /etc/nginx/sites-available/steward /etc/nginx/sites-enabled/steward

# Add rate limit zone + WebSocket map to /etc/nginx/nginx.conf http{} block:
# limit_req_zone $binary_remote_addr zone=steward_api:10m rate=60r/m;
# limit_req_zone $binary_remote_addr zone=steward_proxy:10m rate=120r/m;
# map $http_upgrade $connection_upgrade {
#     default upgrade;
#     ''      close;
# }

sudo nginx -t && sudo systemctl reload nginx

# Get TLS certificates
sudo certbot --nginx -d api.steward.fi -d proxy.steward.fi
```

---

## Environment Variable Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `STEWARD_MASTER_PASSWORD` | **Yes** | — | AES-256 vault encryption key. Use `openssl rand -hex 32`. Rotating this requires re-encrypting all vault entries. |
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string. In Docker Compose, defaults to internal postgres container. |
| `STEWARD_PLATFORM_KEYS` | **Yes** | — | Comma-separated platform admin keys. Used for `/platform/*` routes (cross-tenant admin). |
| `PORT` | No | `3200` | API listen port. |
| `STEWARD_BIND_HOST` | No | `127.0.0.1` | Set to `0.0.0.0` when behind a reverse proxy or in Docker. |
| `STEWARD_SESSION_SECRET` | No | `STEWARD_MASTER_PASSWORD` | JWT signing secret. Set separately to allow independent rotation. |
| `STEWARD_DEFAULT_TENANT_KEY` | No | — | Default tenant key for single-tenant deployments (no `X-Steward-Tenant` header needed). |
| `AGENT_TOKEN_EXPIRY` | No | `24h` | Default expiry for agent-scoped JWTs. |
| `RPC_URL` | No | `https://sepolia.base.org` | EVM RPC endpoint. |
| `CHAIN_ID` | No | `84532` | Default chain ID (84532 = Base Sepolia, 8453 = Base mainnet). |
| `REDIS_URL` | No | — | Redis connection string. Enables persistent rate limiting + spend tracking. Without it, falls back to in-memory (resets on restart). |
| `RESEND_API_KEY` | No | — | Resend API key for magic link emails. Without it, tokens print to console (dev mode). |
| `EMAIL_FROM` | No | `login@steward.fi` | From address for magic links. |
| `APP_URL` | No | `https://steward.fi` | Base URL for magic link callbacks. |
| `PASSKEY_RP_NAME` | No | `Steward` | WebAuthn relying party display name. |
| `PASSKEY_RP_ID` | No | `steward.fi` | WebAuthn relying party ID (must match serving domain). |
| `PASSKEY_ORIGIN` | No | `https://steward.fi` | Allowed WebAuthn origin. |
| `STEWARD_PROXY_PORT` | No | `8080` | Port the proxy gateway listens on. |
| `STEWARD_DB_MODE` | No | — | Set to `pglite` for embedded DB (no Postgres needed). For local dev only. |
| `POSTGRES_USER` | No | `steward` | Postgres user (Docker Compose internal DB). |
| `POSTGRES_PASSWORD` | No | `changeme` | Postgres password (Docker Compose internal DB). Change this! |
| `POSTGRES_DB` | No | `steward` | Postgres database name (Docker Compose internal DB). |

---

## Post-Deploy: Credential Proxy Setup

The proxy (`:8080`) requires credential routes before it can inject API keys for agents.

```bash
TENANT_ID="your-tenant-id"
API_KEY="your-tenant-api-key"
BASE="http://localhost:3200"

# 1. Store an API key as a secret
SECRET_ID=$(curl -sf -X POST $BASE/secrets \
  -H "X-Steward-Tenant: $TENANT_ID" \
  -H "X-Steward-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"openai-prod","value":"sk-your-openai-key","description":"OpenAI prod"}' \
  | jq -r '.data.id')

# 2. Create a credential route (inject as Authorization: Bearer {value})
curl -sf -X POST $BASE/secrets/routes \
  -H "X-Steward-Tenant: $TENANT_ID" \
  -H "X-Steward-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"secretId\": \"$SECRET_ID\",
    \"hostPattern\": \"api.openai.com\",
    \"pathPattern\": \"/*\",
    \"injectAs\": \"header\",
    \"injectKey\": \"Authorization\",
    \"injectFormat\": \"Bearer {value}\"
  }"

# 3. Get an agent proxy token (needs api:proxy scope)
TOKEN=$(curl -sf -X POST $BASE/agents/your-agent-id/token \
  -H "X-Steward-Tenant: $TENANT_ID" \
  -H "X-Steward-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"scopes":["api:proxy"],"expiresIn":"1h"}' | jq -r '.data.token')

# 4. Test proxy injection
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/openai/v1/models
```

Built-in proxy aliases: `openai`, `anthropic`, `birdeye`, `coingecko`, `helius`.

---

## Full E2E Smoke Test

```bash
STEWARD_URL=http://localhost:3200 bun run scripts/e2e-integration-test.ts
```

Expected: `Passed: 11/11  Failed: 0`

---

## Troubleshooting

**API won't start**
```bash
# Docker
docker compose logs steward-api

# Systemd
journalctl -u steward -n 50 --no-pager
```
Common causes: missing `STEWARD_MASTER_PASSWORD`, bad `DATABASE_URL`, port 3200 already in use.

**`/ready` returns 503**
- Migrations still running — wait 10–30s and retry
- DB unreachable — check `DATABASE_URL` and postgres health
- `STEWARD_MASTER_PASSWORD` not set

**Proxy returns 403 on all requests**
- No credential route configured for that host+path
- Agent JWT missing `api:proxy` scope
- JWT expired

**Docker: services can't reach each other**
- Both API and proxy must be on the `backend` network to reach postgres/redis
- Check `docker compose ps` and `docker network inspect steward-fi_backend`

**High memory (>500MB)**
- Likely a connection pool leak — restart and check for unclosed DB connections
- `docker compose restart steward-api`
