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
| Source | `eliza-cloud-api-prod`, source `fbb124e5` (`main`, released 2026-11-01T15:52:55Z), on the version that release published. Root records that version in fresh receipts |
| Target | `eliza-cloud-admission-prod` (does not exist before phase 1) |
| Bindings of `Nprod` | `eliza-cloud-api-prod` `INFERENCE_ADMISSION_GATES`; known external consumer `diag-admission-caller-9bd05690` `PRODUCTION` (`script_name = eliza-cloud-api-prod`) |
| Object baseline | 100 sampled IDs, 91 with stored data. Public summary `OBJECT-IDENTITIES-BEFORE.json` (counts and `identitySetSHA256`); the IDs stay in Root's private receipt |
| Effective variables | Root's receipts `CURRENT-EFFECTIVE-FLAGS.json`, `auth-cache-flag-review/EFFECTIVE-FLAGS.json` and `auth-cache-flag-review/EFFECTIVE-FUNDED-RATE-FLAGS.json`, captured again on the version that serves `fbb124e5` |

The receipts of 2026-11-01T12:37Z read version `742e1bf0` (source
`a6252d47`). Until phase 2 the readback requires the receipts to name the live
API version, so it refuses them now: Root captures them again first. The
values stay the same. `packages/cloud/api/wrangler.toml` at `fbb124e5` is
identical to the file at `a6252d47`, and the audit finds no drift between its
production variables and those receipts' values. The release workflows on
`fbb124e5` change only the Pages deploy, not the API's `--var` values or
secrets. A fresh receipt with another value stops the audit.

## Phase sources

Each phase is one commit. Before a deploy, the validator must name that phase.

| Step | Commit | Deploys | `--phase` |
| --- | --- | --- | --- |
| 0 live source | `fbb124e5432197ec8554e99ab5ecf343c31d8f22` | nothing (serving today) | `source-owned` |
| 1 target pending | `42df2e14de66779ff02f67e0afd8216357989620` | admission Worker, target deploy tool | `target-pending` |
| 2 source commit | `ac729ff04edf6dc3532803b0bfd1f362327c76d5` | API, protected release from `main` | `source-commit` |
| 3 target adopted | `e07ab734390d92adfe1d456412c994dddebef439` | admission Worker, target deploy tool | `adopted` |
| Steady state | branch tip, landed on `main` | release workflow | `adopted` |

These commits are frozen. The chain was first built on `a6252d47`; `main`
then moved to `fbb124e5`, so it was regenerated there. The validator commit
`2e8601d8` and each phase commit carry the same change as their reviewed
counterparts on `a6252d47` (`e7b911d8`, `489ae447`, `eaf2467c`, `f24f2879`),
cherry-picked with `-x`: only the base differs. None of the phase files
changed between the two bases. The commits after phase 3 change only files
that no phase deploy reads: the readback, the audit, the target deploy tool,
their fixtures, the reverse patches, this runbook, and the tip's validator
and release workflow. Only the steady state and the reverse steps read the
tip's validator and workflow. Deploy only from a phase commit. Run the audit,
the target deploy tool and the readback from the reviewed branch tip, in a
separate checkout (`$TIP`).

Use Bun 1.4.2 and built workspace dependencies (`bun run build:core`) in
`$TIP` and in one phase checkout, `$PHASE`. The admission bundle includes
ignored `dist` outputs and `node_modules`, so `H1` holds only for one build.
Build `$PHASE` once, and run phase 1, the gate 2 bundle check and phase 3 in
it: check out each step's commit there, never rebuild or reinstall. The audit
proves those steps have the same bundle sources. R2 reuses `$PHASE` only if
its bundle sources (the audit's `ADMISSION_BUNDLE_SOURCES`) still equal phase
1's; otherwise R2 needs a fresh build and its own reviewed bundle hash.
`$STATE` is Root's directory `admission-worker-production-plan-20261101`.

## Gates

1. **Root, each phase.** Root approves one phase at a time, holds the release
   lock and is the only deployer. During the transfer, nobody deploys,
   releases, rolls back or changes a secret on the API, the target or the
   diagnostic consumer. A secret change also creates a new Worker version.
   From R0, nobody changes a GitHub variable or secret the release reads: the
   `production` environment's, the repository's or the organization's. The
   phase 2 release republishes them.
2. **Branch and release freeze, from R0 until gate 3 reads back.** `develop`,
   `staging` and `main` take only the gate 2 and gate 3 changes, and
   production takes only the runs Root names: no other merge, no revert of the
   phase 2 merge, no `force` dispatch and no rollback. Until gate 3, `main`
   runs the base release workflow, which has no production admission check. A
   revert of the phase 2 merge passes CI, and its release would declare a live
   local class in the API again. No approval step stops it: the `production`
   GitHub Environment has only its `main` branch policy and no required
   reviewers (`gh api repos/elizaOS/eliza/environments/production --jq
   .protection_rules`). Whenever `main` moves, the main reconciler dispatches
   the production release once Develop Full passes on `main`
   (`cloud-production` in `.github/main-effects.json`), and it runs at once.
   So this freeze is the only stop between gate 2 and gate 3. Required
   reviewers on `production` for the window would add one; that is Root's or
   the owner's decision. Before each step Root confirms that no production run
   is queued or in progress; this prints nothing:

   ```bash
   gh run list --repo elizaOS/eliza --workflow cloud-cf-deploy.yml --limit 100 \
     --json databaseId,displayTitle,status --jq '.[] | select(.status !=
     "completed" and (.displayTitle | startswith("Cloud CF production")))'
   ```

   Keep the window short: line up the gate 3 maintainer before phase 3 and
   land gate 3 right after R3.
3. **Human merge gate 2: the phase 2 change on `main`.** A maintainer with
   merge authority lands exactly the frozen phase 2 change (`fbb124e5` to
   `ac729ff0`) on live `main` as `M`: a merge of `ac729ff0`, not a squash, so
   the tip later merges onto `M` cleanly. `M`'s first parent must be the
   commit the API serves in R1. It may change only the five paths of that
   change, each with its content at `ac729ff0`. It reaches `main` through the
   normal promotion (see "Delivery of `M`" under phase 2). Root's phase
   approval does not grant this merge. If `main` moved after R0, stop: the
   audit refuses the merge, and the phase chain must be regenerated on the new
   `main` and reviewed again.
4. **Final human merge gate 3.** After phase 3 reads back, a maintainer lands
   the reviewed branch tip on `main`, on top of `M`, by the same promotion.
   Only then does the release workflow publish the adopted state. Root's
   approval does not grant this merge either.

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

With `--commit source-owned=<commit the API serves>` it also checks that
commit before phase 1: it must have the phase 1 commit's admission bundle
sources (the audit's `ADMISSION_BUNDLE_SOURCES`), and the chain base's phase 2
paths and release workflows (`RELEASE_WORKFLOWS`: `cloud-cf-deploy.yml` and
`cloud-cf-release.yml`). Otherwise phase 1 would deploy gate code the API does
not serve, gate 2 would refuse `M` only after phase 1 is live, or the phase 2
and steady releases would run workflows nobody reviewed with this chain.

For gate 2 add `--commit source-owned=<R1 API commit> --commit
source-commit=<phase 2 commit> --live R1.json`. Then it also requires the
phase 2 commit's first parent to be the commit R1 names, `ac729ff0` as its
ancestor (a merge, not a squash), only the phase 2 paths in the merge, each
with its content at `ac729ff0`, and no change to the admission bundle sources
from the phase 1 commit. For gate 3 add `--steady <steady commit> --tip
<reviewed tip SHA>` too: the steady commit's first parent must be the phase 2
commit, and its tree must equal a clean merge of the reviewed tip onto it
(`git merge-tree`). Root runs both on the `staging` commits before their
promotion to `main` (see "Delivery of `M`"). Each gate entry prints the
`tree` it checked; the promotion must carry exactly that tree. Any `problems`
entry stops the transfer.

**Target deploy tool.** Every admission Worker step uses it, never a bare
Wrangler command. It requires a clean checkout at the step's commit (the
runbook commit for phases 1 and 3), runs that tree's validator with the phase,
and builds the bundle with that tree's Wrangler, always with `--config` of the
admission configuration. It refuses to upload for the API's phases.
`--bundle-sha256` must equal the bundle it builds. `--deploy` needs it and
`--api-commit`, the commit the API serves now, which `$TIP` must have. Before
the upload, the API commit's tree must validate as the step before (the live
source predates the validator), and a live readback, with the readback's
credentials, must prove that step fully rolled out: each Worker on one version
at 100%, the API on `--api-commit` and, for phase 3, the target still on the
phase 1 commit. A failed readback uploads nothing.

```bash
bun $TIP/packages/cloud/scripts/production-admission-target-deploy.ts \
  --checkout <checkout of the step's commit> --phase <phase> \
  --outdir <new directory> [--bundle-sha256 <H1>] \
  [--deploy --api-commit <commit the API serves>]
```

**Readback.** It needs `CLOUDFLARE_ACCOUNT_ID` and a read-capable
`CLOUDFLARE_API_TOKEN`. In phase mode it proves:

- the expected owner of `Nprod`, its SQLite storage, and no second gate
  namespace (pagination fails closed and ends only on a short page);
- a complete script list, and the exact set of bindings of `Nprod` in every
  script's latest upload and in every version its latest deployment serves;
- that the API and the target (when it exists) export the class code;
- the diagnostic consumer's binding record is unchanged (see below);
- the live API variables equal Root's receipts, and the receipts read the live
  API version until phase 2; the uncarried gate variables stay unset; API and
  target variables match;
- Root's saved sample: its counts and `identitySetSHA256` match the summary,
  most sampled IDs with stored data keep it, and most of those without it
  are still listed;
- with `--previous`: only this phase's Worker changed version, and the sample
  file and every API and target variable value are unchanged.

An uploaded version that no deployment serves, other than a script's latest,
is not read; the freeze keeps any such version from being deployed.

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
values. Traffic can add or delete a sampled object's stored data, and an
object without stored data may then leave enumeration; the receipt counts
each case. A missing sampled ID that had stored data has lost it. Stored data
lost in most of the sample, or most of the IDs without stored data missing,
stops the transfer.

## Before phase 1

1. Production must serve the tip of `main`, and `develop` and `staging` must
   equal it (`gh api repos/elizaOS/eliza/branches/<branch> --jq
   .commit.sha`). If `main` moved since the last production release, Root
   releases `main` first and captures fresh effective-variable receipts; the
   readback requires them to name the live API version. If `develop` or
   `staging` is ahead of `main`, promote or hold that work first.
2. Root takes the release lock, and the freeze starts.
3. Root confirms, read-only on staging's completed transfer, the Cloudflare
   fields the readback has seen only in fixtures. `eliza-cloud-api-staging`
   holds the tombstone and `eliza-cloud-admission-staging` adopted. If any
   differs, stop: the production readback would fail only after the commit.
   - `GET /workers/durable_objects/namespaces?per_page=100&page=<n>`:
     staging's `InferenceAdmissionGate` namespace has
     `eliza-cloud-admission-staging` as `script`. The page after the last one
     (`n` one more than `total_count` / 100, rounded up) returns `result`
     `[]` and `result_info` with `page` equal to `n`, `per_page` 100, `count`
     0 and the same `total_count`. The readback requires each of these. If
     Cloudflare returns the last page again instead, every readback stops
     whenever the namespace total is a multiple of 100.
   - `GET /workers/scripts/eliza-cloud-api-staging/versions/<serving
     version>`: `INFERENCE_ADMISSION_GATES` has that namespace's ID as
     `namespace_id` and `eliza-cloud-admission-staging` as `script_name`.
   - The same version's `resources.script.named_handlers` lists
     `InferenceAdmissionGate` with `class` among its handlers.
4. Run the audit with `--commit source-owned=<commit the API serves>`.
   Expect no problems. A problem in its `before phase 1` entry means the
   frozen chain does not match the API's source: stop, then regenerate the
   phase chain on the commit the API serves and have it reviewed again.
5. Record the baseline as `R0.json`: `--phase source-owned --commit <commit
   the API serves>`, without `--previous`.
6. Record the release's inputs. Take `since`, the `createdAt` of the latest
   successful production run of the commit the API serves, then list each
   input's last update, names and dates only:

   ```bash
   gh run list --repo elizaOS/eliza --workflow cloud-cf-deploy.yml \
     --branch main --commit <commit the API serves> \
     --json databaseId,displayTitle,createdAt,conclusion
   for endpoint in environments/production/variables \
     environments/production/secrets actions/variables actions/secrets \
     actions/organization-variables actions/organization-secrets; do
     gh api --paginate "repos/elizaOS/eliza/$endpoint" --jq \
       "(.variables // .secrets)[] | [\"$endpoint\", .name, .updated_at] | @tsv" ||
       echo "unreadable $endpoint"
   done | sort > "$STATE/INPUTS-R0.tsv"
   ```

   An `updated_at` later than `since`, or an `unreadable` line, stops: the
   phase 2 release would publish that change together with the commit. A
   deleted input leaves no entry. Phase 2 compares this list with a new one,
   so it sees a deletion after R0. A variable deleted between `since` and R0
   shows only in R2, after the commit, as a changed API variable.
7. Settle TRANSFER-2 now if possible. Phase 2 cannot start without it, and an
   abort after phase 1 leaves a pending target that a later attempt cannot
   start from (see the abort).

## Phase 1: target pending

```bash
git -C $PHASE checkout 42df2e14de66779ff02f67e0afd8216357989620
bun $TIP/packages/cloud/scripts/production-admission-target-deploy.ts \
  --checkout $PHASE --phase target-pending --outdir <dir 1>
```

The dry run lists `INFERENCE_RECOVERY_SERVICE` and 16 variables, and no
Durable Object binding. Wrangler warns that the top-level
`INFERENCE_ADMISSION_GATES` is not on `env.production`; that is intended.
Record the printed `bundleSHA256` as `H1`. Then upload with the same command,
a new `--outdir`, `--bundle-sha256 H1 --deploy --api-commit <commit the API
serves, as in R0>`. The tool first reads back `source-owned`: the target
absent and the API on that commit.

Record the pending-transfer receipt for `Nprod`. Read back `--phase
target-pending --commit 42df2e14de66779ff02f67e0afd8216357989620 --previous
R0.json` as `R1.json`. The API still owns `Nprod`, its version does not
change, and the target has no binding of `Nprod`.

### Abort before phase 2

Until the API commits, the API owns `Nprod` and serves every request. The
pending target has no binding, route or traffic. To abort:

1. Do not land or release phase 2. Read back `--phase target-pending --commit
   42df2e14de66779ff02f67e0afd8216357989620 --previous R1.json` as the abort
   receipt; it proves nothing moved.
2. Leave the target deployed as `target-pending`. Do not delete it, and do not
   deploy it without the pending declaration: a cleanup of the pending target
   is a separate reviewed change.
3. End the freeze. `main` keeps the base tree, whose releases deploy only the
   API with its live class, as today. The tip cannot be released by mistake:
   its release readback requires the target to own `Nprod` before any upload.

A later attempt cannot start from this state with these tools: R0
(`source-owned`) and the tool's phase 1 readback both require the target to
be absent. It first needs a separately reviewed change: the cleanup of the
pending target, or a retry that starts phase 1 from the live `target-pending`
state. Then it starts again at "Before phase 1", on a phase chain based on
the commit the API serves, with fresh receipts.

## Phase 2: source commit

This deploy commits the transfer for every object. The 32 MiB API dry run is
not run locally; the checks below replace it.

**Precondition TRANSFER-2: the diagnostic consumer.** Phase 2 does not start,
and gate 2 does not land, until `$STATE` records one of:

- the rehearsal result: in a disposable rehearsal, a third-party consumer
  bound like `diag-admission-caller-9bd05690` (the class, with the source as
  `script_name`) resolved the same namespace at runtime after the source
  committed and after the target adopted; or
- the owner's explicit acceptance that `diag-admission-caller-9bd05690` may
  stop resolving `Nprod` once the API holds only the tombstone, together with
  a separately reviewed rebind plan: its new binding, when it runs after
  phase 3, and the matching change to `KNOWN_EXTERNAL_CONSUMERS`.

Without either, abort as above.

**Delivery of `M`.** The protected release needs a staging certificate for
`M`'s exact tree (`validate-staging-certification`), and staging certifies
only trees it deploys. So the phase 2 change takes the normal reviewed
promotion, `develop` to `staging` to `main`, as the only change on each
branch: the merge lands on `develop`, `staging` deploys and certifies its
tree forward from its own head (the phase 2 change leaves staging's
configuration unchanged), and the promotion to `main` lands `M`. That is why
`develop` and `staging` equal `main` at R0. Never dispatch a staging deploy
from another ref: it would roll staging off its head. Call the `staging`
commit that holds the change `S2`. `M` is `S2` or a merge commit with `S2`'s
tree whose first parent is the previous `main`; the main reconciler refuses a
`main` commit whose tree differs from the reviewed `staging` commit. The gate
2 audit reads only the first parent and the tree, and the freeze keeps `main`
on the commit the API serves, so Root checks `S2` before the promotion. Once
`M` is on `main`, nothing stops its release (see the freeze under Gates).

1. Gate 2 lands the phase 2 change on `develop`, and it reaches `staging` as
   `S2`.
2. Run the audit with the gate 2 arguments and `--commit
   source-commit=<S2>`. The phase 2 API diff must be exactly
   `exports.InferenceAdmissionGate` (`storage` to `state = "transferred"`,
   `transferred_to`) and the binding's `script_name`.
3. Check out `S2` in `$PHASE` and run the target deploy tool with `--phase
   source-commit --bundle-sha256 H1` and no `--deploy` (it refuses one). It
   runs `S2`'s validator and proves that its admission bundle, from phase 1's
   build, equals `H1`. With the audit's unchanged bundle sources, that is the
   evidence that the target serves the API's gate code and storage schema
   once the API commits. The API bundle that CI builds is not compared.
4. Prove the release's inputs unchanged since R0. The release republishes
   `--var` values and secrets built from GitHub variables, secrets and the
   live bindings, with code that `M` does not change: the audit allows only
   the five phase paths, and in the API configuration only the admission
   export and binding. List them again with the loop of "Before phase 1"
   step 6 into `"$STATE/INPUTS-M.tsv"`. `diff "$STATE/INPUTS-R0.tsv"
   "$STATE/INPUTS-M.tsv"` must print nothing: an added, changed, deleted or
   unreadable input stops phase 2, because the release would change a live
   value together with the commit.
5. Only then may a maintainer merge the promotion of `S2` to `main`. When
   Develop Full passes on `M`, the main reconciler dispatches the production
   release of `M`, and it runs without approval. Root dispatches nothing and
   confirms exactly one production run of `M`, and that it succeeded:

   ```bash
   gh run list --repo elizaOS/eliza --workflow cloud-cf-deploy.yml \
     --commit <M> --json databaseId,displayTitle,status,conclusion
   ```

   Secrets, `--var` values and provenance then match every release. The base
   workflow on `M` publishes only the API. Do not deploy the API from a local
   CLI: `keep_vars` and the release `--var` values would change live
   variables.
6. Read back `--phase source-commit --commit <M> --previous R1.json` as
   `R2.json`. The target owns `Nprod`. The API binding names the target. The
   target version does not change. The API still exports the class code as
   the tombstone. Every API variable value equals R1's.

## Phase 3: target adopted

Before the source commit, a live export here creates a second namespace, so
the tool's `--deploy` reads back `source-commit` first: the target owns
`Nprod`, the API serves `M` on one version at 100%, and the target still
serves the phase 1 commit. A phase 2 release that is pending, skipped or still
rolling out stops it. Fetch `M` into `$TIP`: the tool requires `M`'s tree to
validate as `source-commit`.

```bash
git -C $PHASE checkout e07ab734390d92adfe1d456412c994dddebef439
bun $TIP/packages/cloud/scripts/production-admission-target-deploy.ts \
  --checkout $PHASE --phase adopted --outdir <dir 3> \
  --bundle-sha256 H1
```

The dry run adds `INFERENCE_ADMISSION_GATES (InferenceAdmissionGate)`, and the
bundle equals `H1`; only configuration differs. Upload with a new `--outdir`
and `--deploy --api-commit <M>`. Read back `--phase adopted --commit
e07ab734390d92adfe1d456412c994dddebef439 --previous R2.json` as `R3.json`. The
target's local binding names `Nprod`, not a new ID. Recovery of an expired
lease reaches the API through `INFERENCE_RECOVERY_SERVICE` (observability
logs). A failed recovery keeps the lease for the existing retry path.

Then gate 3, without delay. The reviewed tip lands on `develop` and reaches
`staging` the same way, as `S3`: a merge onto the phase 2 commit there.
Before its promotion to `main`, Root runs the audit with the gate 2
arguments, `--commit source-commit=<first parent of S3>`, `--steady <S3>` and
`--tip <reviewed tip SHA>`; the gate 2 checks pin that first parent to `M`'s
tree. Once the promotion lands, the main reconciler releases it without
approval. Root reads back `--phase adopted --commit <released main SHA>` as
`R4.json`, without `--previous`: that release deploys both Workers. From then
on, each production release validates the committed phase, reads back,
deploys the admission Worker, reads back, deploys the API and reads back.

## Stop conditions

Stop, keep every Worker, class and tombstone, and report the receipt when:

- a validator, audit, target deploy tool, deploy or readback fails;
- `Nprod` changes, disappears, loses SQLite storage or has another owner;
- a second `InferenceAdmissionGate` namespace appears;
- the script list is incomplete, or a Worker stops exporting the class code;
- any script gains, loses or retargets a binding of `Nprod`;
- most sampled IDs with stored data lose it (a missing one counts), or most
  sampled IDs without stored data disappear;
- an API variable differs from Root's receipts or from the previous receipt,
  or API and target variables differ;
- a GitHub variable or secret the release reads changed or appeared after
  the last production release, or disappeared after R0;
- a Worker serves more than one version, or an unexpected commit;
- another merge, deploy, release, variable or secret change runs during the
  freeze.

Never retry a failed phase with different configuration.

## Known external consumer

`diag-admission-caller-9bd05690` binds `PRODUCTION` to the class in
`eliza-cloud-api-prod`. It is not rebound during the transfer. Root's phase
readbacks prove its binding record is unchanged: `Nprod`, the class,
`script_name` the API, on the same version. That is not proof that the binding
resolves `Nprod` at runtime. Cloudflare does not expose that, and the API's
declaration differs by phase: live, transferred tombstone, or
`expecting-transfer` during the reverse. Runtime resolution through each
phase, forward and reverse, needs a disposable rehearsal with a third-party
consumer, a separate packet under Root's review. Until it runs, the
consumer's runtime behavior is unproven, so phase 2 waits on TRANSFER-2 (see
phase 2). A change to that Worker during the transfer is a stop condition. A
release does not depend on it: a release readback accepts a deleted consumer
and requires a present one to keep its record. A rebind is a reviewed change
to `KNOWN_EXTERNAL_CONSUMERS` in the readback, or every readback stops.

## Rollback

Ordinary version rollback does not move namespace ownership.

- **Before phase 2:** abort as above. The API still owns `Nprod`.
- **Between phases 2 and 3:** the only reviewed path is forward: complete
  phase 3, then reverse if needed.
- **After phase 2:** never deploy, roll back or force-dispatch production to
  a source that declares a live local admission class in the API (any source
  before phase 2, including `fbb124e5` and `a6252d47`). It would try to
  create the class again. A compatible API version keeps the tombstone and
  the target binding. Target code may roll back only to adopted,
  protocol-compatible versions.

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
   staging certificate, and the main reconciler releases it without approval.
   Root then reads back `--phase reverse-pending --commit <released main SHA>
   --previous <adopted receipt>`. Take that adopted receipt (`--phase adopted
   --commit <served main SHA>`) right before the promotion of R1 to `main`,
   with the lock held.
2. **R2.** On a checkout of the R2 commit, run the target deploy tool with
   `--phase reverse-commit --bundle-sha256 H1`, then `--deploy --api-commit
   <R1 released main SHA>`. It reads back `reverse-pending` first, with the
   API on that commit, and requires that commit's tree to validate as
   `reverse-pending`: Cloudflare shows `adopted` with the same bindings. The
   dry run lists no Durable Object binding. Read back `--phase reverse-commit
   --commit <R2> --previous <R1 receipt>`. R2 need not land on `main`; a
   release of `main` at R1 now stops, because the live state is no longer
   `adopted` or `reverse-pending`.
3. **R3.** The R3 commit (R1, R2 and R3 patches) lands on `main` and is
   released the same way. Root reads back `--phase reverse-adopted --commit
   <released main SHA> --previous <R2 receipt>`. The API's local binding
   names `Nprod`; the target keeps its tombstone.

The freeze applies from R1 until R3 reads back. No environment has run a
reverse transfer: staging accepts only `adopted`, and the disposable rehearsal
above has not run. The reverse is executable source, not a proven procedure.
