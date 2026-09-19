# GitHub Actions simplification implementation plan

Status: consolidation (#31556), integration repair (#31614), and cache cleanup (#31714) are merged. Surviving hosted failures, final develop qualification and performance measurement remain in progress. See the current checkpoint below.

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
- [x] Capture a timestamped 7-day baseline with paginated runs/jobs: event, branch/SHA, runner, conclusion, queue time, setup/install/build/test duration, cache hits, artifact sizes and cancelled work. Include attempts. Do not infer billing from summed durations. The published 168-hour manifest below records available API data and explicitly marks job-ready queue time unavailable.
- [x] Record the expanded test/command ownership map and read the nearest guides/manifests for changed owners. PR #31556 publishes the comparison; browser selection continuity was independently recomputed from executable inventories.

### 2. Consolidate deterministic execution

- [x] Move unique Tests/Quality/Scenario contracts to canonical owners, keeping practical bounded parallelism.
- [x] Remove duplicate script/server/client/plugin/cloud/static/security execution.
- [x] Create one app test inventory with disjoint test/project/environment assignments; retain unique scenario and real-stack configurations.
- [x] Fold the two fixture workflow wrappers together and retain meaningful browser differences.
- [x] Remove retired workflow files, job aggregates and their obsolete inputs only after every consumer is migrated.
- [x] Update develop surface registry, workflow callers, trigger policy, command inventories and meaningful contract tests atomically. Search `.github`, `packages/scripts`, package scripts, effect registries, documentation and dispatch clients for removed workflow names.

### 3. Simplify control and setup

- [x] Remove no-reuse evidence cache I/O from the normal graph while keeping current-run exact-SHA completion and reconciliation compatibility.
- [x] Remove redundant full-branch classifier jobs. Express required lane membership once; skip is valid only for an explicitly planned optional lane.
- [x] Keep one early cheap validation gate before expensive work. Test required aggregate behavior on failure, cancellation, missing output and zero executed tests.
- [x] Narrow setup inputs; avoid full postinstall/native tools in pure checks; do not introduce installed `node_modules` archives without ABI/platform correctness proof.
- [ ] Measure Turbo/Bun cache restore cost; remove broad fallbacks that cost more than a fresh install. Preserve pinned versions, integrity checks and separate runner state.
- [x] Upload useful diagnostics on failure; avoid redundant successful videos/full build trees. Preserve evidence needed for certification and active PR links; choose short retention for ordinary CI and existing durable policies for release evidence.

### 4. Retire administrative clutter carefully

- [x] Search dispatch callers and activity for each retirement candidate listed below. Lack of automatic triggers is not evidence of obsolescence.
- [x] Resolve retirement candidates: retain migrations with recovery consumers; remove the redundant merge-candidate wrapper with canonical PR validation as its replacement. Keep incident recovery operations that still have a consumer.
- [x] Remove unreachable legacy trigger conditions and stale README claims. Do not add a new periodic workflow.
- [x] Keep release, production operations, Terraform, security analysis and device authorities separate where permissions, environments or runner trust differ.

### 5. Validate, deliver to develop, and repair

- [ ] Run workflow parsing/actionlint, trigger policy, guide parity, documentation link/path validation, and relevant script/aggregate/shard tests.
- [ ] Exercise behavioral gate tests: failed child, cancelled child, missing result, empty shard, unknown path, merge candidate, fork PR without secrets, workflow-call permissions, stale/mismatched SHA, and effect dispatch denied before completion.
- [ ] Run changed packages' tests/typecheck/lint and `bun run verify` using Bun 1.3.14 and Node 24.15.0. Rebase the isolated branch on fresh develop, resolve only our changes, install and re-run required gates.
- [x] Open a scoped PR to develop with command ownership before/after and inspected hosted evidence. Deliver through the repository PR workflow; do not bundle unfinished shared-tree edits or force-push develop.
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

## Current implementation checkpoint — 2026-09-18

[PR #31556](https://github.com/elizaOS/eliza/pull/31556) merged as
`55d8cc2ebc419c7ee57d9fd49956b98e12f5fa81`. At this checkpoint, develop is
`9ce803264c17cfb6b8477d50d082a3be04fe34a1`; it retains all seven
workflow retirements from that consolidation. Subsequent workflow edits repair
existing lanes without restoring the removed wrappers. The older shared checkout still contains the retired
wrappers. They have not been restored on develop.

| Structural measure | Before | After consolidation |
| --- | ---: | ---: |
| Workflow definitions | 67 | 60 |
| Expanded full-validation jobs | 98 | 57 |
| Required workflow families | 14 | 9 |
| Ineffective evidence-cache operations | 28 | 0 |

The consolidation removes 2,797 net lines from `.github`. Six disjoint app
browser partitions preserve the same 962 project/file/test identities. Plugin
shard 3 owns the personal-assistant unit suite formerly repeated by client;
the separate integration contract remains in general E2E. Four Story Gate
shards preserve catalog coverage. Failed app browser shards retain diagnostics
for three days, while successful shards avoid those uploads. Release and
certification artifacts retain their separate authority and retention.

### Baseline and measurement

The [published baseline manifest](https://github.com/elizaOS/eliza/releases/download/pr-evidence-13/31556-baseline-20260916-manifest.json)
covers exactly 168 hours, September 9 at 23:02:23 UTC through September 16 at
23:02:23 UTC: 233 runs, 19,958 jobs, all attempt one. There were 52 failed and
181 cancelled runs, with no successful control. Valid elapsed job time totals
179,622.52 minutes; 913 inconsistent intervals remain in the raw evidence but
are excluded from that total. This supersedes the earlier date-based 234-run
estimate. Durations are not billing, and job-ready queue timestamps are
unavailable. Artifact metadata totals 45,561,562,925 uploaded bytes across
5,174 records; it does not measure retained storage.

The [published cache comparison](https://github.com/elizaOS/eliza/releases/download/pr-evidence-13/31556-cache-20260917-manifest.json)
records mixed warm restore/install results under differing source and runner
conditions. Broad Bun fallback was removed after observed 1.41 GB restores;
these observations do not justify disabling all useful caches. The isolated
follow-up disables unused story-shard Turbo caching, selects one publisher per
smoke/plugin matrix, and removes a plugin Cargo cache whose manifest hash and
payload are empty. Reader shards still install and execute independently.
The cloud follow-up also assigns six batch-runner checks to the first unit
shard, removing 18 repeated executions across the other three shards. All
cloud unit commands remain unconditional; the first shard remains required.
Those duplicates consumed 12 seconds in the inspected develop run, not a
material whole-run speedup. Actionlint across all 60 workflows, 27 focused
cache/pinning contracts and parsed command preservation checks pass. The
combined full gate passed before merge. Hosted plugin shards 1 and 4 on
`ebc808e3a67fb941e29153d89fc896524d32fe3c` both pass in run 35365029880:
shard 1 publishes the Turbo cache and runs Bun's primary-hit post handler;
shard 4 restores both caches without either publication handler. This verifies
that matrix's publisher/reader behavior, not whole-graph performance acceptance.

### Remaining acceptance

[Develop Full run 35307831975](https://github.com/elizaOS/eliza/actions/runs/35307831975)
failed at `d07f6dc`; it is not a successful performance control.
[Integration PR #31614](https://github.com/elizaOS/eliza/pull/31614) merged as
`9ce803264c17cfb6b8477d50d082a3be04fe34a1` on September 18. Its head
`7321244a200285498ff831164f4918250d54407b` passes normal
frozen installation, the complete root verification, all 99 combined scenarios
without skips, and all five hosted PR admission checks. Its real HTTP activation
and cold-restart check passes with the original watchdog. Selected-state UI
supplement review is still in progress.

The repair merge's [Develop Full run 35317307769](https://github.com/elizaOS/eliza/actions/runs/35317307769)
finished with three owning failures: onboarding's generated 67-character
`prompt_cache_key` exceeds its upstream 64-character limit (#31720), a
websocket endpoint assertion matches port digits inside a random client ID
(#31721), and docs route-explorer light-theme contrast fails the Story Gate
(owned with #24104). Downstream aggregate failures are consequences of these
lanes. The selected-state docs review also found dark-hover badge contrast;
that review remains open. These failures are not grounds to delete their checks.

Prior integration head `2ea08dc` passes Windows runtime qualification and
[full CI attempt two](https://github.com/elizaOS/eliza/actions/runs/35306660592).
Attempt one retains an unexplained Twilio HTTP 500; fresh local Worker/PGlite
qualification passes all 18 API E2E files, 517 tests with 18 explicit skips.
The latest develop run also contains intermittent Worker failures. Do not
close those investigations solely because a rerun passes.

1. Cache changes merged through [PR #31714](https://github.com/elizaOS/eliza/pull/31714)
   as `ebc808e3a67fb941e29153d89fc896524d32fe3c`, after full root verification
   and all five hosted admission checks. Inspect reader/writer behavior on the
   resulting develop run; source validation alone does not prove cache savings.
2. Finish the surviving hosted repairs, verify the combined source and merge
   through a reviewed PR. Preserve concurrent edits and existing ownership.
3. Obtain terminal green Develop Full on the resulting current develop SHA,
   including platform contracts. PR admission and canonical CI alone do not
   satisfy this requirement.
4. Obtain successful cold and warm full-graph runs and at least three comparable
   completed post-change observations. Report the 40% job-minute and 30%
   wall-time targets as met, missed or unestablished, with baseline limitations.
5. If qualification exposes a regression in consolidation itself, follow the
   selective rollback procedure below. Product failures keep their owning fixes.

### Selective rollback procedure

Use a fresh worktree and a PR based on current `origin/develop`; never reset or
stash a shared checkout. Diagnose the failing contract before choosing scope.

1. For a cache-publication regression, inspect the inverse of cache merge
   `ebc808e3a67fb941e29153d89fc896524d32fe3c` against its first parent. Restore
   only the affected publisher policy, preserving subsequent setup fixes and
   the cloud test inventory. A cache-only rollback must not restore retired
   duplicate test workflows.
2. For missing validation ownership, compare consolidation merge
   `55d8cc2ebc419c7ee57d9fd49956b98e12f5fa81` with its first parent
   `d1fc585275eb79da97909ee67c513af56e14bddd`. Restore the missing executable
   contract to its current owner first. Restore an old wrapper only if that is
   necessary to recover the contract, and remove its duplicate invocation from
   the consolidated owner in the same change.
3. Review the inverse with `git diff <merge> <merge>^1 -- <affected-paths>`.
   Apply selected hunks to the fresh branch. The complete inverse conflicts
   with later README, CI and plan changes; do not resolve those conflicts by
   replacing current files with historical copies. Keep integration repair
   `9ce803264c17cfb6b8477d50d082a3be04fe34a1` and subsequent product fixes.
4. If surface IDs or job ownership change, update the develop graph, aggregate
   dependencies and executable contract tests together. Preserve missing,
   cancelled and failed-child rejection, current-run source binding, and the
   existing deployment authority boundary.
5. Run actionlint on the complete workflow graph, relevant aggregate/shard and
   trigger contracts, pinned installation, root verification, guide parity and
   Markdown link validation. Merge through a PR and inspect terminal Develop
   Full on the resulting SHA. Record any temporarily restored duplicate work
   as rollback cost; do not claim the original savings during rollback.

These are recovery instructions, not an executed rollback or evidence that an
unmodified historical inverse applies cleanly to current develop.

## Historical execution records

These source-specific records are retained for traceability; the current checkpoint above supersedes their pending delivery status.

Hosted correction: retain the Discord gateway workflow after its adversarial source-only guard exposed a distinct no-configuration/no-secret caller boundary. Consolidating that wrapper alone saved no job execution, so its original authority and tests remain intact. Final structural counts are 60 workflows and 57 expanded develop jobs (98 before), across nine required families. Operational YAML formatting is preserved; device README wording is restored. The two script-lane failures caused by those changes passed targeted local rechecks.

Further execution tracing found that the general end-to-end runner already owns both agent and personal-assistant integration commands. Its executable plan and hosted logs prove membership; the duplicate dedicated integration job is removed, retaining its Node PGlite mode in the surviving owner. The app-core screenshot diagnostic now invokes the owning Vitest configuration directly (two tests pass), avoiding an accidental full app-core sweep caused by forwarding arguments through a chained package script. Cloud's standalone source checks remain enabled by default; Develop Full delegates that duplicate lint/typecheck subset to its mandatory canonical CI family.

Seven-day baseline collection now covers all 234 run inventories / 20,055 jobs after retrying transient GitHub API errors. Latest-attempt elapsed job time totals about 180,409 minutes, including 49,317 minutes in cancelled jobs. These are elapsed durations, not billing, and exclude prior rerun attempts; no successful run control exists in the sampled metadata. The four-shard Story Gate run [35159762211](https://github.com/elizaOS/eliza/actions/runs/35159762211) passed with a reviewed aggregate: 1,689 stories, zero broken or accessibility failures. It records console errors in 78 stories; a green gate is not a claim of an empty browser console. This is one hosted family result, not full develop acceptance.

Post-rebase record: synced onto `215bd8a541` and preserved its diagnostics runner fix in canonical CI while retiring the old Test wrapper. Pinned install and full verify before this rebase exited zero; the exact post-rebase gate is queued behind other agents on the shared host. Manual review confirms 11 Telegram activation runs, two SSH backfill runs, four SlopHub cutover runs, 18 dedicated staging re-review runs, and 64 monetized-loop runs at inspection. Existing authority docs and executable contracts retain these manual consumers; dispatch activity alone is not a retirement criterion.

Review evidence: old canonical Playwright selected 926 tests, old Test WebKit 36, and the consolidated graph selects the identical 962 project/file/test identities. The original auto-discovery command selected 69 filenames and 252 tests, all retained; four filenames were already ignored by the Chromium project. Full local verify passed on `c5a4963bcb`; subsequent review repaired the moved live jobs to reject cleanup-only and diagnostic dispatches and excluded remote-capabilities from generic smoke. Sixteen parsed-condition admission cases and the dedicated canary workflow tests validate that boundary without live effects. PR #31556 remains pending fixed-head qualification and hosted/develop acceptance.

Final admission correction qualified: pinned install and full `bun run verify` exited zero on `a433fe964a`. Failed browser shards now retain their Playwright reports/test-results for three days under unique shard names; successful shards avoid those uploads. This restores useful diagnostics from the retired scenario wrappers.

Terminal hosted logs exposed an additional nested duplicate: client and plugin shard 3 each ran the same personal-assistant `test` command (2,750 tests, 2,744 executed, six skips, zero failures). Executable Vitest file inventories contain the identical 309 files under each lane environment, with no additions or losses; the plugin config does not consume the only-unit selector. The CI client command now excludes that one task, retaining app, browser extension and UI tasks, while the plugin matrix owns the complete suite and general E2E retains its separate integration command. This removes 17.88 observed minutes of duplicate client work; it is not a prediction of full-run wall time. Scope is frozen after this proven duplicate and failed-shard diagnostics.


## Delivery and remaining acceptance — 2026-09-17

Consolidation PR [#31556](https://github.com/elizaOS/eliza/pull/31556) is merged as `55d8cc2ebc419c7ee57d9fd49956b98e12f5fa81`. Its final PR head `feb72b6ea3f674f37f281281090e1bacf28db47d` passed all five hosted admission checks in [run 35166723688](https://github.com/elizaOS/eliza/actions/runs/35166723688). This supersedes earlier pending-PR checkpoints above, but does not establish full develop acceptance. Rollback uses a reviewed revert of the consolidation merge relative to its first parent, preserving later concurrent work.

The [published baseline manifest](https://github.com/elizaOS/eliza/releases/download/pr-evidence-13/31556-baseline-20260916-manifest.json) covers exactly 168 hours, 2026-09-09T23:02:23Z through 2026-09-16T23:02:23Z: 233 runs and 19,958 jobs, all run attempts equal to one. There were 52 failed and 181 cancelled runs, with no successful control. The 179,622.52 nonnegative elapsed job-minutes exclude 913 inconsistent intervals, preserved in the raw data. This corrects the earlier date-based 234-run sample; elapsed time is not billing. Job-ready queue timestamps are unavailable from this API and must remain unavailable rather than inferred from dependency waits. Artifact metadata records 45,561,562,925 uploaded bytes across 5,174 records, not retained storage or billing.

Executable browser inventories preserve all 962 project/test identities across six disjoint shards. The first merged run executed 895 browser cases with 67 skips and zero failures. The client owner passed with app, extension and UI only; the identical personal-assistant suite remains in plugin shard 3, with its distinct integration owner retained. The four-shard story aggregate covered 1,689 stories, zero broken/accessibility failures, and 78 stories recording console errors. These are inspected component results, not a full-run success claim.

The first full run, [35172605233](https://github.com/elizaOS/eliza/actions/runs/35172605233), was superseded: 46 successful, seven failed and four cancelled jobs. Its 676.17 valid elapsed job-minutes are not a comparable completed control. The later cbf41 run [35175108616](https://github.com/elizaOS/eliza/actions/runs/35175108616) was also superseded, with 43 successful, six failed and eight cancelled jobs. Develop then advanced to `7e7a415b015544c3119a7b984e06fa319f1ea742`; its [full run 35176922818](https://github.com/elizaOS/eliza/actions/runs/35176922818) was in progress at that earlier checkpoint and was subsequently superseded by the Discord repair merge.

Cache log evidence shows a broad Bun fallback restored about 1.41 GB in 23–27 seconds before installation. Final-graph exact-lock misses installed in 22.87 and 49.08 seconds in different jobs; these observations do not prove a net speedup. One client post step spent 22.4 seconds losing a cache reservation race. Warm-cache success and the proposed single-writer decision remain unverified. Turbo and pinned Bun release caches stay enabled.

Remaining acceptance is unchanged: fix the surviving source/fixture/setup failures, obtain terminal green validation on current develop, inspect successful cold/warm full runs, and compare at least three reasonably comparable completed runs. The 40% elapsed job-minute and 30% wall-time targets remain unproven. Do not count cancelled runs or component successes as completion.

The [paired exact-lock cache evidence manifest](https://github.com/elizaOS/eliza/releases/download/pr-evidence-13/31556-cache-20260917-manifest.json) preserves six compressed source logs and the structured comparison; all seven public payload hashes were verified after download. Diagnostics warm restore+install was 25.53 seconds slower, provisioning 5.55 seconds faster, and remote integration 8.85 seconds slower than their preceding cold observations. These are mixed observations under different runner/source conditions, not a causal benchmark or justification for universal cache disable.

Discord timing repair [#31578](https://github.com/elizaOS/eliza/pull/31578) passed all five hosted checks in run35176290653 at exact99cd1f6d79278c058005b2babdba5b4fd1f5c058 and merged normally as `54113ed9cdc0c166dd77397425a59eee45c29921` at2026-09-17T03:26:55Z. The bounded inspection tests replace a flaky wall-clock assertion while retaining complete-content/error behavior. Full develop acceptance remains pending.

## Repair checkpoint — 2026-09-17

At this historical checkpoint, the observed develop revision was `54113ed9cdc0c166dd77397425a59eee45c29921`. Its [Develop Full run](https://github.com/elizaOS/eliza/actions/runs/35178205034) has surviving failures and is not acceptance evidence. The structural reduction is 67 to 60 workflow files, 98 to 57 expanded full-graph jobs, and 14 to 9 required surface families. These counts are not measured runtime or billing savings.

A separate repair candidate addresses the following observed defects. It remains unmerged and requires qualification after rebasing onto current develop; component results below do not replace that gate.

| Finding | Repair and inspected component evidence | Status |
| --- | --- | --- |
| [UI lifecycle #31558](https://github.com/elizaOS/eliza/issues/31558) | Explicit React Testing Library cleanup in the inline widget matrix; 23 focused tests pass and a 12-test lifecycle probe retains zero roots. | Final qualification pending. |
| [Goals imports #31158](https://github.com/elizaOS/eliza/issues/31158) | Exact source aliases for goals/calendar database leaves; clean missing-dist failure reproduced, then 81 tests pass with one existing live-model skip. | Final qualification pending; supersede PR #31159 only after verified merge. |
| [Family intake #31579](https://github.com/elizaOS/eliza/issues/31579) | Supply the canonical healthy-empty envelope for the queried intake GET; preserve mutation fallback and strict browser server-error assertions. | Browser execution and affected captures pending. |
| [Birdeye diagnostics #31581](https://github.com/elizaOS/eliza/issues/31581) | Preserve response body and selected headers in the strict 401 assertion. Local real Worker/PGlite Group H passes 78 tests with four live-provider skips; the later hosted Group H also passes. | Earlier intermittent 500 remains unexplained. No retry or success-policy change. |
| [Connector fixture #31584](https://github.com/elizaOS/eliza/issues/31584) | Separate real iMessage zero-priority selection from unranked first-offered fallback; eight focused tests pass. | Independent source review clear; final qualification pending. |
| [Calendar fixture #31585](https://github.com/elizaOS/eliza/issues/31585) | Reproduce one-shot status interference with an intervening owner read. Keep agent identity unavailable throughout the request, delegate other reads, and restore the fixture in finally. The real HTTP/PGlite regression passes while preserving 503, error-code, unchanged-queue, authorization and tamper assertions. | Independent review clear; final qualification pending. |

Source/runtime owners are repairing the remaining first-run, scenario, OpenAI wire and Worker fixture failures. Track their exact merged revisions and terminal hosted results; local results from an unmerged owner branch do not make develop green. The shared working tree has not been stashed, reset or included in the repair.

A same-checkout root verification comparison changed all 373 Turbo task hashes between the 7e7a and 54113 bases. The complete inherited environment and global-input summaries were not captured, so the invalidating input is unproven. Preserve Turbo run summaries on the next required gate rather than starting a duplicate full run for measurement. No cache policy change is justified by this observation alone.

## Combined repair delivery checkpoint — 2026-09-17

Google capability schema PR #31121 advanced develop to `13cc36d4acbe0f29f426cd9e6e69aeb262abe818`. The preceding 54113 run, [35178205034](https://github.com/elizaOS/eliza/actions/runs/35178205034), finished cancelled: 45 successful, eight failed and four cancelled jobs. Valid nonnegative intervals total 708.22 elapsed job-minutes; two negative timestamp intervals are excluded and retained in the measurement data. This is not billed usage or a successful performance control. Its [replacement run 35181380381](https://github.com/elizaOS/eliza/actions/runs/35181380381) is still in progress at this checkpoint.

The coordinator assigned the seven-file workflow repair at `2a69561c5fda02a3e1e536a1880ffd534829e1dd` to the first-run repair owner for one combined final qualification and PR. This avoids a duplicate installation, root verification and full UI run. The workflow repair branch remains frozen; there is no separate PR #31558 (31558 is an issue). Exact file hashes and original component proofs are available in the [component evidence manifest](https://github.com/elizaOS/eliza/releases/download/pr-evidence-13/31558-components-2a69561-manifest.json). These are pre-combination proofs, not final-head acceptance.

The combined owner must retain the additional goals suite, real HTTP/PGlite calendar integration, real Worker/PGlite Group H diagnostic check, and family-operations browser control test, alongside the shared UI/root/app-audit gates. Keep issue #31581 open: its previous intermittent response failure remains unexplained. Replace this checkpoint's pending statements only after inspecting terminal results at the actual combined revision and its resulting develop SHA.

The combined candidate also includes the reviewed Windows browser-security Node 24.15 pin and failure-only package diagnostics for #31587. Its [component evidence](https://github.com/elizaOS/eliza/releases/download/pr-evidence-13/31587-cca0e1f7-manifest.json) does not establish the cause of the earlier missing Vitest chunk. Exact combined-head Windows PowerShell 5.1 execution remains required.

The unchecked final-validation items above remain open for the final combined
source. Historical passing checks do not qualify later commits, and successful
individual families do not establish full develop completion. No production
effect dispatch or repository-protection change is part of this cleanup.
