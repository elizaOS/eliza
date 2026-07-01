# Gateway Discord Service

Multi-tenant Discord gateway that maintains WebSocket connections to Discord and forwards events to Eliza Cloud for processing.

## Features

- **Multi-tenant**: Single pod handles up to 100 Discord bot connections
- **Auto-scaling**: Kubernetes HPA scales based on CPU/bot count
- **Failover**: Automatic reassignment when pods die (45s detection)
- **Graceful shutdown**: Immediate connection release during deployments
- **Voice support**: Transcribes voice messages before routing
- **Encrypted tokens**: Bot tokens encrypted at rest with AES-256-GCM
- **Hybrid Mode**: Supports both Eliza App system bot and user-created bots

## Table of Contents

- [Features](#features)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Running Locally](#running-locally)
  - [Registering a Discord Bot Connection](#registering-a-discord-bot-connection)
  - [Setting Up the Eliza App Bot](#setting-up-the-eliza-app-bot)
  - [Verifying the Setup](#verifying-the-setup)
  - [Testing the Flow](#testing-the-flow)
  - [Troubleshooting](#troubleshooting)
- [Configuration Reference](#configuration-reference)
  - [Scripts](#scripts)
  - [Running Tests](#running-tests)
- [Architecture Overview](#architecture-overview)
- [Hybrid Architecture: Eliza App Bot + User-Created Bots](#hybrid-architecture-eliza-app-bot--user-created-bots)
  - [Leader Election](#leader-election-for-eliza-app-bot)
  - [Message Flow: Eliza App Bot](#message-flow-eliza-app-bot)
- [Pod Lifecycle & Communication](#pod-lifecycle--communication)
  - [Startup Sequence](#startup-sequence)
  - [Bot Assignment Polling](#bot-assignment-polling)
  - [Heartbeat System](#heartbeat-system)
  - [Event Forwarding](#event-forwarding)
  - [Failover Mechanism](#failover-mechanism)
  - [Graceful Shutdown](#graceful-shutdown)
  - [Health Endpoints](#health-endpoints)
- [How Discord Response Authentication Works](#how-discord-response-authentication-works)
- [Complete System Documentation](#complete-system-documentation)
  - [Database Schema](#1-database-table-discord_connections)
  - [API Endpoints](#2-api-endpoints)
  - [Bot → Character Mapping & User Context](#3-bot--character-mapping--user-context)
  - [End-to-End Examples](#4-end-to-end-examples)
- [Kubernetes Deployment](#kubernetes-deployment)
- [Infrastructure (Terraform)](#infrastructure-terraform)

---

## Getting Started

### Prerequisites

#### 1. Discord Bot Setup (for User-Created Bots)

Follow these steps to create a Discord bot for the multi-tenant gateway:

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **"New Application"** and give it a name
3. Copy the **Application ID** from the General Information page
4. Navigate to the **Bot** section in the left sidebar
5. Click **"Reset Token"** to generate a new bot token
6. Copy the **Bot Token** (you'll only see it once!)
7. Enable **Privileged Gateway Intents**:
   - `MESSAGE CONTENT INTENT` (required - allows reading message content)
   - `SERVER MEMBERS INTENT` (optional - for member-related events)
8. Generate OAuth2 URL and invite bot to your test server:
   - Go to **OAuth2 → URL Generator**
   - Select scopes: `bot`
   - Select permissions: `Send Messages`, `Read Message History`, `Add Reactions`
   - Copy the generated URL and open it in a browser to invite the bot

> **Tip**: The dashboard's "Add to Server" button automatically generates the correct OAuth2 URL with permissions: Send Messages (2048) + Read Message History (65536) + Add Reactions (64) = 67648

#### 2. Environment Variables

**Option A: Use root `.env.local` (Recommended for local development)**

The gateway can use the same `.env.local` file as the main Eliza Cloud app. Add the required variables to your root `.env.local`:

```bash
# Add to your root .env.local file:

# Gateway authentication (JWT-based)
GATEWAY_BOOTSTRAP_SECRET=your_random_secret_here   # Generate with: openssl rand -hex 32

# JWT signing keys for Eliza Cloud (required for token issuance)
# Generate PKCS#8 key with: openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt
JWT_SIGNING_PRIVATE_KEY="base64-encoded-private-key"
JWT_SIGNING_PUBLIC_KEY="base64-encoded-public-key"
```

The gateway already picks up these existing variables from root `.env.local`:
- `NEXT_PUBLIC_APP_URL` - Used as the Eliza Cloud URL
- `KV_REST_API_URL` / `KV_REST_API_TOKEN` - Redis for failover
- `BLOB_READ_WRITE_TOKEN` - For voice message storage

Then run with:
```bash
cd services/gateway-discord
bun run dev  # Uses ../../.env.local automatically
```

**Option B: Create a separate `.env` file in this directory**

Create a `.env` file in `services/gateway-discord/`:

```bash
# Required - JWT Authentication
GATEWAY_BOOTSTRAP_SECRET=your_random_secret_here   # Exchanged for JWT at startup

# Eliza Cloud URL (pick ONE of these options):
# Option A: Use dedicated env var (recommended for production)
ELIZA_CLOUD_URL=http://localhost:3000

# Option B: Reuse the same var as main app (convenient for local dev)
# If ELIZA_CLOUD_URL is not set, it falls back to NEXT_PUBLIC_APP_URL
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Optional - Redis for failover coordination
KV_REST_API_URL=https://your-redis.upstash.io
KV_REST_API_TOKEN=your_upstash_token_here

# Optional - Voice message handling
BLOB_READ_WRITE_TOKEN=your_blob_token       # For storing voice transcriptions
VOICE_MESSAGE_ENABLED=true                  # Enable/disable voice processing

# Optional - Tuning
POD_NAME=gateway-local                      # Pod identifier (auto-set in K8s)
MAX_BOTS_PER_POD=100                        # Max bots per instance
LOG_LEVEL=info                              # debug | info | warn | error
```

Then run with:
```bash
cd services/gateway-discord
bun run dev:local  # Uses local .env file
```

**URL Resolution Order:**
1. `ELIZA_CLOUD_URL` (if set)
2. `NEXT_PUBLIC_APP_URL` (fallback)
3. `https://elizacloud.ai` (default)

Generate secure secrets:
```bash
# Generate bootstrap secret
openssl rand -hex 32

# Generate ES256 key pair for JWT signing in PKCS#8 format (run on Eliza Cloud side)
# Note: PKCS#8 format (-----BEGIN PRIVATE KEY-----) is required by jose library
openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out private.pem
openssl ec -in private.pem -pubout -out public.pem
# Base64 encode for environment variables
base64 -w 0 private.pem  # JWT_SIGNING_PRIVATE_KEY
base64 -w 0 public.pem   # JWT_SIGNING_PUBLIC_KEY
```

### Running Locally

#### Option 1: Development Mode (Recommended)

**Step 1: Start Eliza Cloud**

In the root directory:
```bash
bun run dev
```
This starts the Next.js app on `http://localhost:3000`

**Step 2: Start the Gateway**

In a new terminal:
```bash
cd services/gateway-discord

# Install dependencies
bun install

# Start with hot reload (runs on port 3000 by default)
bun run dev
```

The gateway will:
- Start on port 3000 (scripts default to this to avoid conflict with Eliza Cloud on 3000)
- Poll `http://localhost:3000/api/internal/discord/gateway/assignments` every 30s
- Forward events to `http://localhost:3000/api/internal/discord/events`
- Send heartbeats every 15s

> **Note:** The gateway's PORT only affects where it listens for health checks and metrics.
> It always connects to Eliza Cloud via `NEXT_PUBLIC_APP_URL` (http://localhost:3000).

#### Option 2: Production Mode

```bash
bun run start  # Runs on port 3000 by default
```

#### Option 3: Docker

```bash
# Build and start
bun run docker:up

# View logs
bun run docker:logs

# Stop
bun run docker:down
```

Or manually:
```bash
docker build -t gateway-discord:local .
docker run -p 3000:3000 --env-file .env gateway-discord:local
```

#### Option 4: Docker Compose

```bash
docker compose up -d
```

This maps port 3000 on your host to 3000 in the container.

### Registering a Discord Bot Connection

Use the Discord Connections API to manage bot connections.

**Create a connection:**

```bash
curl -X POST http://localhost:3000/api/v1/discord/connections \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  -d '{
    "applicationId": "YOUR_DISCORD_APPLICATION_ID",
    "botToken": "YOUR_BOT_TOKEN",
    "characterId": "YOUR_CHARACTER_UUID",
    "organizationId": "YOUR_ORGANIZATION_UUID",
    "metadata": {
      "responseMode": "always"
    }
  }'
```

**Response:**
```json
{
  "success": true,
  "connection": {
    "id": "connection-uuid",
    "applicationId": "YOUR_DISCORD_APPLICATION_ID",
    "characterId": "character-uuid",
    "status": "pending",
    "isActive": true,
    "createdAt": "2024-01-15T12:00:00.000Z"
  },
  "message": "Connection created. The gateway will pick it up within 30 seconds."
}
```

**API Endpoints:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/discord/connections` | List all connections |
| `POST` | `/api/v1/discord/connections` | Create a new connection |
| `GET` | `/api/v1/discord/connections/:id` | Get a single connection |
| `PATCH` | `/api/v1/discord/connections/:id` | Update a connection |
| `DELETE` | `/api/v1/discord/connections/:id` | Delete a connection |

**Create Connection Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `applicationId` | string | Yes | Discord Application ID from Developer Portal |
| `botToken` | string | Yes | Bot token from Discord Developer Portal |
| `characterId` | string (uuid) | Yes | Character ID for AI responses |
| `intents` | number | No | Discord gateway intents (default: 38401) |
| `metadata.responseMode` | string | No | `"always"`, `"mention"`, or `"keyword"` |
| `metadata.enabledChannels` | string[] | No | Only respond in these channels |
| `metadata.disabledChannels` | string[] | No | Ignore these channels |
| `metadata.keywords` | string[] | No | Required if responseMode is `"keyword"` |

**Update Connection Request Body:**

| Field | Type | Description |
|-------|------|-------------|
| `characterId` | string (uuid) or null | Change or remove the linked character |
| `isActive` | boolean | Enable/disable the connection |
| `metadata` | object | Update response behavior |

### Setting Up the Eliza App Bot

The gateway also supports a single system-wide **Eliza App Bot** (DM-only) alongside user-created bots. To enable it:

1. **Create a Discord Application** at [Discord Developer Portal](https://discord.com/developers/applications)
   - Click "New Application" and give it a name
   - Copy the **Application ID** from General Information page

2. **Configure the Bot:**
   - Go to the "Bot" section in the left sidebar
   - Click "Reset Token" to generate a new bot token
   - Copy the **Bot Token** (you'll only see it once!)
   - Under "Privileged Gateway Intents", enable:
     - `MESSAGE CONTENT INTENT` (required to read DM content)

3. **Invite Bot to Test Server (Optional):**
   The Eliza App bot is DM-only, but you can invite it to a server to make it easier for users to find and DM:
   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot&permissions=2048
   ```
   > Note: `permissions=2048` grants "Send Messages" only, which is sufficient for DM responses.

4. **Set Environment Variables (Local Development):**
   ```bash
   ELIZA_APP_DISCORD_BOT_ENABLED=true
   ELIZA_APP_DISCORD_BOT_TOKEN=your-bot-token
   ELIZA_APP_DISCORD_APPLICATION_ID=your-app-id  # Optional, for reference
   ```

5. **Configure via Helm (Kubernetes):**
   
   First, add the bot secrets to your Kubernetes secret:
   ```bash
   kubectl create secret generic gateway-discord-secrets \
     --namespace gateway-discord \
     --from-literal=eliza-app-discord-bot-token="your-bot-token" \
     --from-literal=eliza-app-discord-application-id="your-app-id"
   ```
   
   Then enable the bot in your Helm values:
   ```yaml
   # values.yaml or values-production.yaml
   elizaAppBot:
     enabled: true
   ```
   
   Deploy with:
   ```bash
   helm upgrade --install gateway-discord ./chart \
     --namespace gateway-discord \
     --set elizaAppBot.enabled=true
   ```

6. **Ensure Redis is configured** (required for leader election):
   ```bash
   KV_REST_API_URL=https://your-redis.upstash.io
   KV_REST_API_TOKEN=your-token
   ```

> For more details on how the Eliza App Bot works (leader election, DM handling, intents), see [Hybrid Architecture](#hybrid-architecture-eliza-app-bot--user-created-bots).

### Verifying the Setup

**Port Reference:**
| Running Method | Gateway Port | Notes |
|----------------|--------------|-------|
| Local (`bun run dev`) | `http://localhost:3000` | Scripts default to port 3000 |
| Docker (`docker compose up`) | `http://localhost:3000` | Mapped from container's internal port 3000 |

#### 1. Check Gateway Health

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "healthy",
  "podName": "gateway-local",
  "totalBots": 1,
  "connectedBots": 1,
  "disconnectedBots": 0,
  "totalGuilds": 3,
  "uptime": 12345,
  "controlPlane": {
    "consecutiveFailures": 0,
    "lastSuccessfulPoll": "2024-01-15T12:00:00.000Z",
    "healthy": true
  }
}
```

#### 2. Check Gateway Status

```bash
curl http://localhost:3000/status
```

Shows detailed information about all active connections.

#### 3. Check Prometheus Metrics

```bash
curl http://localhost:3000/metrics
```

Returns metrics in Prometheus format for monitoring.

#### 4. Watch the Logs

Gateway logs show:
- `Bot connected` - Discord WebSocket successfully connected
- `Routing event` - Message received and forwarded
- `Failed to forward event` - Eliza Cloud unreachable

Eliza Cloud logs show:
- `[Discord Events] Received event` - Event received from gateway
- `[DiscordRouter] Routing event` - Event being processed

### Testing the Flow

1. **Send a message** in your Discord server where the bot is present
2. **Watch gateway logs** for:
   ```
   [INFO] Received MESSAGE_CREATE event
   [INFO] Forwarding to Eliza Cloud...
   ```
3. **Watch Eliza Cloud logs** for:
   ```
   [Discord Events] Received event
   [DiscordRouter] Routing event
   ```
4. **Check Discord** - The bot should respond!

### Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| Gateway can't reach Eliza Cloud | Wrong URL | Set `ELIZA_CLOUD_URL` or `NEXT_PUBLIC_APP_URL` to `http://localhost:3000` (or `http://host.docker.internal:3000` in Docker) |
| `401 Unauthorized` on API calls | JWT authentication failed | Check `GATEWAY_BOOTSTRAP_SECRET` matches on both sides, verify JWT signing keys are configured |
| Gateway fails on startup | Token acquisition failed | Ensure Eliza Cloud is running and has `JWT_SIGNING_PRIVATE_KEY`/`JWT_SIGNING_PUBLIC_KEY` configured |
| Bot connects but doesn't respond | No linked app/character | Ensure the connection has `character_id` linked to an app with a character |
| Bot connects but doesn't respond | Response mode filtering | Check `metadata.responseMode` and channel filters |
| `Connection not found` error | Invalid connection ID | Create connection via repository first |
| No assignments returned | Connection inactive | Check `is_active=true` in database |
| `Invalid token` error | Bad bot token | Verify token in Discord Developer Portal |
| Events not forwarded | Network issue | Check `ELIZA_CLOUD_URL` or `NEXT_PUBLIC_APP_URL` is accessible |

---

## Configuration Reference

### Gateway Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GATEWAY_BOOTSTRAP_SECRET` | Yes | - | Secret exchanged for JWT at startup |
| `ELIZA_CLOUD_URL` | No* | - | Main Eliza Cloud app URL (takes precedence) |
| `NEXT_PUBLIC_APP_URL` | No* | - | Fallback URL if `ELIZA_CLOUD_URL` not set |
| `KV_REST_API_URL` | No | - | Redis URL for failover |
| `KV_REST_API_TOKEN` | No | - | Redis auth token |
| `POD_NAME` | No | `gateway-{hostname}` | Pod identifier |
| `PORT` | No | `3000` | HTTP server port |
| `MAX_BOTS_PER_POD` | No | `100` | Max connections per pod |
| `VOICE_MESSAGE_ENABLED` | No | `true` | Process voice messages |
| `BLOB_READ_WRITE_TOKEN` | No | - | Managed blob storage for voice |
| `LOG_LEVEL` | No | `info` | Logging verbosity |
| `DEAD_POD_THRESHOLD_MS` | No | `45000` | Failover detection threshold |
| `FAILOVER_CHECK_INTERVAL_MS` | No | `30000` | How often to check for dead pods |
| `ELIZA_APP_DISCORD_BOT_ENABLED` | No | `false` | Set to `"true"` to enable Eliza App bot |
| `ELIZA_APP_DISCORD_BOT_TOKEN` | No* | - | Eliza App system bot token (required if enabled) |
| `ELIZA_APP_DISCORD_APPLICATION_ID` | No | - | Eliza App bot application ID (for reference) |

**\*** Required when `ELIZA_APP_DISCORD_BOT_ENABLED=true`

### Eliza Cloud Environment Variables (for JWT authentication)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GATEWAY_BOOTSTRAP_SECRET` | Yes | - | Must match gateway's bootstrap secret |
| `JWT_SIGNING_PRIVATE_KEY` | Yes | - | Base64-encoded ES256 private key (PKCS#8) |
| `JWT_SIGNING_PUBLIC_KEY` | Yes | - | Base64-encoded ES256 public key (SPKI) |
| `JWT_SIGNING_KEY_ID` | No | `primary` | Key identifier for JWKS rotation |

**\*** At least one of `ELIZA_CLOUD_URL` or `NEXT_PUBLIC_APP_URL` should be set. If neither is set, defaults to `https://elizacloud.ai`.

**URL Resolution Order:**
```
ELIZA_CLOUD_URL → NEXT_PUBLIC_APP_URL → https://elizacloud.ai
```

### Scripts

```bash
# Development (uses root ../../.env.local, runs on port 3000)
bun run dev          # Development with hot reload, uses root .env.local
bun run start        # Production mode, uses root .env.local

# Development (uses local .env in this directory, runs on port 3000)
bun run dev:local    # Development with hot reload, uses local .env
bun run start:local  # Production mode, uses local .env

# Build & Test
bun run build        # Build for deployment
bun run typecheck    # TypeScript type checking
bun run test         # Run tests

# Docker
bun run docker:build # Build Docker image
bun run docker:run   # Run Docker container (uses root .env.local)
bun run docker:up    # Start with docker-compose
bun run docker:down  # Stop docker-compose
bun run docker:logs  # View container logs

# Kubernetes - see chart/README.md for Helm deployment commands
```

### Running Tests

The gateway service has comprehensive test coverage including unit tests and e2e tests.

**Note:** Use `SKIP_SERVER_CHECK=true` to skip the local server check (required for unit tests that mock all dependencies).

#### Run All Tests

```bash
# From the repository root
SKIP_SERVER_CHECK=true bun test services/gateway-discord/tests/ lib/services/gateway-discord/__tests__/ --timeout 60000
```

#### Run Service Tests Only

```bash
# Unit tests for gateway-manager, logger, voice-message-handler + e2e tests
SKIP_SERVER_CHECK=true bun test services/gateway-discord/tests/ --timeout 60000

# Run a specific test file
SKIP_SERVER_CHECK=true bun test services/gateway-discord/tests/logger.test.ts
SKIP_SERVER_CHECK=true bun test services/gateway-discord/tests/gateway-manager.test.ts
SKIP_SERVER_CHECK=true bun test services/gateway-discord/tests/voice-message-handler.test.ts
```

#### Run E2E Tests Only

```bash
SKIP_SERVER_CHECK=true bun test services/gateway-discord/tests/e2e/ --timeout 60000
```

#### Run Lib Tests Only

```bash
# Unit tests for schemas, constants, event-router
SKIP_SERVER_CHECK=true bun test lib/services/gateway-discord/__tests__/ --timeout 60000

# Run a specific test file
SKIP_SERVER_CHECK=true bun test lib/services/gateway-discord/__tests__/schemas.test.ts
SKIP_SERVER_CHECK=true bun test lib/services/gateway-discord/__tests__/constants.test.ts
SKIP_SERVER_CHECK=true bun test lib/services/gateway-discord/__tests__/event-router.test.ts
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    DISCORD GATEWAY ARCHITECTURE                                          │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────┘

┌───────────────┐                                                                    ┌───────────────────┐
│   DISCORD     │                                                                    │   DISCORD API     │
│   GATEWAY     │◄──────────────── WebSocket Connection (per bot) ──────────────────►│   (WebSocket)     │
│   (external)  │                                                                    │                   │
└───────────────┘                                                                    └───────────────────┘
        │
        │  Discord Events (MESSAGE_CREATE, GUILD_MEMBER_ADD, etc.)
        ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              KUBERNETES CLUSTER - Gateway Service                                        │
│  ┌─────────────────────────┐  ┌─────────────────────────┐  ┌─────────────────────────┐                  │
│  │     Gateway Pod 1       │  │     Gateway Pod 2       │  │     Gateway Pod N       │                  │
│  │  ┌───────────────────┐  │  │  ┌───────────────────┐  │  │  ┌───────────────────┐  │                  │
│  │  │  GatewayManager   │  │  │  │  GatewayManager   │  │  │  │  GatewayManager   │  │  ◄── HPA/Autoscale
│  │  │  - Bot connections│  │  │  │  - Bot connections│  │  │  │  - Bot connections│  │                  │
│  │  │  - Event handlers │  │  │  │  - Event handlers │  │  │  │  - Event handlers │  │                  │
│  │  │  - Max 100 bots   │  │  │  │  - Max 100 bots   │  │  │  │  - Max 100 bots   │  │                  │
│  │  ├───────────────────┤  │  │  ├───────────────────┤  │  │  ├───────────────────┤  │                  │
│  │  │ VoiceMessageHandler│ │  │  │ VoiceMessageHandler│ │  │  │ VoiceMessageHandler│ │                  │
│  │  │  - Transcription  │  │  │  │  - Transcription  │  │  │  │  - Transcription  │  │                  │
│  │  └───────────────────┘  │  │  └───────────────────┘  │  │  └───────────────────┘  │                  │
│  │  /health /ready /metrics│  │  /health /ready /metrics│  │  /health /ready /metrics│                  │
│  └────────────┬────────────┘  └────────────┬────────────┘  └────────────┬────────────┘                  │
│               │                            │                            │                               │
└───────────────┼────────────────────────────┼────────────────────────────┼───────────────────────────────┘
                │                            │                            │
                │ Heartbeat (15s)            │                            │
                ▼                            ▼                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                          REDIS (Upstash)                                                │
│  ┌─────────────────────────┐  ┌─────────────────────────┐  ┌─────────────────────────┐                  │
│  │  Pod State (TTL: 5m)   │  │  Active Pods Set       │  │  Session State (TTL:1h) │                  │
│  │  discord:pod:{podName}  │  │  discord:active_pods    │  │  discord:session:{id}   │                  │
│  │  - lastHeartbeat        │  │  - [pod1, pod2, ...]    │  │  - guildCount           │                  │
│  │  - connectionIds[]      │  │                         │  │  - eventsReceived       │                  │
│  └─────────────────────────┘  └─────────────────────────┘  └─────────────────────────┘                  │
│                                                                                                         │
│  ► FAILOVER: If pod heartbeat > 45s stale, other pods claim orphaned connections                       │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                │
                │ Forward Events / Poll Assignments / Status Updates
                ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    ELIZA CLOUD (Next.js Application)                                    │
│                                                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────────────────────────────┐   │
│  │                              Internal API (JWT Bearer Token auth)                                │   │
│  │                                                                                                   │   │
│  │  POST /api/internal/auth/token              ← Exchange bootstrap secret for JWT                  │   │
│  │  POST /api/internal/auth/refresh            ← Refresh JWT before expiry                          │   │
│  │  POST /api/internal/discord/events          ← Receive & route Discord events                     │   │
│  │  GET  /api/internal/discord/gateway/assignments  ← Return bot assignments for pod               │   │
│  │  POST /api/internal/discord/gateway/status       ← Update connection status                     │   │
│  │  POST /api/internal/discord/gateway/heartbeat    ← Receive heartbeat, update last_heartbeat     │   │
│  │  POST /api/internal/discord/gateway/failover     ← Handle dead pod failover                     │   │
│  │  POST /api/internal/discord/gateway/shutdown     ← Release connections on graceful shutdown     │   │
│  └────────────────────────────────────────────────────┬────────────────────────────────────────────┘   │
│                                                       │                                                 │
│                                                       ▼                                                 │
│  ┌───────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│  │                                    Event Router                                                    │ │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐               │ │
│  │  │ MESSAGE_CREATE  │  │ MESSAGE_UPDATE  │  │ REACTION_ADD    │  │ MEMBER_JOIN     │   ...         │ │
│  │  │ - Filter check  │  │                 │  │                 │  │                 │               │ │
│  │  │ - Response mode │  │                 │  │                 │  │                 │               │ │
│  │  │ - Channel filter│  │                 │  │                 │  │                 │               │ │
│  │  └────────┬────────┘  └─────────────────┘  └─────────────────┘  └─────────────────┘               │ │
│  │           │                                                                                        │ │
│  │           ▼                                                                                        │ │
│  │  ┌─────────────────────────────────────────────────────────────────────────────────────────────┐  │ │
│  │  │                            Eliza Agent Runtime                                                │  │ │
│  │  │  1. Create/Get runtime for character directly                                                   │  │ │
│  │  │  2. Ensure world, room, entity exist                                                         │  │ │
│  │  │  3. Create Memory for user message                                                           │  │ │
│  │  │  4. Emit MESSAGE_RECEIVED event → Agent processes → Generate response                        │  │ │
│  │  │  5. Create Memory for agent response                                                         │  │ │
│  │  └────────────────────────────────────────────────────────────────────────────────────────────┬┘  │ │
│  └───────────────────────────────────────────────────────────────────────────────────────────────┼───┘ │
│                                                                                                  │     │
└──────────────────────────────────────────────────────────────────────────────────────────────────┼─────┘
                                                                                                   │
                                                                                                   │
                ▼                                                                                  │
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                        POSTGRESQL (Neon)                                                │
│  ┌─────────────────────────────────────────────────────────────────────────────────────────────────┐   │
│  │                                  discord_connections table                                       │   │
│  │                                                                                                   │   │
│  │  id                 │ organization_id │ character_id   │ application_id │ bot_user_id                   │   │
│  │  bot_token_encrypted│ encrypted_dek   │ token_nonce │ token_auth_tag │ encryption_key_id          │   │
│  │  assigned_pod       │ status          │ error_message │ guild_count │ events_received             │   │
│  │  last_heartbeat     │ connected_at    │ intents  │ is_active │ metadata (enabledChannels, etc.)  │   │
│  │                                                                                                   │   │
│  │  Indexes: organization_id, character_id, assigned_pod, status, is_active                               │   │
│  │  Unique: (organization_id, application_id)                                                        │   │
│  └─────────────────────────────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                                                                   │
                                                                                                   │
                                              Response via Discord REST API                        │
                                              POST /channels/{id}/messages ◄───────────────────────┘
```

### Data Flow Summary

| Step | Direction | Description |
|------|-----------|-------------|
| **1** | Pod → Eliza Cloud | Gateway pod polls `/assignments` every 30s to get bot tokens |
| **2** | Pod → Discord | Pod connects to Discord WebSocket Gateway with bot token |
| **3** | Discord → Pod | Discord sends events (messages, reactions, etc.) over WebSocket |
| **4** | Pod → Eliza Cloud | Pod forwards events to `/events` endpoint |
| **5** | Eliza Cloud | Event Router filters + routes to Agent Runtime |
| **6** | Eliza Cloud | Agent processes message, generates response |
| **7** | Eliza Cloud → Discord | Response sent directly to Discord REST API |
| **8** | Pod → Redis | Heartbeat every 15s for failover detection |
| **9** | Pod → Eliza Cloud | Heartbeat to `/heartbeat` to update `last_heartbeat` in DB |

---

## Hybrid Architecture: Eliza App Bot + User-Created Bots

The gateway supports two types of Discord bots simultaneously:

### 1. Eliza App Bot (System Bot)

A single system-wide Discord bot for the Eliza App, configured via environment variables.

**Key Features:**
- **DM-only**: Only handles direct messages, not server/guild messages
- **Auto-provisioning**: Users are auto-created on first message (like Blooio/iMessage)
- **Leader election**: Only one pod connects the bot to prevent duplicates
- **Environment-based config**: Token set via `ELIZA_APP_DISCORD_BOT_TOKEN`

**Discord.js Client Configuration:**
```typescript
// Required intents for DM support
intents: [
  GatewayIntentBits.DirectMessages,  // Receive DM events
  GatewayIntentBits.MessageContent,  // Read message content
]

// Required partials for DM support (CRITICAL!)
// DM channels are NOT cached by default in Discord.js
partials: [
  Partials.Channel,  // Handle uncached DM channels
  Partials.Message,  // Handle partial message events
]
```

> **Important**: Without `Partials.Channel` and `Partials.Message`, the bot will silently ignore DM messages because DM channels are not part of any guild and are not cached by default.

### 2. User-Created Bots (Multi-tenant)

Bots created by users through the dashboard, stored in `discord_connections` table.

**Key Features:**
- **Per-organization**: Each organization can have their own Discord bots
- **DB-configured**: Bot tokens stored encrypted in PostgreSQL
- **Channel filtering**: Can be configured to respond in specific channels
- **Response modes**: Supports "always", "mention", and "keyword" modes
- **DM support**: Fully supports DMs in addition to guild channels

**Discord.js Client Configuration:**
```typescript
// Intents from database or defaults
intents: assignment.intents || DEFAULT_DISCORD_INTENTS

// Required partials for DM support (applied to ALL user bots)
partials: [
  Partials.Channel,  // Handle uncached DM channels
  Partials.Message,  // Handle partial message events
]
```

> **Note**: Partials are automatically configured for all user-created bots to ensure DM functionality works correctly.

### Leader Election for Eliza App Bot

To prevent duplicate connections when the gateway scales horizontally, the Eliza App bot uses Redis-based leader election:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       LEADER ELECTION FLOW                                   │
└─────────────────────────────────────────────────────────────────────────────┘

┌────────────┐   ┌────────────┐   ┌────────────┐
│   Pod A    │   │   Pod B    │   │   Pod C    │
│            │   │            │   │            │
│  Try SETNX │   │  Try SETNX │   │  Try SETNX │
│  "leader"  │   │  "leader"  │   │  "leader"  │
└─────┬──────┘   └─────┬──────┘   └─────┬──────┘
      │                │                │
      ▼                ▼                ▼
┌─────────────────────────────────────────────────┐
│              Redis (SETNX with TTL)             │
│                                                 │
│  Key: discord:eliza-app-bot:leader              │
│  Value: "pod-a"                                 │
│  TTL: 10 seconds                                │
│                                                 │
│  Result:                                        │
│    Pod A: OK (becomes leader, connects bot)     │
│    Pod B: nil (not leader, skips)               │
│    Pod C: nil (not leader, skips)               │
└─────────────────────────────────────────────────┘

Every 3 seconds:
- Leader renews lock with EXPIRE
- Non-leaders try SETNX (in case leader dies)

If leader dies:
- Lock expires after 10 seconds
- Next pod to try SETNX becomes leader (~3-10 seconds failover)
```

**Configuration:**

| Constant | Value | Description |
|----------|-------|-------------|
| `ELIZA_APP_LEADER_KEY` | `discord:eliza-app-bot:leader` | Redis key for leader lock |
| `ELIZA_APP_LEADER_TTL_SECONDS` | 10 | Lock TTL - how long before lock expires |
| `ELIZA_APP_LEADER_CHECK_INTERVAL_MS` | 3000 | How often pods check/renew leadership |

**Multi-Environment Warning:**

If you share the **same Redis instance** across multiple environments (production, staging, local), you **must** use different leader keys for each environment. Otherwise:

- Environments will compete for the same leader lock
- Only ONE bot across ALL environments will run at a time
- Local development could steal leadership from production

The `ELIZA_APP_LEADER_KEY` is currently hardcoded. If you need environment isolation with a shared Redis, either:
1. Use **separate Redis instances** per environment (recommended)
2. Modify the code to read from an environment variable:
   ```typescript
   const ELIZA_APP_LEADER_KEY = process.env.ELIZA_APP_LEADER_KEY || "discord:eliza-app-bot:leader";
   ```

Recommended key naming by environment:
```bash
# Production
ELIZA_APP_LEADER_KEY=discord:eliza-app-bot:leader:prod

# Development
ELIZA_APP_LEADER_KEY=discord:eliza-app-bot:leader:dev

# Local Development
ELIZA_APP_LEADER_KEY=discord:eliza-app-bot:leader:local
```

> **Setup instructions**: See [Setting Up the Eliza App Bot](#setting-up-the-eliza-app-bot) in Getting Started.

### Message Flow: Eliza App Bot

```
Discord User                  Gateway Pod (Leader)              Eliza Cloud
     │                              │                               │
     │  DM: "Hello!"                │                               │
     │─────────────────────────────►│                               │
     │                              │                               │
     │                              │  POST /api/eliza-app/webhook/discord
     │                              │  { event_type: "MESSAGE_CREATE",
     │                              │    data: { author, content } }
     │                              │──────────────────────────────►│
     │                              │                               │
     │                              │              ┌─────────────────┴──────────────┐
     │                              │              │ 1. Auto-provision Discord user │
     │                              │              │ 2. Create/get room             │
     │                              │              │ 3. Acquire distributed lock    │
     │                              │              │ 4. Process via MessageHandler  │
     │                              │              │ 5. Send response               │
     │                              │              └─────────────────┬──────────────┘
     │                              │                               │
     │  "Hi! How can I help?"       │                               │
     │◄────────────────────────────────────────────────────────────│
```

---

## Pod Lifecycle & Communication

This section explains how gateway pods manage their lifecycle, communicate with external services, and handle failover scenarios.

### Overview

```mermaid
flowchart TB
    subgraph pod [Gateway Pod]
        GM[GatewayManager]
        BC1[BotConnection 1]
        BC2[BotConnection N]
        VH[VoiceHandler]
    end
    
    subgraph intervals [Background Tasks]
        Poll[Poll Interval 30s]
        HB[Heartbeat Interval 15s]
        FO[Failover Check 30s]
    end
    
    subgraph external [External Services]
        EC[Eliza Cloud API]
        Redis[Redis/Upstash]
        Discord[Discord WebSocket]
    end
    
    GM --> Poll
    GM --> HB
    GM --> FO
    
    Poll --> EC
    HB --> EC
    HB --> Redis
    FO --> Redis
    FO --> EC
    
    BC1 --> Discord
    BC2 --> Discord
```

### Startup Sequence

When a gateway pod starts, it follows this initialization sequence:

1. **Initialize GatewayManager** with config (`podName`, `elizaCloudUrl`, `gatewayBootstrapSecret`)
2. **Initialize Redis client** for failover coordination (if configured)
3. **Acquire JWT token** by exchanging bootstrap secret with `/api/internal/auth/token`
4. **Start HTTP server** (Hono) with endpoints: `/health`, `/ready`, `/metrics`, `/status`
5. **Start background intervals**:
   - `pollForBots()` every 30 seconds
   - `sendHeartbeat()` every 15 seconds
   - `checkForDeadPods()` every 30 seconds (if Redis available)
   - Token refresh at 80% of token lifetime (48 minutes for 1-hour tokens)
6. **Start voice message cleanup job** (if enabled)

### Bot Assignment Polling

Every 30 seconds, the pod polls Eliza Cloud for bot assignments:

```mermaid
sequenceDiagram
    participant Pod
    participant ElizaCloud
    participant Discord
    
    Pod->>ElizaCloud: GET /api/internal/discord/gateway/assignments
    Note right of Pod: ?pod=X&current=N&max=100
    ElizaCloud-->>Pod: assignments array with botTokens
    
    loop For each new assignment
        Pod->>Discord: Connect WebSocket with botToken
        Discord-->>Pod: ClientReady event
        Pod->>ElizaCloud: POST /gateway/status
        Note right of Pod: status: connected, bot_user_id
    end
    
    loop For removed assignments
        Pod->>Discord: Disconnect WebSocket
        Pod->>ElizaCloud: POST /gateway/status
        Note right of Pod: status: disconnected
    end
```

**Key behaviors:**

| Behavior | Description |
|----------|-------------|
| Capacity limit | Respects `MAX_BOTS_PER_POD` (default: 100) to prevent resource exhaustion |
| Failure tracking | Tracks `consecutivePollFailures` - after 5 failures, marks pod as "unhealthy" |
| Cleanup | Disconnects bots that are no longer in the assignment list |

### Heartbeat System

The gateway uses a **dual heartbeat** mechanism for reliability:

| Target | Endpoint | Purpose | Data |
|--------|----------|---------|------|
| **Eliza Cloud** | `POST /gateway/heartbeat` | Update `last_heartbeat` in PostgreSQL | `pod_name`, `connection_ids[]` |
| **Redis** | `SETEX discord:pod:{name}` | Fast failover detection | `{podId, connections[], lastHeartbeat}` with 5min TTL |

**Redis Key Structure:**

```
discord:pod:{podName}       # Pod state with TTL (5 min)
discord:active_pods         # Set of all active pod names
discord:session:{connId}    # Session state (preserved on disconnect, 1 hour TTL)
```

### Event Forwarding

When a Discord event arrives (MESSAGE_CREATE, etc.), it's forwarded to Eliza Cloud:

```mermaid
sequenceDiagram
    participant Discord
    participant Pod
    participant ElizaCloud
    participant Agent
    
    Discord->>Pod: MESSAGE_CREATE event
    Pod->>Pod: Process voice attachments if any
    Pod->>ElizaCloud: POST /api/internal/discord/events
    Note right of ElizaCloud: 60s timeout for AI processing
    ElizaCloud->>Agent: Route to AgentRuntime
    Agent-->>ElizaCloud: Response text
    ElizaCloud-->>Pod: 200 OK
    Pod->>Pod: Increment eventsRouted counter
```

**Failure handling:**
- Tracks `consecutiveFailures` per connection
- Logs failures but doesn't disconnect (allows temporary network issues to recover)
- Uses 60-second timeout for AI processing (longer than standard 10s for other calls)

### Failover Mechanism

When a pod dies, other pods detect it and claim orphaned connections:

```mermaid
sequenceDiagram
    participant PodA as Pod A - alive
    participant PodB as Pod B - dead
    participant Redis
    participant ElizaCloud
    
    PodA->>Redis: SMEMBERS discord:active_pods
    Redis-->>PodA: podA, podB
    PodA->>Redis: GET discord:pod:podB
    Redis-->>PodA: lastHeartbeat stale > 45s
    
    PodA->>ElizaCloud: POST /gateway/failover
    Note right of PodA: claiming_pod: A, dead_pod: B
    Note right of ElizaCloud: Validates heartbeat staleness
    Note right of ElizaCloud: Atomically reassigns connections
    ElizaCloud-->>PodA: claimed: 5
    
    PodA->>Redis: SREM discord:active_pods podB
    PodA->>Redis: DEL discord:pod:podB
```

**Timing configuration:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `DEAD_POD_THRESHOLD_MS` | 45,000ms | Time since last heartbeat to consider pod dead |
| `FAILOVER_CHECK_INTERVAL_MS` | 30,000ms | How often to check for dead pods |
| **Max failover latency** | 75s | Worst case: 45s + 30s |

The threshold should be at least 2x the heartbeat interval (15s) to avoid false positives during network blips.

### Graceful Shutdown

When a pod receives `SIGTERM` or `SIGINT`, it performs a graceful shutdown:

1. **Clear all intervals** (poll, heartbeat, failover)
2. **Stop voice cleanup job**
3. **For each bot connection:**
   - Save session state to Redis (stats, guild count)
   - Remove event listeners
   - Destroy Discord client
4. **POST `/gateway/shutdown`** to release connections in DB
   - Allows other pods to claim connections immediately
5. **Clean up Redis state:**
   - `DEL discord:pod:{podName}`
   - `SREM discord:active_pods {podName}`

### Health Endpoints

| Endpoint | Purpose | Returns 503 When |
|----------|---------|------------------|
| `/health` | Liveness probe (K8s restarts pod if 503) | `status === "unhealthy"` (control plane lost OR all bots disconnected) |
| `/ready` | Readiness probe (K8s stops traffic if 503) | `status !== "healthy"` OR control plane unhealthy |
| `/metrics` | Prometheus metrics scraping | Never (always returns metrics text) |
| `/status` | Detailed debug information | Never (always returns JSON status) |

### Communication Summary

| From | To | Endpoint | Frequency | Purpose |
|------|-----|----------|-----------|---------|
| Pod | Eliza Cloud | `GET /gateway/assignments` | 30s | Get bot assignments |
| Pod | Eliza Cloud | `POST /gateway/status` | On connect/disconnect | Update connection status |
| Pod | Eliza Cloud | `POST /gateway/heartbeat` | 15s | Update DB heartbeat |
| Pod | Eliza Cloud | `POST /gateway/failover` | On dead pod detection | Claim orphaned connections |
| Pod | Eliza Cloud | `POST /gateway/shutdown` | On graceful shutdown | Release connections |
| Pod | Eliza Cloud | `POST /discord/events` | Per Discord event | Forward events for processing |
| Pod | Redis | Various keys | 15s + on-demand | Fast failover coordination |

---

## How Discord Response Authentication Works

When Eliza Cloud needs to send a response back to Discord, it uses the **same bot token** that was used to establish the WebSocket connection. Here's how it works:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ DISCORD RESPONSE FLOW                                                        │
└─────────────────────────────────────────────────────────────────────────────┘

1. Bot token stored encrypted in PostgreSQL (AES-256-GCM envelope encryption)
   ┌─────────────────────────────────────────────────────────────────────────┐
   │ discord_connections                                                      │
   │   bot_token_encrypted: "encrypted..."  ← Encrypted with DEK             │
   │   encrypted_dek: "..."                 ← DEK encrypted with KEK (KMS)   │
   │   token_nonce: "..."                   ← AES-GCM nonce                  │
   │   token_auth_tag: "..."                ← AES-GCM auth tag               │
   └─────────────────────────────────────────────────────────────────────────┘

2. When message received, Eliza Cloud processes and generates response

3. Eliza Cloud decrypts bot token from database:
   ┌─────────────────────────────────────────────────────────────────────────┐
   │ const botToken = await encryption.decrypt({                             │
   │   encryptedValue: connection.bot_token_encrypted,                       │
   │   encryptedDek: connection.encrypted_dek,                               │
   │   nonce: connection.token_nonce,                                        │
   │   authTag: connection.token_auth_tag,                                   │
   │ });                                                                      │
   └─────────────────────────────────────────────────────────────────────────┘

4. Eliza Cloud sends response directly to Discord REST API:
   ┌─────────────────────────────────────────────────────────────────────────┐
   │ POST https://discord.com/api/v10/channels/{channelId}/messages          │
   │                                                                          │
   │ Headers:                                                                 │
   │   Authorization: Bot {decrypted_bot_token}                              │
   │   Content-Type: application/json                                         │
   │                                                                          │
   │ Body:                                                                    │
   │   { "content": "Hello! How can I help?", "message_reference": {...} }   │
   └─────────────────────────────────────────────────────────────────────────┘
```

**Key Points:**
- **No separate Discord configuration needed** - The bot token itself grants permission to send messages
- **Bot token is never exposed** - It's decrypted only when needed, in memory
- **Same token for WebSocket and REST** - Discord uses the same token for both connection types
- **Response is sent directly** - Eliza Cloud sends to Discord, not through the Gateway

---

## Complete System Documentation

### 1. Database Table: `discord_connections`

This table stores all Discord bot connections that the gateway service manages.

#### Schema Breakdown

```sql
CREATE TABLE "discord_connections" (
  -- ═══════════════════════════════════════════════════════════════
  -- IDENTITY & RELATIONSHIPS
  -- ═══════════════════════════════════════════════════════════════
  "id" uuid PRIMARY KEY,                    -- Unique connection ID
  "organization_id" uuid NOT NULL,          -- Links to user's organization (CASCADE delete)
  "character_id" uuid,                      -- Links to Eliza agent character (SET NULL on delete)
  "application_id" text NOT NULL,           -- Discord Application ID (from Developer Portal)
  "bot_user_id" text,                       -- Discord Bot User ID (set after connection)
                                            -- ⚠️ Different from application_id!
                                            -- Used for @mention detection

  -- ═══════════════════════════════════════════════════════════════
  -- ENCRYPTED BOT TOKEN (Envelope Encryption with AES-256-GCM)
  -- ═══════════════════════════════════════════════════════════════
  "bot_token_encrypted" text NOT NULL,      -- The encrypted bot token
  "encrypted_dek" text NOT NULL,            -- Encrypted Data Encryption Key
  "token_nonce" text NOT NULL,              -- Nonce for AES-GCM
  "token_auth_tag" text NOT NULL,           -- Authentication tag for integrity
  "encryption_key_id" text NOT NULL,        -- Which KMS key was used

  -- ═══════════════════════════════════════════════════════════════
  -- GATEWAY ASSIGNMENT & STATUS
  -- ═══════════════════════════════════════════════════════════════
  "assigned_pod" text,                      -- Which K8s pod owns this connection
                                            -- NULL = unassigned, available for claiming
  "status" text NOT NULL DEFAULT 'pending', -- Connection lifecycle state
                                            -- Values: pending → connecting → connected
                                            --         ↘ disconnected ↙
                                            --              ↓ error
  "error_message" text,                     -- Error details if status='error'

  -- ═══════════════════════════════════════════════════════════════
  -- STATISTICS (updated by gateway)
  -- ═══════════════════════════════════════════════════════════════
  "guild_count" integer DEFAULT 0,          -- Number of Discord servers bot is in
  "events_received" integer DEFAULT 0,      -- Total events from Discord
  "events_routed" integer DEFAULT 0,        -- Events successfully sent to Eliza Cloud

  -- ═══════════════════════════════════════════════════════════════
  -- HEARTBEAT & TIMING
  -- ═══════════════════════════════════════════════════════════════
  "last_heartbeat" timestamp,               -- Last time pod confirmed it's alive
                                            -- Used for failover detection
  "connected_at" timestamp,                 -- When bot successfully connected to Discord

  -- ═══════════════════════════════════════════════════════════════
  -- CONFIGURATION
  -- ═══════════════════════════════════════════════════════════════
  "intents" integer DEFAULT 38401,          -- Gateway Discord Intents bitmask
                                            -- Default: GUILDS | GUILD_MESSAGES | 
                                            -- GUILD_MESSAGE_REACTIONS | DIRECT_MESSAGES |
                                            -- MESSAGE_CONTENT
  "is_active" boolean DEFAULT true,         -- Soft delete / disable flag
  "metadata" jsonb,                         -- Flexible config (see below)

  "created_at" timestamp,
  "updated_at" timestamp
);
```

#### Metadata JSONB Structure

```typescript
interface DiscordConnectionMetadata {
  // Channel filtering
  enabledChannels?: string[];   // Only respond in these channel IDs (allowlist)
  disabledChannels?: string[];  // Never respond in these channel IDs (blocklist)
  
  // Response mode
  responseMode?: "always" | "mention" | "keyword";
  // - "always": Respond to every message (default)
  // - "mention": Only when @bot is mentioned
  // - "keyword": Only when message contains keywords
  
  keywords?: string[];  // Required when responseMode="keyword"
}
```

#### Indexes

| Index | Purpose |
|-------|---------|
| `organization_id_idx` | Fast lookup by organization |
| `character_id_idx` | Fast lookup by Eliza agent |
| `assigned_pod_idx` | Find all connections for a pod |
| `status_idx` | Filter by connection status |
| `is_active_idx` | Filter active connections |
| `unassigned_idx` | **Partial index** for fast assignment queries |
| `org_app_unique_idx` | **Unique constraint** - one bot per Discord app per org |

---

### 2. API Endpoints

#### Authentication Endpoints

##### `POST /api/internal/auth/token`

**Purpose**: Exchange bootstrap secret for JWT token (called once at pod startup).

**Request Headers**:
- `X-Gateway-Secret`: The bootstrap secret

**Request Body**:
```json
{
  "pod_name": "gateway-pod-abc123",
  "service": "discord-gateway"
}
```

**Response**:
```json
{
  "access_token": "eyJhbGciOiJFUzI1NiIs...",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

##### `POST /api/internal/auth/refresh`

**Purpose**: Refresh JWT token before expiry (called at 80% of token lifetime).

**Request Headers**:
- `Authorization: Bearer {current_jwt}`

**Response**:
```json
{
  "access_token": "eyJhbGciOiJFUzI1NiIs...",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

---

#### Gateway Endpoints

All gateway endpoints require the `Authorization: Bearer {jwt}` header for authentication.

##### `GET /api/internal/discord/gateway/assignments`

**Purpose**: Gateway pods call this to get bots to connect.

**Query Parameters**:

| Param | Type | Description |
|-------|------|-------------|
| `pod` | string | Pod name (e.g., `gateway-pod-abc123`) |
| `current` | number | Current number of bots on this pod |
| `max` | number | Maximum bots this pod can handle |

**Response**:
```json
{
  "assignments": [
    {
      "connectionId": "uuid",
      "organizationId": "uuid",
      "applicationId": "123456789012345678",
      "botToken": "decrypted-bot-token",
      "intents": 38401
    }
  ]
}
```

**Logic**:
1. Returns all connections already assigned to this pod
2. If `current < max`, claims unassigned connections and returns them too
3. Bot tokens are decrypted using the encryption service

---

#### 2.2 `POST /api/internal/discord/gateway/status`

**Purpose**: Gateway reports connection status changes.

**Request Body**:
```json
{
  "connection_id": "uuid",
  "pod_name": "gateway-pod-abc123",
  "status": "connected",
  "error_message": "Invalid token",
  "bot_user_id": "987654321098765432"
}
```

**Logic**:
- Updates `status`, `assigned_pod`, `error_message` in database
- Sets `connected_at` timestamp when status becomes "connected"
- Stores `bot_user_id` for mention detection

---

#### 2.3 `POST /api/internal/discord/gateway/heartbeat`

**Purpose**: Gateway pods send periodic heartbeats (every 15s).

**Request Body**:
```json
{
  "pod_name": "gateway-pod-abc123",
  "connection_ids": ["uuid1", "uuid2", "uuid3"]
}
```

**Logic**:
- Updates `last_heartbeat` timestamp for all specified connections
- Only updates connections that belong to this pod (security check)

---

#### 2.4 `POST /api/internal/discord/gateway/failover`

**Purpose**: A live pod claims connections from a dead pod.

**Request Body**:
```json
{
  "claiming_pod": "gateway-pod-healthy",
  "dead_pod": "gateway-pod-crashed"
}
```

**Response**:
```json
{
  "claimed": 5
}
```

**Logic**:
1. **Validation**: Cannot claim from self
2. **Heartbeat check**: If dead pod has recent heartbeat (< 45s), reject
3. **Atomic reassignment**: Only reassigns connections with stale heartbeats
4. Sets `status = 'pending'` so they get picked up on next assignment poll

---

#### 2.5 `POST /api/internal/discord/gateway/shutdown`

**Purpose**: Pod releases all connections during graceful shutdown.

**Request Body**:
```json
{
  "pod_name": "gateway-pod-shutting-down"
}
```

**Response**:
```json
{
  "released": 10
}
```

**Logic**:
- Sets `assigned_pod = NULL` and `status = 'pending'` for all connections
- Allows immediate reassignment (vs waiting 45s for failover timeout)

---

#### 2.6 `POST /api/internal/discord/events`

**Purpose**: Gateway forwards Discord events for processing.

**Request Body**:
```json
{
  "connection_id": "uuid",
  "organization_id": "uuid",
  "platform_connection_id": "uuid",
  "event_type": "MESSAGE_CREATE",
  "event_id": "1234567890123456789",
  "guild_id": "111222333444555666",
  "channel_id": "777888999000111222",
  "data": {
    "id": "1234567890123456789",
    "channel_id": "777888999000111222",
    "author": {
      "id": "user-id",
      "username": "JohnDoe",
      "bot": false
    },
    "content": "Hello bot!",
    "timestamp": "2024-01-15T12:00:00.000Z"
  },
  "timestamp": "2024-01-15T12:00:00.000Z"
}
```

**Logic**:
1. Validates payload with Zod schemas
2. Routes to `routeDiscordEvent()` which:
   - Checks channel filters and response mode
   - Gets the linked Eliza agent and character
   - Creates an `AgentRuntime` for the character
   - Processes message through the agent
   - Sends response back to Discord via REST API

---

### 3. Bot → Character Mapping & User Context

This section explains how the system determines which character/agent to use for a Discord bot, and how conversation history is maintained per user.

#### How Discord Bot → Character Mapping Works

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                        DISCORD BOT → CHARACTER MAPPING                                                   │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────┐      ┌─────────────────────┐      ┌─────────────────┐
│  discord_connections│      │   user_characters   │      │  AgentRuntime   │
│                     │      │                     │      │                 │
│  id: conn-uuid      │      │  id: char-uuid      │      │  agentId: ...   │
│  character_id ──────┼─────►│  name: "MyBot"      │─────►│  character: {}  │
│  organization_id    │      │  bio: "..."         │      │  memory: ...    │
│  bot_token_encrypted│      │  personality: ...   │      │                 │
│                     │      │  knowledge: [...]   │      │                 │
└─────────────────────┘      └─────────────────────┘      └─────────────────┘

LOOKUP CHAIN:
1. connection.character_id           → Gets the Character directly
2. runtimeFactory.createRuntimeForUser(context) → Creates AgentRuntime with character
```

**Code Flow:**

```typescript
// 1. Get the discord connection by ID
const connection = await discordConnectionsRepository.findById(payload.connection_id);

// 2. Get the linked character directly
const character = await userCharactersRepository.findById(connection.character_id);

// 3. Create runtime context with the character
const context = userContextService.createSystemContext(AgentMode.CHAT);
context.characterId = character.id;
context.organizationId = connection.organization_id;

// 4. Create AgentRuntime for this character
const runtime = await runtimeFactory.createRuntimeForUser(context);
```

---

#### How Conversation History is Maintained Per User

Unique IDs are generated deterministically from Discord data to ensure consistency:

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  ROOM ID (per channel per organization)                                                                  │
│  ────────────────────────────────────────                                                                │
│  roomId = stringToUuid(`discord-${organization_id}-${channel_id}`)                                       │
│                                                                                                          │
│  Example: Organization "org-123" + Channel "456789" → Deterministic UUID                                │
│                                                                                                          │
│  This means:                                                                                             │
│  • Same channel always maps to same room                                                                 │
│  • Different orgs with same channel get different rooms (isolation)                                     │
│  • All messages in a channel share history                                                               │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  ENTITY ID (per Discord user)                                                                            │
│  ───────────────────────────                                                                             │
│  entityId = stringToUuid(`discord-user-${author.id}`)                                                    │
│                                                                                                          │
│  Example: Discord User ID "987654321" → Deterministic UUID                                              │
│                                                                                                          │
│  This means:                                                                                             │
│  • Same Discord user always maps to same entity                                                          │
│  • User's profile info stored in entity metadata                                                         │
│  • Agent can remember this user across conversations                                                     │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

#### Memory Storage

Both user messages and agent responses are saved as `Memory` objects:

```typescript
// User message saved to maintain conversation history
const userMessage: Memory = {
  id: uuidv4(),
  roomId: roomUuid,           // ← Channel-based room
  entityId: entityUuid,       // ← Discord user
  agentId: runtime.agentId,   // ← The character/agent
  content: {
    text: message.text,
    source: "discord",
  },
  metadata: {
    type: MemoryType.MESSAGE,
    role: "user",
    discord: {                // ← Discord-specific metadata preserved
      discordMessageId,
      discordChannelId,
      discordAuthor,
    },
  },
};

await runtime.createMemory(userMessage, "messages");

// Agent response also saved with link to original message
const responseMemory: Memory = {
  id: createUniqueUuid(runtime, userMessage.id),
  roomId: roomUuid,
  entityId: runtime.agentId,  // ← Agent is the sender
  agentId: runtime.agentId,
  content: {
    text: responseText,
    source: "agent",
    inReplyTo: userMessage.id,  // ← Links to the user's message
  },
  metadata: {
    type: MemoryType.MESSAGE,
    role: "agent",
  },
};

await runtime.createMemory(responseMemory, "messages");
```

---

#### Complete Data Relationship Model

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              COMPLETE RELATIONSHIP DIAGRAM                                               │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────┘

 Organizations                Characters                    Discord Connections
 ─────────────               ──────────                    ───────────────────
 ┌───────────┐         ┌──────────────────┐            ┌────────────────────┐
 │ org-uuid  │◄────────│ organization_id  │◄───────────│ organization_id    │
 │           │         │                  │            │                    │
 │ User's    │         │ character-uuid   │◄───────────│ character_id       │
 │ workspace │         │ name: "AI Helper"│            │ connection-uuid    │
 │           │         │ bio: "I help..." │            │ application_id     │
 └───────────┘         │ system_prompt    │            │ bot_token_encrypted│
                       │ knowledge: [...]  │            │                    │
                       │ settings: {...}  │            └────────────────────┘
                       └──────────────────┘


 Rooms (Channels)            Entities (Users)           Memories (Messages)
 ────────────────           ────────────────           ───────────────────
 ┌────────────────┐      ┌────────────────────┐      ┌────────────────────┐
 │ room-uuid      │      │ entity-uuid        │      │ memory-uuid        │
 │ (deterministic │      │ (deterministic     │      │                    │
 │  from channel) │      │  from Discord ID)  │      │ roomId ────────────┼──►(room)
 │                │      │                    │      │ entityId ──────────┼──►(entity)
 │ name: "Discord │      │ names: ["JohnDoe"] │      │ agentId ───────────┼──►(character)
 │  Channel #123" │      │ metadata: {        │      │                    │
 │ worldId: ...   │      │   discord: {       │      │ content: {         │
 │ source: discord│      │     id, username,  │      │   text: "Hello!"   │
 │                │      │     avatar, ...    │      │   source: "discord"│
 └────────────────┘      │   }                │      │ }                  │
                         │ }                  │      │ metadata: {        │
                         └────────────────────┘      │   discord: {...}   │
                                                     │ }                  │
                                                     └────────────────────┘
```

---

#### Key Points Summary

| Concept | How It Works |
|---------|--------------|
| **Bot → Character** | `discord_connections.character_id` → `user_characters.id` (direct link) |
| **User Identity** | Deterministic UUID from Discord user ID: `stringToUuid("discord-user-{id}")` |
| **Channel History** | Deterministic UUID from org + channel: `stringToUuid("discord-{org}-{channel}")` |
| **Message Storage** | Both user and agent messages saved as `Memory` in the room |
| **Context Isolation** | Each organization has separate rooms even for same Discord channel |
| **User Continuity** | Same Discord user always gets same entity UUID across all messages |

This design ensures:
- **Character consistency**: Same Discord bot always uses the same character personality
- **Conversation continuity**: Messages in a channel are stored together as history
- **User recognition**: The agent can remember and reference past interactions with a user
- **Organization isolation**: Different orgs can't see each other's conversations

---

### 4. End-to-End Examples

#### Phase 1: Setup (One-time)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 1: Admin creates a Discord bot connection                               │
└─────────────────────────────────────────────────────────────────────────────┘

User Dashboard                          Eliza Cloud                      PostgreSQL
     │                                       │                               │
     │  POST /api/discord/connections        │                               │
     │  {                                    │                               │
     │    characterId: "eliza-app-uuid",           │                               │
     │    applicationId: "discord-app-id",   │                               │
     │    botToken: "Bot MTIz..."            │                               │
     │  }                                    │                               │
     │──────────────────────────────────────►│                               │
     │                                       │                               │
     │                                       │  1. Encrypt token (AES-256)   │
     │                                       │  2. INSERT discord_connections│
     │                                       │────────────────────────────────►│
     │                                       │                               │
     │                                       │   ✓ Connection created        │
     │                                       │◄────────────────────────────────│
     │  { id: "conn-uuid", status: "pending"}│                               │
     │◄──────────────────────────────────────│                               │

Database state after:
┌────────────────────────────────────────────────────────────────────────────┐
│ discord_connections                                                         │
├─────────────┬────────────────┬──────────────┬────────────┬─────────────────┤
│ id          │ organization_id│ assigned_pod │ status     │ is_active       │
├─────────────┼────────────────┼──────────────┼────────────┼─────────────────┤
│ conn-uuid   │ org-uuid       │ NULL         │ pending    │ true            │
└─────────────┴────────────────┴──────────────┴────────────┴─────────────────┘
```

#### Phase 2: Gateway Pod Startup

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 2: Gateway pod starts and claims connections                            │
└─────────────────────────────────────────────────────────────────────────────┘

Kubernetes                     Gateway Pod                    Eliza Cloud
     │                              │                              │
     │  kubectl apply deployment    │                              │
     │─────────────────────────────►│                              │
     │                              │                              │
     │                              │  GET /assignments?pod=gw-1   │
     │                              │  &current=0&max=100          │
     │                              │─────────────────────────────►│
     │                              │                              │
     │                              │                   ┌──────────┴──────────┐
     │                              │                   │ 1. Find unassigned  │
     │                              │                   │ 2. Decrypt tokens   │
     │                              │                   │ 3. Claim for pod    │
     │                              │                   └──────────┬──────────┘
     │                              │                              │
     │                              │  { assignments: [{           │
     │                              │      connectionId: "...",    │
     │                              │      botToken: "Bot MTIz..." │
     │                              │  }]}                         │
     │                              │◄─────────────────────────────│
     │                              │                              │

Database state after:
┌────────────────────────────────────────────────────────────────────────────┐
│ discord_connections                                                         │
├─────────────┬──────────────┬────────────┬─────────────────┬────────────────┤
│ id          │ assigned_pod │ status     │ last_heartbeat  │ connected_at   │
├─────────────┼──────────────┼────────────┼─────────────────┼────────────────┤
│ conn-uuid   │ gw-1         │ connecting │ NULL            │ NULL           │
└─────────────┴──────────────┴────────────┴─────────────────┴────────────────┘
```

#### Phase 3: Discord WebSocket Connection

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 3: Gateway connects to Discord WebSocket                                │
└─────────────────────────────────────────────────────────────────────────────┘

Gateway Pod                    Discord API                    Eliza Cloud
     │                              │                              │
     │  WebSocket: wss://gateway.   │                              │
     │  discord.gg/?v=10            │                              │
     │─────────────────────────────►│                              │
     │                              │                              │
     │  HELLO (heartbeat interval)  │                              │
     │◄─────────────────────────────│                              │
     │                              │                              │
     │  IDENTIFY (token, intents)   │                              │
     │─────────────────────────────►│                              │
     │                              │                              │
     │  READY (bot info, guilds)    │                              │
     │◄─────────────────────────────│                              │
     │                              │                              │
     │                  ┌───────────┴───────────┐                  │
     │                  │ Bot User ID: 987...   │                  │
     │                  │ Guild Count: 3        │                  │
     │                  └───────────┬───────────┘                  │
     │                              │                              │
     │  POST /status                │                              │
     │  { status: "connected",      │                              │
     │    bot_user_id: "987..." }   │                              │
     │────────────────────────────────────────────────────────────►│
     │                              │                              │

Database state after:
┌─────────────────────────────────────────────────────────────────────────────┐
│ discord_connections                                                          │
├─────────────┬──────────────┬───────────┬─────────────┬────────────┬─────────┤
│ id          │ assigned_pod │ status    │ bot_user_id │ connected_at│ guilds │
├─────────────┼──────────────┼───────────┼─────────────┼────────────┼─────────┤
│ conn-uuid   │ gw-1         │ connected │ 987...      │ 2024-01-15 │ 3      │
└─────────────┴──────────────┴───────────┴─────────────┴────────────┴─────────┘
```

#### Phase 4: Heartbeat Loop (Every 15 seconds)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 4: Gateway sends periodic heartbeats                                    │
└─────────────────────────────────────────────────────────────────────────────┘

Gateway Pod                         Redis                      Eliza Cloud
     │                                │                              │
     │  ┌─────────────────────────────┴──────────────────────────────┤
     │  │ Every 15 seconds:                                          │
     │  └─────────────────────────────┬──────────────────────────────┤
     │                                │                              │
     │  SETEX discord:pod:gw-1        │                              │
     │  TTL=300s                      │                              │
     │  { connections: [...],         │                              │
     │    lastHeartbeat: 1705320000 } │                              │
     │───────────────────────────────►│                              │
     │                                │                              │
     │  SADD discord:active_pods gw-1 │                              │
     │───────────────────────────────►│                              │
     │                                │                              │
     │  POST /heartbeat               │                              │
     │  { pod_name: "gw-1",           │                              │
     │    connection_ids: ["..."] }   │                              │
     │────────────────────────────────────────────────────────────────►│
     │                                │                              │
     │                                │              UPDATE last_heartbeat
     │                                │                              │
```

#### Phase 5: Message Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 5: User sends message in Discord                                        │
└─────────────────────────────────────────────────────────────────────────────┘

Discord User          Discord           Gateway Pod           Eliza Cloud
     │                   │                   │                      │
     │  "Hello bot!"     │                   │                      │
     │──────────────────►│                   │                      │
     │                   │                   │                      │
     │                   │ MESSAGE_CREATE    │                      │
     │                   │ (WebSocket)       │                      │
     │                   │──────────────────►│                      │
     │                   │                   │                      │
     │                   │                   │ POST /events         │
     │                   │                   │ {                    │
     │                   │                   │   event_type: "MESSAGE_CREATE",
     │                   │                   │   data: {            │
     │                   │                   │     content: "Hello bot!",
     │                   │                   │     author: {...}    │
     │                   │                   │   }                  │
     │                   │                   │ }                    │
     │                   │                   │─────────────────────►│
     │                   │                   │                      │
     │                   │                   │         ┌────────────┴────────────┐
     │                   │                   │         │ Event Router:           │
     │                   │                   │         │ 1. Check channel filter │
     │                   │                   │         │ 2. Check response mode  │
     │                   │                   │         │ 3. Get linked app       │
     │                   │                   │         │ 4. Create AgentRuntime  │
     │                   │                   │         │ 5. Process message      │
     │                   │                   │         │ 6. Generate response    │
     │                   │                   │         └────────────┬────────────┘
     │                   │                   │                      │
     │                   │  POST /channels/  │                      │
     │                   │  .../messages     │                      │
     │                   │  { content: "Hi!" }                      │
     │                   │◄─────────────────────────────────────────│
     │                   │                   │                      │
     │  "Hi! How can I   │                   │                      │
     │   help you?"      │                   │                      │
     │◄──────────────────│                   │                      │
```

#### Phase 6: Failover (Pod Crash Scenario)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 6: Gateway pod crashes, another pod takes over                          │
└─────────────────────────────────────────────────────────────────────────────┘

Gateway Pod 1 (gw-1)      Redis          Gateway Pod 2 (gw-2)    Eliza Cloud
     │                      │                    │                    │
     │  💥 CRASH!           │                    │                    │
     X                      │                    │                    │
                            │                    │                    │
     ┌──────────────────────┴──────────────────────────────────────────┐
     │ After 45 seconds (DEAD_POD_THRESHOLD_MS):                       │
     └──────────────────────┬──────────────────────────────────────────┘
                            │                    │                    │
                            │  Every 30s: Check  │                    │
                            │  for dead pods     │                    │
                            │◄───────────────────│                    │
                            │                    │                    │
                            │  GET discord:pod:  │                    │
                            │  gw-1              │                    │
                            │  → lastHeartbeat   │                    │
                            │    is 50s old!     │                    │
                            │───────────────────►│                    │
                            │                    │                    │
                            │                    │ POST /failover     │
                            │                    │ { claiming: "gw-2",│
                            │                    │   dead: "gw-1" }   │
                            │                    │───────────────────►│
                            │                    │                    │
                            │                    │   ┌────────────────┴────────┐
                            │                    │   │ 1. Verify gw-1 is dead │
                            │                    │   │ 2. Reassign connections│
                            │                    │   │    gw-1 → NULL         │
                            │                    │   │ 3. Set status=pending  │
                            │                    │   └────────────────┬────────┘
                            │                    │                    │
                            │                    │ { claimed: 5 }     │
                            │                    │◄───────────────────│
                            │                    │                    │
                            │  SREM active_pods  │                    │
                            │  gw-1              │                    │
                            │◄───────────────────│                    │
                            │                    │                    │
     ┌──────────────────────┴──────────────────────────────────────────┐
     │ On next poll cycle (30s), gw-2 gets the connections             │
     └──────────────────────────────────────────────────────────────────┘
```

#### Phase 7: Graceful Shutdown (Deployment Update)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ STEP 7: Pod receives SIGTERM during rolling deployment                       │
└─────────────────────────────────────────────────────────────────────────────┘

Kubernetes             Gateway Pod (gw-1)         Redis         Eliza Cloud
     │                      │                       │                │
     │  SIGTERM             │                       │                │
     │─────────────────────►│                       │                │
     │                      │                       │                │
     │                      │ 1. Stop accepting     │                │
     │                      │    new connections    │                │
     │                      │                       │                │
     │                      │ 2. Disconnect all     │                │
     │                      │    Discord WebSockets │                │
     │                      │                       │                │
     │                      │ 3. POST /shutdown     │                │
     │                      │    { pod_name: "gw-1" }                │
     │                      │───────────────────────────────────────►│
     │                      │                       │                │
     │                      │                       │   UPDATE SET   │
     │                      │                       │   assigned_pod=NULL
     │                      │                       │   status='pending'
     │                      │                       │                │
     │                      │ { released: 5 }       │                │
     │                      │◄───────────────────────────────────────│
     │                      │                       │                │
     │                      │ DEL discord:pod:gw-1  │                │
     │                      │───────────────────────►│               │
     │                      │                       │                │
     │                      │ SREM active_pods gw-1 │                │
     │                      │───────────────────────►│               │
     │                      │                       │                │
     │  exit(0)             │                       │                │
     │◄─────────────────────│                       │                │
     │                      │                       │                │
     ┌──────────────────────┴───────────────────────────────────────────┐
     │ Other pods immediately see the released connections on next poll │
     │ No 45s failover wait required!                                   │
     └──────────────────────────────────────────────────────────────────┘
```

### Connection Status Transitions

```
                    ┌─────────────────────────────────────────┐
                    │           CONNECTION LIFECYCLE           │
                    └─────────────────────────────────────────┘

    ┌─────────┐     Poll assigns      ┌────────────┐     Login success   ┌───────────┐
    │ pending │────────────────────────│ connecting │─────────────────────│ connected │
    └─────────┘     to a pod          └────────────┘                     └───────────┘
         ▲                                  │                                   │
         │                                  │ Login fails                       │
         │                                  ▼                                   │
         │                            ┌─────────┐                               │
         │◄───────────────────────────│  error  │                               │
         │   Retry on next poll       └─────────┘                               │
         │                                                                      │
         │                                                                      │
         │   Pod shutdown/            ┌──────────────┐                          │
         │   Failover                 │ disconnected │◄─────────────────────────┘
         └────────────────────────────└──────────────┘   WebSocket disconnect
```

---

## Kubernetes Deployment

The gateway is deployed to Kubernetes using **Helm charts** (recommended) for better release management and environment-specific configuration.

### Quick Start with Helm

```bash
# Deploy to development
helm upgrade --install gateway-discord ./chart \
  --namespace gateway-discord \
  --create-namespace \
  -f ./chart/values.yaml \
  -f ./chart/values-development.yaml

# Deploy to production
helm upgrade --install gateway-discord ./chart \
  --namespace gateway-discord \
  --create-namespace \
  -f ./chart/values.yaml \
  -f ./chart/values-production.yaml

# Uninstall
helm uninstall gateway-discord -n gateway-discord
```

### Release Management

```bash
# View release history
helm history gateway-discord -n gateway-discord

# Rollback to previous version
helm rollback gateway-discord -n gateway-discord

# View current deployed values
helm get values gateway-discord -n gateway-discord
```

### K8s Resources

```
┌─────────────────────────────────────────────────────────────────────┐
│ Namespace: gateway-discord (Helm Release: gateway-discord)          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐ │
│  │   Deployment    │    │       HPA       │    │       PDB       │ │
│  │                 │    │                 │    │                 │ │
│  │ replicas: 2     │◄───│ min: 2, max: 10 │    │ minAvailable: 1 │ │
│  │ (auto-scaled)   │    │ target CPU: 70% │    │ (HA guarantee)  │ │
│  └────────┬────────┘    └─────────────────┘    └─────────────────┘ │
│           │                                                         │
│           ▼                                                         │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                        Pods                                  │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │   │
│  │  │  gw-pod-1   │  │  gw-pod-2   │  │  gw-pod-N   │   ...    │   │
│  │  │  100 bots   │  │  100 bots   │  │  100 bots   │          │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘          │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────┐    ┌─────────────────┐                        │
│  │ ServiceMonitor  │    │     Alerts      │                        │
│  │ (Prometheus)    │    │ (PrometheusRule)│                        │
│  │                 │    │                 │                        │
│  │ /metrics scrape │    │ - HighErrorRate │                        │
│  │ every 15s       │    │ - ControlPlane  │                        │
│  └─────────────────┘    │ - PodCrash      │                        │
│                         └─────────────────┘                        │
└─────────────────────────────────────────────────────────────────────┘
```

| Resource | Helm Template | Purpose |
|----------|---------------|---------|
| Deployment | `chart/templates/deployment.yaml` | Pod specification with probes |
| Service | `chart/templates/deployment.yaml` | ClusterIP service |
| HPA | `chart/templates/hpa.yaml` | Auto-scaling (configurable replicas) |
| PDB | `chart/templates/pdb.yaml` | Ensures HA during updates |
| ServiceMonitor | `chart/templates/servicemonitor.yaml` | Prometheus scraping (conditional) |
| PrometheusRule | `chart/templates/alerts.yaml` | Alerting rules (conditional) |

### Values Files

| File | Description |
|------|-------------|
| `chart/values.yaml` | Default values for all environments |
| `chart/values-development.yaml` | Development overrides (smaller resources) |
| `chart/values-production.yaml` | Production overrides (more resources, Prometheus enabled) |

### Required Secrets

Create a Kubernetes secret before deploying:
```bash
kubectl create namespace gateway-discord

# Base secrets (required)
kubectl create secret generic gateway-discord-secrets \
  --namespace gateway-discord \
  --from-literal=eliza-cloud-url="https://your-eliza-cloud-url.com" \
  --from-literal=gateway-bootstrap-secret="your-bootstrap-secret" \
  --from-literal=redis-url="https://your-redis-url" \
  --from-literal=redis-token="your-redis-token" \
  --from-literal=blob-token="your-blob-token"
```

**For Eliza App Discord bot** (optional - only if enabling `elizaAppBot.enabled: true`):
```bash
# Add Eliza App Discord bot secrets
kubectl patch secret gateway-discord-secrets \
  --namespace gateway-discord \
  --type='json' \
  -p='[
    {"op": "add", "path": "/data/eliza-app-discord-bot-token", "value": "'$(echo -n "your-bot-token" | base64)'"},
    {"op": "add", "path": "/data/eliza-app-discord-application-id", "value": "'$(echo -n "your-app-id" | base64)'"}
  ]'
```

Then enable in your Helm values:
```yaml
elizaAppBot:
  enabled: true
```

**Note**: The gateway uses JWT authentication. The `gateway-bootstrap-secret` is exchanged for a JWT token at startup. The Eliza Cloud API must have the corresponding JWT signing keys configured.

For detailed deployment instructions, see [chart/README.md](./chart/README.md).

---

## Infrastructure (Terraform)

The AWS infrastructure required to run the gateway is managed via **Terraform** in the `terraform/` directory.

**What gets provisioned:**
- VPC with public/private subnets across 3 AZs
- EKS cluster for running the gateway pods
- NAT Instance (cost-effective alternative to NAT Gateway)
- IAM roles for EKS and GitHub Actions OIDC
- Kubernetes namespace and secrets

**Automated via GitHub Actions** (`.github/workflows/gateway-discord.yml`):
- Push to `develop` branch → Terraform apply + app deploy to development
- Push to `main` branch → Terraform apply + app deploy to production
- Workflow auto-detects terraform vs app changes and runs appropriate jobs
- If both change, terraform runs first, then deploy waits for completion

```bash
# Manual deployment (if needed)
cd terraform

# Development
terraform init -backend-config=backend-development.hcl
terraform plan -var-file=development.tfvars -var-file=secrets.tfvars
terraform apply -var-file=development.tfvars -var-file=secrets.tfvars

# Production
terraform init -backend-config=backend-production.hcl -reconfigure
terraform plan -var-file=production.tfvars -var-file=secrets.tfvars
terraform apply -var-file=production.tfvars -var-file=secrets.tfvars
```

For detailed infrastructure documentation, see [terraform/README.md](./terraform/README.md).
