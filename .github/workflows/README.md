# Workflows

GitHub Actions provides admission, release, deployment, and device qualification.
Workflow YAML owns triggers and permissions; package scripts own product checks.

PR admission includes mock-backed payment replay Playwright proof. Device
qualification is available through `workflow_dispatch` or `workflow_call` from
authorized callers. Android packaging runs on demand through `android-build.yml`.
Full validation runs on pushes to `staging` and `main`, the promotion steps, and
retains affected integration and browser lanes. The shared selector compares against the last successfully validated ancestor and follows
reverse workspace dependencies; shared tooling, unknown paths,
and unavailable history require full validation. Unit-test fan-out and platform,
RISC-V, and live smoke workflows are retired. Cloud browser/database jobs run in
parallel with static checks. Manual certification and protected release workflows
remain available for target-specific qualification.
Live deployment requires the protected environment gates.

The `develop` to `staging` promotion pull request is opened by hand and merged
with a merge commit whose tree is identical to the promoted `develop` head.
Staging effects are admitted on the green Develop Full run for the `staging`
head plus that merged pull request; a direct push, fast-forward, or squash to
`staging` fails reconciliation and deploys nothing. The agent image build on
`staging` publishes the moving `:staging` tag, which is the default staging
sandbox image.

Apps deployment is paused because the feature is unused. The Apps worker workflow
is disabled in GitHub Actions and is absent from the staging and main effect
registries. Both API environments set `APPS_DEPLOY_ENABLED=0`, so new app container
deploy requests return `503` without creating a job. Resume these controls together
only after the Apps service is approved and qualified.

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
bun packages/scripts/audit-scripts.ts
```
