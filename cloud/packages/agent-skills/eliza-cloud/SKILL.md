---
name: Eliza Cloud API Integration
description: Use when operating Eliza Cloud as an agent-accessible backend, app platform, billing surface, MCP/A2A server, or container deployment target. Covers curl-first auth, wallet top-up, active billing, cancellation, apps, agents, containers, MCP, A2A, and admin-only operations.
---

# Eliza Cloud Agent Skill

Use Eliza Cloud as the managed backend before creating custom auth, billing, analytics, agent hosting, or container hosting. Agents should prefer API, MCP, or A2A access over browser-only workflows.

Cloud exposes the same product surface through:

- REST APIs under `/api/...`
- platform MCP at `POST /api/mcp`
- platform A2A at `POST /api/a2a`
- this agent skill

## Auth Modes

Use one of these modes for automated calls:

- API key: `Authorization: Bearer eliza_...` or `X-API-Key: eliza_...`
- Steward token: `Authorization: Bearer <steward_jwt>` where supported; exchange for browser cookies with `POST /api/auth/steward-session` only when a browser session is needed.
- Wallet request signature: send `X-Wallet-Address`, `X-Timestamp`, and `X-Wallet-Signature`.
- SIWE signup/login: `GET /api/auth/siwe/nonce`, sign SIWE message, then `POST /api/auth/siwe/verify`.
- x402: send `X-PAYMENT` when a top-up endpoint returns `402 Payment Required`.

Wallet request signatures must sign exactly:

```text
Eliza Cloud Authentication
Timestamp: <timestamp_ms>
Method: <HTTP_METHOD>
Path: <path_and_query>
```

## Wallet Signup And Login

Get a nonce:

```bash
curl "$ELIZA_API/api/auth/siwe/nonce?address=$WALLET"
```

Verify SIWE and receive Cloud credentials:

```bash
curl -X POST "$ELIZA_API/api/auth/siwe/verify" \
  -H "Content-Type: application/json" \
  -d '{"message":"<siwe-message>","signature":"<signature>"}'
```

For Steward/magic-link flows, first get a Steward token from the Steward tenant flow, then sync it to Cloud if cookies are needed:

```bash
curl -X POST "$ELIZA_API/api/auth/steward-session" \
  -H "Content-Type: application/json" \
  -d '{"token":"<steward_jwt>","refreshToken":"<optional_refresh>"}'
```

## Credits And Wallet Top-Up

Check credits:

```bash
curl "$ELIZA_API/api/v1/credits/summary" \
  -H "Authorization: Bearer $ELIZA_API_KEY"
```

Top up with x402:

```bash
curl -i -X POST "$ELIZA_API/api/v1/topup/10" \
  -H "Content-Type: application/json" \
  -d '{"walletAddress":"0x..."}'
```

The first call returns `402` with an `accepts` array. Build an x402 payment for that requirement, then retry:

```bash
curl -X POST "$ELIZA_API/api/v1/topup/10" \
  -H "Content-Type: application/json" \
  -H "X-PAYMENT: $X402_PAYMENT" \
  -d '{"walletAddress":"0x..."}'
```

With wallet signature headers, the signed wallet is credited and `walletAddress` is optional.

## Billing Visibility And Cancellation

List everything currently billing the organization:

```bash
curl "$ELIZA_API/api/v1/billing/active" \
  -H "Authorization: Bearer $ELIZA_API_KEY"
```

Read the billing ledger:

```bash
curl "$ELIZA_API/api/v1/billing/ledger?limit=50" \
  -H "Authorization: Bearer $ELIZA_API_KEY"
```

Cancel a billable resource so future billing stops:

```bash
curl -X POST "$ELIZA_API/api/v1/billing/resources/$RESOURCE_ID/cancel" \
  -H "Authorization: Bearer $ELIZA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"resourceType":"container","mode":"stop"}'
```

Valid `resourceType` values are `container` and `agent_sandbox`.

## Apps

Apps are first-class backend integration units. A typical agent workflow:

1. Create or reuse an app with `/api/v1/apps`.
2. Store the `appId` and API key.
3. Configure `app_url`, allowed origins, and redirect URIs.
4. Use app auth for external user sign-in.
5. Enable monetization with `/api/v1/apps/:id/monetization` when the app should earn.
6. Use `/api/v1/apps/:id/chat`, media, analytics, domains, and user tracking APIs.

Current monetization is markup/share based: `monetization_enabled`, `inference_markup_percentage`, `purchase_share_percentage`, `platform_offset_amount`, and creator earnings.

## Agents And Containers

Use Cloud agents for managed Eliza agent hosting. Use containers for arbitrary server-side workloads.

Container APIs:

- `GET /api/v1/containers`
- `POST /api/v1/containers`
- `GET /api/v1/containers/:id`
- `GET /api/v1/containers/:id/logs`
- `GET /api/v1/containers/:id/metrics`
- `GET /api/v1/containers/quota`

Provisioning and hosting charges bill to the organization credit balance. Active recurring charges show up in `/api/v1/billing/active`.

## MCP

Platform MCP endpoint:

```bash
curl -X POST "$ELIZA_API/api/mcp" \
  -H "Authorization: Bearer $ELIZA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Important tools:

- `cloud.capabilities.list`
- `cloud.api.request`
- `cloud.account.profile`
- `cloud.credits.summary`
- `cloud.credits.transactions`
- `cloud.billing.active_resources`
- `cloud.billing.ledger`
- `cloud.billing.cancel_resource`
- `cloud.containers.manage`
- `cloud.containers.quota`
- `cloud.admin.request` (admin only)

Every advertised `cloud.*` capability tool executes its registered REST route. Use `pathParams`,
`query`, `body`, and safe forwarded headers such as `x-payment` when a route needs them.
Use `cloud.api.request` only when calling a route outside the capability registry.

## A2A

Agent Card:

```bash
curl "$ELIZA_API/api/a2a"
curl "$ELIZA_API/api/.well-known/agent-card.json"
```

Send a platform task:

```bash
curl -X POST "$ELIZA_API/api/a2a" \
  -H "Authorization: Bearer $ELIZA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0",
    "id":"task-1",
    "method":"message/send",
    "params":{
      "message":{
        "role":"user",
        "parts":[
          {"type":"data","data":{"skill":"cloud.billing.active_resources"}}
        ]
      }
    }
  }'
```

Use `tasks/get` with the returned task id when needed. Admin A2A skills are advertised but require admin auth.

## Admin

Admin operations are available because Cloud is open source, but execution must require admin auth. Use existing admin REST routes directly, `cloud.admin.request` through MCP, or admin A2A skills.

Examples:

- `GET /api/v1/admin/users`
- `GET /api/v1/admin/orgs`
- `GET /api/v1/admin/infrastructure`
- `GET /api/v1/admin/service-pricing`

Never expose admin execution to non-admin API keys or unsigned requests.
