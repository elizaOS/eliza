# Benchmark integration review

Reviewed on 2026-09-23 in the shared monorepo checkout. These checks validate
integration and harness behavior, not benchmark scores or agent quality.
Concurrent changes elsewhere in this checkout are outside this cleanup.

## Cleanup completed

- Removed the nested Git repository, empty `eliza/` checkout, submodule metadata,
  submodule setup scripts, copied workspace configuration, redundant lockfile,
  and nested workflows that GitHub would never execute.
- Registered the benchmark workspaces with the monorepo. Installation uses the
  root lockfile. Biome declarations and schemas are unified at **2.5.8**;
  the repository consistency check now passes, including `packages/os`.
- Migrated Framework, LifeOps, ConfigBench, VoiceBench, and Three-Agent Dialogue
  away from retired runtime APIs. Runners explicitly compose assistant behavior;
  in-memory database users now use the supported SQLite testing adapter.
  ConfigBench no longer patches a legacy database adapter or searches core for
  the moved secrets plugin.
- Removed the unsupported minimal-bootstrap scenario instead of silently
  measuring different behavior under its old name. Removed the retired CLI
  inference route and its fallback. Fixed current-owner graph imports,
  lifecycle contract paths, test helpers, and account-broker resolution.
- Migrated deterministic model responses to current Stage-1 and native tool
  contracts. The new [HTTP smoke](scripts/runtime-smoke.py) verifies
  authentication, execution through the real message service, captured actions,
  and explicit nonpublishable mock labeling.
- Removed registrations, campaign entries, baseline generators, scorer functions,
  harness adapters, exports, and obsolete tests for the retired Hyperliquid,
  RLM, ScamBench, Solana, and WooBench suites. Removed the nonexistent Smithers
  harness from live orchestration choices. Historical result readers retain
  compatibility with archived identifiers; those identifiers register no runs.
- Reconciled campaign accounting and runtime gates with the remaining suites.
  Inventory now reports **53 adapters, 44 registry entries, zero missing
  adapters, and zero unrepresented benchmark directories**.
- Fixed action-calling's monorepo corpus path. Calibration explicitly reports
  an unavailable full corpus; smoke rows cannot claim full-corpus provenance.
- Removed the dead production-finance evidence producer. Its benchmark dataset
  and scoring contract remain, without claiming support from a retired action.
  Updated household permissions and kept non-use fixture timestamps inside the
  production assessment window.
- Consolidated repeated pytest registration into a shared bootstrap while
  retaining standalone-suite invocation. LifeOps Vitest uses the repository's
  canonical workspace source aliases.
- Removed duplicate instruction files, repeated evidence boilerplate, duplicate
  VoiceAgentBench fixtures, generated corpus-audit reports, and redundant
  metadata/report-copy tests. Cost reports write to ignored output directories.
- Added narrow ignore-rule exceptions for authored task trees and consumed
  snapshots hidden by the root runtime-state rules. These inputs will now be
  included when the benchmark sources are committed.
- Added the root [benchmark workflow](../../.github/workflows/benchmarks.yml)
  for offline tests, inventory, and runtime smoke checks. Paid live framework
  execution requires explicit manual selection. Execution classifications no
  longer claim nonexistent scheduled workflows.
- Benchmark provenance and resume fingerprints include the enclosing runtime,
  plugins, patches, and root lockfile, including uncommitted changes.

## Inputs intentionally retained

Vendored OSWorld helpers, isolated Terminal-Bench container inputs, protected
answers, NL2Repo fixtures, seeded worlds, action manifests, replay transcripts,
and golden metrics are consumed benchmark inputs. Their placement or isolation
is part of the benchmark contract. They are not disposable run output, even
when some bytes match or a generator originally produced them.

Generated reports, caches, and local run output are excluded and removed.
Installed dependencies are ignored and remain reproducible from the root lock.

## Validation

- Shared Python, library, and orchestrator checks: **903 passed, 10 skipped**.
- Four harness suites with isolated test-module imports: **449 passed,
  21 skipped**. The Docker boundary is an explicit opt-in in that offline lane.
- Explicit Docker evaluator checks: **5 passed**, including real execution of
  the candidate in the pinned container.
- Native HTTP smoke: passed, including rejected unauthenticated mutation and
  a captured benchmark action through `messageService.handleMessage`.
- Framework single-message smoke: passed with the real runtime and deterministic
  model. Three-Agent Dialogue four-turn synthetic smoke: passed, unscored.
- ConfigBench deterministic run: passed its 682-scenario oracle check.
- Remaining LifeOps unit suite in this shared tree: **4 tests passed**.
- Migrated TypeScript typechecks passed with built workspace dependencies;
  focused Biome checks passed across **66 files**. A later LifeOps recheck was
  blocked by missing sibling declaration outputs, including auth, browser, and
  X plugin declarations. The workspace needs those build dependencies restored
  before that gate can be certified on the final shared revision.
- Standalone VisualWebBench collection: **20 tests collected**. Inventory,
  Biome consistency, changed-document local links, and diff whitespace checks
  passed.
- Root `bun run verify` passes the previous Biome blocker but fails in
  **`@elizaos/ui` lint**, including existing test-file lint errors. It is not
  green for this shared revision.

Hosted workflow execution and live-model scoring were not performed. No paid
model score, native audio quality, or release-readiness claim follows from these
checks. No commit or PR was created by this cleanup.
