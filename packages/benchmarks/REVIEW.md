# Benchmark integration review

Reviewed on 2026-09-23 against the shared working tree. This is a cleanup and
integration review, not benchmark score certification. Other work modified and
staged this checkout during the review; the validation below describes the
observed working tree, not an isolated release revision.

## Cleanup applied

- Removed the nested `.git` directory (146 MB), empty `eliza/` checkout,
  `.gitmodules`, and the submodule setup/workspace-copy scripts.
- Registered benchmark workspaces in the monorepo root. Removed copied runtime
  workspace entries, overrides, patches, and trusted dependency configuration
  from the benchmark manifest. Dependency installation now uses the root lock.
- Removed the redundant top-level Biome configuration and configbench Bun lock;
  aligned benchmark Biome declarations/configurations with root version 2.5.8.
- Removed 54 byte-identical `CLAUDE.md` copies and repeated managed evidence
  boilerplate. Root policy and local `AGENTS.md` files remain authoritative.
- Removed the reproducible LifeOps corpus audit JSON/Markdown output and its
  report-equality test. Retained the behavioral corpus checks; report generation
  remains available. Cost reports now default to ignored `benchmark_results/`.
- Removed the results-matrix tests that depended on already-deleted report
  documents, and the stale meeting-registry prose assertions.
- Consolidated the identical VoiceAgentBench fixture files into
  `fixtures/mock_tasks.jsonl`, updating the voice smoke launcher.
- Removed inert nested GitHub workflows/actions that assumed the standalone
  repository and deleted submodule bootstrap. No hosted replacement is claimed.
- Repaired default runtime paths in the manifest exporter, LifeOps Vitest
  configuration, and subscription gateway. The gateway loads the account broker
  from `packages/app`, and the runner uses core's current `index.ts` entry.
- Updated benchmark provenance and resume fingerprints to include the enclosing
  monorepo runtime packages, plugins, patches, and lockfile. Added tests showing
  that uncommitted changes to these inputs invalidate prior run signatures.
- Removed the retired CLI-inference dependency and its unusable framework route,
  including the zero-vector embedding fallback. Explicit requests for that
  provider now fail with an actionable error instead of selecting an API route.

## Remaining integration findings

| Priority | Finding and affected consumer | Recommended next change |
| --- | --- | --- |
| High | [LifeOps runner](suites/lifeops-bench/runner/src/server.ts) and its tests still target removed core/agent APIs. Typecheck reports `enableDocuments`, removed stage-1 exports, graph exports, and old test-helper imports. Ten test files fail, including import/collection failures. | Migrate imports to current owners, compose assistant behavior explicitly, and exercise a real HTTP benchmark turn before trusting scores. |
| High | [Framework runner](framework/typescript/src/bench.ts) imports the removed `InMemoryDatabaseAdapter` and passes retired runtime options such as `disableBasicCapabilities`. Its typecheck fails. | Use a supported test database/runtime assembly and explicitly document what overhead is measured. Do not silently replace this with a mock of the runtime. |
| High | The inventory reports five registered benchmarks with no discovered adapter: `hyperliquid_bench`, `rlm_bench`, `scambench`, `solana`, and `woobench`. Their directories disappeared during concurrent work; this cleanup did not remove them. [Campaign declarations](suites/orchestrator/full_campaign.py) still reference them. | Reconcile the registry, campaign declarations, adapter factories, scorers, and tests with the intended suite removals in that workstream. Do not simply suppress inventory failures. |
| Medium | The broader orchestrator suite has additional score-contract and code-agent smoke failures beyond missing suites. | Review the individual failures against current scoring and execution contracts; retain honest failures instead of weakening publication checks. |
| Medium | Execution classifications in [ci_coverage.py](suites/orchestrator/ci_coverage.py) are not evidence of active hosted CI. Imported nested workflows never execute in GitHub Actions. | Add selected validated lanes to root workflows after runtime migration, with monorepo paths and explicit live-run opt-in. |
| Medium | Root `verify` stops at a Biome version mismatch from `packages/os` (2.5.6 versus root 2.5.8). | Resolve this in the separate OS integration workstream, then rerun the complete root gate. |

## Duplicates deliberately preserved

The byte-duplicate scan also found copies in vendored OSWorld agents, isolated
Terminal-Bench task containers, protected ground-truth files, and NL2Repo
fixtures. Those paths are part of task packaging or independently vendored
implementations. Removing identical bytes without changing those contracts can
break container builds or expose ground truth to an agent.

The LifeOps action manifest, seeded world snapshots, ASR replay transcripts,
and golden metric baselines are consumed benchmark inputs. They remain even
when their original production involved generation. Run outputs and reproducible
reports are distinct from those inputs.

Further consolidation candidates are the repeated Python test bootstraps and
vendored OSWorld helper implementations. Centralize the first only after testing
standalone suite collection; consolidate the second at its upstream ownership
boundary. The orchestrator and `orchestrator_lifecycle` are different capabilities
and should remain separate.

## Validation observed

- Bun 1.3.14 installation with Node 24.15.0: passed with `--ignore-scripts`;
  native/postinstall builds were not run.
- Shared Python tests, library tests, execution-identity tests, and Eliza server
  manager tests: **273 passed, 10 skipped**. The first run hit a macOS process
  teardown permission failure; the rerun passed without changing that code.
- Expanded execution-identity regression tests: **16 passed**.
- LifeOps behavioral corpus audit tests: **4 passed**.
- Benchmark action plugin: **19 tests passed**, typecheck and lint passed.
- Subscription gateway: **68 tests passed**, typecheck and lint passed.
- Full orchestrator tests: **654 passed, 23 failed**.
- LifeOps runner: **130 tests passed, 5 failed; 10 test files failed overall**,
  including import/collection failures. Typecheck also failed.
- Framework runner typecheck failed on retired runtime APIs.
- Inventory exited **2** for the missing adapters listed above.
- Root `bun run verify` failed at the OS Biome mismatch before subsequent gates.

Live-model scoring, native builds, and UI capture are outside this cleanup;
no benchmark performance or agent-quality claim follows from these checks.
