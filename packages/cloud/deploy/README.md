# @elizaos/cloud-deploy

Renders the Cloud API Worker's Wrangler configuration for one product from a
deployment file, so a product deploys its own Cloud from upstream code without
editing `packages/cloud/api/wrangler.toml`.

Private and unpublished. Run it with Bun from an upstream checkout; it has no
dependencies. It is not yet a workspace member.

## Product directory

```
cloud/
  deployment.json            identity and resource ids per environment; no secrets
  wrangler.staging.jsonc     rendered; do not edit
  wrangler.production.jsonc  rendered; do not edit
  secrets.staging.txt        rendered; names of the secrets to set
  secrets.production.txt
```

The upstream checkout lives elsewhere (a submodule, a sibling clone). Paths in
the rendered config are written relative to the product directory, so the
rendered files are valid as long as the two directories keep their relative
position. Render again after moving either, or after advancing upstream.

## Deployment file

`{ "id": "<deployment id>", "environments": { "staging": {...}, "production": {...} } }`.
See `examples/product.json`. Each environment has:

| Field                                                                          | Rendered as                                                                                                                |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `workerName`, `accountId`                                                      | `name`, `account_id`                                                                                                       |
| `routes[]` `{ pattern, zone }`                                                 | `routes` (the pattern's host must be in the zone)                                                                          |
| `origins` `{ web, app, api, firstParty? }`                                     | `CLOUD_WEB_ORIGIN`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_API_URL`, `ELIZA_CLOUD_URL`, `CLOUD_FIRST_PARTY_ORIGINS`           |
| `tenantId`                                                                     | `STEWARD_TENANT_ID`, `NEXT_PUBLIC_STEWARD_TENANT_ID`                                                                       |
| `serviceName`, `blobHost`, `assetsBase`, `mailFrom`, `billingUrl`              | `CLOUD_PUBLIC_SERVICE_NAME`, `R2_PUBLIC_HOST`, `NEXT_PUBLIC_ASSETS_CDN_URL`, `SENDGRID_FROM_EMAIL`, `CLOUD_BILLING_URL`    |
| `entitlement` `{ issuer, audience }`                                           | `ELIZA_ENTITLEMENT_ISSUER`, `ELIZA_ENTITLEMENT_AUDIENCE`                                                                   |
| `resources` `{ hyperdriveId, kvNamespaceId, r2Bucket, rateLimitNamespaceIds }` | `hyperdrive`, `kv_namespaces`, `r2_buckets`, `ratelimits[].namespace_id` (one id per rate-limit binding upstream declares) |
| `placement?` `{ mode, region? }`                                               | `placement`                                                                                                                |
| `durableObjectTransfers?` `{ ClassName: workerName }`                          | `script_name` on that class's binding and a `transferred` export                                                           |
| `vars?`                                                                        | further non-secret variables, verbatim                                                                                     |
| `secrets[]`                                                                    | `secrets.<environment>.txt`; names only                                                                                    |

The id is rendered as `CLOUD_DEPLOYMENT_ID`, the environment name as
`ENVIRONMENT`. Together with the fields above these are the settings
`resolveCloudDeployment` requires of a product deployment.

Validation refuses, with every problem listed: unknown fields; malformed ids,
origins, hosts and routes; a host on or under `eliza.app` or `elizacloud.ai`
unless the id is `eliza`; any value shaped like a credential; a
secret-named variable under `vars`; a variable that a typed field already
sets.

## What is taken from upstream

From `packages/cloud/api/wrangler.toml` (top level plus `env.production`):
entry, compatibility date and flags, `workers_dev`, `minify`, `keep_vars`,
`define`, `alias`, observability, crons, AI and browser bindings, binding
names, rate-limit shapes, Durable Object bindings and exports. Nothing else.
No `[vars]` value is copied: a product states every variable it wants. An
upstream key the renderer does not know stops the render, and a rendered
non-eliza config that still contains an eliza account, Worker name, zone,
database, cache or bucket id, or host is refused.

## Commands

```
bun packages/cloud/deploy/src/cli.ts render \
  --deployment cloud/deployment.json --environment staging \
  --upstream path/to/eliza --out cloud

bun packages/cloud/deploy/src/cli.ts check --config cloud/wrangler.staging.jsonc
```

`render` writes `wrangler.<environment>.jsonc` and `secrets.<environment>.txt`
into `--out`. Exit 0 on success, 1 on an invalid deployment or render, 2 on a
usage error.

`check` runs `wrangler deploy --dry-run` on a rendered config and prints a
JSON report (`ok`, `bundleBytes`, Wrangler's upload size, files). It uploads
nothing and passes no Cloudflare credential to Wrangler. It uses the
`wrangler` installed in the upstream tree the config points at, so that tree
must be installed and its workspace packages built; `--wrangler <bin>`
overrides, `--keep <dir>` keeps the bundle. Exit 0 when the bundle builds.

`bun test packages/cloud/deploy/src` runs the tests.

## The eliza deployment

`deployments/eliza.json` states the eliza.app deployment as data. Rendering it
reproduces the staging and production sections of `wrangler.toml`; the tests
compare the two and name every difference:

- Six added variables (`CLOUD_DEPLOYMENT_ID`, `CLOUD_WEB_ORIGIN`,
  `CLOUD_PUBLIC_SERVICE_NAME`, `NEXT_PUBLIC_ASSETS_CDN_URL`,
  `SENDGRID_FROM_EMAIL`, `CLOUD_BILLING_URL`), set to the values the Worker
  already resolves for the eliza deployment. Before eliza deploys from a
  rendered config, check that none of these is also set on the deployed
  Worker as a secret or dashboard variable.
- Staging's explicit `migrations = []` is omitted (no migrations either way).

Its `secrets` list mirrors the names in the comment block of `wrangler.toml`
and has not been compared with the deployed Workers. `wrangler.toml` and the
release workflows are unchanged and still authoritative.

## Not covered

- The Pages front end, the Steward login Worker, and the speech and admission
  Workers: each still has its own eliza `wrangler.toml`.
- The top-level (unnamed, local development) environment of `wrangler.toml`.
- Default values for upstream's operational variables: a product lists the
  ones it wants under `vars`.
- eliza hosts compiled into the Worker bundle as defaults for the eliza
  deployment. They are code, not configuration.
- Database migrations and a baseline for a new database.
- Provisioning Cloudflare resources (Hyperdrive, KV, R2, rate-limit
  namespaces, routes, DNS) and setting secrets.
- An actual deploy, and npm publication of this package or the Worker's.
