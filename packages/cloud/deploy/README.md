# @elizaos/cloud-deploy

Renders a product's Cloud configuration from one deployment file: API, Steward
login, speech and admission Workers, and Pages. Structure comes from upstream
Wrangler files; product identity and resource IDs come from the deployment file.
It never provisions resources, sets secrets, publishes packages or deploys.

Public but not yet published, with no runtime dependencies. This workspace participates
in repository tests, typechecking and linting. Run it with pinned Bun from a
checkout, or from an install of packed packages for the API Worker.

## Render and check

```bash
bun packages/cloud/deploy/src/cli.ts render \
  --deployment cloud/deployment.json --environment staging \
  --upstream path/to/eliza --out cloud --component all

bun packages/cloud/deploy/src/cli.ts check \
  --config cloud/wrangler.staging.jsonc

bun run --cwd packages/cloud/deploy test
bun run --cwd packages/cloud/deploy typecheck
bun run --cwd packages/cloud/deploy lint:check
```

`--component` is `api` by default; it also accepts `login`, `speech`, `admission`,
`web` or `all`. `all` renders every defined component before writing any output,
so a validation refusal leaves the destination unchanged. Environments are
`staging` and `production`. Exit codes: 0 success, 1 validation/check failure,
2 command usage error.

API output is `wrangler.<environment>.jsonc` and `secrets.<environment>.txt`.
Other components insert their name before the environment. Secret files contain
names only. Paths are relative to the destination: render again after moving it
or changing upstream. Pages deployment requires copying its rendered config to
the project's `wrangler.json` or `wrangler.toml`.

## Deployment file

Start with [examples/product.json](examples/product.json). The exact field and
validation contract is [src/schema.ts](src/schema.ts). A deployment has an `id`
and an `environments` object. Each environment declares:

- Worker name, account ID, routes and zones, web/app/API origins and tenant ID.
- Public service name, blob authority (`host[:port]`), assets base, mail sender,
  billing URL, and entitlement issuer/audience.
- Hyperdrive, KV, R2 and rate-limit resource IDs; optional placement and Durable
  Object transfers; extra non-secret `vars`; required secret names.
- Optional `components`: login, speech, admission and web.

Unknown fields, malformed identities, credentials in configuration, secret-named
plain variables, and attempts to override derived variables are rejected. Product
configs may not carry Eliza hosts, account/resource IDs or Worker/project names.
Upstream settings the renderer does not understand also stop rendering.

Component rules:

- Login declares its custom domain, enabled flag, container settings, variables
  and secret names. Products must supply every setting whose runtime default is
  an Eliza host or mail sender, plus all five required login secrets. Without a
  pushed container image, deployment builds upstream's Dockerfile.
- Speech and admission receive the API's deployment identity. Cross-Worker
  bindings name this deployment's owners. A dedicated admission Worker requires
  `durableObjectTransfers.InferenceAdmissionGate` to name it, preserving one gate.
  `speech.hostsSessions` directs new speech sessions to that Worker while the API
  keeps its export for existing sessions.
- Pages derives identity, API upstream, tenant, environment and native callback
  variables, and binds this deployment's API Worker. Native callbacks must use
  the environment's web/app origin and its API origin. Product Pages requests
  fail with 503 if `API_UPSTREAM` is absent or malformed.

## Installed API packages

A product can bundle the API without an upstream checkout. Install
`@elizaos/cloud-api` and `@elizaos/cloud-deploy`, and create `worker.ts`:

```ts
export * from "@elizaos/cloud-api/worker";
export { default } from "@elizaos/cloud-api/worker";
```

```bash
bunx cloud-deploy render --deployment deployment.json --environment staging \
  --packages . --main worker.ts --out .
bunx cloud-deploy check --config wrangler.staging.jsonc --metafile bundle.json
```

`--packages` supports the API only. It reads the installed package's Wrangler
template, keeps its internal aliases and reports omitted sibling-source aliases;
those dependencies resolve through `node_modules`. Source-shipped packages remain
TypeScript; other packages resolve to built outputs. Checkout and installed
bundles therefore need not be byte-identical. A product install also resolves
Wrangler from the manifest range rather than the checkout lockfile.

[scripts/pack-check.ts](scripts/pack-check.ts) validates tarballs and a clean
product install without publishing:

```bash
bun packages/cloud/deploy/scripts/pack-check.ts --work /path/outside/the/repo \
  --public workspace
```

Build workspace outputs first; `--built <tree>` accepts an equivalent built tree.
The check replaces workspace ranges in staged copies, packs required packages,
rejects shipped tests/fixtures/secret files and missing exports, installs with
scripts disabled, renders and bundles, and checks that every file input stays
inside the product. `--public workspace` requires bundled Eliza packages from
these tarballs; `--public registry` tests published versions instead. Third-party
dependencies come from npm.

## Scope of checks

Worker checks run `wrangler deploy --dry-run` without Cloudflare credentials.
Login adds `--containers-rollout=none`, so its image is not built. Pages has no
deployment dry run: the checker compiles Functions with the rendered config in a
scratch Pages project. It does not build the Vite app. Reports explicitly list
unvalidated behavior. `--wrangler`, `--keep` and Worker-only `--metafile` are
available for inspection.

[deployments/eliza.json](deployments/eliza.json) has parity tests against the
upstream templates. Rendered API configuration adds six explicit identity
variables and omits staging's empty migration list. Login matches exactly;
speech/admission add deployment identity variables; Pages adds the deployment ID
and flattens each environment. The speech/admission staging values differ from
their present runtime defaults: qualify the staging contract before deployment.
Secret lists have not been compared with deployed Workers. Existing Wrangler
files and release workflows remain authoritative.

The five source packages (`@elizaos/cloud-api`, `cloud-shared`,
`cloud-services-common`, `plugin-network`, `cloud-deploy`) are public, in the
release cohort, at the cohort version and under fixed versioning. None has been
published: publication remains a coordinated maintainer release with the
packages they depend on. Run the pack check on the release commit before
publication and again from the registry after it. The full Cloud dependency
install is large.

Resource provisioning, database baselines/migrations, product Vite builds and
branding, login container qualification, resource/account validation, live
Durable Object transfers, native-device acceptance and actual deployment remain
separate work. Login, speech, admission and Pages currently require a checkout;
their packages and JavaScript/type-declaration builds are not provided here.
