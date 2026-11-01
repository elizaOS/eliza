# Production admission namespace transfer

Root is the only executor. This runbook moves the existing production
`InferenceAdmissionGate` namespace from `eliza-cloud-api-prod` to
`eliza-cloud-admission-prod`, as staging did, and back if needed. It never
creates, deletes or replaces a namespace. A production release publishes only
a committed `adopted`, `reverse-pending` or `reverse-adopted` state, after live
readback proves the state it starts from (`cloud-cf-release.yml`).

## Fixed identities

| Item | Value |
| --- | --- |
| Namespace `Nprod` | `9e1a8820e95d4dcaa5867c0e37ea581b` (`eliza-cloud-api-prod_InferenceAdmissionGate`, SQL) |
| Source | `eliza-cloud-api-prod`, version `742e1bf0`, source `a6252d47` |
| Target | `eliza-cloud-admission-prod` (does not exist before phase 1) |
| Bindings of `Nprod` | `eliza-cloud-api-prod` `INFERENCE_ADMISSION_GATES`; known external consumer `diag-admission-caller-9bd05690` `PRODUCTION` (`script_name = eliza-cloud-api-prod`) |
| Object baseline | 100 sampled IDs, 91 with stored data. Public summary `OBJECT-IDENTITIES-BEFORE.json` (counts and `identitySetSHA256`); the IDs stay in Root's private receipt |
| Effective variables | Root's receipts `CURRENT-EFFECTIVE-FLAGS.json` (reads version `742e1bf0`), `auth-cache-flag-review/EFFECTIVE-FLAGS.json` and `auth-cache-flag-review/EFFECTIVE-FUNDED-RATE-FLAGS.json` |

## Phase sources

Each phase is one commit. Before a deploy, the validator must name that phase.

| Step | Commit | Deploys | `--phase` |
| --- | --- | --- | --- |
| 0 live source | `a6252d47d2c6f022ecc3736c0ed14d760dc01d51` | nothing (serving today) | `source-owned` |
| 1 target pending | `489ae447576e78e5c1e5fcc4dd07894537a8c325` | admission Worker, target deploy tool | `target-pending` |
| 2 source commit | `eaf2467cddcd320584b3b0850dbd668caca6c503` | API, protected release from `main` | `source-commit` |
| 3 target adopted | `f24f2879288313c32021ece8168f6f1549891688` | admission Worker, target deploy tool | `adopted` |
| Steady state | branch tip, landed on `main` | release workflow | `adopted` |

These commits are frozen. The fixes after Root's reviews of `8da60fe4` and
`aeb1619e` change only files that no phase deploy reads: the readback, the
audit, the target deploy tool, their fixtures, the reverse patches, this
runbook, and the tip's validator and release workflow. Only the steady state
and the reverse steps read the tip's validator and workflow. Deploy only from a
phase commit. Run the audit, the target deploy tool and the readback from the
reviewed branch tip, in a separate checkout (`$TIP`).

Use Bun 1.4.2 and built workspace dependencies (`bun run build:core`) in every
checkout. `$STATE` is Root's directory
`admission-worker-production-plan-20261101`.

## Gates

1. **Root, each phase.** Root approves one phase at a time, holds the release
   lock and is the only deployer. During the transfer, nobody deploys,
   releases, rolls back or changes a secret on the API, the target or the
   diagnostic consumer. A secret change also creates a new Worker version.
2. **Main and release freeze, from R0 until gate 3 reads back.** `main` takes
   only the gate 2 and gate 3 merges, and production takes only Root's
   dispatches: no other merge, no revert of the phase 2 merge, no `force`
   dispatch and no rollback. Until gate 3, `main` runs the base release
   workflow, which has no production admission check. A revert of the phase 2
   merge passes CI, and its release would declare a live local class in the
   API again. No mechanical guard on `main` prevents that; this freeze does.
3. **Human merge gate 2: the phase 2 change on `main`.** A maintainer with
   merge authority lands exactly the frozen phase 2 change (`a6252d47` to
   `eaf2467c`) on live `main`. The merge's first parent must be the commit the
   API serves in R1, and it may change only the five paths of that change. The
   protected production release also requires a staging certificate for the
   exact tree (`validate-staging-certification`), so the change reaches `main`
   through staging at that tree. Staging's configuration is unchanged by it.
   Root's phase approval does not grant this merge. If `main` moved after R0,
   stop: the audit refuses the merge, and the phase chain must be regenerated
   on the new `main` and reviewed again.
4. **Final human merge gate 3.** After phase 3 reads back, a maintainer lands
   the branch tip on `main`, on top of the phase 2 merge. Only then does the
   release workflow publish the adopted state. Root's approval does not grant
   this merge either.

## Tools

**Audit** (offline). It checks every phase row above, the steady state and the
reverse steps: that tree's validator with the pinned phase, a config diff
limited to the admission export and binding, and the effective variables.

```bash
bun $TIP/packages/cloud/scripts/production-admission-phase-audit.ts \
  --effective "$STATE/CURRENT-EFFECTIVE-FLAGS.json" \
  --effective "$STATE/auth-cache-flag-review/EFFECTIVE-FLAGS.json" \
  --effective "$STATE/auth-cache-flag-review/EFFECTIVE-FUNDED-RATE-FLAGS.json"
```

For gate 2 add `--commit source-owned=<R1 API commit> --commit
source-commit=<phase 2 main SHA> --live R1.json`. Then it also requires the
merge's first parent to be the commit R1 names, only the phase 2 paths in the
merge, and no change to the admission bundle sources between the phase 1
commit and the phase 2 `main` commit. For gate 3 add `--steady <main SHA>`
too; the steady merge's first parent must be the phase 2 `main` commit. Any
`problems` entry stops the transfer.

**Target deploy tool.** Every admission Worker step uses it, never a bare
Wrangler command. It requires a clean checkout at the step's commit (the
runbook commit for phases 1 and 3), runs that tree's validator with the phase,
and builds the bundle with that tree's Wrangler, always with `--config` of the
admission configuration. It refuses to upload for the API's phases.
`--bundle-sha256` must equal the bundle it builds; `--deploy` needs it.

```bash
bun $TIP/packages/cloud/scripts/production-admission-target-deploy.ts \
  --checkout <checkout of the step's commit> --phase <phase> \
  --outdir <new directory> [--bundle-sha256 <H1>] [--deploy]
```

**Readback.** It needs `CLOUDFLARE_ACCOUNT_ID` and a read-capable
`CLOUDFLARE_API_TOKEN`. In phase mode it proves:

- the expected owner of `Nprod`, its SQLite storage, and no second gate
  namespace (pagination fails closed);
- a complete script list, and the exact set of bindings of `Nprod` in every
  script;
- that the API and the target (when it exists) export the class code;
- the diagnostic consumer's binding record is unchanged (see below);
- the live API variables equal Root's receipts, and the receipts read the live
  API version until phase 2; the uncarried gate variables stay unset; API and
  target variables match;
- Root's saved sample: its counts and `identitySetSHA256` match the summary,
  and every sampled ID is still listed;
- with `--previous`: only this phase's Worker changed version, and the sample
  file and every API and target variable value are unchanged.

```bash
bun $TIP/packages/cloud/scripts/production-admission-readback.ts \
  --phase <phase> [--commit <deployed SHA>] \
  --object-sample <Root's private sample> \
  --object-summary "$STATE/OBJECT-IDENTITIES-BEFORE.json" \
  --effective "$STATE/CURRENT-EFFECTIVE-FLAGS.json" \
  --effective "$STATE/auth-cache-flag-review/EFFECTIVE-FLAGS.json" \
  --effective "$STATE/auth-cache-flag-review/EFFECTIVE-FUNDED-RATE-FLAGS.json" \
  [--previous <previous receipt>] > <receipt>
```

The sample is JSON: `[{id, hasStoredData}]` or `{namespace, objects: [...]}`.
`identitySetSHA256` is the SHA-256 of the sorted IDs joined by single
newlines, with no trailing newline. If the saved summary used another form,
R0 stops; Root derives the summary again from the private receipt in this
form. The receipt holds counts, hashes and variable digests, never IDs or
values. Traffic can add or delete a sampled object's stored data; the receipt
counts both. A missing sampled ID, or stored data lost in most of the sample,
stops the transfer.

## Before phase 1

1. Production must serve the tip of `main`. If `main` moved since the last
   production release, Root releases `main` first and captures fresh
   effective-variable receipts; the readback requires them to name the live
   API version.
2. Root takes the release lock, and the freeze starts.
3. Run the audit with `--commit source-owned=<commit the API serves>`.
   Expect no problems.
4. Record the baseline as `R0.json`: `--phase source-owned --commit <commit
   the API serves>`, without `--previous`.

## Phase 1: target pending

```bash
git -C <phase 1 checkout> checkout 489ae447576e78e5c1e5fcc4dd07894537a8c325
bun $TIP/packages/cloud/scripts/production-admission-target-deploy.ts \
  --checkout <phase 1 checkout> --phase target-pending --outdir <dir 1>
```

The dry run lists `INFERENCE_RECOVERY_SERVICE` and 16 variables, and no
Durable Object binding. Wrangler warns that the top-level
`INFERENCE_ADMISSION_GATES` is not on `env.production`; that is intended.
Record the printed `bundleSHA256` as `H1`. Then upload with the same command,
a new `--outdir`, `--bundle-sha256 H1 --deploy`.

Record the pending-transfer receipt for `Nprod`. Read back `--phase
target-pending --commit 489ae447576e78e5c1e5fcc4dd07894537a8c325 --previous
R0.json` as `R1.json`. The API still owns `Nprod`, its version does not
change, and the target has no binding of `Nprod`.

### Abort before phase 2

Until the API commits, the API owns `Nprod` and serves every request. The
pending target has no binding, route or traffic. To abort:

1. Do not dispatch phase 2. Read back `--phase target-pending --commit
   489ae447576e78e5c1e5fcc4dd07894537a8c325 --previous R1.json` as the abort
   receipt; it proves nothing moved.
2. Leave the target deployed as `target-pending`. Do not delete it, and do not
   deploy it without the pending declaration: a cleanup of the pending target
   is a separate reviewed change.
3. End the freeze. `main` keeps the base tree, whose releases deploy only the
   API with its live class, as today. The tip cannot be released by mistake:
   its release readback requires the target to own `Nprod` before any upload.

A later attempt starts again at the audit, with fresh receipts.

## Phase 2: source commit

This deploy commits the transfer for every object. The 32 MiB API dry run is
not run locally; these checks replace it:

1. Gate 2 lands the phase 2 change on `main` as `M`.
2. Run the audit with the gate 2 arguments. The phase 2 API diff must be
   exactly `exports.InferenceAdmissionGate` (`storage` to `state =
   "transferred"`, `transferred_to`) and the binding's `script_name`.
3. Run the target deploy tool on a checkout of `M` with `--phase
   source-commit --bundle-sha256 H1` and no `--deploy` (it refuses one). It
   runs `M`'s validator and proves the API and the target run the same gate
   code and storage schema once the API commits.
4. Dispatch the protected production release for `M`, so secrets, `--var`
   values and provenance match every release. The base workflow on `M`
   publishes only the API. Do not deploy the API from a local CLI:
   `keep_vars` and the release `--var` values would change live variables.
5. Read back `--phase source-commit --commit <M> --previous R1.json` as
   `R2.json`. The target owns `Nprod`. The API binding names the target. The
   target version does not change. The API still exports the class code as
   the tombstone. Every API variable value equals R1's.

## Phase 3: target adopted

Start only after phase 2 is fully rolled out. Before the source commit, a live
export here creates a second namespace.

```bash
git -C <phase 3 checkout> checkout f24f2879288313c32021ece8168f6f1549891688
bun $TIP/packages/cloud/scripts/production-admission-target-deploy.ts \
  --checkout <phase 3 checkout> --phase adopted --outdir <dir 3> \
  --bundle-sha256 H1
```

The dry run adds `INFERENCE_ADMISSION_GATES (InferenceAdmissionGate)`, and the
bundle equals `H1`; only configuration differs. Upload with a new `--outdir`
and `--deploy`. Read back `--phase adopted --commit
f24f2879288313c32021ece8168f6f1549891688 --previous R2.json` as `R3.json`. The
target's local binding names `Nprod`, not a new ID. Recovery of an expired
lease reaches the API through `INFERENCE_RECOVERY_SERVICE` (observability
logs). A failed recovery keeps the lease for the existing retry path.

Then gate 3. Root runs the audit with the gate 3 arguments, dispatches the
release, and reads back `--phase adopted --commit <released main SHA>` as
`R4.json`, without `--previous`: that release deploys both Workers. From then
on, each production release validates the committed phase, reads back, deploys
the admission Worker, reads back, deploys the API and reads back.

## Stop conditions

Stop, keep every Worker, class and tombstone, and report the receipt when:

- a validator, audit, target deploy tool, deploy or readback fails;
- `Nprod` changes, disappears, loses SQLite storage or has another owner;
- a second `InferenceAdmissionGate` namespace appears;
- the script list is incomplete, or a Worker stops exporting the class code;
- any script gains, loses or retargets a binding of `Nprod`;
- a sampled ID disappears, or most of the sample loses its stored data;
- an API variable differs from Root's receipts or from the previous receipt,
  or API and target variables differ;
- a Worker serves more than one version, or an unexpected commit;
- another merge, deploy, release or secret change runs during the freeze.

Never retry a failed phase with different configuration.

## Known external consumer

`diag-admission-caller-9bd05690` binds `PRODUCTION` to the class in
`eliza-cloud-api-prod`. It is not rebound. Every readback proves its binding
record is unchanged: `Nprod`, the class, `script_name` the API, on the same
version. That is not proof that the binding resolves `Nprod` at runtime.
Cloudflare does not expose that, and the API's declaration differs by phase:
live, transferred tombstone, or `expecting-transfer` during the reverse.
Runtime resolution through each phase, forward and reverse, needs a disposable
rehearsal with a third-party consumer. That rehearsal is a separate packet
under Root's review; until it runs, the consumer's runtime behavior is
unproven. A change to that Worker during the transfer is a stop condition. A
rebind or deletion is a reviewed change to `KNOWN_EXTERNAL_CONSUMERS` in the
readback, or every readback stops.

## Rollback

Ordinary version rollback does not move namespace ownership.

- **Before phase 2:** abort as above. The API still owns `Nprod`.
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
(cumulative) and committed as its own reviewed commit. The audit validates all
three with each tree's validator and Root's receipts. Never delete or recreate
the class, the target Worker or the namespace. Writes and leases made after
phase 2 stay in `Nprod`.

| Step | Patch | Deploys | `--phase` |
| --- | --- | --- | --- |
| R1 | `R1-reverse-pending.patch`: API export `expecting-transfer` from the target, `storage = "sqlite"`; binding keeps `script_name` | API, protected release | `reverse-pending` |
| R2 | `R2-reverse-commit.patch`: target export `transferred` to the API, no `storage`; target bindings `[]` | admission Worker, target deploy tool | `reverse-commit` |
| R3 | `R3-reverse-adopted.patch`: API export `storage = "sqlite"`; binding loses `script_name` | API, protected release | `reverse-adopted` |

After gate 3, the release workflow runs R1 and R3. It reads the committed
phase from the validator (`--print-phase`) and checks the live phase before
the upload: `adopted` for R1, `reverse-commit` for R3. It skips the admission
Worker, deploys only the API with the release secrets and `--var` values, and
reads back the committed phase with the release commit. Any other committed
phase stops before an upload. `reverse-adopted` is also a steady state:
later releases publish only the API, and the target keeps its tombstone.

1. **R1.** The R1 commit reaches `main` through a human merge gate, with its
   staging certificate. Root dispatches its production release, then reads
   back `--phase reverse-pending --commit <released main SHA> --previous
   <adopted receipt>`. Take that adopted receipt (`--phase adopted --commit
   <served main SHA>`) right before the R1 release, with the lock held.
2. **R2.** On a checkout of the R2 commit, run the target deploy tool with
   `--phase reverse-commit --bundle-sha256 H1`, then `--deploy`. The dry run
   lists no Durable Object binding. Read back `--phase reverse-commit
   --commit <R2> --previous <R1 receipt>`. R2 need not land on `main`; a
   release of `main` at R1 now stops, because the live state is no longer
   `adopted` or `reverse-pending`.
3. **R3.** The R3 commit (R1, R2 and R3 patches) lands on `main` the same way.
   Root dispatches its release and reads back `--phase reverse-adopted
   --commit <released main SHA> --previous <R2 receipt>`. The API's local
   binding names `Nprod`; the target keeps its tombstone.

The freeze applies from R1 until R3 reads back. No environment has run a
reverse transfer: staging accepts only `adopted`, and the disposable rehearsal
above has not run. The reverse is executable source, not a proven procedure.
