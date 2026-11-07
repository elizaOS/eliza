# Workflows

GitHub Actions provides admission, release, deployment, and device qualification.
Workflow YAML owns triggers and permissions; package scripts own product checks.

PR admission includes mock-backed payment replay Playwright proof. Device
qualification is available through `workflow_dispatch` or `workflow_call` from
authorized callers. Android packaging runs on demand through `android-build.yml`.
Develop validation retains affected integration and browser lanes. The shared
selector compares against the last successfully validated ancestor and follows
reverse workspace dependencies; shared tooling, unknown paths,
and unavailable history require full validation. Unit-test fan-out and platform,
RISC-V, and live smoke workflows are retired. Cloud browser/database jobs run in
parallel with static checks. Manual certification and protected release workflows
remain available for target-specific qualification.
Live deployment requires the protected environment gates.

`staging-launch-gate.yml` is the manual exact-SHA staging certification. It
runs front door, first turn, reload, messaging, and routing against the staging
head that Pages and the API Worker both serve, and uploads privacy-safe lane
receipts plus one composed receipt naming the owner of the first failed lane.

`deploy-gateway-webhook.yml` deploys these fixed targets:

| Environment | Branch | Service |
| --- | --- | --- |
| `staging` | `staging` | `eliza-gateway-webhook-staging` |
| `production` | `main` | `eliza-gateway-webhook-production` |

Gateway releases use Cloudflare Containers and the protected runtime configuration
secret. Set `GATEWAY_WEBHOOK_CLOUDFLARE_ACTIVE=true` only after the old owner is
stopped and the Cloudflare handoff is verified. Releases push the immutable image
before updating the Worker, then check the active version, image, runtime source,
credential equality, and Telegram identity.

Validate workflow syntax and executable references from the repository root:

```bash
actionlint -config-file .github/actionlint.yaml
node packages/scripts/audit-scripts.ts
```
