# Fanout plan — filling the 145 uncovered routes

The foundation lives at [`test/e2e/agent-token-flow.test.ts`](e2e/agent-token-flow.test.ts).
Every group below should follow the same patterns:

- Place tests under `cloud/packages/tests/e2e/api/<group>.test.ts` so they
  inherit the existing `bun test --preload packages/tests/e2e/preload.ts`
  pipeline. Use the local `apps/api/test/e2e/_helpers/api.ts` import path.
- Each route gets at least three assertions:
  1. **Auth gate** — request without credentials returns 401/403/404 as
     declared by `apps/api/src/middleware/auth.ts`'s public-path list.
  2. **Happy path** — with a valid Bearer key (or session cookie for
     session-only routes), the response shape matches the route's Zod schema
     or the documented JSON.
  3. **Validation** — at least one body / query-param failure returns the
     expected 400 with a structured `error`.
- Cron + webhook routes use `cronHeaders()` / signed-payload helpers from
  the existing `cloud/packages/tests/e2e/helpers/api-client.ts`.
- Skip cleanly (`test.skipIf(...)`) for routes that need a real third-party
  secret (`STRIPE_SECRET_KEY`, `ELEVENLABS_API_KEY`, `FAL_KEY`,
  `ANTHROPIC_API_KEY`). The test must be runnable locally without paid keys.

## Group A — Authentication, sessions, identity (12)

Owner: `eliza-plugin-dev` (auth flows are core).

```
/api/auth/anonymous-session
/api/auth/pair
/api/auth/steward-debug
/api/auth/steward-session
/api/anonymous-session
/api/set-anonymous-session
/api/sessions/current
/api/internal/auth/refresh
/api/internal/identity/resolve
/api/test/auth/session                 ← already exercised by foundation; add direct test
/api/eliza-app/auth/connection-success
/api/eliza-app/cli-auth/init
/api/eliza-app/cli-auth/poll
/api/eliza-app/cli-auth/complete
```

## Group B — Account, billing, credits, top-ups (16)

Owner: `general-purpose`.

```
/api/v1/api-keys/:id/regenerate
/api/v1/api-keys/explorer
/api/v1/user/avatar
/api/v1/user/email
/api/v1/user/wallets
/api/v1/user/wallets/provision
/api/v1/user/wallets/rpc
/api/v1/topup/10
/api/v1/topup/50
/api/v1/topup/100
/api/v1/pricing/summary
/api/quotas/usage
/api/stats/account
/api/stripe/create-checkout-session
/api/stripe/credit-packs
/api/signup-code/redeem
```

## Group C — Agents (`/api/v1/agents`, `/api/agents`, `/api/my-agents`) (24)

Owner: `general-purpose` *(agent lifecycle, headscale, mcp wiring)*.

```
/api/agents/:id/a2a
/api/agents/:id/headscale-ip
/api/agents/:id/mcp
/api/v1/agents/:agentId
/api/v1/agents/:agentId/logs
/api/v1/agents/:agentId/monetization
/api/v1/agents/:agentId/publish
/api/v1/agents/:agentId/restart
/api/v1/agents/:agentId/resume
/api/v1/agents/:agentId/status
/api/v1/agents/:agentId/suspend
/api/v1/agents/:agentId/usage
/api/v1/agents/by-token
/api/my-agents/characters
/api/my-agents/characters/avatar
/api/my-agents/characters/:id
/api/my-agents/characters/:id/clone
/api/my-agents/characters/:id/share
/api/my-agents/characters/:id/stats
/api/my-agents/characters/:id/track-interaction
/api/my-agents/characters/:id/track-view
/api/my-agents/saved
/api/my-agents/saved/:id
/api/my-agents/claim-affiliate-characters
/api/characters/:characterId/mcps
/api/characters/:characterId/public
```

## Group D — AI / inference / media (5)

Owner: `general-purpose`. **Note** — every route here needs a live provider
key. Tests must `test.skipIf(!hasProviderKey)` when the relevant env var is
missing so the suite still runs locally.

```
/api/elevenlabs/stt
/api/elevenlabs/tts
/api/fal/proxy
/api/og
/api/openapi.json
```

## Group E — Agent / admin / advertising / training (14)

Owner: `agent-backend-dev` *(this is the Agent-specific surface)*.

```
/api/admin/redemptions
/api/v1/admin/ai-pricing
/api/v1/admin/docker-containers
/api/v1/admin/docker-containers/:id/logs
/api/v1/admin/docker-containers/audit
/api/v1/admin/docker-nodes/:nodeId/health-check
/api/v1/admin/infrastructure/containers/actions
/api/v1/advertising/accounts/:id
/api/v1/advertising/campaigns/:id
/api/v1/advertising/campaigns/:id/analytics
/api/v1/advertising/campaigns/:id/creatives
/api/v1/advertising/campaigns/:id/pause
/api/v1/advertising/campaigns/:id/start
/api/training/vertex/tune
```

## Group F — Eliza-app integration + connection initiators (15)

Owner: `connector-dev` *(Discord / Telegram / WhatsApp wiring)*.

```
/api/eliza-app/connections
/api/eliza-app/connections/:platform/initiate
/api/eliza-app/gateway/:agentId
/api/eliza-app/provision-agent
/api/eliza-app/user/me
/api/eliza-app/webhook/blooio
/api/eliza-app/webhook/discord
/api/eliza-app/webhook/telegram
/api/eliza-app/webhook/whatsapp
/api/eliza/rooms/:roomId
/api/eliza/rooms/:roomId/messages
/api/eliza/rooms/:roomId/messages/stream
/api/eliza/rooms/:roomId/welcome
/api/webhooks/blooio/:orgId
/api/webhooks/twilio/:orgId
/api/webhooks/whatsapp/:orgId
```

## Group G — MCP integrations (17)

Owner: `general-purpose`. Each `/api/mcps/<provider>/:transport` route is a
JSON-RPC bridge for the named provider. Tests should send a single
`tools/list` request and assert the bridge proxies an MCP envelope back, no
provider call required (use a stub OAuth secret in DB).

```
/api/mcps/airtable/:transport
/api/mcps/asana/:transport
/api/mcps/crypto/:transport
/api/mcps/dropbox/:transport
/api/mcps/github/:transport
/api/mcps/google/:transport
/api/mcps/hubspot/:transport
/api/mcps/jira/:transport
/api/mcps/linear/:transport
/api/mcps/linkedin/:transport
/api/mcps/microsoft/:transport
/api/mcps/notion/:transport
/api/mcps/salesforce/:transport
/api/mcps/time/:transport
/api/mcps/twitter/:transport
/api/mcps/weather/:transport
/api/mcps/zoom/:transport
```

## Group H — Misc, internal, gallery, chain, organizations, invites (20)

Owner: `general-purpose`.

```
/api/v1/chain/nfts/:chain/:address
/api/v1/chain/transfers/:chain/:address
/api/v1/gallery/:id
/api/v1/gallery/explore
/api/v1/gallery/stats
/api/v1/proxy/birdeye/*
/api/cron/agent-billing
/api/crypto/payments/:id/confirm
/api/crypto/webhook
/api/feedback
/api/internal/discord/eliza-app/messages
/api/internal/discord/events
/api/internal/discord/gateway/assignments
/api/internal/discord/gateway/failover
/api/internal/discord/gateway/heartbeat
/api/internal/discord/gateway/shutdown
/api/internal/discord/gateway/status
/api/invites/accept
/api/invites/validate
/api/organizations/invites
/api/organizations/invites/:inviteId
/api/organizations/members
/api/organizations/members/:userId
```

## Sequencing guidance

1. Land foundation (this PR) so every group has a working harness to copy.
2. Run Group A first — auth gates everything else; if a group A regression
   surfaces, B–H all break the same way.
3. Run B–C in parallel after A passes.
4. D–H last; many touch external services and will gate on env credentials.

After each group lands, regenerate `COVERAGE.md`:

```bash
bun run test:audit       # from apps/api/
```

The `Uncovered` count should drop monotonically. Aim for zero before
declaring this task done.
