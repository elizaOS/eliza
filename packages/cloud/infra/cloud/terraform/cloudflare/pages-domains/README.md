# Cloudflare Pages public domains

This Terraform root owns the four stable Pages custom-domain bindings, their
proxied CNAME records, and the staging dedicated-agent wildcard edge assets:

| Environment | Project | Public domain | CNAME target |
| --- | --- | --- | --- |
| staging | `eliza-cloud` | `staging.elizacloud.ai` | `develop.eliza-cloud.pages.dev` |
| staging | `eliza-app` | `app-staging.elizacloud.ai` | `develop.eliza-app.pages.dev` |
| production | `eliza-cloud` | `elizacloud.ai` | `eliza-cloud.pages.dev` |
| production | `eliza-app` | `app.elizacloud.ai` | `eliza-app.pages.dev` |

For staging agents it also adopts both proxied A records at
`*.staging.elizacloud.ai` and advanced certificate pack `02490878…`. Universal
SSL covers only `*.elizacloud.ai`; the paid advanced pack is what makes the
two-label agent hosts terminate TLS. The matching Worker route remains owned by
`packages/cloud/api/wrangler.toml`.

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
- On `staging`, `STAGING_AGENT_WILDCARD_ORIGINS_JSON` with the exact two live
  origin IPv4 addresses, `STAGING_AGENT_CERTIFICATE_PACK_ID` with the full live
  pack id, and `STAGING_AGENT_CERTIFICATE_HOSTS_JSON` with the exact pack host
  inventory. Keeping these as protected Environment variables avoids guessing
  or committing live edge inventory while still making every plan reproducible.

The outputs expose Pages domain state plus wildcard DNS and advanced-certificate
status; the post-apply workflow verifies both, completes a real wildcard TLS
handshake, probes the public Pages endpoints, and requires the environment
routing beacon.
