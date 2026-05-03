# Deployment Guide

## Prerequisites

- Docker + Docker Compose v2
- A secure `STEWARD_MASTER_PASSWORD` (minimum 32 characters recommended)
- A PostgreSQL database (or use the bundled Compose postgres service)

---

## Docker Compose (Recommended)

The included `docker-compose.yml` starts the API and PostgreSQL:

```bash
# 1. Set required environment variables
export STEWARD_MASTER_PASSWORD="$(openssl rand -hex 32)"

# 2. Optionally configure overrides
export PORT=3200
export RPC_URL=https://mainnet.base.org

# 3. Start
docker compose up -d
```

The API is available at `http://127.0.0.1:3200` (bound to localhost only — put a reverse proxy in front for public access).

### Fixing the Dockerfile

**The default Dockerfile has a build-breaking bug:** it references `packages/dashboard/package.json` which does not exist in the repo. Fix it before building:

```dockerfile
# Remove these lines from the deps stage:
# COPY packages/dashboard/package.json packages/dashboard/package.json

# And from the build + runtime stages:
# COPY packages/dashboard/package.json packages/dashboard/package.json
```

Or apply the fix directly:

```bash
sed -i '/packages\/dashboard/d' Dockerfile
```

### Running Migrations

Migrations do not run automatically on startup. Run them before starting the API:

```bash
# Against a running Postgres container
docker compose exec api bun packages/db/src/migrate.ts

# Or against an external database
DATABASE_URL=postgresql://user:pass@host/db bun packages/db/src/migrate.ts
```

**Critical:** The auth tables migration (`drizzle/migration-auth-tables.sql`) is not in the numbered Drizzle sequence. It must be run manually on a fresh deploy:

```bash
psql $DATABASE_URL -f packages/db/drizzle/migration-auth-tables.sql
```

Without this, the `users`, `authenticators`, `sessions`, and `user_tenants` tables will be missing and all user auth flows will fail.

### Production Docker Compose

A more complete compose for production with Redis:

```yaml
services:
  api:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      PORT: ${PORT:-3200}
      DATABASE_URL: postgresql://${POSTGRES_USER:-steward}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-steward}
      STEWARD_MASTER_PASSWORD: ${STEWARD_MASTER_PASSWORD:?STEWARD_MASTER_PASSWORD is required}
      STEWARD_JWT_SECRET: ${STEWARD_JWT_SECRET:?STEWARD_JWT_SECRET is required}
      REDIS_URL: redis://redis:6379
      RPC_URL: ${RPC_URL:-https://mainnet.base.org}
      RESEND_API_KEY: ${RESEND_API_KEY}
      APP_URL: ${APP_URL:-https://your-app.com}
      PASSKEY_RP_ID: ${PASSKEY_RP_ID:-your-app.com}
      PASSKEY_ORIGIN: ${PASSKEY_ORIGIN:-https://your-app.com}
    ports:
      - "127.0.0.1:3200:3200"
    healthcheck:
      test: ["CMD", "bun", "-e", "const r = await fetch('http://127.0.0.1:3200/health'); if (!r.ok) process.exit(1);"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
    networks:
      - public
      - backend

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${POSTGRES_DB:-steward}
      POSTGRES_USER: ${POSTGRES_USER:-steward}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?required}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-steward}"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - backend

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - backend

volumes:
  postgres-data:
  redis-data:

networks:
  public:
  backend:
    internal: true
```

---

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `STEWARD_MASTER_PASSWORD` | Master password for AES-256-GCM key derivation. Also used as JWT fallback secret if `STEWARD_JWT_SECRET` is not set. **Never change after initial setup** — all encrypted keys will be unreadable. |
| `DATABASE_URL` | PostgreSQL connection string: `postgresql://user:pass@host:5432/db`. If not set, falls back to PGLite embedded mode. |

### Recommended for Production

| Variable | Default | Description |
|----------|---------|-------------|
| `STEWARD_JWT_SECRET` | (falls back to `STEWARD_MASTER_PASSWORD`) | Separate secret for signing JWTs. Set this to avoid using the master password for JWT signing. |
| `STEWARD_PLATFORM_KEYS` | — | Comma-separated platform operator keys for cross-tenant admin access. |
| `REDIS_URL` | — | Redis connection string. Enables rate limiting, spend tracking, and persistent token/challenge stores. Example: `redis://localhost:6379` |

### Network / Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3200` | HTTP listen port |
| `STEWARD_BIND_HOST` | `127.0.0.1` | Bind address (use `0.0.0.0` to expose on all interfaces) |

### Auth

| Variable | Default | Description |
|----------|---------|-------------|
| `RESEND_API_KEY` | — | Resend API key for sending magic link emails. If not set, links are printed to console (dev mode). |
| `EMAIL_FROM` | `login@steward.fi` | Sender address for magic link emails |
| `APP_URL` | `https://steward.fi` | Base URL for magic link generation. Set to your app's public URL. |
| `PASSKEY_RP_NAME` | `"Steward"` | WebAuthn relying party display name |
| `PASSKEY_RP_ID` | `"steward.fi"` | WebAuthn relying party domain. Must match the domain where credentials are registered. |
| `PASSKEY_ORIGIN` | `"https://steward.fi"` | Expected origin for WebAuthn verification. |

### Blockchain

| Variable | Default | Description |
|----------|---------|-------------|
| `RPC_URL` | `https://mainnet.base.org` | Default EVM JSON-RPC endpoint |
| `CHAIN_ID` | `84532` (Base Sepolia) | Default chain ID for signing |

### Tenant

| Variable | Default | Description |
|----------|---------|-------------|
| `STEWARD_DEFAULT_TENANT_KEY` | — | API key for the default tenant (used when `X-Steward-Tenant` header is absent). Useful for single-tenant deployments. |

### Embedded Mode (PGLite)

| Variable | Default | Description |
|----------|---------|-------------|
| `PGLITE_DATA_DIR` | `~/.steward/data` | Directory for PGLite data persistence |
| `STEWARD_PGLITE_MEMORY` | `false` | Use fully in-memory PGLite (data lost on restart) |

---

## Database Setup

### PostgreSQL (Production)

1. Create the database and user:

```sql
CREATE USER steward WITH PASSWORD 'your-password';
CREATE DATABASE steward OWNER steward;
GRANT ALL PRIVILEGES ON DATABASE steward TO steward;
```

2. Set the connection string:

```bash
export DATABASE_URL="postgresql://steward:your-password@localhost:5432/steward"
```

3. Run migrations:

```bash
bun packages/db/src/migrate.ts

# Then run the auth tables migration manually:
psql $DATABASE_URL -f packages/db/drizzle/migration-auth-tables.sql
```

### PGLite (Embedded / Local)

No setup required. Steward detects when `DATABASE_URL` is absent and automatically initializes PGLite.

```bash
# Data persists in ~/.steward/data by default
bun packages/api/src/index.ts

# Custom data directory
PGLITE_DATA_DIR=/var/lib/steward bun packages/api/src/index.ts

# Fully in-memory (data lost on restart — testing only)
STEWARD_PGLITE_MEMORY=true bun packages/api/src/index.ts
```

---

## Redis (Optional)

Redis is optional but strongly recommended for production. Without it:

- **Rate limiting** does not work (in-memory rate limiting resets on restart)
- **Spend tracking** across the policy engine is per-process only
- **WebAuthn challenge store** is in-memory — passkey registration/login breaks on server restart
- **Magic link token store** is in-memory — tokens sent before a restart cannot be verified

With Redis configured via `REDIS_URL`, all of these use Redis-backed persistent stores.

```bash
# Local Redis
export REDIS_URL="redis://localhost:6379"

# Redis with auth
export REDIS_URL="redis://:password@redis-host:6379"

# Redis with TLS (Upstash, etc.)
export REDIS_URL="rediss://:password@redis-host:6380"
```

---

## Health Checks

The API exposes a health check endpoint:

```http
GET /health
```

Response when healthy:

```json
{
  "ok": true,
  "version": "0.1.0",
  "uptime": 42.3
}
```

Response when shutting down: `503 Service Unavailable`

Used by Docker's `HEALTHCHECK` instruction and by load balancers.

---

## Reverse Proxy (nginx)

Steward binds to `127.0.0.1` by default. Put nginx (or Caddy) in front:

```nginx
server {
    listen 443 ssl;
    server_name api.your-app.com;

    location / {
        proxy_pass http://127.0.0.1:3200;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Steward's rate limiter uses X-Forwarded-For
        # so the real client IP is limited, not the proxy IP
    }
}
```

---

## Security Checklist

- [ ] Set `STEWARD_MASTER_PASSWORD` to a cryptographically random value (32+ chars)
- [ ] Set `STEWARD_JWT_SECRET` separately from `STEWARD_MASTER_PASSWORD`
- [ ] Store both secrets in a secrets manager (not in `.env` files in version control)
- [ ] Use a dedicated Postgres user with minimal permissions
- [ ] Configure `APP_URL`, `PASSKEY_RP_ID`, and `PASSKEY_ORIGIN` to match your actual domain
- [ ] Enable Redis for production (persistent rate limiting and auth token stores)
- [ ] Run the auth tables migration (`migration-auth-tables.sql`) on fresh deploys
- [ ] Fix the Dockerfile by removing the non-existent `packages/dashboard` lines
- [ ] Bind `STEWARD_BIND_HOST` to `127.0.0.1` and use a reverse proxy for TLS termination
- [ ] Never rotate `STEWARD_MASTER_PASSWORD` without first decrypting and re-encrypting all agent keys
