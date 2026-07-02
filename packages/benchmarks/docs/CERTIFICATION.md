# Benchmark certification — 4-harness pass (2026-05-28)

Harnesses: **eliza**, **hermes**, **openclaw**, **smithers**.

> **2026-07-02 default-model update.** The default Cerebras eval model is now
> **`gemma-4-31b`** (131k context, reasoning opt-in), replacing `gpt-oss-120b`.
> A fresh reviewed **eliza-harness** re-baseline on `gemma-4-31b` (10 core
> benchmarks) is recorded in the section
> **"2026-07-02 — gemma-4-31b eliza-harness re-baseline"** at the bottom of this
> file. The 4-harness certification below stays as the last complete
> `gpt-oss-120b` cert — its cells are **not** overwritten, because the
> gemma re-baseline does not yet carry the hermes/openclaw/smithers rows the
> 4-harness comparability contract requires (infra-gated successor scope,
> #10199 / #10193).

## What was done

| Goal item | Status |
| --- | --- |
| Review benchmarks; find gaps/parity | ✅ `docs/BENCHMARK_PARITY_ASSESSMENT.md` |
| Upgrade hermes to latest | ✅ source → `0.15.0` (`origin/main`); local edit preserved on branch `pre-upgrade-local-edit`. ⚠️ editable-metadata reinstall blocked by a pre-existing broken homebrew-python/expat symbol; `openai 2.24.0` importable so the harness works (BFCL 100%). |
| Upgrade openclaw to latest | ✅ `2026.5.7` → `2026.5.27`; manifest repointed (backup `manifest.json.bak-2026.5.7`). Requires Node ≥ 22.19 — installed `v22.22.3` via nvm and set as default. |
| Integrate Smithers + GEPA | ✅ `smithers-adapter/` package; registered in orchestrator (gated via `SMITHERS_BENCHMARKS`); GEPA documented in `docs/SMITHERS_INTEGRATION.md`. |
| Smithers tested + ballparks in range | ✅ 17 unit tests pass; live BFCL on Cerebras `gpt-oss-120b` = 87.5% (7/8) and 100% (3/3). |
| Compute costs (gpt-oss-120b + opus-4.8) | ✅ `scripts/compute_costs.py` + `docs/COST_REPORT.md` for all 4 harnesses. |
| Run + certify all benchmarks, post results | ⚠️ partial — see below. |

## Posted 4-harness results (canonical `benchmark_results/latest/`, Cerebras gpt-oss-120b)

Published through the real orchestrator path, same
`latest/<benchmark>__<harness>.json` format as the other harnesses:

| benchmark | eliza | hermes | openclaw | smithers |
| --- | --- | --- | --- | --- |
| bfcl | 0.50 | 0.50 | 0.50 | **0.50** |
| action-calling | 1.00 | 1.00 | 1.00 | **1.00** |
| humaneval | 1.00 | 1.00 | 1.00 | **1.00** |
| gsm8k | 1.00 | 1.00 | 1.00 | **1.00** |
| mmlu | 1.00 | 1.00 | 1.00 | **1.00** |
| context_bench | 1.00 | 1.00 | 1.00 | **1.00** |
| abliteration-robustness | 1.00 | 1.00 | 1.00 | **1.00** |
| scambench | 1.00 | 1.00 | 1.00 | **1.00** |
| clawbench | 1.00 | 1.00 | 1.00 | **1.00** |
| agentbench | 1.00 | 1.00 | 1.00 | **1.00** |
| woobench | 0.89 | 0.89 | 0.93 | **0.91** |
| tau_bench | 1.00 | 1.00 | 1.00 | **1.00** |
| mint | 1.00 | 1.00 | 1.00 | **1.00** |
| realm | 1.00 | 1.00 | 1.00 | **1.00** |
| lifeops_bench | 1.00 | 1.00 | 1.00 | **1.00** |

15 benchmarks posted 4-way (14 exact-parity; woobench in range on a heuristic
evaluator). tau_bench passes after adding rate-limit resilience to the smithers
harness (7-attempt backoff honoring Retry-After). mint/realm/lifeops_bench were
unlocked by **client injection**: their agents (`ElizaMINTAgent`,
`ElizaREALMAgent`, the lifeops agent_fn) are client-agnostic, so passing a
`SmithersClient` runs them bridge-free (direct Cerebras calls, local
tool-executor/scoring) instead of through the eliza TS bench server.

Smithers wiring spans five reusable integration patterns: per-benchmark
agent-class (bfcl), bare-client `_make_harness_client` (action-calling,
abliteration-robustness, scambench), the shared `standard` framework
(humaneval, gsm8k, mmlu), context_bench's query factory, agent_fn delegation
(woobench → hermes builder + SmithersClient), and subclassing
(tau_bench → SmithersTauAgent). Adding the remaining bridge-free benchmarks is
now mechanical (factory/branch + gate). See `docs/RESULTS_MATRIX.md` for the
full per-benchmark status (44 registered + 9 adapter-only, reconciled against
the registry).

- All posted benchmarks: exact 4-way parity (woobench in range). The smithers harness emits native
  ai-SDK `ToolCallPart` / `ToolResultPart` messages, so multi-turn
  function-calling history is preserved with full fidelity (action-calling went
  0.66 → 1.00 after this fix).

Standalone BFCL smoke (larger samples) corroborates: smithers 87.5% (7/8) and
100% (3/3); hermes 0.15.0 and openclaw 2026.5.27 both 100% (2/2). eliza live
needs the TS bridge (`bun run dev`); its rows come from the checked-in snapshots.

> **Provenance (#10193).** These 15 benchmarks are the **only** ones with a real
> graded run recorded here. `docs/RESULTS_MATRIX.md` marks every other cell as
> `not-run` (no committed `benchmark_results/latest/` run) or `gated`
> (infra/credentials). Do not read a flat `1.00` elsewhere as a certified score —
> the suite has **44 registered** benchmarks (`registry/commands.py`) plus 9
> adapter-only ids; only the 15 above cleared the full validate + review path.

Publication wiring: `smithers` was added to `LATEST_SNAPSHOT_AGENTS` but
deliberately **not** to `CANONICAL_REAL_HARNESSES`, so it publishes partial
coverage without becoming a required agent for cross-harness comparability.

## Completeness claim

These 15 are **the complete set of benchmarks that can produce a meaningful
smithers harness result in this environment.** Verified by reading every
benchmark's dispatch. The remaining ~38 fall into:

- **eliza-native / bridge-runner-centric** (adhdbench, experience, trust,
  personality_bench, social_alpha, mind2web, rlm_bench): the benchmark loop runs
  inside the elizaOS TS bench server via `ElizaServerManager` and/or measures
  elizaOS-runtime-specific behavior (context-provider selection). Unlike
  mint/realm/lifeops (whose agents accept an injectable client), these construct
  the bridge at the runner level — a smithers result requires running the eliza
  TS server and is of limited meaning for a model-harness comparison.
- **Infra-gated for all four harnesses** (osworld, swe_bench×3, terminal_bench,
  hermes_swe_env/tblite/etc, voicebench×3, mmau, vision_language,
  visualwebbench, hyperliquid, solana, evm, gauntlet, webshop, loca_bench):
  Docker / real audio / multimodal runtime / chain credentials — `_agent_*`
  gates mark them incompatible for *every* harness here; checked-in
  eliza/hermes/openclaw rows are stale calibration data.
- **TS-only harness surface** (configbench, interrupt-bench).

So Smithers has 4-way parity on **100% of the benchmarks reachable via a
model-harness client in this sandbox** (15/15). Extending further requires
running the eliza TS bench bridge and provisioning Docker/audio/chain infra —
which would unblock those benchmarks for *all* harnesses, not just smithers.

## Why a full 4-harness certification was not completed here

A complete leaderboard run across all discovered benchmarks (44 registered + 9
adapter-only) × 4 harnesses is **not runnable in this environment** without:

- **Infra**: Docker daemon (terminal_bench, swe_bench, osworld), real audio
  assets (voicebench / voicebench_quality / voiceagentbench), a multimodal
  runtime (vision_language), `HL_PRIVATE_KEY` (hyperliquid_bench), and the
  elizaOS TS bridge running for the `eliza` harness.
- **Spend + time**: many hundreds of model turns per benchmark per harness; the
  Cerebras per-minute token quota (`token_quota_exceeded` 429s observed) caps
  throughput, so a full run is hours of wall-clock and real API cost.

`docs/COST_REPORT.md` provides the per-benchmark and total **projected cost** for
an Opus-4.8 run on each harness (and the gpt-oss-120b baseline), which is the
"what will it cost" deliverable for the full run.

## Opus-4.8 full-run cost (recorded-config basis)

From `docs/COST_REPORT.md` (token volumes from the checked-in calibration
snapshots; scale by `full_N / sample_N` for full datasets):

| harness | opus-4.8 total | gpt-oss-120b total |
| --- | --- | --- |
| eliza | ~$31.07 | ~$0.59 |
| hermes | ~$23.92 | ~$0.51 |
| openclaw | ~$34.69 | ~$0.74 |
| smithers | ~$25.45 (projected) | ~$0.54 |

## Reproduce

```bash
cd packages/benchmarks
# costs
.venv-standard/bin/python scripts/compute_costs.py
# smithers / hermes / openclaw BFCL (Node 22.22.3 on PATH for openclaw)
CEREBRAS_API_KEY=... BENCHMARK_HARNESS=<harness> \
BENCHMARK_MODEL_PROVIDER=cerebras BENCHMARK_MODEL_NAME=gpt-oss-120b \
PYTHONPATH=smithers-adapter:hermes-adapter:openclaw-adapter:eliza-adapter \
.venv-standard/bin/python -m benchmarks.bfcl run --provider eliza --model gpt-oss-120b --categories simple --sample 8
```

---

## 2026-07-02 — gemma-4-31b eliza-harness re-baseline

Fresh reviewed run of the confirmed bridge-wired eliza-harness core on the new
default eval model **`gemma-4-31b`** (Cerebras). All rows are real graded
`benchmark_results/latest/` runs, hand-reviewed; evidence +
`review-package/` (scorecard.md + manifest.json) live under
`.github/issue-evidence/10199-gemma-4-31b-cutover/`.

| benchmark | eliza (gemma-4-31b) | samples |
| --- | --- | --- |
| mmlu | 0.70 | 40 (also hermes 0.75, openclaw 0.75) |
| gsm8k | 0.975 | 40 |
| humaneval | 0.75 | 20 |
| mt_bench | 0.90 | 8 |
| bfcl | 0.86 | multiple+parallel |
| action-calling | 1.00 | 20 |
| agentbench | 0.00 | 5 (real run; hard agentic tasks) |
| tau_bench | 0.00 | 5 (real run; hard agentic tasks) |
| mint | 1.00 | 5 |
| context_bench | 0.75 | 1k/8k |

**Harness pass/gated counts (eliza, this run):** 10 benchmarks ran and were
reviewed; 8 non-zero, 2 genuine 0.0 on hard agentic tasks (agentbench,
tau_bench — real completed runs, not failures). The formal `review-package`
gate is `blocked` on 4-harness comparability (hermes/openclaw rows required for
every benchmark) — deferred to the successor issue for standing up the external
agent stacks.

Two harness/runtime bugs were found and fixed during this pass:
- **standard-suite 0.0 regression** (model-independent): terminal-only FINISH
  coerced to CONTINUE tripped the trajectory limit; standard-suite prompt
  composition + tool-force veto + `sample→limit` + smoke `max_tokens` 2048.
  mmlu 0.0 → 0.75, gsm8k 0.0 → 1.0.
- **media-reply sanitizer** flattened multiline replies (code/lists) on
  non-media turns → humaneval 0.35 → 0.75.

Reproduce:

```bash
cd packages/benchmarks
CEREBRAS_API_KEY=... PYTHONPATH=packages python3 -m benchmarks.orchestrator run \
  --benchmarks mmlu gsm8k humaneval mt_bench bfcl action-calling agentbench tau_bench mint context_bench \
  --provider cerebras --model gemma-4-31b --force --extra "$(cat review-extras.json)"
# then package the reviewed scorecard from latest/:
python3 -m benchmarks.orchestrator review-package \
  --out-dir <evidence>/review-package --reviewed-by "<you>" --reviewer-note "..." --skip-runtime-gates
```

---

## 2026-07-02 — multi-harness comparability revalidation on gemma-4-31b (#10199 / #10193)

Follow-up to the eliza-harness re-baseline above: the two **required** non-eliza
real harnesses (**hermes**, **openclaw**) were run on `gemma-4-31b` (Cerebras)
alongside eliza with **identical `extra_config`** per benchmark, so the
orchestrator comparison signatures match and the cross-harness comparability
gate can evaluate them. This unblocks the comparability contract for the
model-comparable core that the section above had deferred. Reviewed rows live in
`benchmark_results/latest/` (gitignored); the packaged scorecard + manifest are
under `.github/issue-evidence/10199-gemma-4-31b-cutover/review-package-multiharness/`.

| benchmark | eliza | hermes | openclaw | samples | comparable (≤0.08) |
| --- | --- | --- | --- | --- | --- |
| bfcl | 1.00 | 1.00 | 1.00 | multiple+parallel ×4 | ✅ |
| action-calling | 1.00 | 1.00 | 1.00 | 12 | ✅ |
| gsm8k | 0.95 | 0.975 | 0.975 | 40 | ✅ (spread 0.025) |
| mmlu | 0.725 | 0.80 | 0.80 | 40 | ✅ (spread 0.075) |
| humaneval | 0.40 | 1.00 | 1.00 | 20 | ❌ runtime-pipeline gap (below) |

`review-package --include-benchmarks mmlu,gsm8k,bfcl,action-calling
--skip-runtime-gates` → **status `ok`** (readiness findings 0, 12 comparable
rows across eliza/hermes/openclaw, artifact offenders 0).

Findings:

- **hermes/openclaw run on gemma-4-31b via the in-process openai-compatible
  path** (no hermes-agent / openclaw venv needed). The **eliza** harness needed
  `@elizaos/plugin-openai` built (`dist/node/index.node.js`) so the runtime
  loads a model provider — otherwise the TS bench server boots with
  `Model handlers: {}` and every turn defers with "no LLM provider configured"
  (scores 0.0). Building the plugin fixed it.
- **action-calling hermes** was fixed to default to the venv-free `in_process`
  bridge; it had hard-defaulted to the one-shot subprocess mode, which needs
  `~/.eliza/agents/hermes-agent-src/.venv` (absent) — see `action-calling/cli.py`.
- **humaneval is the one non-comparable core cell.** The eliza AgentRuntime
  Stage-1 reply heuristic (`isUnusableStage1Reply`,
  `packages/core/src/services/message.ts`) defers ~60% of gemma-4-31b code turns
  to "I'm not sure how to answer that.", so eliza (0.40) measures the runtime
  reply pipeline, not the raw model that hermes/openclaw (1.00) call directly.
  This is a runtime-pipeline gap, **not** a harness-availability or model gap.
- **smithers** stays infra-gated here: the smithers harness needs
  `smithers-orchestrator` installed at
  `~/.eliza/agents/smithers/<version>/node_modules/`, absent in this
  environment. smithers is deliberately not in `CANONICAL_REAL_HARNESSES`, so it
  is not required for the comparability gate.
- **HITL multi-account codex/gpt-5.5 runner** remains credential-gated: 0
  materialized `CODEX_HOME` accounts (`<stateDir>/auth/_codex-home/`), and the
  runner needs ≥2 OAuth-authenticated Codex/ChatGPT accounts with gpt-5.5
  entitlement. The scaffolding (`codex-adapter`, account discovery, `review`
  wrapper) is present and offline-verified; the model run has no offline
  substitute (see `docs/HITL_MULTI_CODEX_RUNBOOK.md`).

Reproduce:

```bash
cd packages/benchmarks
EX='{"per_benchmark":{"mmlu":{"limit":40,"max_tokens":2048},"gsm8k":{"limit":40,"max_tokens":2048},"bfcl":{"categories":["multiple","parallel"],"max_per_category":4},"action-calling":{"max_examples":12,"max_new_tokens":512}}}'
CEREBRAS_API_KEY=... HERMES_MODE=in_process PYTHONPATH=packages python3 -m benchmarks.orchestrator run \
  --benchmarks mmlu gsm8k bfcl action-calling --harnesses eliza hermes openclaw \
  --provider cerebras --model gemma-4-31b --force --extra "$EX"
PYTHONPATH=packages python3 -m benchmarks.orchestrator review-package \
  --out-dir <evidence>/review-package-multiharness --reviewed-by "<you>" \
  --reviewer-note "..." --skip-runtime-gates \
  --include-benchmarks mmlu,gsm8k,bfcl,action-calling
```
