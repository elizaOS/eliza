# Workflows

GitHub Actions provides admission, release, deployment, and device qualification.
Workflow YAML owns triggers and permissions; package scripts own product checks.

PR admission includes mock-backed payment replay Playwright proof. Device
qualification is available through `workflow_dispatch` or `workflow_call` from
authorized callers. Android packaging runs on demand through `android-build.yml`.
Develop validation runs package tests and integration contracts once; broad smoke
shards, mock walkthrough recordings, and the dev smoke workflow are retired.
Storybook catalog rendering and isolated Discord gateway reruns remain on demand;
Cloud already owns the gateway tests.
Live deployment requires the protected environment gates.

`deploy-gateway-webhook.yml` deploys these fixed targets:

| Environment | Branch | Service |
| --- | --- | --- |
| `staging` | `staging` | `gateway-webhook-stg` |
| `production` | `main` | `gateway-webhook` |

No separate build. Test workflow contracts from the repository root:

```bash
bun run test:scripts
```
