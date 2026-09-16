# GitHub Actions simplification implementation plan

Status: implementation in progress in the isolated `chore/workflow-simplification` worktree; local focused validation passed, full local and hosted validation pending.

Prepared 2026-09-16 for elizaOS/eliza. This file is the execution checklist and progress record. The objective is less repeated work and faster trustworthy develop validation, not merely fewer YAML files.

## Baseline and evidence

The audit inspected all 67 workflow definitions, their triggers and job graphs, the four local composite actions, root validation scripts, the develop surface/effect integration, trigger policy, checked-in branch policy, and recent hosted runs. Detailed execution tracing focused on the automatic PR/develop graph; manual operations received an inventory and authority-boundary review, not a live deployment test.

The shared checkout started at `3f3ca48d916bea9a5f0ef3f4cd7b222456fa2c8a` on `codex/31532-lean-node-runtime`, with hundreds of existing edits, including 21 Actions/config files. Working-tree observations include that unfinished work. Remote develop was `cfd144bf95af02590e8707259ad6db8f48edad1d` during readback. Refresh both before implementation; do not overwrite concurrent changes.

- 67 workflows: 55 expose manual dispatch and 22 expose reusable calls (overlapping counts). One owns PR/merge-group admission; one owns branch validation. The other push workflow handles release tags. There are no schedule triggers. Names such as “nightly” and “weekly” do not indicate periodic execution.
- [Develop Full run 35128823244](https://github.com/elizaOS/eliza/actions/runs/35128823244), for `deb7dea70cae27fcec65cf386e10a43a9a120007`, had 98 jobs and approximately **1,156.4 summed job-minutes**, including failed/cancelled work. This is elapsed job duration, not billed minutes or a representative median. It excludes pre-start queue time and does not apply OS billing multipliers.
- That run spent approximately 415.6 minutes in canonical CI, 273.9 in Tests, 164.7 in Scenarios, and 104.7 in Cloud. It finished red in about 68 minutes from run creation to final completion.
- The 30 most recent Develop Full runs sampled across its branches contained 23 cancellations, six failures, and one unfinished run. This bounded sample has no successful run; it is not a long-term reliability statistic.
- `develop-surface-graph.json` sets `reusePolicy: current-run-only` and `runnerImageIdentity: not-bound`. `resolveEvidenceRuns()` therefore requests every surface. Fourteen cache restores in planning and fourteen restore/save steps in completion cannot avoid any surface execution under this policy.
- Root `verify` already includes typecheck, lint, guide parity, focused-test checks, dependency checks, and workflow policy checks. Several child workflows repeat subsets.
- Live branch readback reported `protected: false`, and `/rules/branches/develop` returned an empty list. The checked-in manifest requires `All Tests Passed` plus review. Do not assume the manifest is applied; do not change repository protection as part of compute cleanup.

## Findings and proposed decisions

| Priority | Finding | Implementation decision | Proof required before deleting the old path |
| --- | --- | --- | --- |
| P0 | `ci.yml` and `test.yml` both execute server, client, plugin and script suites. | Make `ci.yml` the canonical deterministic graph. Migrate unique Tests contracts, then delete `test.yml`. | Compare expanded test membership, runner conditions, environment, package filters and shard unions; every unique contract has a new owner. |
| P0 | Script inventory runs in canonical CI, Tests and Scenario PR. | Execute `test:scripts` once per full validation. Remove the two repeated full sweeps. | Unique scenario executors remain; script inventory stays complete and rejects zero work. |
| P0 | Canonical Quality, Tests merge-quality, and Extended Quality repeat lint/typecheck/format. | Keep one `verify` plus one format invocation; retain the actual frontend build. Delete `quality.yml` after migrating unique checks. | Homepage/app output builds and unique snapshot/security checks still run; no nested root unit sweep remains in a build job. |
| P0 | Canonical app smoke, Scenario PR, and Tests zero-key browser overlap. | Use one app Playwright inventory and project/shard partition. Move unique accounts, walkthrough, real-local, deterministic scenario and diagnostic tests to explicit owners. Delete `scenario-pr.yml` after migration. | Compare test IDs plus browser project, environment and setup, not just filenames. Detect overlapping shard assignments and missing tests. |
| P0 | Canonical smoke calls cloud tests while `cloud-tests.yml` runs the cloud manifest. | Cloud workflow owns cloud unit, integration and stack contracts. Remove the duplicate full cloud call. | Check `test-cloud-run.mjs` expansion against cloud workflow commands; retain PostgreSQL concurrency and payment tests. |
| P0 | Gitleaks runs in canonical CI, standalone surface and Tests merge-quality. | Keep one branch secret scan and the separate PR diff scan. | Preserve commit-range/merge-parent semantics, redaction, and scan failure behavior. |
| P0 | Develop evidence caches can never authorize reuse under current policy. | Remove cache restore/save plumbing from the automatic path; retain an exact-SHA, current-run completion manifest and effect handoff. | Missing, failed, cancelled or unexpectedly skipped mandatory lanes prevent success and effect dispatch. Do not enable evidence reuse to make the cache useful. |
| P1 | Multiple nested classifiers run although branch events intentionally select every lane. | Compute selection once per entry workflow. Full develop uses a fixed required suite; PR uses an explicit affected closure. | Unknown paths and shared tooling changes expand conservatively; all mandatory results are checked. |
| P1 | Core and extended UI fixture workflows repeat setup. | Consolidate into one fixture workflow with measured partitions and required Chromium/WebKit coverage. | Keep all distinct UI contracts; bound shard size using runtime rather than arbitrary job count. |
| P1 | Story gate uses a build plus eight shards and aggregate. | Retain its unique story coverage; measure and reduce shards if setup dominates. | Same catalog coverage and failure semantics; report setup versus test time before/after. |
| P1 | Shared setup defaults enable Python, protoc and full postinstall for broad consumers. | Make generic JS setup lean; explicitly opt in native/build/browser prerequisites at actual consumers. Deduplicate Bun bootstrap between composites only where behavior is identical. | Cold-cache install and representative JS, native, cloud, desktop and Windows jobs pass. Preserve existing download integrity and runner isolation. |
| P1 | All heavy surfaces start together, even when cheap structural validation fails. | Run cheap source/workflow/lockfile checks before expensive fan-out. Keep independent tests parallel with bounded concurrency. | Measure whether the saved red-run work outweighs the added healthy-run critical path. Avoid serializing all tests behind a long build. |
| P1 | Live-only jobs allocate runners just to report no work on pushes. | Move credential-backed paths to the existing live entry; use admission before runner-heavy work. | Missing credentials fail requested live runs; no successful develop result claims live-provider proof. |
| P2 | README claims specialized PR triggers that YAML no longer has; job names retain obsolete merge-queue semantics. | Rewrite documentation and names around the final graph; prune unreachable PR/schedule branches after caller search. | Trigger inventory and README agree; preserved manual inputs still function. |
| P2 | Many manual files are migrations, certifications, and deployment authorities. | Retire only proven obsolete operations; retain credential/environment boundaries. | Search internal and external callers, recent dispatch history and runbooks, and identify a supported replacement before deletion. |

Do not remove a failing test just because it is red. The sampled run has real failures in cloud units, server/client suites, UI hosting/activity, script contracts and all story shards. Read their logs, classify setup failure versus product regression versus duplicated failure, and fix the surviving owning lane.

## Target validation design

Retain two automatic entry points: `pr-static-smoke.yml` and `develop-full.yml`. Preserve the stable PR status `All Tests Passed`. Develop completion remains a separate exact-commit authority for promotion/effects.

| Boundary | Required work |
| --- | --- |
| PR and merge candidate | Exact candidate/diff integrity, secret scan, workflow validation, frozen install, affected build/typecheck/lint, relevant high-risk payment/subscription and Windows security contracts. Add affected behavioral tests through the consolidated runner where admission currently only checks static correctness; avoid invoking a second full pipeline. |
| Every develop validation | One full deterministic source gate; non-overlapping server/core, client, plugins and script suites; essential integration/scenario contracts; one partitioned app browser suite; unique UI fixtures/story contracts; cloud contracts; product build/startup/container smoke; platform contracts. Deduplicate first while preserving current required coverage. |
| Native/platform changes | Explicit ownership for Android bundle compilation, desktop contracts and macOS/Windows smoke. Start by preserving current coverage; only narrow after dependency/consumer mapping proves the gate still covers shared runtime changes. |
| Manual certification | Live models, acoustic/voice matrices, physical devices, provider credentials, GPU certification, latency/performance experiments. A deterministic green result does not certify these. |
| Release and deploy | Existing exact-source, protected-environment, staging certificate, migration and release provenance contracts. Workflow cleanup grants no deployment authority. |

Do not replace full develop coverage with “changed since the preceding push”: the preceding tip may have been cancelled or failed. Do not treat Turbo task caching as a green workflow certificate. Preserve latest-tip cancellation with branch-specific groups; never solve starvation by allowing an unbounded queue of stale full runs. First shorten the graph and batch our own commits. If cancellation still dominates, evaluate a bounded dispatcher separately, without breaking staging/main exact-source admission or the current ban on scheduled/completion-triggered validation.

## Implementation sequence

### 1. Refresh and establish ownership

- [x] Re-read status and current workflow diffs; fetch develop without checking out, resetting or stashing the shared tree.
- [x] Create an isolated `chore/` worktree from current `origin/develop`. Do not copy or commit other agents' uncommitted changes. Reconcile any needed overlapping work with its current source before editing.
- [x] Open one concrete consolidation issue citing the measured duplicates and acceptance criteria. Follow CONTRIBUTING coordination requirements.
- [ ] Capture a timestamped 7-day baseline with paginated runs/jobs: event, branch/SHA, runner, conclusion, queue time, setup/install/build/test duration, cache hits, artifact sizes and cancelled work. Include attempts. Do not infer billing from summed durations.
- [ ] Record the expanded test/command ownership map and read the nearest guides/manifests for each script/package being changed. This plan's command overlap is a starting point, not a completed equivalence proof.

### 2. Consolidate deterministic execution

- [x] Move unique Tests/Quality/Scenario contracts to canonical owners, keeping practical bounded parallelism.
- [x] Remove duplicate script/server/client/plugin/cloud/static/security execution.
- [ ] Create one app test inventory with disjoint test/project/environment assignments; retain unique scenario and real-stack configurations.
- [x] Fold the two fixture workflow wrappers together and retain meaningful browser differences.
- [x] Remove retired workflow files, job aggregates and their obsolete inputs only after every consumer is migrated.
- [x] Update develop surface registry, workflow callers, trigger policy, command inventories and meaningful contract tests atomically. Search `.github`, `packages/scripts`, package scripts, effect registries, documentation and dispatch clients for removed workflow names.

### 3. Simplify control and setup

- [x] Remove no-reuse evidence cache I/O from the normal graph while keeping current-run exact-SHA completion and reconciliation compatibility.
- [x] Remove redundant full-branch classifier jobs. Express required lane membership once; skip is valid only for an explicitly planned optional lane.
- [x] Keep one early cheap validation gate before expensive work. Test required aggregate behavior on failure, cancellation, missing output and zero executed tests.
- [x] Narrow setup inputs; avoid full postinstall/native tools in pure checks; do not introduce installed `node_modules` archives without ABI/platform correctness proof.
- [ ] Measure Turbo/Bun cache restore cost; remove broad fallbacks that cost more than a fresh install. Preserve pinned versions, integrity checks and separate runner state.
- [ ] Upload useful diagnostics on failure; avoid redundant successful videos/full build trees. Preserve evidence needed for certification and active PR links; choose short retention for ordinary CI and existing durable policies for release evidence.

### 4. Retire administrative clutter carefully

- [ ] Search dispatch callers and activity for each retirement candidate listed below. Lack of automatic triggers is not evidence of obsolescence.
- [ ] Remove obsolete one-time migrations and redundant manual wrappers with a documented replacement. Keep incident recovery operations that still have a consumer.
- [x] Remove unreachable legacy trigger conditions and stale README claims. Do not add a new periodic workflow.
- [x] Keep release, production operations, Terraform, security analysis and device authorities separate where permissions, environments or runner trust differ.

### 5. Validate, deliver to develop, and repair

- [ ] Run workflow parsing/actionlint, trigger policy, guide parity, documentation link/path validation, and relevant script/aggregate/shard tests.
- [ ] Exercise behavioral gate tests: failed child, cancelled child, missing result, empty shard, unknown path, merge candidate, fork PR without secrets, workflow-call permissions, stale/mismatched SHA, and effect dispatch denied before completion.
- [ ] Run changed packages' tests/typecheck/lint and `bun run verify` using Bun 1.3.14 and Node 24.15.0. Rebase the isolated branch on fresh develop, resolve only our changes, install and re-run required gates.
- [ ] Open a scoped PR to develop with command ownership before/after and inspected hosted evidence. Deliver through the repository PR workflow; do not bundle unfinished shared-tree edits or force-push develop.
- [ ] Exercise hosted cold/warm setup and representative full validation without dispatching production effects. Keep old/new comparison temporary and bounded rather than permanently running both suites.
- [ ] Merge the scoped work, record the resulting develop SHA, and inspect all surviving required jobs on that exact SHA. If another agent advances develop, follow the new tip and distinguish superseded runs from failures.
- [ ] Fix surviving workflow/setup/product issues in scope and repeat until the current develop tip has terminal green validation. Do not call cancelled, skipped, unavailable or locally passing hosted checks green.

## Acceptance and measurement

Correctness takes precedence over arbitrary file or job counts:

1. Each required behavioral contract has one owner per validation run. Matrix partitions are complete and non-overlapping; exceptions for distinct browser/runtime/database environments are explicit.
2. One PR aggregate and one develop completion authority report failure for missing or failed required work. No disabled checks, blanket `continue-on-error`, fake success or secret-driven silent skips.
3. Zero evidence-cache restores/saves that cannot influence execution; no duplicate full script, server/client/plugin or cloud sweeps.
4. A cold-cache full run and subsequent warm run complete successfully on the final implemented graph, including preserved platform contracts. Changes arriving meanwhile require fresh exact-tip evidence.
5. Compare at least three reasonably comparable completed post-change runs to the baseline, separating setup, test time, queue time, cancellations and runner OS. Initial engineering targets: **at least 40% fewer summed job-minutes** and **at least 30% lower full-run wall time**. These are targets, not promised savings; report any miss and the measured remaining bottleneck. The 1,156-minute failed sample alone is not a valid performance control.
6. Keep a concrete rollback revision for graph changes. Roll back only this scoped work; never reset unrelated develop changes. No production policy or credentials change is included.

## Complete workflow disposition inventory

The following table covers all 67 workflow files at audit time. “Retire after migration” means remove the wrapper only after its unique contracts have verified owners. “Review retirement” means a candidate, not an approved deletion.

| Workflow | Triggers | Disposition |
| --- | --- | --- |
| `account-deletion-staging-canary.yml` | workflow_dispatch | Keep: destructive staging certification boundary. |
| `activate-personal-shared-telegram-edge.yml` | workflow_dispatch | Review retirement: cutover candidate; verify deployment-state and recovery consumers. |
| `android-arm64-local-e2e.yml` | repository_dispatch | Keep manual/explicit: distinct live/device/certification environment; share setup where proven identical. |
| `app-live-e2e.yml` | workflow_dispatch | Keep manual/explicit: distinct live/device/certification environment; share setup where proven identical. |
| `arm-headscale-control-plane.yml` | workflow_dispatch | Keep protected operational entry pending caller review; no ordinary develop compute savings from deletion. |
| `backfill-operator-ssh-key.yml` | workflow_dispatch | Review retirement: one-time migration candidate; prove completion and no recovery consumer. |
| `browser-bridge-windows-security.yml` | workflow_call, workflow_dispatch | Keep: Windows-specific security boundary. |
| `build-agent-image.yml` | workflow_dispatch | Keep protected operational entry pending caller review; no ordinary develop compute savings from deletion. |
| `certification-hosted.yml` | workflow_dispatch | Keep manual/explicit: distinct live/device/certification environment; share setup where proven identical. |
| `certification-image.yml` | workflow_dispatch | Keep manual/explicit: distinct live/device/certification environment; share setup where proven identical. |
| `certification-vast.yml` | workflow_dispatch | Keep manual/explicit: distinct live/device/certification environment; share setup where proven identical. |
| `chat-shell-gestures.yml` | workflow_call, workflow_dispatch | Consolidation candidate: move unique gesture/parity contracts into UI fixture owner. |
| `ci.yml` | workflow_call, workflow_dispatch | Keep/refactor: canonical deterministic validation owners. |
| `classify-paths.yml` | workflow_call | Simplify: remove repeated branch invocations; retain proven admission classification. |
| `claude.yml` | issues | Review event noise and maintained consumer; 26 skipped runs in the sampled latest 100 repository runs. |
| `cloud-cf-deploy.yml` | workflow_dispatch | Keep protected operational entry pending caller review; no ordinary develop compute savings from deletion. |
| `cloud-cf-release.yml` | workflow_call | Keep protected operational entry pending caller review; no ordinary develop compute savings from deletion. |
| `cloud-deploy-backend.yml` | workflow_dispatch | Keep protected operational entry pending caller review; no ordinary develop compute savings from deletion. |
| `cloud-gateway-discord.yml` | workflow_call | Consolidation candidate: cloud owner if unique gateway conditions are preserved. |
| `cloud-latency-certification.yml` | workflow_dispatch | Keep manual/explicit: distinct live/device/certification environment; share setup where proven identical. |
| `cloud-placement-ab.yml` | workflow_dispatch | Keep manual/explicit: distinct live/device/certification environment; share setup where proven identical. |
| `cloud-tests.yml` | workflow_call, workflow_dispatch | Keep/refactor: sole cloud deterministic inventory. |
| `codeql.yml` | workflow_dispatch | Keep: on-demand security analysis; no ordinary PR compute. |
| `database-identity-staging-report.yml` | workflow_dispatch | Keep protected operational entry pending caller review; no ordinary develop compute savings from deletion. |
| `deploy-aasa.yml` | workflow_dispatch | Keep protected operational entry pending caller review; no ordinary develop compute savings from deletion. |
| `deploy-apps-worker.yml` | workflow_dispatch | Keep protected operational entry pending caller review; no ordinary develop compute savings from deletion. |
| `deploy-eliza-provisioning-worker.yml` | workflow_dispatch | Keep protected operational entry pending caller review; no ordinary develop compute savings from deletion. |
| `deploy-gateway-webhook.yml` | workflow_dispatch | Keep protected operational entry pending caller review; no ordinary develop compute savings from deletion. |
| `deploy-tunnel-proxy.yml` | workflow_dispatch | Keep protected operational entry pending caller review; no ordinary develop compute savings from deletion. |
| `dev-smoke.yml` | workflow_call, workflow_dispatch | Keep/tune: distinct developer startup and HMR behavior. |
| `develop-full.yml` | push, workflow_dispatch | Simplify: sole branch authority, current-run manifest and handoff. |
| `develop-reconcile.yml` | workflow_dispatch | Keep: exact-source deployment ledger/promotion; update only for manifest compatibility. |
| `device-e2e.yml` | workflow_call, workflow_dispatch | Keep manual/explicit: distinct live/device/certification environment; share setup where proven identical. |
| `docker-ci-smoke.yml` | workflow_call, workflow_dispatch | Keep: production container build and boot contract. |
| `electrobun-contract.yml` | workflow_dispatch | Keep manual/explicit: distinct live/device/certification environment; share setup where proven identical. |
| `gitleaks.yml` | workflow_call | Keep: one branch scan owner, called once. |
| `infra.yml` | workflow_dispatch | Keep protected operational entry pending caller review; no ordinary develop compute savings from deletion. |
| `live-smoke.yml` | workflow_dispatch | Keep manual/explicit: distinct live/device/certification environment; share setup where proven identical. |
| `merge-candidate-biome.yml` | workflow_dispatch | Review retirement: compare exact candidate diagnostic with canonical PR path. |
| `mobile-app-auth-registration-admin.yml` | workflow_dispatch | Keep protected operational entry pending caller review; no ordinary develop compute savings from deletion. |
| `monetized-loop-nightly.yml` | workflow_dispatch | Keep pending consumer review: manual despite its name. |
| `personal-dedicated-rereview-staging.yml` | workflow_dispatch | Review retirement: compare current dedicated certification entry. |
| `platform-smoke.yml` | workflow_call, workflow_dispatch | Keep: macOS/Windows runtime proof and exact-head manual mode. |
| `pr-static-smoke.yml` | pull_request, merge_group | Keep: sole PR/merge admission; reuse consolidated contracts. |
| `prod-ops-runner.yml` | workflow_dispatch | Keep protected operational entry pending caller review; no ordinary develop compute savings from deletion. |
| `production-railway-database-authority-audit.yml` | workflow_dispatch | Keep: protected production authority readback. |
| `quality.yml` | workflow_call, workflow_dispatch | Retire after migration: preserve frontend build and unique source checks. |
| `regen-homepage-baselines.yml` | workflow_dispatch | Keep protected operational entry pending caller review; no ordinary develop compute savings from deletion. |
| `release-electrobun.yml` | push, workflow_call, workflow_dispatch | Keep: release/store authority; preserve signing, tag/source and environment boundaries. |
| `release.yaml` | workflow_dispatch | Keep: release/store authority; preserve signing, tag/source and environment boundaries. |
| `repository-ruleset-drift.yml` | workflow_dispatch, repository_dispatch | Keep: live protection readback; do not conflate with manifest validity. |
| `scenario-pr.yml` | workflow_call, workflow_dispatch | Retire after migration: single browser inventory; retain unique scenarios/accounts/real-stack work. |
| `security-advisory-gate.yml` | workflow_dispatch | Keep protected operational entry pending caller review; no ordinary develop compute savings from deletion. |
| `slophub-cutover.yml` | workflow_dispatch | Review retirement: cutover candidate; verify completion and supported recovery. |
| `snap-publish.yml` | workflow_call | Keep: release/store authority; preserve signing, tag/source and environment boundaries. |
| `staging-staleness-guard.yml` | workflow_dispatch | Keep protected operational entry pending caller review; no ordinary develop compute savings from deletion. |
| `staging-standing-capability.yml` | workflow_dispatch | Keep protected operational entry pending caller review; no ordinary develop compute savings from deletion. |
| `store-mobile-publish.yml` | workflow_call | Keep: release/store authority; preserve signing, tag/source and environment boundaries. |
| `store-windows-publish.yml` | workflow_call | Keep: release/store authority; preserve signing, tag/source and environment boundaries. |
| `tee-build-deploy.yml` | workflow_dispatch | Keep protected operational entry pending caller review; no ordinary develop compute savings from deletion. |
| `test.yml` | workflow_call, workflow_dispatch | Retire after migration: duplicated tests; preserve unique integrations/remote capability/desktop proofs. |
| `ui-e2e-gate.yml` | workflow_call | Consolidate: become the single UI fixture wrapper. |
| `ui-fixture-e2e.yml` | workflow_call | Retire after migration into the UI fixture wrapper. |
| `ui-story-gate.yml` | workflow_call, workflow_dispatch | Keep/tune: unique story catalog contracts; measure shard overhead. |
| `voice-code-bench.yml` | workflow_dispatch | Keep manual/explicit: distinct live/device/certification environment; share setup where proven identical. |
| `voice-live-e2e.yml` | workflow_dispatch | Keep manual/explicit: distinct live/device/certification environment; share setup where proven identical. |
| `weekly-maintenance.yml` | workflow_dispatch | Review retirement: manual despite its name; verify current maintenance consumers. |

## Local action disposition

| Action | Decision |
| --- | --- |
| `setup-bun-workspace` | Retain and narrow generic defaults; explicit native/postinstall opt-ins and measured cache policy. |
| `cloud-setup-test-env` | Retain database/service setup; share exact Bun bootstrap with workspace setup if it reduces maintained logic without widening dependencies. |
| `normalize-snapd-root` | Retain Snap-specific packaging prerequisite. |
| `stage-voice-real-assets` | Retain real voice asset preparation; share within live voice consumers. |

## Plan validation record

- All 67 workflow files are classified exactly once; plan Markdown link/path and conflict-marker checks passed.
- `bun run check:agents-claude` failed in the pre-existing shared tree because tracked `packages/auth/{AGENTS,CLAUDE}.md` and `packages/vault/{AGENTS,CLAUDE}.md` are absent during concurrent package migration. No guide was changed by this planning task.
- The initial plan-only checkpoint made no workflow changes. The implementation below supersedes that checkpoint; full validation, hosted repair and develop completion remain pending.

## Implementation checkpoint — 2026-09-16

Issue: [#31540](https://github.com/elizaOS/eliza/issues/31540). Base revision for a scoped rollback: `cfd144bf95af02590e8707259ad6db8f48edad1d`; revert the consolidation commit(s), never reset concurrent develop work.

The implementation reduces 67 workflow files to 59 and 14 develop surface families to eight. All 28 current-run-only evidence cache restore/save steps are removed. These are structural counts, not measured runtime savings.

| Retired owner | Preserved owner and distinct contracts |
| --- | --- |
| Tests | Canonical CI: two server partitions, four plugin shards, client and scripts once; remote router/Docker/synthetic-world contracts, integration, desktop, diagnostics, model-provider and scenario contracts retained. Credential-backed certification moved to explicit `live-smoke` remote-capabilities admission. |
| Extended Quality | Canonical quality: one verify/format gate plus unique guide/security self-tests. Frontend build retains homepage behavioral tests/snapshots and app build. |
| Scenario PR | Canonical app Playwright projects and six shards; separate accounts, walkthrough and real-local workflow environment retained. Local provisioning/chat contracts have an explicit job. |
| Extended UI fixture and Chat Shell Gestures | UI Fixture Contracts owns core, extended and gesture jobs; duplicate Chromium commands removed, WebKit, launcher, performance and glitch proofs retained. |
| Cloud Gateway Discord | Cloud tests owns gateway integration with its original working directory and environment. |
| Classify Paths | Full branch graph runs its mandatory families directly; PR admission keeps its existing affected closure. Unused standalone classifier and its obsolete tests are retired; Windows command coverage moved to canonical quality. |
| Merge Candidate Biome | Canonical quality owns formatting; its planted-invalid-source regression still executes Biome. No historical dispatch runs were found for this wrapper. |

All develop families now depend on a cheap source/conflict/workflow-lint plan. Story shards wait for a successful catalog build. Native compiler setup defaults are off; existing native and manual operations preserve their prerequisites through explicit inputs. Repository postinstall remains enabled where workspace patches, generated sources and links are required. The separate cloud composite remains because database/service setup differs and nested cache actions previously lost save inputs; no speculative shared bootstrap replaces that boundary.

Manual retirement review retained operator SSH backfill, Telegram edge activation, SlopHub cutover, dedicated staging re-review and maintenance: dispatch history exists and does not prove migration completion or absence of incident-recovery consumers. Claude issue automation remains capability-gated; absence of a repository variable does not establish absence of organization configuration. Removing these entries would save no ordinary develop jobs.

Additional baseline: the seven-day run inventory contains 234 runs (181 cancelled, 52 failed, one in progress at collection). It has no successful control. The inspected story sample spends 91–107 seconds per shard in workspace setup and 149–202 seconds executing a failing shard; a lower shard count requires successful coverage and timing evidence before claiming a speed improvement.

Validation so far: whole-workflow actionlint passes; 97 focused graph/toolchain/admission tests and 23 setup/classifier tests pass; live credential/result shell self-test, Bun pin inventory, trigger policy, guide parity and Markdown path validation pass. `bun install --frozen-lockfile` completed. The first broad verify was stopped to release a saturated shared host; serial script validation was interrupted too. Neither is recorded as passing. Shared-tree changes remain untouched.

Outstanding: finish full serial repository/package gates after the coordinated host slot; inspect remaining artifact/cache costs and command/environment coverage; validate hosted cold/warm behavior, repair surviving failures, deliver through a PR and observe terminal green on current develop. Runtime targets remain unproven. No production effects are dispatched as part of branch validation.
