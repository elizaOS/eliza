---
name: alchemy
description: Configure, test locally in workerd, and deploy Vibestack applications to Cloudflare with Alchemy v2 (alchemy.run): read before writing or editing alchemy.run.ts, Cloudflare Worker/DO/Static Assets stacks, or deployment CI workflows.
---

# Alchemy deployment, local runtime, and verification

Eliza on Vibestack uses **Alchemy v2** (`alchemy@2.0.0-beta.85` + `@alchemy.run/cloudflare@2.0.0-beta.85` + `@alchemy.run/test@2.0.0-beta.85`), Effect 4 native, running directly on Node 26+.

## Hard rules

- **Use Alchemy v2 only** (`alchemy` + `@alchemy.run/cloudflare` at `2.0.0-beta.85`). Never install legacy v1 (`alchemy-async` / `0.x`) or obsolete placeholders (`alchemy-effect`, `@alchemy.run/core`, `alchemy.run`).
- **Never install `@cloudflare/vite-plugin`** alongside Alchemy: `Cloudflare.Website.Vite` injects `@alchemy.run/cloudflare-runtime/vite` automatically and conflicts with `@cloudflare/vite-plugin`.
- **Keep `pnpm check` offline and fast.** Never run live cloud deploys inside `pnpm check` or default `pnpm test`. Run offline `workerd` boot/integration verification in `pnpm test:deploy` (using `@alchemy.run/test/Vitest` with `dev: true`) and live post-deploy checks inside `Alchemy.Action`.
- **Always set `ALCHEMY_FAST_DISTILLED=1`** (or `--fast-distilled`) on Node 26 CLI invocations to lazy-load distilled cloud operations and cut startup time and heap usage.
- **Allow `workerd` build scripts** in `pnpm-workspace.yaml` (`allowBuilds: { workerd: true }`).
- **Ignore local state directories**: keep `.alchemy/` and `.wrangler/` out of Git, ESLint, Stylelint, and Turborepo task inputs.
- **Isolate `deploy/` from package `tsconfig.json` and `typescript-eslint` `projectService`**: files importing `@alchemy.run/cloudflare` pull `@distilled.cloud/cloudflare` declarations; typecheck them via a dedicated `deploy/tsconfig.json` and list `**/deploy/**` and `**/alchemy.run.ts` in `untyped` in `eslint.config.js` so `lint:js` never OOMs.
- **Never commit secrets or pass them through cached Turbo tasks.** Put `CLOUDFLARE_*`, `ALCHEMY_*`, `R2_STATE_*`, and `ELIZA_CLOUD_*` only in `passThroughEnv` on `cache: false` deploy tasks.

## Toolchain alignment

- Alchemy `2.0.0-beta.85` requires `effect: "^4.1.0"` and Node `>=26`.
- Eliza pins `effect: 4.1.1`, `@effect/platform-node: 4.1.1`, `@effect/vitest: 4.1.1`, and `vibelang` / `vibelang-runtime` / `vibelang-vite` at `0.0.13`, matching `alchemy@2.0.0-beta.85` with zero peer conflicts.
- Pin exact `alchemy`, `@alchemy.run/cloudflare`, and `@alchemy.run/test` versions in `pnpm-workspace.yaml` under `catalog:`.

## Eliza domain to Cloudflare mapping

| Layer | Cloudflare primitive in Alchemy v2 |
| --- | --- |
| `@elizaos/cloud-worker` API & hosted return pages | `Cloudflare.Worker` (`packages/cloud-worker/alchemy.run.ts`) with `bundle: false` prebuilt Worker ESM (`dist/worker/entry.mjs`), `compatibilityFlags: ["nodejs_compat"]`, `crons: ["* * * * *"]`, and `assets: { ...hashAssetDirectory(pagesDir), binding: "ASSETS", runWorkerFirst: true }` |
| Retired v3 SQLite Durable Objects | Re-exported as HTTP 410 `RetiredDurableObject` stubs from the prebuilt Worker entry with `AdoptPolicy.adopt(true)` and `RemovalPolicy.retain()` so live DO namespaces stay intact for rollback |
| Existing external Postgres pool | `createHyperdriveRef` from `vibestack/alchemy.ts` (zero `Account > Hyperdrive:Read` API calls, resolved from `ELIZA_CLOUD_V4_WRANGLER_CONFIG` with explicit `ELIZA_CLOUD_HYPERDRIVE_ID` override and staging/production defaults, guarded by `assertStageGuard`), `Cloudflare.Hyperdrive.lookup` when resolving by name (`ELIZA_CLOUD_HYPERDRIVE_NAME`), plus `dev` origin support for local `alchemy dev` and `DATABASE_URL` fallback locally |
| Workers AI & Send Email bindings | `Cloudflare.Email.SendEmail` (`SIGN_IN_EMAIL`, resolved from `ELIZA_CLOUD_V4_WRANGLER_CONFIG` and enabled by default on staging/production) and optional `Cloudflare.Workers.AI()` (`AI`) |
| Post-deploy verification gate | `Alchemy.Action` calling `verifyDeploymentEndpoints` from `vibestack/alchemy.ts` against `/api/health`, `/api/public/service`, and `/api/v1/auth/methods`, returning a typed `DeploymentReceipt` |

## Helpers in `vibestack/alchemy.ts`

`vibestack/alchemy.ts` is a zero-dependency Node 26 module exported as the `./alchemy` package subpath, providing four composable primitives:

1. **`resolveStage` & `assertStageGuard`**:
   - Discriminated `StageTarget` (`dev`, `test`, `preview`, `staging`, `production`).
   - Scopes local dev/test stages by user and git worktree (`dev_<user>_<worktree>`, `test_<user>_<worktree>`) so parallel worktrees and agents never collide. Never hardcode a fixed `dev.port`.
   - `assertStageGuard(target, { resourceIds, domains, productionIds, productionDomains })` fails statically before deploy if any non-production stage references a production resource ID or domain.
2. **`hashAssetDirectory(dir)`**:
   - Deterministically SHA-256 hashes a Turbo-built static asset directory and returns `{ directory, path, hash, fileCount, totalBytes }` so `Cloudflare.Worker` skips re-hashing and re-uploading unchanged assets.
3. **`verifyDeploymentEndpoints(baseUrl, endpoints, options)`**:
   - Bounded exponential-retry HTTP verifier handling Cloudflare edge propagation (`404`/5xx cold-start windows), checking status codes, headers, body substrings, JSON predicates, and optional commit SHA headers/fields, returning a typed `DeploymentReceipt`.
4. **`makeR2BucketObjects(config, adapter)` & `createR2BucketClient(config)`**:
   - Zero-dep Node 26 R2 object client supporting both S3-compatible SigV4 (`kind: "s3"`, matching `R2_STATE_ACCESS_KEY_ID` / `R2_STATE_SECRET_ACCESS_KEY`) and Cloudflare R2 REST API (`kind: "api"`). Plugs directly into `alchemy/State/BucketState`'s `makeBucketState` when CI tokens lack `Secrets Store Write`.

## State stores & safe adoption

- **Local dev & offline tests**: `Alchemy.localState()` (stored in `.alchemy/state/`, gitignored).
- **R2 bucket state (CI default when configured)**: wrap `makeR2BucketObjects` in `makeBucketState` using `R2_STATE_BUCKET`, `CLOUDFLARE_ACCOUNT_ID`, `R2_STATE_ACCESS_KEY_ID`, and `R2_STATE_SECRET_ACCESS_KEY` (conditional-put `__lease__.json` locking).
- **Cloudflare managed state**: `Cloudflare.state()` when `ALCHEMY_STATE_STORE=cloudflare` (requires Secrets Store Write permission).
- **Adopting existing Workers & preserving secrets**:
  - Pass `.pipe(Alchemy.AdoptPolicy.adopt(true))` and `.pipe(Alchemy.RemovalPolicy.retain())` (and `--adopt` on CLI) when adopting `eliza-cloud-api-staging` and `eliza-cloud-api-prod`.
  - **Worker secrets are preserved**: `Cloudflare.Worker` does not wipe secrets set outside Alchemy (such as the 253 existing encrypted secrets on `eliza-cloud-api-{staging,prod}`); it only deletes secrets previously managed by Alchemy.
  - **Durable Object migrations**: always run `pnpm deploy:plan -- --stage <stage>` first when adopting Workers with existing or retired Durable Object classes to confirm zero unintended `deleted_classes` operations.

## Local dev & verifiable testing (`workerd`)

- **Local runtime**: `pnpm dev:cf` runs `ALCHEMY_FAST_DISTILLED=1 alchemy --fast-distilled dev` (real local `workerd` with hot reload — zero Cloudflare credentials required).
- **Offline `workerd` verification (`pnpm test:deploy`)**:
  - Uses `@alchemy.run/test/Vitest` (`Test.make({ providers: Cloudflare.providers(), dev: true, stage })`) in `packages/cloud-worker/deploy/worker.test.ts` with `beforeAll(deploy(Stack))` and `afterAll(destroy(Stack))`.
  - Boots the real built `@elizaos/cloud-worker` bundle + `ASSETS` inside local `workerd` — catching global-scope runtime errors, Node compat regressions, and asset routing issues offline in PR CI before touching Cloudflare.
  - The same `verifyDeploymentEndpoints` probes run post-deploy inside `Alchemy.Action` against the live deployed URL.

## Turborepo & zero-trust CI optimization

- **Single-build handoff**: build `@elizaos/cloud-worker` once through Turborepo (leveraging the R2 `vibestack-turbo-cache` remote cache), then pass the prebuilt ESM bundle (`bundle: false`) and hashed `dist/pages` assets (`hashAssetDirectory`) into Alchemy so CI never double-builds.
- **Zero-trust publication boundary**:
  - Untrusted PR verification jobs (`.github/workflows/ci.yml`) read shared caches and run offline `pnpm test:deploy` (`workerd`) with **no** Cloudflare deploy secrets.
  - Privileged deploy jobs (`.github/workflows/deploy-cloud-worker.yml`) run with `concurrency: { cancel-in-progress: false }` on `staging` and `main`, verify database identity and release migrations read-only before deploying, never restore untrusted PR caches, and fail atomically if post-deploy `Alchemy.Action` verification fails.
- **Credentials**: Alchemy reads `~/.alchemy/profiles.json` (`alchemy profile edit --add Cloudflare`) or `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (it does not read Wrangler's OAuth token).
