# Phase 4 Markdown Wipe Candidates

Date: 2026-05-11
Scope root: `/Users/shawwalters/eliza-workspace/eliza/eliza`
Assigned output: `docs/audits/repo-cleanup-2026-05-11/phase-4-markdown-wipe-candidates.md`

## Scope

This audit inventories Markdown files that can be removed, should be reviewed before removal, or should be kept. It follows the cleanup rule from the current task:

- Keep `README.md` files by default.
- Keep actual docs-site docs, especially authored/generated docs under `packages/docs/**` that are part of the Mintlify docs package.
- Flag audit, scratch, change-note, generated report, benchmark result, local worktree, dependency, training corpus, and source-adjacent rationale Markdown for deletion or review.
- Do not delete anything in this pass.

Out-of-scope for command scans: `node_modules`, `dist`, `build`, `.cache`, `.turbo`, and `coverage` folders. A separate generated-artifacts audit should handle JSON, model, data, binary, benchmark, and training artifacts.

## Methodology

Commands used:

```sh
rg --files -g '*.md' -g '!node_modules/**' -g '!**/dist/**' -g '!**/build/**' -g '!**/.cache/**' -g '!**/.turbo/**' -g '!**/coverage/**' | sort
git ls-files '*.md' | sort
find docs -maxdepth 4 -type d | sort
find docs/audits reports packages/inference/reports packages/inference/verify/reports packages/training -type f \( -name '*.md' -o -name '*.MD' \) 2>/dev/null | sort
git status --short --ignored -- packages/training/.venv packages/training/.pytest_cache packages/training/data packages/training/local-corpora
git ls-files '*.md' | rg '(^|/)README\.md$' | wc -l
git ls-files '*.md' | rg '(^|/)(AGENTS|CLAUDE|CHANGELOG|LICENSE|NOTICE|SECURITY|CONTRIBUTING|CODE_OF_CONDUCT)\.md$' | wc -l
```

Observed counts:

| Inventory | Count | Notes |
|---|---:|---|
| Tracked `*.md` files | 2301 | `git ls-files '*.md'`. |
| Tracked `README.md` files | 318 | Kept by user rule unless the whole owner folder is removed. |
| Tracked contributor/legal/change-log style docs | 24 | `AGENTS.md`, `CLAUDE.md`, `CHANGELOG.md`, `NOTICE.md`, etc. Mostly keep or review. |
| `docs/audits/lifeops-2026-05-11/prompts/*.md` | 989 | Generated prompt review pages. |
| `packages/benchmarks/benchmark_results/**/*.md` | 318 | Generated benchmark run outputs. |
| Ignored `.claude/worktrees/**/*.md` | about 13,893 | Local duplicated agent worktrees, ignored by git. |
| Ignored `packages/training/.venv/**/*.md` plus `.pytest_cache` | 16 | Dependency/cache docs, ignored by git. |
| Ignored `packages/training/data/**/*.md` | 125 | Dataset/corpus metadata, ignored by git. |
| Ignored `packages/training/local-corpora/**/*.md` | 8 | Local corpus docs, ignored by git. |

The all-files scan with ignored files enabled is very noisy because `.claude/worktrees/**` duplicates prior workspaces. Those paths are treated as generated local state, not authored repository docs.

## High-Confidence Deletions

These should not affect runtime behavior. Some still require link cleanup because other docs may mention them.

### Local and Ignored Agent Worktrees

Delete as local generated state. These are ignored by git and duplicate repository content inside agent worktrees.

| Path | Evidence | Risk |
|---|---|---|
| `.claude/worktrees/` | `git status --short --ignored -- .claude/worktrees` reports `!! .claude/`; filesystem scan found about 13,893 Markdown files before stopping. | Low. Delete local directory, keep `.claude/` ignored. |

Recommended ignore:

```gitignore
.claude/
```

### Generated Python and Training Local State

Delete as generated/dependency/cache state.

| Path | Evidence | Risk |
|---|---|---|
| `packages/training/.pytest_cache/README.md` | `git status --short --ignored` reports `!! packages/training/.pytest_cache/`. | Low. Cache output. |
| `packages/training/.venv/lib/python3.11/site-packages/anthropic/lib/foundry.md` | In ignored virtualenv. | Low. Third-party dependency doc. |
| `packages/training/.venv/lib/python3.11/site-packages/docstring_parser-0.18.0.dist-info/licenses/LICENSE.md` | In ignored virtualenv. | Low. Third-party dependency doc. |
| `packages/training/.venv/lib/python3.11/site-packages/httpcore-1.0.9.dist-info/licenses/LICENSE.md` | In ignored virtualenv. | Low. Third-party dependency doc. |
| `packages/training/.venv/lib/python3.11/site-packages/httpx-0.28.1.dist-info/licenses/LICENSE.md` | In ignored virtualenv. | Low. Third-party dependency doc. |
| `packages/training/.venv/lib/python3.11/site-packages/huggingface_hub/templates/datasetcard_template.md` | In ignored virtualenv. | Low. Third-party dependency template. |
| `packages/training/.venv/lib/python3.11/site-packages/huggingface_hub/templates/modelcard_template.md` | In ignored virtualenv. | Low. Third-party dependency template. |
| `packages/training/.venv/lib/python3.11/site-packages/idna-3.13.dist-info/licenses/LICENSE.md` | In ignored virtualenv. | Low. Third-party dependency doc. |
| `packages/training/.venv/lib/python3.11/site-packages/numpy/random/LICENSE.md` | In ignored virtualenv. | Low. Third-party dependency doc. |
| `packages/training/.venv/lib/python3.11/site-packages/onnxruntime/Privacy.md` | In ignored virtualenv. | Low. Third-party dependency doc. |
| `packages/training/.venv/lib/python3.11/site-packages/onnxruntime/tools/mobile_helpers/coreml_supported_mlprogram_ops.md` | In ignored virtualenv. | Low. Generated dependency support table. |
| `packages/training/.venv/lib/python3.11/site-packages/onnxruntime/tools/mobile_helpers/coreml_supported_neuralnetwork_ops.md` | In ignored virtualenv. | Low. Generated dependency support table. |
| `packages/training/.venv/lib/python3.11/site-packages/onnxruntime/tools/mobile_helpers/nnapi_supported_ops.md` | In ignored virtualenv. | Low. Generated dependency support table. |
| `packages/training/.venv/lib/python3.11/site-packages/pyarrow/tests/data/orc/README.md` | In ignored virtualenv. | Low. Third-party test data doc. |
| `packages/training/.venv/lib/python3.11/site-packages/torchgen/packaged/autograd/README.md` | In ignored virtualenv. | Low. Third-party dependency doc. |
| `packages/training/.venv/lib/python3.11/site-packages/typer/.agents/skills/typer/SKILL.md` | In ignored virtualenv. | Low. Third-party package metadata. |

Recommended ignore:

```gitignore
packages/training/.venv/
packages/training/.pytest_cache/
```

### Generated or Local Training Corpus Markdown

These are ignored by git and should not live in source unless a training package owner explicitly promotes a small manifest into source.

| Path | Evidence | Risk |
|---|---|---|
| `packages/training/data/` | `git status --short --ignored` reports `!! packages/training/data/`; ignored scan found 125 Markdown files. | Low to medium. Delete local data; keep any canonical source manifests separately if needed. |
| `packages/training/local-corpora/` | `git status --short --ignored` reports `!! packages/training/local-corpora/`; ignored scan found 8 Markdown files. | Low. Local corpora should stay out of repo. |

Representative Markdown found under `packages/training/data/`:

- `packages/training/data/native/SOURCE_MATRIX.md`
- `packages/training/data/native/audit/composition_audit.md`
- `packages/training/data/native/audit/native_synthesis_templates.md`
- `packages/training/data/native/audit/real_eliza_trajectory_comparison.md`
- `packages/training/data/native/audit/runtime_reference_trajectories.md`
- `packages/training/data/native/fillins/final/dataset_prompt_templates.md`
- `packages/training/data/native/fillins/final/fillin_summary.md`
- `packages/training/data/native/fillins/final/rejected_samples.md`
- `packages/training/data/native/fillins/latest/dataset_prompt_templates.md`
- `packages/training/data/native/fillins/latest/fillin_summary.md`
- `packages/training/data/native/fillins/retry-final-failures-1/dataset_prompt_templates.md`
- `packages/training/data/native/fillins/retry-final-failures-1/fillin_summary.md`
- `packages/training/data/native/fillins/retry-quota-1/dataset_prompt_templates.md`
- `packages/training/data/native/fillins/retry-quota-1/fillin_summary.md`
- `packages/training/data/raw/**/README.md`
- `packages/training/data/raw/**/report.md`
- `packages/training/data/raw/**/dataset_card.md`
- `packages/training/data/raw/**/release_notes.md`

Recommended ignore:

```gitignore
packages/training/data/
packages/training/local-corpora/
```

### Generated Prompt Review Pages

Delete or archive outside source. These are generated audit pages, not source docs, and they dominate tracked Markdown volume.

| Path | Evidence | Risk |
|---|---|---|
| `docs/audits/lifeops-2026-05-11/prompts/` | Contains 989 tracked generated prompt review pages. `INDEX.md` starts with `Generated: 2026-05-11T17:22:58.339Z`. | Low once any current prompt-review output is archived externally. |

Exact deletion unit:

```text
docs/audits/lifeops-2026-05-11/prompts/
```

Representative files:

- `docs/audits/lifeops-2026-05-11/prompts/INDEX.md`
- `docs/audits/lifeops-2026-05-11/prompts/prompts.messageHandlerTemplate.md`
- `docs/audits/lifeops-2026-05-11/prompts/service-task.should_respond.md`
- `docs/audits/lifeops-2026-05-11/prompts/service-task.context_routing.md`
- `docs/audits/lifeops-2026-05-11/prompts/planner.template.baseline.md`
- `docs/audits/lifeops-2026-05-11/prompts/planner.schema.baseline.md`
- `docs/audits/lifeops-2026-05-11/prompts/action.*.description.md`
- `docs/audits/lifeops-2026-05-11/prompts/action.*.param.*.description.md`

Recommended follow-up:

```sh
rg -n 'docs/audits/lifeops-2026-05-11/prompts|prompts/INDEX.md' .
```

### Source-Adjacent Change Notes

Delete from source. These are implementation notes about previous parameter typing work, not source, generated docs, package docs, or current user docs.

| Path | Evidence | Risk |
|---|---|---|
| `plugins/app-lifeops/src/actions/book-travel.params.notes.md` | Sibling rationale note, not imported. `rg` only found the generic audit reference in `docs/audits/lifeops-2026-05-09/12-action-typed-params-audit.md`. | Low. |
| `plugins/app-lifeops/src/actions/calendar.params.notes.md` | Starts with `CALENDAR parameter typing rationale (2026-05-10)`. | Low. |
| `plugins/app-lifeops/src/actions/calendly.params.notes.md` | Sibling rationale note, not imported. | Low. |
| `plugins/app-lifeops/src/actions/entity.params.notes.md` | Sibling rationale note, not imported. | Low. |
| `plugins/app-lifeops/src/actions/health.params.notes.md` | Sibling rationale note, not imported. | Low. |
| `plugins/app-lifeops/src/actions/remote-desktop.params.notes.md` | Sibling rationale note, not imported. | Low. |
| `plugins/app-lifeops/src/actions/schedule.params.notes.md` | Sibling rationale note, not imported. | Low. |
| `plugins/app-lifeops/src/actions/screen-time.params.notes.md` | Sibling rationale note, not imported. | Low. |

Before deleting, remove or ignore the stale reference in:

```text
docs/audits/lifeops-2026-05-09/12-action-typed-params-audit.md
```

### Auto-Generated PR Review Lessons

Delete and ignore.

| Path | Evidence | Risk |
|---|---|---|
| `.prr/lessons.md` | Content says it is auto-generated by `prr`; the current file contains a commit diff about deleting itself. | Low. |

Recommended ignore:

```gitignore
.prr/
```

### Generated Benchmark Result Markdown

Delete from source and add/confirm ignores. Keep benchmark source READMEs, harness docs, and benchmark task specs.

| Path | Evidence | Risk |
|---|---|---|
| `packages/benchmarks/benchmark_results/` | 318 Markdown files under timestamped run directories such as `rg_20260505T053030Z_410ea4f0/.../output/agentbench-report.md`. | Low. Generated run output. |
| `packages/benchmarks/configbench/results/configbench-report-2026-05-07T14-23-09-699Z.md` | Timestamped benchmark result. | Low. |
| `packages/benchmarks/configbench/results/configbench-report-2026-05-07T14-34-23-365Z.md` | Timestamped benchmark result. | Low. |
| `packages/benchmarks/configbench/results/configbench-report-2026-05-07T15-04-16-893Z.md` | Timestamped benchmark result. | Low. |
| `packages/benchmarks/configbench/results/configbench-report-2026-05-09T05-31-01-828Z.md` | Timestamped benchmark result. | Low. |
| `packages/benchmarks/configbench/results/configbench-report-2026-05-09T05-31-22-138Z.md` | Timestamped benchmark result. | Low. |
| `packages/benchmarks/configbench/results/configbench-report-2026-05-09T05-34-45-633Z.md` | Timestamped benchmark result. | Low. |
| `packages/benchmarks/configbench/results/configbench-report-2026-05-09T05-35-15-778Z.md` | Timestamped benchmark result. | Low. |
| `packages/benchmarks/configbench/results/configbench-report-2026-05-09T05-35-25-104Z.md` | Timestamped benchmark result. | Low. |
| `packages/benchmarks/configbench/results/configbench-report-2026-05-09T05-35-35-439Z.md` | Timestamped benchmark result. | Low. |
| `packages/benchmarks/configbench/results/configbench-report-2026-05-09T05-35-58-408Z.md` | Timestamped benchmark result. | Low. |
| `packages/benchmarks/configbench/results/configbench-report-2026-05-09T05-37-26-854Z.md` | Timestamped benchmark result. | Low. |
| `packages/benchmarks/openclaw-benchmark/benchmark/benchmark_resukts/ralphy/ralphy.md` | Result folder, typo `benchmark_resukts`, not source docs. | Low. |
| `packages/benchmarks/openclaw-benchmark/benchmark/benchmark_resukts/ralphy/results.md` | Result folder, typo `benchmark_resukts`, not source docs. | Low. |

Recommended ignore:

```gitignore
packages/benchmarks/benchmark_results/
packages/benchmarks/**/results/
packages/benchmarks/**/benchmark_resukts/
```

Use caution with broad `**/results/`: some packages may intentionally track static fixtures there. Prefer package-local ignores if needed.

### Vendored Test Dependency Markdown

Delete only if the Solidity contract tests do not rely on a pristine vendored tree. These are docs inside vendored OpenZeppelin test dependencies, not app source.

| Path | Evidence | Risk |
|---|---|---|
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/.changeset/*.md` | 21 tracked changeset docs. | Low to medium. Could be restored if vendored dependency is updated from upstream. |
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/CHANGELOG.md` | Vendored dependency changelog. | Low. |
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/CODE_OF_CONDUCT.md` | Vendored dependency community doc. | Low. |
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/CONTRIBUTING.md` | Vendored dependency community doc. | Low. |
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/GUIDELINES.md` | Vendored dependency community doc. | Low. |
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/README.md` | Vendored dependency README. User rule keeps READMEs, but this is vendored test fixture docs. | Medium because README deletion is a policy exception. |
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/RELEASING.md` | Vendored dependency release doc. | Low. |
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/SECURITY.md` | Vendored dependency security doc. | Medium because third-party security/license posture may matter. |
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/audits/README.md` | Vendored dependency docs. | Low. |
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/docs/README.md` | Vendored dependency docs. | Low. |
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/fv/README.md` | Vendored dependency docs. | Low. |
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/lib/erc4626-tests/README.md` | Vendored dependency docs. | Low. |
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/lib/forge-std/CONTRIBUTING.md` | Vendored dependency docs. | Low. |
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/lib/forge-std/README.md` | Vendored dependency docs. | Low to medium. |
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/lib/forge-std/RELEASE_CHECKLIST.md` | Vendored dependency docs. | Low. |
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/lib/halmos-cheatcodes/README.md` | Vendored dependency docs. | Low. |
| `packages/app-core/test/contracts/lib/openzeppelin-contracts/scripts/upgradeable/README.md` | Vendored dependency docs. | Low. |

Recommendation: either prune docs from the vendored fixture with an allowlist for legal/license files, or replace the vendored tree with a package/submodule/fetch step.

### Inference Verification Subagent Reports

Delete or archive after preserving current kernel requirements in `packages/inference/AGENTS.md`, `packages/inference/verify/ROADMAP.md`, or issue tracker.

| Path | Evidence | Risk |
|---|---|---|
| `packages/inference/verify/reports/cpu-voice-optimization-subagent-2026-05-11.md` | Dated subagent report. | Low to medium. |
| `packages/inference/verify/reports/metal-kernel-optimization-subagent-2026-05-11.md` | Dated subagent report. | Low to medium. |
| `packages/inference/verify/reports/vulkan-kernel-optimization-subagent-2026-05-11.md` | Dated subagent report. | Low to medium. |

## Review Needed

These are likely cleanup targets, but should not be deleted until references, durable facts, or current release/workflow responsibilities are consolidated.

### Current Cleanup Audit Folder

Keep while this cleanup is active. Delete or archive after implementation signoff.

```text
docs/audits/repo-cleanup-2026-05-11/
```

Current files:

- `docs/audits/repo-cleanup-2026-05-11/README.md`
- `docs/audits/repo-cleanup-2026-05-11/SUMMARY.md`
- `docs/audits/repo-cleanup-2026-05-11/VALIDATION_STATUS.md`
- `docs/audits/repo-cleanup-2026-05-11/phase-2-validation/PHASE-2-REVIEW.md`
- `docs/audits/repo-cleanup-2026-05-11/phase-2-validation/README.md`
- `docs/audits/repo-cleanup-2026-05-11/phase-2-validation/deep-dives/README.md`
- `docs/audits/repo-cleanup-2026-05-11/phase-2-validation/deep-dives/triage-app-e2e-game-launch.md`
- `docs/audits/repo-cleanup-2026-05-11/phase-2-validation/deep-dives/triage-cloud-typecheck-biome.md`
- `docs/audits/repo-cleanup-2026-05-11/phase-2-validation/deep-dives/triage-core-lint.md`
- `docs/audits/repo-cleanup-2026-05-11/phase-2-validation/deep-dives/triage-lifeops-launchqa-sharp.md`
- `docs/audits/repo-cleanup-2026-05-11/phase-2-validation/deep-dives/triage-tooling-madge-types-barrels.md`
- `docs/audits/repo-cleanup-2026-05-11/phase-2-validation/research-gaps-weaknesses-optimization.md`
- `docs/audits/repo-cleanup-2026-05-11/phase-2-validation/research-knip-madge-types.md`
- `docs/audits/repo-cleanup-2026-05-11/phase-2-validation/validation-lint-build.md`
- `docs/audits/repo-cleanup-2026-05-11/phase-2-validation/validation-targeted-verify.md`
- `docs/audits/repo-cleanup-2026-05-11/phase-2-validation/validation-tests.md`
- `docs/audits/repo-cleanup-2026-05-11/phase-2-validation/validation-typecheck.md`
- `docs/audits/repo-cleanup-2026-05-11/phase-3-backend-types-routes-duplication.md`
- `docs/audits/repo-cleanup-2026-05-11/phase-3-generated-artifacts-and-binaries.md`
- `docs/audits/repo-cleanup-2026-05-11/phase-3-naming-shims-reexports.md`
- `docs/audits/repo-cleanup-2026-05-11/phase-3-test-quality-and-speed.md`
- `docs/audits/repo-cleanup-2026-05-11/wave-01-search-pollution-generated-artifacts.md`
- `docs/audits/repo-cleanup-2026-05-11/wave-02-lifeops-health-contracts.md`
- `docs/audits/repo-cleanup-2026-05-11/wave-03-backend-route-ownership.md`
- `docs/audits/repo-cleanup-2026-05-11/wave-04-frontend-state-ui.md`
- `docs/audits/repo-cleanup-2026-05-11/wave-05-test-cleanup.md`
- `docs/audits/repo-cleanup-2026-05-11/wave-06-assets-docs-artifacts.md`
- `docs/audits/repo-cleanup-2026-05-11/wave-07-naming-text-cleanup.md`
- `docs/audits/repo-cleanup-2026-05-11/wave-08-final-validation-signoff.md`
- `docs/audits/repo-cleanup-2026-05-11/phase-4-markdown-wipe-candidates.md`

### Older Root Audit Docs

Likely delete after any durable findings are already reflected in code, tests, or package docs.

```text
docs/audits/action-inventory-2026-05-09.md
docs/audits/action-structure-audit-2026-05-10.md
docs/audits/action-structure-audit-2026-05-11.md
docs/audits/benchmark-example-action-audit-2026-05-11.md
docs/audits/hierarchy-flatness-audit.md
docs/audits/lifeops-2026-05-09/
docs/audits/lifeops-2026-05-11/
docs/audits/mobile-2026-05-11/
```

`docs/audits/lifeops-2026-05-09/` files:

- `docs/audits/lifeops-2026-05-09/01-doc-inventory.md`
- `docs/audits/lifeops-2026-05-09/02-scenario-larp-audit.md`
- `docs/audits/lifeops-2026-05-09/03-coverage-gap-matrix.md`
- `docs/audits/lifeops-2026-05-09/04-telemetry-audit.md`
- `docs/audits/lifeops-2026-05-09/05-cerebras-wiring.md`
- `docs/audits/lifeops-2026-05-09/06-mockoon-build.md`
- `docs/audits/lifeops-2026-05-09/07-actions-implementation.md`
- `docs/audits/lifeops-2026-05-09/08-new-scenarios.md`
- `docs/audits/lifeops-2026-05-09/09-doc-and-larp-cleanup.md`
- `docs/audits/lifeops-2026-05-09/10-recorder-fixes.md`
- `docs/audits/lifeops-2026-05-09/11-optimizer-regression-analysis.md`
- `docs/audits/lifeops-2026-05-09/12-action-typed-params-audit.md`
- `docs/audits/lifeops-2026-05-09/12-real-root-cause.md`
- `docs/audits/lifeops-2026-05-09/13-action-description-audit.md`
- `docs/audits/lifeops-2026-05-09/14-capability-taxonomy.md`
- `docs/audits/lifeops-2026-05-09/REPORT.md`

`docs/audits/lifeops-2026-05-11/` non-prompt files:

- `docs/audits/lifeops-2026-05-11/INDEX.md`
- `docs/audits/lifeops-2026-05-11/REPORT.md`
- `docs/audits/lifeops-2026-05-11/RUNBOOK.md`
- `docs/audits/lifeops-2026-05-11/action-collisions.md`
- `docs/audits/lifeops-2026-05-11/app-lifeops-typecheck-cleanup.md`
- `docs/audits/lifeops-2026-05-11/baseline-runs.md`
- `docs/audits/lifeops-2026-05-11/bench-server-cerebras-404-fix.md`
- `docs/audits/lifeops-2026-05-11/cache-key-stability.md`
- `docs/audits/lifeops-2026-05-11/cerebras-backoff.md`
- `docs/audits/lifeops-2026-05-11/eliza-1-status.md`
- `docs/audits/lifeops-2026-05-11/eliza-tool-call-fix.md`
- `docs/audits/lifeops-2026-05-11/final-rebaseline-report.md`
- `docs/audits/lifeops-2026-05-11/hermes-finalize-fix.md`
- `docs/audits/lifeops-2026-05-11/known-typecheck-failures.md`
- `docs/audits/lifeops-2026-05-11/larp-purge.md`
- `docs/audits/lifeops-2026-05-11/openclaw-tag-closure-fix.md`
- `docs/audits/lifeops-2026-05-11/personality-bench-eliza-runtime.md`
- `docs/audits/lifeops-2026-05-11/personality-judge-extensions.md`
- `docs/audits/lifeops-2026-05-11/personality-redesign.md`
- `docs/audits/lifeops-2026-05-11/planner-disambiguation-fix.md`
- `docs/audits/lifeops-2026-05-11/rebaseline-report.md`
- `docs/audits/lifeops-2026-05-11/retrieval-funnel.md`
- `docs/audits/lifeops-2026-05-11/retrieval-pareto.md`
- `docs/audits/lifeops-2026-05-11/scenario-cleanup-typecheck-faultinjection.md`
- `docs/audits/lifeops-2026-05-11/scenario-runner-extract-params-fix.md`
- `docs/audits/lifeops-2026-05-11/scorer-fixes.md`
- `docs/audits/lifeops-2026-05-11/serialization-audit.md`
- `docs/audits/lifeops-2026-05-11/wave-5a-gap-list.md`

Risk: medium. These are not runtime files, but some may contain unique current findings. Consolidate any still-current facts into `plugins/app-lifeops/README.md`, `plugins/plugin-health/README.md`, package docs, issues, or this cleanup plan before deletion.

### LifeOps Architecture Audit Docs

Do not delete the contract docs named in `AGENTS.md` unless `AGENTS.md` is updated first. Review the rest.

Keep by current contributor contract:

- `plugins/app-lifeops/docs/audit/post-cleanup-architecture.md`
- `plugins/app-lifeops/docs/audit/wave1-interfaces.md`
- `plugins/app-lifeops/docs/audit/IMPLEMENTATION_PLAN.md`
- `plugins/app-lifeops/docs/audit/prompt-content-lint.md`

Review for deletion/consolidation:

- `plugins/app-lifeops/docs/audit/GAP_ASSESSMENT.md`
- `plugins/app-lifeops/docs/audit/HARDCODING_AUDIT.md`
- `plugins/app-lifeops/docs/audit/JOURNEY_GAME_THROUGH.md`
- `plugins/app-lifeops/docs/audit/UX_JOURNEYS.md`
- `plugins/app-lifeops/docs/audit/action-economy-audit.md`
- `plugins/app-lifeops/docs/audit/action-hierarchy-final-audit.md`
- `plugins/app-lifeops/docs/audit/composability-audit.md`
- `plugins/app-lifeops/docs/audit/default-pack-curation-rationale.md`
- `plugins/app-lifeops/docs/audit/default-packs-rationale.md`
- `plugins/app-lifeops/docs/audit/final-confidence-report.md`
- `plugins/app-lifeops/docs/audit/interruptbench-wave0-contract.md`
- `plugins/app-lifeops/docs/audit/missing-journeys-audit.md`
- `plugins/app-lifeops/docs/audit/post-Wave-2-ambiguity-register.md`
- `plugins/app-lifeops/docs/audit/post-cleanup-completion-report.md`
- `plugins/app-lifeops/docs/audit/rigidity-hunt-audit.md`
- `plugins/app-lifeops/docs/audit/thread-response-handler-production-contract.md`
- `plugins/app-lifeops/docs/audit/translation-harness.md`

### Docs-Site Unlinked Internal Docs

`packages/docs` is the docs-site package, so it is mostly a keep area. However a navigation parse of `packages/docs/docs.json` found many Markdown/MDX files not linked from navigation. All of `packages/docs/docs/**` appears unlinked by `docs.json` and includes launch QA, old plans, reports, and specs.

Review deletion of:

- `packages/docs/docs/ELIZAOS_ARCHITECTURE.md`
- `packages/docs/docs/SETUP_AOSP.md`
- `packages/docs/docs/SETUP_IOS.md`
- `packages/docs/docs/apps/desktop/release-heavy-inventory.md`
- `packages/docs/docs/apps/desktop/release-regression-checklist.md`
- `packages/docs/docs/architecture/wallet-and-trading.md`
- `packages/docs/docs/cache-validation.md`
- `packages/docs/docs/launchdocs/00-launch-review-summary.md`
- `packages/docs/docs/launchdocs/01-onboarding-setup-qa.md`
- `packages/docs/docs/launchdocs/02-coding-subscriptions.md`
- `packages/docs/docs/launchdocs/03-docs-v2.md`
- `packages/docs/docs/launchdocs/05-settings-qa.md`
- `packages/docs/docs/launchdocs/06-ios-qa.md`
- `packages/docs/docs/launchdocs/07-android-qa.md`
- `packages/docs/docs/launchdocs/08-cloud-eliza-ai-qa.md`
- `packages/docs/docs/launchdocs/09-desktop-qa.md`
- `packages/docs/docs/launchdocs/10-remote-interfaces.md`
- `packages/docs/docs/launchdocs/11-browser-wallet-qa.md`
- `packages/docs/docs/launchdocs/12-computer-use-qa.md`
- `packages/docs/docs/launchdocs/14-lifeops-qa.md`
- `packages/docs/docs/launchdocs/15-utility-apps-qa.md`
- `packages/docs/docs/launchdocs/16-all-app-pages-qa.md`
- `packages/docs/docs/launchdocs/17-prompt-optimization.md`
- `packages/docs/docs/launchdocs/18-finetune-suite.md`
- `packages/docs/docs/launchdocs/19-local-models.md`
- `packages/docs/docs/launchdocs/20-automation-minimize-human-qa.md`
- `packages/docs/docs/launchdocs/21-production-readiness-validation.md`
- `packages/docs/docs/launchdocs/22-store-review-notes.md`
- `packages/docs/docs/launchdocs/23-ai-qa-master-plan.md`
- `packages/docs/docs/launchdocs/24-accessibility-and-dark-mode-qa.md`
- `packages/docs/docs/launchdocs/25-ai-qa-results-2026-05-11.md`
- `packages/docs/docs/launchdocs/automation-remote-pairing.md`
- `packages/docs/docs/migrations/eliza-submodule-removal.md`
- `packages/docs/docs/proposals/2026-04-23-shrink-disable-local-eliza-workspace.md`
- `packages/docs/docs/superpowers/plans/2026-04-14-steward-wallet-cloud-login-wiring.md`
- `packages/docs/docs/superpowers/plans/2026-04-16-codeflow-cleanup.md`
- `packages/docs/docs/superpowers/plans/2026-05-10-secrets-payments-bench-and-harness.md`
- `packages/docs/docs/superpowers/plans/2026-05-10-secrets-payments-e2e-implementation.md`
- `packages/docs/docs/superpowers/plans/2026-05-10-sensitive-request-links-parallel-implementation.md`
- `packages/docs/docs/superpowers/reports/2026-05-10-secrets-payments-e2e-research.md`
- `packages/docs/docs/superpowers/reports/2026-05-10-sensitive-request-links-architecture-gaps.md`
- `packages/docs/docs/superpowers/reports/2026-05-10-sensitive-request-links-implementation-design.md`
- `packages/docs/docs/superpowers/specs/2026-04-14-steward-wallet-cloud-login-wiring-design.md`
- `packages/docs/docs/superpowers/specs/2026-05-10-action-primitives-secrets-payments-identity.md`
- `packages/docs/docs/superpowers/specs/2026-05-10-sensitive-request-links-prd.md`

Risk: medium. These may be intentionally hidden docs, but the path shape `packages/docs/docs/**` is suspicious because the docs package root already is `packages/docs`.

Validation before deletion:

```sh
rg -n 'packages/docs/docs|docs/launchdocs|docs/superpowers|ELIZAOS_ARCHITECTURE|SETUP_AOSP|SETUP_IOS' packages docs README.md
bun --cwd packages/docs test
```

### Root Release and Eliza-1 Status Docs

Do not wipe until the current release workflow has a single canonical place. Several files explicitly reference each other.

- `ELIZA_1_GGUF_READINESS.md` - generated by `packages/training/scripts/manifest/eliza1_platform_plan.py`; deletion is reasonable only if the generator and generated JSON remain canonical.
- `ELIZA_1_RELEASE_ASSET_STATUS.md` - current status map and links to release evidence.
- `ELIZA_1_TESTING_TODO.md` - current QA checklist.
- `ELIZA_1_VOICE_SWARM.md` - explicitly says it is historical and complete. Strong deletion candidate after removing references from `ELIZA_1_RELEASE_ASSET_STATUS.md`.
- `RELEASE_V1.md` - release runbook; keep unless superseded by `packages/inference/AGENTS.md` plus generated release docs.

High-probability consolidation target:

```text
ELIZA_1_VOICE_SWARM.md
```

### Inference Status, Audit, and Benchmark Docs

Review after deciding the canonical inference docs. Likely keep `README.md`, `AGENTS.md`, `CLAUDE.md`, `PRECACHE.md`, `verify/ROADMAP.md`, and current hardware verification docs. Migrate or delete dated audit/benchmark notes.

- `packages/inference/BENCHMARK_2026-05-10.md`
- `packages/inference/DEVICE_SUPPORT_GAP_2026-05-10.md`
- `packages/inference/PATCH_AUDIT_2026-05-10.md`
- `packages/inference/SHADER_REVIEW_2026-05-10.md`
- `packages/inference/bench_M4Max_2026-05-10.md`
- `packages/inference/bench_M4Max_batched_2026-05-10.md`
- `packages/inference/reports/local-e2e/2026-05-11/eval-suite-run/README.md`
- `packages/inference/reports/porting/2026-05-10/platform-verification-performance-grid.md`
- `packages/inference/reports/porting/2026-05-11/asr-tokenizer-fusion.md`
- `packages/inference/reports/porting/2026-05-11/cpu-kernel-optimization.md`
- `packages/inference/reports/porting/2026-05-11/cuda-bringup-operator-steps.md`
- `packages/inference/reports/porting/2026-05-11/cuda-kernel-static-review.md`
- `packages/inference/reports/porting/2026-05-11/e2e-loop-benchmark.md`
- `packages/inference/reports/porting/2026-05-11/embedding-model-review.md`
- `packages/inference/reports/porting/2026-05-11/fused-attn-op-contract.md`
- `packages/inference/reports/porting/2026-05-11/ios-physical-device-smoke.md`
- `packages/inference/reports/porting/2026-05-11/kernel-optimization-review.md`
- `packages/inference/reports/porting/2026-05-11/metal-fused-attn-and-polar-preht-design.md`
- `packages/inference/reports/porting/2026-05-11/needs-hardware-ledger.md`
- `packages/inference/reports/porting/2026-05-11/qwen-backbone-unification.md`
- `packages/inference/reports/porting/2026-05-11/remaining-work-ledger.md`
- `packages/inference/reports/porting/2026-05-11/text-model-review.md`
- `packages/inference/reports/porting/2026-05-11/text-vision-path.md`
- `packages/inference/reports/porting/2026-05-11/this-machine-test-capability.md`
- `packages/inference/reports/porting/2026-05-11/vulkan-kernel-optimization.md`
- `packages/inference/reports/porting/2026-05-11/wakeword-head-plan.md`

Risk: medium to high for files referenced by release docs:

- `packages/inference/reports/porting/2026-05-11/needs-hardware-ledger.md`
- `packages/inference/reports/porting/2026-05-11/remaining-work-ledger.md`
- `packages/inference/reports/porting/2026-05-11/kernel-optimization-review.md`
- `packages/inference/reports/porting/2026-05-11/ios-physical-device-smoke.md`

### Top-Level `reports/`

Likely delete after link cleanup. These are historical wave reports and generated audits, not source. Risk is broken links from `docs/porting/CURRENT-STATE.md` and related status docs.

- `reports/barrel-audit.md`
- `reports/path-alias-audit.md`
- `reports/porting/2026-05-09-baseline/INDEX.md`
- `reports/porting/2026-05-09-baseline/catalog-coverage.md`
- `reports/porting/2026-05-09-baseline/larp-inventory.md`
- `reports/porting/2026-05-09-baseline/profile.md`
- `reports/porting/2026-05-09-unified/INDEX.md`
- `reports/porting/2026-05-09-w2/cache-stress.md`
- `reports/porting/2026-05-09-w2/embedding-e2e.md`
- `reports/porting/2026-05-09-w2/polar-neon-cross.md`
- `reports/porting/2026-05-09-w2/qjl-neon-cross.md`
- `reports/porting/2026-05-09-w3/cuda-compile-only.md`
- `reports/porting/2026-05-09-w3/vulkan-compile-only.md`
- `reports/porting/2026-05-09-w3/windows-cross-build.md`
- `reports/porting/2026-05-09-w4/bench-stub/profile.md`
- `reports/porting/2026-05-09-w4/build-matrix-rerun.md`
- `reports/porting/2026-05-09-w4/twins-consolidation.md`
- `reports/porting/2026-05-09-w4/vulkan-turbo-fix.md`
- `reports/porting/2026-05-10/cuttlefish-x86_64-smoke.md`
- `reports/porting/2026-05-10/eliza-1-repos/README.md`
- `reports/porting/2026-05-10/eliza-1-repos/UPLOAD.md`
- `reports/porting/2026-05-10/eliza-1-repos/bonsai-8b-1bit-optimized/README.md`
- `reports/porting/2026-05-10/eliza-1-repos/eliza-1-27b-optimized/README.md`
- `reports/porting/2026-05-10/eliza-1-repos/eliza-1-2b-optimized/README.md`
- `reports/porting/2026-05-10/eliza-1-repos/eliza-1-9b-optimized/README.md`
- `reports/porting/2026-05-10/eliza-1-repos/qwen3.5-4b-drafter/README.md`
- `reports/porting/2026-05-10/eliza-1-repos/qwen3.5-4b-optimized/README.md`
- `reports/porting/2026-05-10/eliza-1-repos/qwen3.5-9b-drafter/README.md`
- `reports/porting/2026-05-10/eliza-1-repos/qwen3.5-9b-optimized/README.md`
- `reports/porting/2026-05-10/eliza-1-repos/qwen3.6-27b-drafter/README.md`
- `reports/porting/2026-05-10/eliza-1-repos/qwen3.6-27b-optimized/README.md`

Recommended validation:

```sh
rg -n 'reports/porting|barrel-audit|path-alias-audit' README.md docs packages plugins
```

### Personality Scenario Distribution Markdown

Likely generated summaries. Review whether the scenario generator can recreate them.

- `test/scenarios/personality/INDEX.md`
- `test/scenarios/personality/escalation/_distribution.md`
- `test/scenarios/personality/hold_style/_distribution.md`
- `test/scenarios/personality/note_trait_unrelated/_distribution.md`
- `test/scenarios/personality/scope_global_vs_user/_distribution.md`
- `test/scenarios/personality/shut_up/_distribution.md`

Risk: medium. `INDEX.md` links to each `_distribution.md`; benchmark docs reference the scenario root. Delete only if scenario discovery does not depend on Markdown and the summaries are generated elsewhere.

### Cloud Package Docs

Review. These may be operational docs, but they are not `README.md` and not in the root docs-site package.

- `cloud/packages/docs/ROADMAP.md`
- `cloud/packages/docs/advertising-api-setup.md`
- `cloud/packages/docs/affiliate-referral-comparison.md`
- `cloud/packages/docs/anthropic-cot-budget.md`
- `cloud/packages/docs/api-authentication.md`
- `cloud/packages/docs/auth-api-consistency.md`
- `cloud/packages/docs/building-a-monetized-app.md`
- `cloud/packages/docs/domain-registrar-provider-setup.md`
- `cloud/packages/docs/full-real-e2e-env-keys.md`
- `cloud/packages/docs/full-real-e2e-missing-api-keys.md`
- `cloud/packages/docs/media-generation-provider-setup.md`
- `cloud/packages/docs/referrals.md`
- `cloud/packages/docs/staging.md`
- `cloud/packages/docs/unit-testing-agent-mocks.md`
- `cloud/packages/docs/wallet-siwe-api-key-setup.md`

Risk: medium. Some docs may be onboarding-critical for cloud operators; consolidate into `packages/docs` or `cloud/README.md`.

### Training Package Tracked Docs

Review after deciding whether `packages/training` is source, archive, or separate artifact. Keep package README and contributor docs while the package remains.

- `packages/training/REVIEW_2026-05-10.md`
- `packages/training/benchmarks/OPTIMIZATION_INVENTORY.md`
- `packages/training/benchmarks/THROUGHPUT.md`
- `packages/training/benchmarks/eliza1_gates.md`
- `packages/training/docs/dataset/CANONICAL_RECORD.md`
- `packages/training/docs/dataset/COVERAGE_AUDIT.md`
- `packages/training/docs/dataset/RUNTIME_PHASES.md`
- `packages/training/docs/training/gguf-to-runtime.md`
- `packages/training/scripts/CHECKPOINT_SYNC.md`
- `packages/training/scripts/CLOUD_VAST.md`
- `packages/training/scripts/HF_PUBLISHING.md`
- `packages/training/scripts/RL_TRAINING.md`
- `packages/training/scripts/quantization/AUDIT_2026-05-10.md`
- `packages/training/scripts/templates/model_card_base.md`
- `packages/training/scripts/templates/model_card_quant.md`
- `packages/training/scripts/templates/model_card_uncensored.md`

Risk: medium. Some are operational runbooks; others are dated audit/status docs. Consolidate current training operations into `packages/training/README.md` or generated release docs.

### Plugin Project Plans and Hand-Offs

Review for deletion or consolidation into README/issues.

- `plugins/plugin-agent-orchestrator/PROJECT.md`
- `plugins/plugin-agent-orchestrator/docs/default-eliza-skills-and-agent-bridge-plan.md`
- `plugins/plugin-agent-orchestrator/docs/sub-agent-routing.md`
- `plugins/plugin-background-runner/HANDOFF.md`
- `plugins/plugin-background-runner/INSTALL.md`
- `plugins/plugin-google-meet-cute/MIGRATION_NOTES.md`
- `plugins/plugin-mysticism/PLAN.md`
- `plugins/plugin-rlm/PAPER_COMPARISON.md`
- `plugins/plugin-x/src/__tests__/TESTING_GUIDE.md`

Risk: low to medium. Package behavior should not depend on these, but user/developer workflows may.

## Keep

Keep these unless their whole package is removed.

### Repository and Package README Files

There are 318 tracked `README.md` files. The cleanup rule says to keep them. Examples:

- `README.md`
- `cloud/README.md`
- `packages/agent/README.md`
- `packages/app/README.md`
- `packages/app-core/README.md`
- `packages/core/README.md`
- `packages/docs/README.md`
- `packages/elizaos/README.md`
- `packages/examples/README.md`
- `packages/inference/README.md`
- `packages/prompts/README.md`
- `packages/registry/README.md`
- `packages/skills/README.md`
- `packages/training/README.md`
- `packages/ui/src/onboarding/README.md`
- `packages/vault/README.md`
- `plugins/app-lifeops/README.md`
- `plugins/plugin-health/README.md`
- `plugins/*/README.md`

Exception candidates are vendored fixture READMEs, such as `packages/app-core/test/contracts/lib/openzeppelin-contracts/**/README.md`, listed above.

### Contributor, Contract, Legal, and Security Docs

Keep or review only with owner approval:

- `AGENTS.md`
- `cloud/AGENTS.md`
- `cloud/CLAUDE.md`
- `packages/inference/AGENTS.md`
- `packages/inference/CLAUDE.md`
- `packages/training/AGENTS.md`
- `packages/training/CLAUDE.md`
- `cloud/CHANGELOG.md`
- `packages/agent/CHANGELOG.md`
- `packages/core/CHANGELOG.md`
- `plugins/plugin-agent-orchestrator/CHANGELOG.md`
- `plugins/plugin-ollama/CHANGELOG.md`
- `packages/training/scripts/quantization/fused_turboquant_vendored/NOTICE.md`
- `packages/training/scripts/quantization/polarquant/LICENSE.md`
- `packages/training/scripts/quantization/qjl/NOTICE.md`

### Actual Docs-Site Content

Keep `packages/docs/**` pages that are authored docs-site content, especially files referenced by `packages/docs/docs.json`.

Evidence:

- `packages/docs/package.json` names the package `@elizaos/docs`.
- `packages/docs/docs.json` is Mintlify configuration.
- Navigation-linked docs include `agents`, `apps`, `cli`, `connectors`, `examples`, `guides`, `plugin-registry`, `plugins`, `projects`, `runtime`, `user`, localized `es`, `fr`, and `zh` content.

Keep examples:

- `packages/docs/index.mdx`
- `packages/docs/quickstart.mdx`
- `packages/docs/installation.mdx`
- `packages/docs/api-reference.mdx`
- `packages/docs/agents/*.md`
- `packages/docs/apps/**/*.md`
- `packages/docs/cli/**/*.mdx`
- `packages/docs/connectors/*.md`
- `packages/docs/guides/*.mdx`
- `packages/docs/plugin-registry/**/*.md`
- `packages/docs/plugins/*.mdx`
- `packages/docs/runtime/*.md`
- `packages/docs/user/*.md`
- `packages/docs/es/**`
- `packages/docs/fr/**`
- `packages/docs/zh/**`

Review exception: `packages/docs/docs/**`, listed above, because it is unlinked and looks like a nested legacy docs dump.

### Skills Source Docs

Keep `packages/skills/skills/**/SKILL.md` and `packages/skills/skills/**/references/*.md`. These are source artifacts for the skills system, not ordinary docs slop.

Examples:

- `packages/skills/skills/eliza/SKILL.md`
- `packages/skills/skills/eliza/references/agent-orchestration.md`
- `packages/skills/skills/elizaos/SKILL.md`
- `packages/skills/skills/elizaos/references/core-abstractions.md`
- `packages/skills/skills/task-agent-eliza-bridge/SKILL.md`

### Vendored Inference Fork Docs

Keep unless the vendored fork is slimmed as a separate task:

- `packages/inference/llama.cpp/README.md`
- `packages/inference/llama.cpp/AGENTS.md`
- `packages/inference/llama.cpp/CONTRIBUTING.md`
- `packages/inference/llama.cpp/SECURITY.md`
- `packages/inference/llama.cpp/docs/**`
- `packages/inference/llama.cpp/examples/**/README.md`
- `packages/inference/llama.cpp/tools/**/README.md`
- `packages/inference/omnivoice.cpp/README.md`
- `packages/inference/omnivoice.cpp/docs/ARCHITECTURE.md`

Risk of deleting these is low for build behavior but medium for fork maintenance.

### GitHub Templates

Keep:

- `.github/ISSUE_TEMPLATE/bug_report.md`
- `.github/ISSUE_TEMPLATE/feature_request.md`
- `.github/pull_request_template.md`
- `.github/workflows/README.md`

These are workflow assets.

## Ignore Patterns

Recommended ignore additions or confirmations:

```gitignore
.claude/
.prr/

packages/training/.venv/
packages/training/.pytest_cache/
packages/training/data/
packages/training/local-corpora/

packages/benchmarks/benchmark_results/
packages/benchmarks/**/benchmark_resukts/

packages/inference/reports/local-e2e/
packages/inference/verify/reports/
```

Potential ignore patterns that need owner review:

```gitignore
docs/audits/**/prompts/
reports/
packages/benchmarks/**/results/
```

Do not add a blanket `*.md` ignore anywhere.

## Validation Risk

Markdown deletion has no direct runtime effect unless:

- A package's published npm metadata expects `README.md`.
- Docs-site navigation references the deleted page.
- README/status docs link to the deleted file.
- A test or script reads Markdown fixtures.
- Legal/security/license docs are deleted from vendored code that must preserve notices.
- Cleanup removes active release runbooks before the release process is consolidated.

Before deleting any listed path, run:

```sh
rg -n '<exact-file-or-directory-name>' README.md docs packages plugins cloud test reports
git grep -n '<exact-file-or-directory-name>'
```

After deleting high-confidence groups, run:

```sh
bun run lint
bun run typecheck
bun run build
bun run test
bun --cwd packages/docs test
git diff --check
```

Known existing validation caveat from this cleanup branch: root `bun run test` has previously hung in the app-core Vitest/Electrobun area, and `bun run knip` has previously been blocked by a native `@oxc-resolver` macOS code-signing failure. Treat those as environment/tooling blockers unless re-run evidence changes.

## Proposed Execution Order

1. Delete ignored local/generated state first: `.claude/worktrees/`, `.prr/`, `packages/training/.venv/`, `packages/training/.pytest_cache/`, `packages/training/data/`, `packages/training/local-corpora/`.
2. Delete tracked no-behavior Markdown with low link risk: `plugins/app-lifeops/src/actions/*.params.notes.md`, `docs/audits/lifeops-2026-05-11/prompts/`, generated benchmark result Markdown.
3. Add or tighten ignore rules for generated local state and benchmark outputs.
4. Consolidate active release and LifeOps facts into canonical docs, then delete dated audit/report folders.
5. Run full validation and a docs link search after each batch.
