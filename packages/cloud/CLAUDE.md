# Eliza Cloud

Multi-tenant backend, deployment, routing, SDK, and end-to-end infrastructure
for Eliza Cloud. This guide adds cloud-wide rules to the repository
[CLAUDE.md](../../CLAUDE.md); each package below this directory has a more
specific guide that must be read before editing it.

## Ownership map

- `api/` is the Cloudflare Worker API and generated Hono route tree.
- `shared/` owns server-side schemas, repositories, billing, auth, and services.
- `sdk/` is the typed public client; `routing/` owns model-routing policy.
- `services/` contains deployable control-plane, gateway, and worker services.
- `infra/` owns local-cluster and production infrastructure definitions.
- `e2e/` boots the real local stack and drives it through Playwright.
- `test-mocks/` provides explicit external-service substitutes for tests.
- The current Cloud web surfaces live in `packages/app`, not in this directory.

## Correctness boundaries

- Scope every tenant-owned read and write by organization or user ownership.
  Authentication alone does not prove ownership.
- Debit or reserve credits atomically before irreversible work. Check the
  result, reconcile actual usage afterward, and refund failed external work.
- Give every webhook, payment leg, retryable job, and reconciliation phase a
  stable idempotency key. Retrying must not double-charge, double-credit, or
  double-pay.
- Treat signed payment authorization, provider responses, webhooks, and all
  client input as untrusted boundaries. Validate the authoritative value rather
  than a client-echoed amount.
- Cloud DTOs carry derived values from backend use-cases. UI clients render
  them; they do not reconstruct billing or authorization logic.

## Deployment

`.github/workflows/cloud-cf-deploy.yml` is authoritative. It deploys staging
from `develop` and production from `main` or an approved production dispatch.
Non-preview deployments are gated on the `migrate-db` job, and every deploy job
must fail closed when migration fails. Keep the workflow on the repository's
pinned Bun version and preserve its environment and concurrency guards.

Never deploy, migrate production data, approve an environment, purchase a
domain, or mutate cloud resources without explicit authorization. Inspect the
workflow and the relevant package guide immediately before an authorized
operation; operational details change more often than this overview.

## Common checks

```bash
bun run verify:cloud          # cloud lint and typecheck lanes
bun run test:cloud            # cloud unit/integration package sweep
bun run test:cloud:e2e        # cloud API end-to-end lane
bun run cloud:e2e             # full local Playwright stack
bun run cloud:mock            # local mock stack for manual verification
```

Money, identity, provisioning, and deployment changes require tests at both the
owning package boundary and the real full-stack boundary. Manually inspect the
ledger/rows, structured logs, API responses, and UI/network state produced by
the change. Follow the root evidence policy, and never represent a mock-only
result as proof of a production integration.
