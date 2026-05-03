# Steward Deployment

Steward dashboard and wallet-management endpoints are served by the Eliza Cloud API Worker. There is no separate Steward app, Railway service, or Steward Worker to deploy from this repo.

## Deployment Path

Deploy the normal Cloud stack:

```bash
bun run deploy:api
bun run deploy:web
```

Or deploy both:

```bash
bun run deploy
```

The old `deploy-steward.yml` Railway workflow has been removed. Steward-related changes now ship with the Cloud API Worker deployment.

## Runtime Shape

- Dashboard calls under `/api/v1/eliza/agents/:agentId/api/wallet/*` are handled by `apps/api` directly.
- The Cloud Worker checks the agent belongs to the authenticated organization before it calls Steward.
- Tenant API credentials are resolved through the organization-linked Steward tenant first, with the default Cloud tenant as fallback.
- Worker secrets are read from Cloudflare bindings, not module-level `process.env` snapshots.

## Required Worker Secrets

Set these with `wrangler secret put` or `packages/scripts/cf-secrets-migrate.mjs`:

| Variable | Description |
|----------|-------------|
| `STEWARD_SESSION_SECRET` or `STEWARD_JWT_SECRET` | Secret used to verify Steward session JWTs |
| `STEWARD_TENANT_ID` | Default tenant scope |
| `STEWARD_TENANT_API_KEY` | Default tenant API key |
| `STEWARD_PLATFORM_KEYS` | Platform key list for tenant operations |
| `STEWARD_API_URL` | Optional Steward control-plane URL override |
| `NEXT_PUBLIC_STEWARD_API_URL` | Optional browser/client mirror for Steward auth SDKs |

If `STEWARD_API_URL` is omitted, server-side Steward client code uses `NEXT_PUBLIC_STEWARD_API_URL`, then `NEXT_PUBLIC_API_URL + /steward`, or the current request origin for route-scoped calls. Local development should set one of those values explicitly, usually `http://localhost:8787/steward`.

## Verification

After deployment, verify the single Worker path:

```bash
curl -I https://api.elizacloud.ai/api/health
curl -I https://api.elizacloud.ai/api/v1/eliza/agents/<agent-id>/api/wallet/steward-status
```

Do not trigger or maintain a separate Railway Steward deployment for Eliza Cloud.
