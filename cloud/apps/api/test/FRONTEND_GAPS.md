# Frontend × Worker gap analysis

Auto-generated. Re-run with `node apps/api/test/_frontend-gaps.mjs`.

For each `/api/*` path referenced anywhere in the frontend code (frontend app, homepage, ui package, sdk package), classify what the Hono Worker would do today.

| Bucket | Count | Worker behavior |
| --- | ---: | --- |
| hono-real | 324 | Worker serves this for real. |
| hono-stub | 15 | Worker returns 501; live Next.js handler still serves it. |
| next-only | 0 | Worker has no peer; only the live Next.js handler serves it. |
| unknown   | 29 | No Worker/Next handler matched (grep noise or dynamic path). |
| agent-runtime-api | 16 | Agent `connection.url` (not Cloud Worker). |

## hono-stub (15)

- `/api/affiliate/create-character` → `affiliate/create-character/route.ts`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/eliza-app/webhook/blooio` → `eliza-app/webhook/blooio/route.ts`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/eliza-app/webhook/discord` → `eliza-app/webhook/discord/route.ts`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/eliza-app/webhook/telegram` → `eliza-app/webhook/telegram/route.ts`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/eliza-app/webhook/whatsapp` → `eliza-app/webhook/whatsapp/route.ts`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/training/vertex/tune` → `training/vertex/tune/route.ts`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/v1/admin/docker-containers/audit` → `v1/admin/docker-containers/audit/route.ts`
  - callers: `eliza/cloud/packages/ui/src/components/admin/infrastructure-dashboard.tsx`, `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/v1/admin/infrastructure` → `v1/admin/infrastructure/route.ts`
  - callers: `eliza/cloud/apps/frontend/src/lib/data/admin.ts`, `eliza/cloud/packages/ui/src/components/admin/infrastructure-dashboard.tsx`, `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/v1/admin/infrastructure/containers` → `v1/admin/infrastructure/route.ts`
  - callers: `eliza/cloud/apps/frontend/src/lib/data/admin.ts`, `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/v1/admin/infrastructure/containers/actions` → `v1/admin/infrastructure/route.ts`
  - callers: `eliza/cloud/packages/ui/src/components/admin/infrastructure-dashboard.tsx`, `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/v1/connections` → `v1/connections/[platform]/route.ts`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/v1/containers` → `v1/containers/route.ts`
  - callers: 9 files
- `/api/v1/containers/container-1` → `v1/containers/[id]/route.ts`
  - callers: `eliza/cloud/packages/sdk/src/client.test.ts`
- `/api/v1/containers/container-1/logs` → `v1/containers/[id]/logs/route.ts`
  - callers: `eliza/cloud/packages/sdk/src/client.test.ts`
- `/api/v1/containers/container-1/metrics` → `v1/containers/[id]/metrics/route.ts`
  - callers: `eliza/cloud/packages/sdk/src/client.test.ts`

## next-only (0)


## agent-runtime-api (16)

- `/api/agent/export/estimate`
  - callers: `apps/homepage/src/lib/cloud-api.ts`
- `/api/agent/pause`
  - callers: `apps/homepage/src/lib/cloud-api.ts`
- `/api/agent/resume`
  - callers: `apps/homepage/src/lib/cloud-api.ts`
- `/api/agent/start`
  - callers: `apps/homepage/src/lib/cloud-api.ts`
- `/api/agent/stop`
  - callers: `apps/homepage/src/lib/cloud-api.ts`
- `/api/logs`
  - callers: `apps/homepage/src/lib/cloud-api.ts`
- `/api/metrics`
  - callers: `apps/homepage/src/lib/cloud-api.ts`
- `/api/status`
  - callers: `apps/homepage/src/lib/cloud-api.ts`
- `/api/wallet/addresses`
  - callers: `apps/homepage/src/lib/cloud-api.ts`
- `/api/wallet/balances`
  - callers: `apps/homepage/src/lib/cloud-api.ts`
- `/api/wallet/steward-approve-tx`
  - callers: `apps/homepage/src/lib/cloud-api.ts`
- `/api/wallet/steward-deny-tx`
  - callers: `apps/homepage/src/lib/cloud-api.ts`
- `/api/wallet/steward-pending-approvals`
  - callers: `apps/homepage/src/lib/cloud-api.ts`
- `/api/wallet/steward-policies`
  - callers: `apps/homepage/src/lib/cloud-api.ts`
- `/api/wallet/steward-status`
  - callers: `apps/homepage/src/lib/cloud-api.ts`
- `/api/wallet/steward-tx-records`
  - callers: `apps/homepage/src/lib/cloud-api.ts`

## unknown (29)

- `/api/cron/cleanup-expired-crypto-payments`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/eliza-app/auth/connection-success`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/internal/discord/eliza-app/messages`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/internal/discord/gateway/assignments`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/internal/discord/gateway/failover`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/internal/discord/gateway/heartbeat`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/internal/discord/gateway/shutdown`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/my-agents/claim-affiliate-characters`
  - callers: `eliza/cloud/packages/ui/src/components/my-agents/my-agents.tsx`, `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/stream/settings`
  - callers: `apps/homepage/src/lib/cloud-api.ts`
- `/api/v1/chain/transfers`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/v1/cron/process-provisioning-jobs`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/v1/eliza/google/calendar/calendars`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/v1/eliza/google/gmail/message-send`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/v1/eliza/google/gmail/subscription-headers`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/v1/eliza/launch-sessions`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/v1/fails`
  - callers: `eliza/cloud/packages/sdk/src/client.test.ts`
- `/api/v1/iap`
  - callers: `eliza/cloud/packages/ui/src/components/docs/api-route-explorer-client.tsx`
- `/api/v1/market/candles`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/v1/market/portfolio`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/v1/market/preview/portfolio`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/v1/market/preview/price`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/v1/market/preview/token`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/v1/market/preview/wallet-overview`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/v1/market/trades`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/v1/eliza`
  - callers: `apps/homepage/src/lib/cloud-api.ts`
- `/api/v1/eliza/agents`
  - callers: `apps/homepage/src/lib/cloud-api.ts`
- `/api/v1/needs-credits`
  - callers: `eliza/cloud/packages/sdk/src/client.test.ts`
- `/api/v1/solana/token-accounts`
  - callers: `eliza/cloud/packages/sdk/src/public-routes.ts`
- `/api/v1/storage`
  - callers: `eliza/cloud/apps/frontend/src/pages/sandbox-proxy/page.tsx`

## hono-real (324)

_(elided — these already work)_
