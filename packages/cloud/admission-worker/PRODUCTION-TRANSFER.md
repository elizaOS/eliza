# Production admission namespace transfer

Root is the only executor. This runbook moves the existing production
`InferenceAdmissionGate` namespace from `eliza-cloud-api-prod` to
`eliza-cloud-admission-prod`, as staging did. It never creates, deletes or
replaces a namespace. A release never runs a phase; it republishes only the
adopted state (`cloud-cf-release.yml`).

## Fixed identities

| Item | Value |
| --- | --- |
| Namespace `Nprod` | `9e1a8820e95d4dcaa5867c0e37ea581b` (`eliza-cloud-api-prod_InferenceAdmissionGate`, SQL) |
| Source | `eliza-cloud-api-prod`, version `742e1bf0`, source `a6252d47` |
| Target | `eliza-cloud-admission-prod` (does not exist before phase 1) |
| Writers of `Nprod` | `eliza-cloud-api-prod` `INFERENCE_ADMISSION_GATES`; `diag-admission-caller-9bd05690` `PRODUCTION` (`script_name = eliza-cloud-api-prod`) |
| Object baseline | 100 sampled IDs, identity set SHA-256 `c6e52d34e597469aebecd4acffd230873f85e4cc1b6a12c6bc4580bc1ca4334d` (Root private receipt) |

## Phase sources

Each phase is one commit. Before a deploy, the validator must name that phase.

| Step | Commit | Deploys | `--phase` |
| --- | --- | --- | --- |
| 0 live source | `a6252d47d2c6f022ecc3736c0ed14d760dc01d51` | nothing (serving today) | `source-owned` |
| 1 target pending | `489ae447576e78e5c1e5fcc4dd07894537a8c325` | admission Worker, Root CLI | `target-pending` |
| 2 source commit | `eaf2467cddcd320584b3b0850dbd668caca6c503` | API, protected release from `main` | `source-commit` |
| 3 target adopted | `f24f2879288313c32021ece8168f6f1549891688` | admission Worker, Root CLI | `adopted` |
| Steady state | branch tip, landed on `main` | release workflow | `adopted` |

Run every command from the repository root with Bun 1.4.2 and built workspace
dependencies (`bun run build:core`). The admission deploy uses the API's
Wrangler, as staging does.

## Readback after every phase

Record each item. Stop at the first difference.

1. Namespace list (`GET /accounts/{account}/workers/durable_objects/namespaces`):
   `Nprod` is present with the same ID, `class = InferenceAdmissionGate` and
   `use_sqlite = true`. No other `InferenceAdmissionGate` namespace exists for
   `eliza-cloud-api-prod` or `eliza-cloud-admission-prod`.
2. Active versions (`.../scripts/{script}/deployments`, then
   `.../versions/{id}`): one version at 100% per Worker. Record the version ID
   and `ELIZA_DEPLOY_COMMIT`.
3. Admission bindings: every `INFERENCE_ADMISSION_GATES` and `PRODUCTION`
   binding still resolves `namespace_id = Nprod`.
4. Object IDs: list the same 100 sampled objects again. The identity set
   SHA-256 must not change. Read no object bodies.
5. Leases and receipts: make no admission mutation during a phase. After
   phase 3, recovery of an expired lease must reach the API through
   `INFERENCE_RECOVERY_SERVICE` (observability logs). A failed recovery keeps
   the lease for the existing retry path.

After phase 3, `bun packages/cloud/scripts/production-admission-readback.ts
--stage admission --commit <phase-3 commit>` checks items 1 to 3 with
`CLOUDFLARE_ACCOUNT_ID` and a read-capable `CLOUDFLARE_API_TOKEN`.

## Phase 1: target pending

```bash
git checkout 489ae447576e78e5c1e5fcc4dd07894537a8c325
bun packages/cloud/admission-worker/verify-staging-contract.ts --production --phase target-pending
cd packages/cloud/api
bunx wrangler deploy --config ../admission-worker/wrangler.toml --env production \
  --dry-run --outdir ../../../test-results/admission-worker-production
bunx wrangler deploy --config ../admission-worker/wrangler.toml --env production \
  --var ELIZA_DEPLOY_COMMIT:489ae447576e78e5c1e5fcc4dd07894537a8c325 \
  --tag 489ae447576e78e5c1e5fcc4dd07894537a8c325
```

Expect: the target exists without an `INFERENCE_ADMISSION_GATES` binding and
with `INFERENCE_RECOVERY_SERVICE` to `eliza-cloud-api-prod` /
`InferenceRecoveryService`. The API version and `Nprod` do not change.
Record the pending-transfer receipt for `Nprod`.

## Phase 2: source commit

This deploy commits the transfer for every object. Start only after the
phase 1 receipt names `Nprod`. Deploy the API through the protected release
workflow from a `main` commit whose tree validates as `source-commit`, so
secrets, `--var` values and provenance match every release. That commit's
workflow still publishes only the API. Do not deploy the API from a local
CLI: `keep_vars` and the release `--var` values would change live variables.

```bash
bun packages/cloud/admission-worker/verify-staging-contract.ts --production --phase source-commit
```

Expect: the API version serves the phase 2 commit. Its
`INFERENCE_ADMISSION_GATES` binding has `script_name =
eliza-cloud-admission-prod` and `namespace_id = Nprod`. The API still exports
the class code as the tombstone. The other 14 classes and 13 Durable Object
bindings are unchanged.

## Phase 3: target adopted

Start only after phase 2 is fully rolled out. Before the source commit, a live
export here creates a second namespace.

```bash
git checkout f24f2879288313c32021ece8168f6f1549891688
bun packages/cloud/admission-worker/verify-staging-contract.ts --production --phase adopted
cd packages/cloud/api
bunx wrangler deploy --config ../admission-worker/wrangler.toml --env production \
  --var ELIZA_DEPLOY_COMMIT:f24f2879288313c32021ece8168f6f1549891688 \
  --tag f24f2879288313c32021ece8168f6f1549891688
```

Expect: the target's local `INFERENCE_ADMISSION_GATES` binding resolves
`Nprod`, not a new ID. Then land the branch tip on `main`. From then on, each
production release validates `adopted`, reads back, deploys the admission
Worker, reads back, deploys the API and reads back.

## Stop conditions

Stop, keep every Worker, class and tombstone, and report the receipt when:

- a validator, dry run, deploy or readback fails;
- `Nprod` changes, disappears or loses SQLite storage;
- a second `InferenceAdmissionGate` namespace appears;
- an object ID in the sample changes, or any binding resolves another ID;
- a Worker serves more than one version, or an unexpected commit;
- another deploy or release runs during a phase.

Never retry a failed phase with different configuration.

## Rollback

Ordinary version rollback does not move namespace ownership.

- **Before phase 2:** the source is unchanged. Keep the pending evidence and
  resolve the pending transfer explicitly before another attempt. Do not
  create or delete classes to guess.
- **After phase 2:** never deploy, roll back or force-dispatch production to
  a source that declares a live local admission class in the API (any source
  before phase 2, including `a6252d47`). It would try to create the class
  again. A compatible API version must keep the tombstone and the target
  binding. Target code may roll back only to adopted, protocol-compatible
  versions.

### Reverse transfer

Move the same `Nprod` back to the API. Each step is its own reviewed commit,
validated before deploy. Never delete or recreate the class, the target
Worker or the namespace. Writes and leases made after phase 2 stay in `Nprod`.

| Step | Configuration change | Deploy | `--phase` |
| --- | --- | --- | --- |
| R1 | API `[env.production.exports.InferenceAdmissionGate]`: `state = "expecting-transfer"`, `storage = "sqlite"`, `transfer_from = "eliza-cloud-admission-prod"`; binding keeps `script_name` | API | `reverse-pending` |
| R2 | Target export: `state = "transferred"`, `transferred_to = "eliza-cloud-api-prod"`, no `storage`; target `durable_objects.bindings = []` | admission Worker | `reverse-commit` |
| R3 | API export back to `storage = "sqlite"`; binding loses `script_name` | API | `reverse-adopted` |

Read back after each step. After R3, the API's local binding must resolve
`Nprod`. Keep the target tombstone. The release workflow accepts only
`adopted`, so R1 and R3 need a reviewed release path before execution.
