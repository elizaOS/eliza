# OAuth Architecture

## Overview

This document explains how OAuth connections relate to users, organizations, and agent runtimes in eliza-cloud-v2. It covers the data model, credential flow, and how tools (like MCP servers) can leverage OAuth credentials.

---

## Data Model

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Organization                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  id: "org-123"                                                      │    │
│  │  credit_balance: "25.00"                                            │    │
│  │                                                                     │    │
│  │  ┌──────────────────────┐    ┌──────────────────────────────────┐  │    │
│  │  │        User          │    │      OAuth Connections           │  │    │
│  │  │  id: "user-456"      │    │  (platform_credentials table)    │  │    │
│  │  │  email: "..."        │    │                                  │  │    │
│  │  │  organization_id ────┼────┤  ┌────────────────────────────┐  │  │    │
│  │  │                      │    │  │ id: "conn-789"             │  │  │    │
│  │  │  (entityId in Eliza) │    │  │ platform: "google"         │  │  │    │
│  │  └──────────────────────┘    │  │ platform_email: "user@..." │  │  │    │
│  │                              │  │ status: "active"           │  │  │    │
│  │                              │  │ access_token_secret_id ────┼──┼──┼────┼──► Secrets Service
│  │                              │  │ refresh_token_secret_id ───┼──┼──┼────┼──► (encrypted)
│  │                              │  │ scopes: [...]              │  │  │    │
│  │                              │  └────────────────────────────┘  │  │    │
│  │                              └──────────────────────────────────┘  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Relationships

| Entity | Relationship | Notes |
|--------|--------------|-------|
| **User** | belongs to 1 Organization | `user.organization_id` |
| **Organization** | has many Users | Currently 1:1, but schema supports many |
| **Organization** | has many OAuth Connections | Credentials scoped to org |
| **User** | = `entityId` in elizaOS | Used to identify user in messages |

### Why Organization-Scoped?

OAuth connections are scoped to **organization** (not user) because:
1. Multiple users in an org can share the same Google Workspace connection
2. API keys and service accounts are org-level resources
3. Billing/credits are tracked at org level

In practice, with 1 user = 1 organization, this means each user has their own isolated OAuth connections.

---

## Agent Runtime Context

When a message arrives at the agent:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Incoming Message                                                           │
│  ├── entityId: "user-456"        ← Who sent this message                   │
│  ├── roomId: "room-abc"          ← Conversation context                    │
│  └── content: { text: "..." }                                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Agent Runtime                                                              │
│  ├── character: { ... }          ← Agent personality/config                │
│  ├── plugins: [                                                             │
│  │     plugin-oauth,             ← OAuth actions available                 │
│  │     plugin-mcp,               ← MCP tools available                     │
│  │     ...                                                                  │
│  │   ]                                                                      │
│  └── providers: [                                                           │
│        userAuthStatusProvider    ← Injects user's OAuth status into context│
│      ]                                                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Agent Context (what LLM sees)                                              │
│                                                                             │
│  # User Authentication Status                                               │
│  - Connections: Google (user@gmail.com)                                     │
│  - Credits: 25.00                                                           │
│  - Status: Fully authenticated                                              │
│                                                                             │
│  Available Actions: OAUTH_CONNECT, OAUTH_LIST, OAUTH_GET, OAUTH_REVOKE     │
└─────────────────────────────────────────────────────────────────────────────┘
```

The agent **knows** what OAuth connections exist but **never sees** the actual tokens.

---

## OAuth Flow (Chat-Based)

```
User (Telegram/iMessage)              Agent                    OAuth Service
        │                               │                            │
        │  "connect google"             │                            │
        │──────────────────────────────►│                            │
        │                               │                            │
        │                               │  lookupUser(entityId)      │
        │                               │───────────────────────────►│
        │                               │  { organizationId, userId }│
        │                               │◄───────────────────────────│
        │                               │                            │
        │                               │  initiateAuth(orgId, ...)  │
        │                               │───────────────────────────►│
        │                               │  { authUrl, state }        │
        │                               │◄───────────────────────────│
        │                               │                            │
        │  "Click here to connect:      │                            │
        │   https://accounts.google..." │                            │
        │◄──────────────────────────────│                            │
        │                               │                            │
        │  [User clicks, authorizes     │                            │
        │   in browser]                 │                            │
        │                               │                            │
        │  [Callback stores tokens]     │                            │
        │                               │                            │
        │  "done"                       │                            │
        │──────────────────────────────►│                            │
        │                               │  isPlatformConnected()     │
        │                               │───────────────────────────►│
        │                               │  true                      │
        │                               │◄───────────────────────────│
        │                               │                            │
        │  "Google connected!           │                            │
        │   Logged in as user@gmail"    │                            │
        │◄──────────────────────────────│                            │
```

---

## Credential Access Pattern

### How Actions Access OAuth Tokens

Actions run server-side and can access tokens via `oauthService`:

```typescript
// In an action handler
handler: async (runtime, message, state) => {
  // 1. Get user's organization
  const { organizationId } = await lookupUser(message.entityId);

  // 2. Get valid token (auto-refreshes if expired)
  const { accessToken } = await oauthService.getValidTokenByPlatform({
    organizationId,
    platform: "google"
  });

  // 3. Use token to call external API
  const response = await fetch("https://www.googleapis.com/calendar/v3/...", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  // 4. Return sanitized result (never expose token to agent)
  return { text: "Found 5 calendar events", data: { count: 5 } };
}
```

### Security Model

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  LLM / Agent                                                                │
│  ✗ Cannot see: access tokens, refresh tokens, secrets                       │
│  ✓ Can see: connection status, email, platform name                         │
│  ✓ Can invoke: actions that USE tokens internally                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ invokes action
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Action Handler (Server-Side)                                               │
│  ✓ Has access to: oauthService, secretsService                              │
│  ✓ Can fetch: tokens for user's organization                                │
│  ✓ Can call: external APIs with credentials                                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ encrypted storage
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Secrets Service                                                            │
│  - Tokens encrypted at rest                                                 │
│  - Access audited                                                           │
│  - Scoped to organization                                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Example: Adding Google MCP Server

### Use Case

User wants to add a Google Calendar MCP server so the agent can read/write calendar events using the user's connected Google account.

### How It Would Work

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  1. User connects Google OAuth (existing flow)                              │
│     "connect google" → OAuth flow → tokens stored                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  2. MCP Server configured in character settings                             │
│                                                                             │
│  settings: {                                                                │
│    mcp: {                                                                   │
│      servers: {                                                             │
│        "google-calendar": {                                                 │
│          type: "sse",                                                       │
│          url: "/api/mcp/google-calendar"   ← Internal endpoint             │
│        }                                                                    │
│      }                                                                      │
│    }                                                                        │
│  }                                                                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  3. MCP Server endpoint (OAuth-aware)                                       │
│                                                                             │
│  // api/mcp/google-calendar/route.ts                                        │
│  export async function GET(request: NextRequest) {                          │
│    const { user } = await requireAuth(request);                             │
│                                                                             │
│    // Fetch OAuth token for this user's org                                 │
│    const { accessToken } = await oauthService.getValidTokenByPlatform({     │
│      organizationId: user.organization_id,                                  │
│      platform: "google"                                                     │
│    });                                                                      │
│                                                                             │
│    // Create MCP server instance with credentials                           │
│    const mcpServer = new GoogleCalendarMCP({ accessToken });                │
│    return mcpServer.handleSSE(request);                                     │
│  }                                                                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  4. Agent uses MCP tools                                                    │
│                                                                             │
│  User: "What's on my calendar tomorrow?"                                    │
│  Agent: [calls google-calendar.list_events tool]                            │
│  MCP Server: [uses injected accessToken to call Google API]                 │
│  Agent: "You have 3 meetings tomorrow: ..."                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Architecture Diagram

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────────────────────┐
│    Agent     │────►│  MCP Client  │────►│  MCP Server (internal endpoint)  │
│   (LLM)      │     │ (plugin-mcp) │     │  /api/mcp/google-calendar        │
└──────────────┘     └──────────────┘     └──────────────────────────────────┘
                                                          │
                                                          │ injects OAuth token
                                                          ▼
                                          ┌──────────────────────────────────┐
                                          │      oauthService                │
                                          │  getValidTokenByPlatform()       │
                                          └──────────────────────────────────┘
                                                          │
                                                          ▼
                                          ┌──────────────────────────────────┐
                                          │     Google Calendar API          │
                                          │  (with user's access token)      │
                                          └──────────────────────────────────┘
```

---

## Current Limitations

### ⚠️ Service-Only Access (No External API)

**The OAuth service is accessed directly, not via HTTP API.**

```typescript
// Current approach (works only within this repo)
import { oauthService } from "@/lib/services/oauth";
const token = await oauthService.getValidTokenByPlatform({ ... });

// NOT available (would be needed for external MCP servers)
// GET /api/v1/oauth/token?platform=google&organizationId=...
```

**Implications:**

| Scenario | Works? | Notes |
|----------|--------|-------|
| OAuth actions in plugin-oauth | ✅ Yes | Direct service import |
| MCP server as Next.js API route | ✅ Yes | Same repo, can import service |
| External MCP server (separate process) | ❌ No | Cannot import service |
| Standalone MCP binary | ❌ No | Would need HTTP API |

### Why This Limitation Exists

1. **Security**: Exposing an OAuth token endpoint creates attack surface
2. **Simplicity**: Direct service calls are simpler than HTTP + auth
3. **Scope**: Current use case is Vercel-deployed Next.js app

### Future: OAuth Token API

To support external MCP servers, we would need:

```typescript
// New API endpoint
// GET /api/v1/oauth/token
export async function GET(request: NextRequest) {
  // 1. Authenticate request (API key or session)
  const { user } = await requireAuthOrApiKey(request);

  // 2. Validate platform parameter
  const platform = request.nextUrl.searchParams.get("platform");
  if (!platform) return error("platform required");

  // 3. Fetch token
  const token = await oauthService.getValidTokenByPlatform({
    organizationId: user.organization_id,
    platform
  });

  // 4. Return token (short-lived, for immediate use)
  return NextResponse.json({
    accessToken: token.accessToken,
    expiresAt: token.expiresAt,
    scopes: token.scopes
  });
}
```

This would enable external MCP servers to fetch credentials:

```typescript
// External MCP server
const tokenResponse = await fetch(
  `https://elizacloud.ai/api/v1/oauth/token?platform=google`,
  { headers: { Authorization: `Bearer ${apiKey}` } }
);
const { accessToken } = await tokenResponse.json();
```

---

## Summary

| Component | Role |
|-----------|------|
| **User** | Human identity, mapped to `entityId` in elizaOS |
| **Organization** | Credential scope, billing entity |
| **OAuth Connection** | Platform credentials (Google, etc.) |
| **Agent Runtime** | Loads plugins, processes messages |
| **userAuthStatusProvider** | Tells agent what connections exist |
| **oauthService** | Backend service to fetch/refresh tokens |
| **Action Handlers** | Server-side code that uses tokens |

The agent orchestrates actions but never touches credentials directly. All credential access happens server-side through `oauthService`, ensuring tokens are never exposed to the LLM.
