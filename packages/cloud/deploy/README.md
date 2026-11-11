# @elizaos/cloud-deploy

Renders the Wrangler configuration of each part of a Cloud for one product
from a deployment file: the API Worker, the Steward login Worker, the speech
and admission Workers, and the Pages front end. A product deploys its own
Cloud from upstream code without editing any upstream `wrangler.toml`.

Private and unpublished. Run it with Bun, from an upstream checkout or from
an install of the packed packages (see Consuming from npm); it has no
dependencies. It is not yet a workspace member.

## Product directory

```
cloud/
  deployment.json                      identity and resource ids per environment; no secrets
  wrangler.<environment>.jsonc         rendered API Worker; do not edit
  secrets.<environment>.txt            rendered; names of the secrets to set
  wrangler.<component>.<environment>.jsonc   rendered login, speech, admission, web
  secrets.<component>.<environment>.txt
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
| `components?` `{ login?, speech?, admission?, web? }`                          | the other parts of the Cloud; see Components                                                                               |

The id is rendered as `CLOUD_DEPLOYMENT_ID`, the environment name as
`ENVIRONMENT`. Together with the fields above these are the settings
`resolveCloudDeployment` requires of a product deployment.

Validation refuses, with every problem listed: unknown fields; malformed ids,
origins, hosts and routes; a host on or under `eliza.app` or `elizacloud.ai`
unless the id is `eliza`; any value shaped like a credential; a
secret-named variable under `vars`; a variable that a typed field already
sets.

## Components

Each is optional per environment. A file without `components` renders the API
Worker exactly as before.

```
"components": {
  "login": {
    "workerName": "...",
    "host": "login.example.org",          custom domain
    "enabled": true,                      LOGIN_ENABLED
    "container": { "maxInstances": 1, "instanceType": "standard-1", "image"?: "registry/.../name:tag" },
    "vars"?: { ... },
    "secrets": [ ... ]
  },
  "speech": {
    "workerName": "...",
    "hostsSessions"?: true,               the API binds this Worker's session class
    "routes"?: [ { "pattern", "zone" } ],
    "resources"?: { "hyperdriveId", "kvNamespaceId" },   the API Worker's when omitted
    "vars"?: { ... },
    "secrets": [ ... ]
  },
  "admission": { "workerName": "...", "routes"?: [...], "vars"?: { ... }, "secrets": [ ... ] },
  "web": {
    "projectName": "...",                 Pages project
    "nativeAuthCallbacks"?: [ { "redirectUri", "androidPackage", "appName",
        "browserSignIn"?: { "startPath", "returnPath", "storageKey", "apiOrigin", "tenant" } } ],
    "vars"?: { ... }
  }
}
```

- **login** follows `packages/auth/cloudflare/wrangler.toml`: entry,
  compatibility, cron, migrations, Durable Object bindings and the container
  class. Name, account, custom domain, instance settings and variables come
  from the file. Without `container.image` the container is built from
  upstream's Dockerfile at deploy time. `secrets` must list the five settings
  the Worker refuses to start without. A product must also set `APP_URL`,
  `EMAIL_FROM`, `EMAIL_AUTH_REDIRECT_BASE_URL`, `PASSKEY_RP_ID` and
  `PASSKEY_ORIGIN` under `vars`: the login runtime otherwise falls back to an
  eliza host or sender for each.
- **speech** and **admission** follow their upstream files (which exist for
  staging only; a product may render either environment). A Durable Object
  binding that upstream points at another Worker is pointed at this
  deployment's Worker that owns the class: the admission Worker for
  `InferenceAdmissionGate` when there is one, otherwise the API Worker. The
  admission Worker's service binding is this deployment's API Worker. Both
  are given the same identity variables as the API Worker, since they run its
  classes. With an admission Worker,
  `durableObjectTransfers.InferenceAdmissionGate` must name it, so the API and
  the speech Worker use one gate. `speech.hostsSessions` adds `script_name` to
  the API Worker's speech-session binding without a transfer.
- **web** follows `packages/app/wrangler.toml`: build output directory,
  compatibility date and the name of the API service binding, which is always
  bound to this deployment's API Worker. Variables are derived:
  `CLOUD_DEPLOYMENT_ID`, `API_UPSTREAM` (api origin), `VITE_ELIZA_CLOUD_BASE`
  (app origin), `VITE_STEWARD_TENANT_ID`, `NEXT_PUBLIC_STEWARD_TENANT_ID`,
  `VITE_ENVIRONMENT` and, when callbacks are listed,
  `ELIZA_NATIVE_AUTH_CALLBACKS_JSON`. A callback must be on the environment's
  web or app origin and its `browserSignIn.apiOrigin` must be the api origin.
  The rendered file is one flat Pages configuration per environment. Wrangler
  reads a Pages configuration only as `wrangler.json`/`wrangler.toml` in the
  project directory, so copy it there under that name to deploy, as upstream's
  release does.

Worker names must be distinct within a deployment. Validation applies the
same host, secret and derived-variable rules to every component.

## What is taken from upstream

From `packages/cloud/api/wrangler.toml` (top level plus `env.production`):
entry, compatibility date and flags, `workers_dev`, `minify`, `keep_vars`,
`define`, `alias`, observability, crons, AI and browser bindings, binding
names, rate-limit shapes, Durable Object bindings and exports. Nothing else.
No `[vars]` value is copied from any component: a product states every
variable it wants. An upstream key the renderer does not know stops the
render, as does an upstream login or Pages variable the renderer does not
derive, and a service binding to a Worker it does not recognise. A rendered
non-eliza config that still contains an eliza account, Worker or Pages project
name, zone, database, cache or bucket id, or host is refused; component
renders are scanned against the identity of all five upstream files.

## Commands

```
bun packages/cloud/deploy/src/cli.ts render \
  --deployment cloud/deployment.json --environment staging \
  --upstream path/to/eliza --out cloud \
  [--component api|login|speech|admission|web|all]

bun packages/cloud/deploy/src/cli.ts render \
  --deployment cloud/deployment.json --environment staging \
  --packages . --out cloud [--main cloud/worker.ts]

bun packages/cloud/deploy/src/cli.ts check --config cloud/wrangler.staging.jsonc \
  [--metafile <file>]
```

`--packages <dir>` replaces `--upstream`: the API Worker is rendered from
`@elizaos/cloud-api` installed in `<dir>/node_modules`, and no rendered path
leaves that directory. It renders the API Worker only. `--main` names the
product's own entry in place of the package's.

`render` writes one component's configuration and secret names into `--out`.
`--component` defaults to `api`, whose files keep the names
`wrangler.<environment>.jsonc` and `secrets.<environment>.txt`; the others are
`wrangler.<component>.<environment>.jsonc` and
`secrets.<component>.<environment>.txt`. `all` renders the API Worker and
every component the environment defines, and writes nothing if any is
refused. Exit 0 on success, 1 on an invalid deployment or render, 2 on a
usage error.

`check` prints a JSON report (`kind`, `ok`, `notValidated`, `bundleBytes`,
Wrangler's upload size, files). `--metafile` also writes the bundler's list
of every input file of a Worker bundle. It uploads nothing and passes no Cloudflare
credential to Wrangler. It uses the `wrangler` installed in the upstream tree
the config points at (the component's own, else the API package's), so that
tree must be installed and its workspace packages built; `--wrangler <bin>`
overrides, `--keep <dir>` keeps the bundle. Exit 0 when the bundle builds.

- A Worker configuration is bundled with `wrangler deploy --dry-run`.
- The login Worker is dry-run with `--containers-rollout=none`. Without it
  Wrangler builds the container image even in a dry run, which needs a Docker
  daemon and network access. The Worker and its bindings are checked; the
  image is not built.
- A Pages configuration has no dry-run deploy. `check` copies it into a
  scratch project as `wrangler.json` and runs `wrangler pages functions
  build` on upstream's `packages/app/functions`. This establishes that
  Wrangler accepts the file as a Pages project and that the Pages Functions
  compile. It does not build the web app, and the build output directory need
  not exist.

`bun test packages/cloud/deploy/src` runs the tests.

## Consuming from npm

A product can build the API Worker from packages, with no upstream checkout:

```
package.json     depends on @elizaos/cloud-api and @elizaos/cloud-deploy
worker.ts        export * from "@elizaos/cloud-api/worker";
                 export { default } from "@elizaos/cloud-api/worker";
deployment.json
```

```
bun install
bunx cloud-deploy render --deployment deployment.json --environment staging \
  --packages . --main worker.ts --out .
bunx cloud-deploy check --config wrangler.staging.jsonc
```

`@elizaos/cloud-api/worker` is the Worker module: the default export with the
`fetch` and `scheduled` handlers, and the Durable Object classes the rendered
configuration binds. `worker.ts` must re-export all of it.

Packaging, as it stands in this checkout:

- `@elizaos/cloud-api`, `@elizaos/cloud-shared`,
  `@elizaos/cloud-services-common` and `@elizaos/plugin-network` ship their
  TypeScript sources (`files` excludes tests, fixtures and test support); the
  Worker bundler compiles them. `@elizaos/cloud-api` also ships its
  `wrangler.toml`, which is what the renderer reads. `@elizaos/cloud-deploy`
  ships its sources and runs under Bun.
- The API sources import each other by relative path and other packages by
  name. They do not use the `@/api`, `@/api-app` or `@/api-queue` tsconfig
  paths (tests still may): a bundler ignores tsconfig paths under
  `node_modules`.
- Upstream aliases that point into a sibling workspace's sources
  (`@elizaos/cloud-shared`, `@elizaos/cloud-sdk`, and two more) are left out
  of a `--packages` render and named in its output. Those specifiers resolve
  through `node_modules`: to sources for the source-shipped packages, to
  `dist` for the built ones. A checkout build compiles `@elizaos/cloud-sdk`,
  `@elizaos/plugin-elizacloud` and `@elizaos/core/protocol` from sources
  instead (aliases and tsconfig paths), so the two bundles are not
  byte-identical.
- Wrangler is whatever the product's install resolves for
  `@elizaos/cloud-api`'s `wrangler` range, not the checkout's locked version.

`scripts/pack-check.ts` proves this end to end without publishing:

```
bun packages/cloud/deploy/scripts/pack-check.ts --work <dir outside the repo> \
  [--built <tree with built dist>] [--public workspace|registry]
```

It stages a copy of each package, replaces `workspace:` ranges with the
workspaces' current versions, runs `npm pack`, installs the tarballs into an
empty product directory (`bun install --ignore-scripts`, third-party
dependencies from the public registry), renders with the installed
`cloud-deploy`, and bundles the product's `worker.ts`. It fails when a source
tarball carries a test, fixture or secret file or lacks an `exports` target,
when a rendered path or any bundle input resolves outside the product
directory, and when the bundle takes code of an `@elizaos` package the run did
not pack. With `--public workspace` (the default) the already-published
packages the bundle draws from are packed too, from `--built`, a tree whose
`dist` directories are built and whose sources equal this checkout's; the run
refuses a built tree that differs. `--public registry` takes them from npm at
the versions the manifests name.

## To publish

Nothing here is published, and none of this is done. For a maintainer:

1. Remove `"private": true` from `packages/cloud/api`, `packages/cloud/shared`,
   `packages/cloud/services/_common`, `plugins/plugin-network` and
   `packages/cloud/deploy`, together: `verify-publish-graph.ts` refuses a
   public package that depends on a private one. `files`, `exports` and
   `publishConfig.access` are already set.
2. Add the five names to `packages/scripts/release-cohort.json`.
3. Align versions with the cohort (2.0.5 today): `@elizaos/cloud-api` is
   2.0.3-beta.0, `cloud-shared` and `plugin-network` 0.1.0,
   `cloud-services-common` 1.0.0, `cloud-deploy` 0.0.0. `lerna.json` versions
   `packages/*`, `plugins/*` and `packages/cloud/sdk` only; add
   `packages/cloud/api`, `packages/cloud/shared`, `packages/cloud/services/*`
   and `packages/cloud/deploy` so fixed versioning covers them.
4. Add `packages/cloud/deploy` to the root `workspaces` and refresh
   `bun.lock`. The others are members already.
5. Publish all of them in one release with the packages they depend on.
   `@elizaos/cloud-shared` depends on `@elizaos/auth`, `cloud-routing`,
   `cloud-sdk`, `contracts`, `core`, `host` and twelve plugins at exact
   versions, so a Cloud package is only installable beside the cohort
   release it was packed with.
6. Run `pack-check` with `--public workspace` on the release commit, after
   the workspace build, and again with `--public registry` once published.
7. Decide what a consumer installs. `@elizaos/cloud-shared`'s dependencies
   include every plugin and SDK the full Cloud uses (about 2.8 GB installed);
   optional per-feature dependencies are not done.

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

Its components are compared with their upstream files in the same way:

- login, both environments: no difference.
- speech and admission (staging; upstream has no production file): thirteen
  added variables, the deployment identity the staging API Worker is given
  (`CLOUD_DEPLOYMENT_ID`, `CLOUD_WEB_ORIGIN`, `NEXT_PUBLIC_API_URL`,
  `ELIZA_CLOUD_URL`, `STEWARD_TENANT_ID`, `NEXT_PUBLIC_STEWARD_TENANT_ID`,
  `CLOUD_PUBLIC_SERVICE_NAME`, `R2_PUBLIC_HOST`,
  `NEXT_PUBLIC_ASSETS_CDN_URL`, `SENDGRID_FROM_EMAIL`, `CLOUD_BILLING_URL`,
  `ELIZA_ENTITLEMENT_ISSUER`, `ELIZA_ENTITLEMENT_AUDIENCE`). Upstream leaves
  them unset on these Workers, where they resolve to the eliza defaults; the
  staging tenant, blob host and API origin therefore differ from what those
  Workers resolve today. Compare against the upstream staging contracts
  (`verify-staging-contract.ts`) before eliza deploys either from a rendered
  config.
- web, both environments: `CLOUD_DEPLOYMENT_ID` added. Production is one flat
  file instead of an `env.production` override of the preview values.
  `ELIZA_NATIVE_AUTH_CALLBACKS_JSON` is not in upstream's file (the release
  supplies it) and is not in `eliza.json`.

The `secrets` lists mirror the comment blocks of the upstream files and, for
login, the settings `worker.ts` reads. None has been compared with the
deployed Workers. Every upstream `wrangler.toml` and the release workflows are
unchanged and still authoritative.

## Not covered

- Building the web app for a product. The Pages variables are rendered, but
  the Vite build reads its own environment, and the app's sources carry eliza
  hosts and branding.
- The Pages Functions bundle still contains the eliza domain contract
  (`resolveCanonicalPageRedirect`, landing hosts). It acts only on eliza
  hostnames. The API proxy no longer falls back to eliza's API for a product:
  with `CLOUD_DEPLOYMENT_ID` set to a product id, a missing or malformed
  `API_UPSTREAM` is a 503.
- `packages/cloud/scripts/pages-native-auth-callbacks.ts` reads upstream's
  TOML and a comment-free JSON file; it does not read a rendered `.jsonc`.
- The login container image, and the login runtime's eliza branding in mail
  templates and default tenant configuration.
- Whether a `transferred` export is accepted for a product whose API Worker
  never held the admission namespace, and whether a speech host selected with
  `hostsSessions` serves sessions. Neither has been deployed.
- The top-level (unnamed, local development) environment of the API's
  `wrangler.toml`.
- Default values for upstream's operational variables: a product lists the
  ones it wants under `vars`.
- eliza hosts compiled into the Worker bundles as defaults for the eliza
  deployment. They are code, not configuration.
- Database migrations and a baseline for a new database.
- Provisioning Cloudflare resources (Hyperdrive, KV, R2, rate-limit
  namespaces, routes, DNS, the Pages project) and setting secrets.
- An actual deploy, and npm publication of this package or the Workers'.
- Packages for the login, speech and admission Workers and the Pages front
  end. They have no `package.json`; a product renders them with `--upstream`.
- Type declarations and a JavaScript build of the source-shipped packages. A
  consumer that type-checks against them needs their TypeScript settings.
