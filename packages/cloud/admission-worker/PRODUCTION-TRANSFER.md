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
| Bindings of `Nprod` | `eliza-cloud-api-prod` `INFERENCE_ADMISSION_GATES`; known external consumer `diag-admission-caller-9bd05690` `PRODUCTION` (`script_name = eliza-cloud-api-prod`) |
| Object baseline | 100 sampled IDs, 91 with stored data. Public summary `OBJECT-IDENTITIES-BEFORE.json`; the IDs stay in Root's private receipt |
| Effective variables | Root's receipts `CURRENT-EFFECTIVE-FLAGS.json`, `auth-cache-flag-review/EFFECTIVE-FLAGS.json` and `auth-cache-flag-review/EFFECTIVE-FUNDED-RATE-FLAGS.json` |

## Phase sources

Each phase is one commit. Before a deploy, the validator must name that phase.

| Step | Commit | Deploys | `--phase` |
| --- | --- | --- | --- |
| 0 live source | `a6252d47d2c6f022ecc3736c0ed14d760dc01d51` | nothing (serving today) | `source-owned` |
| 1 target pending | `489ae447576e78e5c1e5fcc4dd07894537a8c325` | admission Worker, Root CLI | `target-pending` |
| 2 source commit | `eaf2467cddcd320584b3b0850dbd668caca6c503` | API, protected release from `main` | `source-commit` |
| 3 target adopted | `f24f2879288313c32021ece8168f6f1549891688` | admission Worker, Root CLI | `adopted` |
| Steady state | branch tip, landed on `main` | release workflow | `adopted` |

These commits are frozen. The fixes after Root's review of `8da60fe4` change
only files that no phase deploy reads: the readback, the audit, their fixtures,
the reverse patches and this runbook. Deploy only from a phase commit. Run the
audit and the readback from the reviewed branch tip, in a separate checkout.

Run every command from the repository root with Bun 1.4.2 and built workspace
dependencies (`bun run build:core`). The admission deploy uses the API's
Wrangler, as staging does. `$STATE` is Root's directory
`admission-worker-production-plan-20261101`.

## Gates

1. **Root, each phase.** Root approves one phase at a time, holds the release
   lock and is the only deployer. During the transfer, nobody deploys,
   releases, rolls back or changes a secret on the API, the target or the
   diagnostic consumer. A secret change also creates a new Worker version.
2. **Human merge gate for phase 2.** A maintainer with merge authority lands
   the phase 2 change on `main`. Production must already serve the `main`
   commit under it, so the merge differs from live only in admission. If
   `main` moved, release `main` first, outside the transfer window. Land the
   phase 2 change, not the branch tip: the tip's workflow requires `adopted`
   and stops. Root's phase approval does not grant this merge.
3. **Final human merge gate.** After phase 3 reads back, a maintainer lands
   the branch tip on `main`. Only then does the release workflow publish the
   adopted state. Until then, `main` keeps the phase 2 tree. Its release
   workflow publishes only the API, which keeps the tombstone and the target
   binding.

## Tools

The audit is offline. It checks every phase row above, the steady state and
the reverse steps: the validator of that tree with the pinned phase, a config
diff limited to the admission export and binding, and the effective variables.

```bash
bun packages/cloud/scripts/production-admission-phase-audit.ts \
  --effective "$STATE/CURRENT-EFFECTIVE-FLAGS.json" \
  --effective "$STATE/auth-cache-flag-review/EFFECTIVE-FLAGS.json" \
  --effective "$STATE/auth-cache-flag-review/EFFECTIVE-FUNDED-RATE-FLAGS.json"
```

Add `--commit source-owned=<live main SHA> --commit source-commit=<phase 2 main
SHA>` for gate 2, and `--steady <main SHA>` for gate 3. Any `problems` entry
stops the transfer.

The readback needs `CLOUDFLARE_ACCOUNT_ID` and a read-capable
`CLOUDFLARE_API_TOKEN`. In phase mode it proves the expected owner of `Nprod`,
the exact set of bindings of `Nprod` in every script, that the diagnostic
consumer still resolves `Nprod` through the API, API and target variable
parity, and that the 100 sampled IDs are still listed with their stored data.
`--previous` lets only the Worker of this phase change version.

```bash
bun packages/cloud/scripts/production-admission-readback.ts \
  --phase <phase> [--commit <deployed SHA>] \
  --object-sample <Root's private sample> \
  --object-summary "$STATE/OBJECT-IDENTITIES-BEFORE.json" \
  [--previous <previous receipt>] > <receipt>
```

The sample is JSON: `[{id, hasStoredData}]` or `{namespace, objects: [...]}`.
The receipt holds counts and the sample file's SHA-256, never the IDs. A
sampled object that disappears or loses its stored data stops the transfer.
One that gains stored data is normal traffic; the receipt counts it.

## Before phase 1

1. Root takes the release lock.
2. Run the audit. Expect no problems.
3. Record the baseline: `--phase source-owned` without `--commit`, saved as
   `R0.json`.

## Phase 1: target pending

```bash
git checkout 489ae447576e78e5c1e5fcc4dd07894537a8c325
bun packages/cloud/admission-worker/verify-staging-contract.ts --production --phase target-pending
cd packages/cloud/api
bunx wrangler deploy --config ../admission-worker/wrangler.toml --env production \
  --dry-run --outdir ../../../test-results/admission-worker-production-phase-1
bunx wrangler deploy --config ../admission-worker/wrangler.toml --env production \
  --var ELIZA_DEPLOY_COMMIT:489ae447576e78e5c1e5fcc4dd07894537a8c325 \
  --tag 489ae447576e78e5c1e5fcc4dd07894537a8c325
```

The dry run lists `INFERENCE_RECOVERY_SERVICE` and 16 variables, and no
Durable Object binding. Wrangler warns that the top-level
`INFERENCE_ADMISSION_GATES` is not on `env.production`; that is intended.
Record the pending-transfer receipt for `Nprod`. Then read back
`--phase target-pending --commit 489ae447576e78e5c1e5fcc4dd07894537a8c325
--previous R0.json` as `R1.json`. The API still owns `Nprod`, its version does
not change, and the target has no binding of `Nprod`.

## Phase 2: source commit

This deploy commits the transfer for every object. Start only after gate 2 and
after `R1.json` names `Nprod`. The 32 MiB API dry run is not run locally:

1. On the phase 2 `main` commit, run
   `verify-staging-contract.ts --production --phase source-commit`.
2. Run the audit with the gate 2 `--commit` values. The phase 2 API diff must
   be exactly `exports.InferenceAdmissionGate` (`storage` to `state =
   "transferred"`, `transferred_to`) and the binding's `script_name`.
3. Deploy the API through the protected release workflow for that commit, so
   secrets, `--var` values and provenance match every release. The workflow
   on that commit publishes only the API. Do not deploy the API from a local
   CLI: `keep_vars` and the release `--var` values would change live
   variables.
4. Read back `--phase source-commit --commit <phase 2 main SHA> --previous
   R1.json` as `R2.json`. The target owns `Nprod`. The API binding names the
   target. The target version does not change. The API still exports the
   class code as the tombstone.

## Phase 3: target adopted

Start only after phase 2 is fully rolled out. Before the source commit, a live
export here creates a second namespace.

```bash
git checkout f24f2879288313c32021ece8168f6f1549891688
bun packages/cloud/admission-worker/verify-staging-contract.ts --production --phase adopted
cd packages/cloud/api
bunx wrangler deploy --config ../admission-worker/wrangler.toml --env production \
  --dry-run --outdir ../../../test-results/admission-worker-production-phase-3
bunx wrangler deploy --config ../admission-worker/wrangler.toml --env production \
  --var ELIZA_DEPLOY_COMMIT:f24f2879288313c32021ece8168f6f1549891688 \
  --tag f24f2879288313c32021ece8168f6f1549891688
```

The dry run adds `INFERENCE_ADMISSION_GATES (InferenceAdmissionGate)`. Its
`index.js` is byte-identical to the phase 1 bundle; only configuration
differs. Read back `--phase adopted --commit
f24f2879288313c32021ece8168f6f1549891688 --previous R2.json` as `R3.json`. The
target's local binding resolves `Nprod`, not a new ID. Recovery of an expired
lease reaches the API through `INFERENCE_RECOVERY_SERVICE` (observability
logs). A failed recovery keeps the lease for the existing retry path. Then
gate 3. From then on, each production release validates `adopted`, reads back,
deploys the admission Worker, reads back, deploys the API and reads back.

## Stop conditions

Stop, keep every Worker, class and tombstone, and report the receipt when:

- a validator, audit, dry run, deploy or readback fails;
- `Nprod` changes, disappears, loses SQLite storage or has another owner;
- a second `InferenceAdmissionGate` namespace appears;
- any script gains, loses or retargets a binding of `Nprod`;
- a sampled object disappears or loses its stored data;
- API and target variables differ;
- a Worker serves more than one version, or an unexpected commit;
- another deploy, release or secret change runs during a phase.

Never retry a failed phase with different configuration.

## Known external consumer

`diag-admission-caller-9bd05690` binds `PRODUCTION` to the class in
`eliza-cloud-api-prod`. It is not rebound. The API keeps the transferred
tombstone, so the binding keeps resolving `Nprod`; every readback proves this.
A change to that Worker during the transfer is a stop condition. After it, a
rebind or deletion is a reviewed change to `KNOWN_EXTERNAL_CONSUMERS` in the
readback, or the release readback stops.

## Rollback

Ordinary version rollback does not move namespace ownership.

- **Before phase 2:** the API still owns `Nprod`. Keep the pending target and
  its evidence, and resolve the pending transfer explicitly before another
  attempt. Do not create or delete classes to guess.
- **Between phases 2 and 3:** the only reviewed path is forward: complete
  phase 3, then reverse if needed.
- **After phase 2:** never deploy, roll back or force-dispatch production to
  a source that declares a live local admission class in the API (any source
  before phase 2, including `a6252d47`). It would try to create the class
  again. A compatible API version keeps the tombstone and the target binding.
  Target code may roll back only to adopted, protocol-compatible versions.

### Reverse transfer

The reverse steps move the same `Nprod` back to the API from the steady state.
Each is a patch in `reverse-transfer/`, applied in order on the steady state
and committed as its own reviewed commit. The audit validates all three.
Never delete or recreate the class, the target Worker or the namespace. Writes
and leases made after phase 2 stay in `Nprod`.

| Step | Patch | Deploys | `--phase` |
| --- | --- | --- | --- |
| R1 | `R1-reverse-pending.patch`: API export `expecting-transfer` from the target, `storage = "sqlite"`; binding keeps `script_name` | API | `reverse-pending` |
| R2 | `R2-reverse-commit.patch`: target export `transferred` to the API, no `storage`; target bindings `[]` | admission Worker, Root CLI | `reverse-commit` |
| R3 | `R3-reverse-adopted.patch`: API export `storage = "sqlite"`; binding loses `script_name` | API | `reverse-adopted` |

For each step: `git apply` the patch, commit, run the validator with its
phase, deploy, then read back with its phase, its commit and `--previous`.
R2 deploys like phase 1, after a dry run whose `index.js` matches phase 1 and
lists no Durable Object binding. After R3, the API's local binding resolves
`Nprod`, and the target keeps its tombstone.

R1 and R3 are not executable yet. They need Root's reviewed release-path work:

1. `cloud-cf-release.yml` accepts only `adopted` for production. R1 and R3
   need an explicit, Root-dispatched path that validates the committed
   reverse phase, skips the admission Worker upload, deploys only the API with
   the release secrets and `--var` values, and reads back with that phase. The
   release has no object sample, so the readback needs a phase mode without it,
   and Root reads back with the sample right after.
2. After R3, `adopted` no longer matches. Every later production release stops
   at validation until the workflow accepts `reverse-adopted` as a steady
   state (API only, target tombstone kept) or the forward transfer runs again.
3. No environment has run a reverse transfer. A staging rehearsal needs the
   validator to accept reverse phases for staging; today staging accepts only
   `adopted`.
