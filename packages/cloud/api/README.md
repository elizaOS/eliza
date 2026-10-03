# @elizaos/cloud-api

The Eliza Cloud HTTP API: a Cloudflare Workers app (Hono router) that backs auth,
app/agent registration, inference routing, billing, MCP, A2A, domains, and container
deploys.

Runs on Cloudflare Workers with Hono. Start with `bun run --cwd packages/cloud/api dev`;
local bindings are derived from root .env/.env.local. Add routes in the file-based route
tree and run the package codegen script. The build script checks types; typecheck also
validates router and Worker bundling contracts.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/cloud/api build  # build
bun run --cwd packages/cloud/api test   # tests
```

## Independent native App Auth clients

`ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON` optionally registers additional native clients.
It is a server-owned JSON array of `{clientId, appId, redirectUri, enabled}` records.
Client IDs, app UUIDs and canonical HTTPS return URLs must be unique, including
against the existing `ai.elizaos.app` registration. Unknown and disabled clients
fail closed; malformed additional configuration does not change the legacy client.
The global mobile-auth enable switch and environment binding still apply.

Before enabling a client, provision its own active, approved app with an active
owner/organization, an exact allowed callback, and no live generated application
API key. Use separate registrations in staging and production. Validate the public
`/api/v1/app-auth/mobile/config` response for that client/environment/return URL
before shipping. The app UUID and server secrets must not be included in the
native configuration. Retain the existing S256 grant, inactive exchange, durable
receipt acknowledgment, self-revocation and account recovery contracts. `cloud:user`
is the existing broad user/organization capability, not a narrower permission claim.
