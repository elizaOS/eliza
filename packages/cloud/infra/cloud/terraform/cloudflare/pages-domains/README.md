# Cloudflare public-domain ownership

This Terraform root owns the durable browser, redirect-ingress, wildcard DNS,
Railway tunnel DNS, and advanced-certificate assets for the consolidated
`eliza-app` deployment. Wrangler owns Pages builds and Worker routes;
Terraform does not deploy either.

## Browser domains

| Environment | Pages project | Public domain             | DNS target                    |
| ----------- | ------------- | ------------------------- | ----------------------------- |
| staging     | `eliza-app`   | `staging.eliza.app`       | `develop.eliza-app.pages.dev` |
| staging     | `eliza-app`   | `cloud-staging.eliza.app` | `develop.eliza-app.pages.dev` |
| production  | `eliza-app`   | `eliza.app`               | `eliza-app.pages.dev`         |
| production  | `eliza-app`   | `cloud.eliza.app`         | `eliza-app.pages.dev`         |
| production  | `eliza-app`   | `www.eliza.app`           | `eliza-app.pages.dev`         |

Cloudflare Pages supports a custom domain on a preview branch by attaching the
domain to the project and pointing its proxied CNAME at
`<branch>.<project>.pages.dev`. Therefore staging remains on the single
`eliza-app` project and uses `develop.eliza-app.pages.dev`; a second staging
Pages project is neither required nor desired. See Cloudflare's
[custom branch aliases](https://developers.cloudflare.com/pages/how-to/custom-branch-aliases/)
documentation.

`www.eliza.app` is attached to the same project so the Pages middleware can
issue its canonical redirect. Legacy names are intentionally **not** Pages
custom domains. Their proxied DNS exists only to enter the `elizacloud.ai`
Worker routes, which return deterministic 308 redirects. The exact inventory
includes the retired `docs.elizacloud.ai` host, legacy browser names, and the
legacy API/blob/plugin/x402 names.

## Wildcard TLS

This root owns the canonical exact Worker service DNS plus both wildcard
families in each environment. Exact DNS covers `api`, `blob`, `plugins`,
`relay`, and `x402`; a Worker route does not create DNS, and the route is
unreachable until its hostname has a proxied record.

| Environment | Managed agents              | Hosted sites                |
| ----------- | --------------------------- | --------------------------- |
| staging     | `*.cloud-staging.eliza.app` | `*.sites-staging.eliza.app` |
| production  | `*.cloud.eliza.app`         | `*.sites.eliza.app`         |

Cloudflare Universal SSL only covers the zone apex and one subdomain level, so
these two-label names require Advanced Certificate Manager. Each advanced pack
must also contain `eliza.app`; Cloudflare requires the zone apex in an advanced
pack. A wildcard covers only one label. See the current
[Universal SSL limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)
and [Advanced Certificate Manager](https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/)
documentation.

Certificate maps are additive generations. An entry with `id` imports an
existing pack with its exact live host list; an entry without `id` creates a new
pack. Never add hosts to an imported generation or reuse its map key for a
different list. Add a new key, apply it, wait for `active`, verify TLS, and only
then retire an older generation in a separate reviewed operation. Every pack is
protected by `prevent_destroy`.

The live staging `*.staging.elizacloud.ai` pack remains at its original resource
address and is imported separately. Deep legacy `sites` and `tunnel` wildcards
use additive redirect certificate generations. Their DNS input is explicit so
the plan exposes the conversion of any DNS-only Railway/Caddy origin to proxied
Worker redirect ingress.

## Railway tunnel DNS and TLS

Railway is the origin and TLS authority for the canonical customer-tunnel
domains:

| Environment | Apex                       | Wildcard                     |
| ----------- | -------------------------- | ---------------------------- |
| staging     | `tunnel-staging.eliza.app` | `*.tunnel-staging.eliza.app` |
| production  | `tunnel.eliza.app`         | `*.tunnel.eliza.app`         |

Attaching each custom domain returns provider-owned routing and verification
records. The protected `RAILWAY_TUNNEL_DNS_RECORDS_JSON` inventory must copy
those CNAME/TXT names and values exactly; do not infer a target from the
Railway project or service id. Each distinct record carries one or more of the
five required apex/wildcard routing, verification, and certificate roles. The
deploy workflow normalizes Railway's relative names to FQDNs and deduplicates a
verification TXT shared by both custom domains into one `shared-verification`
record. If Railway returns separate tokens, both records remain distinct. Copy
the workflow summary object rather than inventing this mapping by hand.

All canonical tunnel records are intentionally DNS-only. Railway documents
that custom-domain verification requires its CNAME/TXT records, and that a
nested wildcard behind Cloudflare must be DNS-only unless Cloudflare Advanced
Certificate Manager is used. DNS-only delegates both apex and wildcard TLS to
Railway, including certificate issuance through the explicit ACME CNAME, so
this tunnel path has no paid Cloudflare certificate dependency. See Railway's
[custom-domain DNS contract](https://docs.railway.com/networking/domains/working-with-domains)
and Cloudflare's
[SaaS/verification DNS-only guidance](https://developers.cloudflare.com/dns/proxy-status/use-cases/).

## Existing-resource adoption

Do not use name-based Terraform imports for this root. Several wildcard names
have multiple A records, and legacy exact names may use different record types.
Populate `dns_record_import_ids` from a fresh Cloudflare DNS export. Its keys are:

- `pages/<resource-key>` for every existing exact browser or legacy record;
- `canonical-edge/<wildcard>|<origin-ip>` for canonical wildcard A records;
- `canonical-service/<hostname>|<origin-ip>` for exact canonical Worker service
  A records;
- `railway-tunnel/<logical-key>` for every reviewed Railway tunnel CNAME/TXT
  record;
- `legacy-edge/<wildcard>|<origin-ip>` for generalized legacy wildcards; and
- `legacy-staging-agent/<origin-ip>` for the two preserved staging-agent records.

Omit a key only when the corresponding DNS record genuinely does not exist.
The examples under `tfvars/` enumerate the exact resource keys. An omitted live
record will make Cloudflare reject the create; it must not be worked around by
deleting DNS before state adoption.

Canonical Pages bindings use deterministic configuration-driven imports of the
form `<account-id>/eliza-app/<domain>`. The cutover therefore attaches the
binding before the first plan and leaves its DNS untouched; Terraform then
adopts the live binding instead of attempting a duplicate create. Inspect the
remote state before every migration and require all existing desired bindings
to appear as imports or already-managed addresses.

## Required protected environment values

The `Infrastructure` workflow must expose the following JSON values as the
matching `TF_VAR_*` environment variables when `component=pages-domains`:

- `DNS_RECORD_IMPORT_IDS_JSON` -> `TF_VAR_dns_record_import_ids`;
- `CANONICAL_EDGE_WILDCARD_ORIGINS_JSON` ->
  `TF_VAR_canonical_edge_wildcard_origins`;
- `CANONICAL_SERVICE_ORIGINS_JSON` -> `TF_VAR_canonical_service_origins`;
- `RAILWAY_TUNNEL_DNS_RECORDS_JSON` ->
  `TF_VAR_railway_tunnel_dns_records`;
- `CANONICAL_EDGE_CERTIFICATE_PACKS_JSON` ->
  `TF_VAR_canonical_edge_certificate_packs`;
- `LEGACY_REDIRECT_WILDCARD_ORIGINS_JSON` ->
  `TF_VAR_legacy_redirect_wildcard_origins`; and
- `LEGACY_REDIRECT_CERTIFICATE_PACKS_JSON` ->
  `TF_VAR_legacy_redirect_certificate_packs`.

Staging additionally requires the immutable live inventory in
`STAGING_AGENT_WILDCARD_ORIGINS_JSON`, `STAGING_AGENT_CERTIFICATE_PACK_ID`, and
`STAGING_AGENT_CERTIFICATE_HOSTS_JSON`.

The shared credentials remain `CLOUDFLARE_API_TOKEN` (Pages, DNS, and SSL
Certificates read/write), `CLOUDFLARE_ACCOUNT_ID`,
`ELIZA_APP_CLOUDFLARE_ZONE_ID`, `APPS_CLOUDFLARE_ZONE_ID`, and the two R2 state
credentials. Keep record ids, origin addresses, and certificate pack ids in
protected GitHub Environment variables rather than committing live values.

## Migration choreography

1. Deploy a successful `develop` and `main` build to `eliza-app`. Pages cannot
   validate a custom branch alias until the target branch has a deployment.
2. Export both Cloudflare zones and certificate packs. Attach the canonical
   apex and wildcard to the selected Railway tunnel-proxy service, then copy
   every Railway-returned CNAME/TXT name and value into the protected tunnel
   DNS inventory. Populate every Cloudflare import id, origin set, pack id, and
   exact host list in the protected staging/production environments. Do not
   infer an IP, Railway target/token, or shortened certificate id.
3. Detach only the obsolete Pages bindings, leaving their DNS records in place:
   `staging.eliza.app` from `eliza-home-staging`, `www.eliza.app` from
   `eliza-app-home`, `app.elizacloud.ai` from its old project, and
   `elizacloud.ai`, `staging.elizacloud.ai`, and `www.elizacloud.ai` from
   `eliza-cloud`. Confirm no other project still owns a domain that this root
   will attach to `eliza-app`.
4. Dispatch `Infrastructure` with `component=pages-domains`,
   `environment=staging`, and `operation=plan`. The successful run uploads a
   three-day encrypted `terraform-plan-<run-id>-<run-attempt>` artifact and
   reports its exact artifact id and GitHub service digest. The protected
   Environment must contain a distinct RSA
   `TERRAFORM_PLAN_ARTIFACT_PUBLIC_KEY` variable and apply-only
   `TERRAFORM_PLAN_ARTIFACT_PRIVATE_KEY` secret; plaintext saved plans never
   enter Actions artifact storage, and plan runs cannot decrypt prior plans.
   The plan must show imports for every pre-existing DNS/certificate object,
   DNS-only Railway tunnel records, new canonical Pages bindings, and only
   additive certificate creation. Stop on any DNS or certificate destroy,
   replace, duplicate-create, or unexpected content change.
5. Deploy the staging Worker routes before converting legacy site/tunnel DNS to
   proxied redirect ingress. Dispatch `operation=apply` with the exact successful
   plan run id, run attempt, artifact id, and service digest copied from that
   run's summary. The apply job verifies the source workflow, environment,
   branch, commit, exact immutable artifact identity, authenticated metadata,
   and plaintext SHA-256 before using that saved plan; it never creates a fresh
   unreviewed plan. Wait for all Pages bindings and every new advanced pack to
   report `active`.
6. Verify the homepage, hosted app, API proxy, a managed-agent hostname, a hosted
   site hostname, and every legacy 308 family over real TLS. Verify path/query
   preservation and confirm `docs.elizacloud.ai` lands on `https://eliza.app`.
7. Repeat inventory, plan, Worker-first ordering, apply, and verification for
   production through its protected Environment approval.
8. Keep old certificate generations until traffic and certificate telemetry
   show the migration is complete. Retirement requires a separate change and
   explicit state/API choreography; this configuration will not destroy them.

No live infrastructure should be applied from a developer workstation. Pull
requests run formatting/static validation; plans and applies use the protected,
manual `Infrastructure` workflow and remote R2 state.
