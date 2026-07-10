# Cloudflare Pages public domains

This Terraform root owns the four stable Pages custom-domain bindings and
their proxied CNAME records:

| Environment | Project | Public domain | CNAME target |
| --- | --- | --- | --- |
| staging | `eliza-cloud` | `staging.elizacloud.ai` | `develop.eliza-cloud.pages.dev` |
| staging | `eliza-app` | `app-staging.elizacloud.ai` | `develop.eliza-app.pages.dev` |
| production | `eliza-cloud` | `elizacloud.ai` | `eliza-cloud.pages.dev` |
| production | `eliza-app` | `app.elizacloud.ai` | `eliza-app.pages.dev` |

Wrangler remains responsible for project deployments and Worker routes. This
root owns only the durable edge attachment and DNS/certificate relationship.
In particular, staging CNAMEs include the `develop.` branch alias; pointing
them at the project-level `*.pages.dev` name serves the production branch.

## Adoption

The live bindings predate this root. `import.tf` adopts Pages domains by their
deterministic import ID and discovers the existing CNAME record ID by exact
name. A missing or duplicate record makes the first plan fail before any write.

Run the `Terraform — Cloudflare Pages Domains` workflow with `action=plan` for
staging first. Review that the plan contains imports and no destroy/replace.
Then apply staging, verify the routing probe and TLS certificate, and repeat
through the production Environment approval. The workflow never runs apply on
push or pull request.

Required GitHub Environment configuration:

- `CLOUDFLARE_API_TOKEN` secret with Pages Read/Write and DNS Read/Write.
- `CLOUDFLARE_ACCOUNT_ID` secret.
- `APPS_CLOUDFLARE_ZONE_ID` secret or variable.
- `R2_STATE_ACCESS_KEY_ID` and `R2_STATE_SECRET_ACCESS_KEY` secrets.

The same `cloudflare_pages_domain` resource exposes domain and certificate
status in `terraform output pages_domains`; the post-apply workflow also probes
the public HTTPS endpoints and requires the environment-routing beacon.
