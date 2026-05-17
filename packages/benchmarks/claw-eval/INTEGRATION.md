# Claw-Eval Integration Notes

Working notes for wiring the upstream **Claw-Eval** (300-task autonomous-agent benchmark from PKU/HKU, arXiv 2604.06132) into this repo's benchmark harness.

Upstream: `https://github.com/claw-eval/claw-eval` (cloned to `claw-eval/`, `.git`/`.github` stripped).

---

## 1. Identity confirmation

This is the same Claw-Eval whose leaderboard the user's table cites.

- `README.md` advertises **300 human-verified tasks, 2,159 rubrics, 9 categories** across `general` (161) / `multimodal` (101) / `multi_turn` (38) splits.
- `score_summary.py` declares `PASS_THRESHOLD = 0.75` and `EXPECTED_TRIALS = 3`, matching the upstream "Updated March 2026" evaluation logic in the README:
  - **Primary metric: Pass^3** — a task only counts as passed when the model meets the success criteria in **all 3 independent trials**.
- `tasks/` on disk contains exactly 300 directories (verified: `ls tasks | wc -l == 300`), each with `task.yaml` + `grader.py`.

User's table columns map as:

| User column        | Claw-Eval source                                                                 |
| ------------------ | -------------------------------------------------------------------------------- |
| **Claw-Eval Avg**  | Mean Pass@1 task score (per-trial pass rate averaged across all 300 tasks).      |
| **Claw-Eval Pass^3** | Fraction of tasks where the agent passed in **all** k=3 independent trials. |

The 64.3–76.6 / 46.2–60.6 ranges in the user's table line up with the public leaderboard's Pass@1 average and Pass^3 columns respectively.

---

## 2. Relationship to existing in-repo artifacts

**Plain statement: none of the existing `clawbench` adapter modules target this upstream.** They target a small in-house scenario harness that happens to share the name "clawbench".

### `openclaw-benchmark/` (sibling directory)

Unrelated. It is a German-language Docker-based comparison testbed for AI coding agents (Ralphy, OpenClaw CLI, Oh-My-OpenCode, BMAD), with one Dockerfile + run.sh per agent under `openclaw-benchmark/{ralphy,openclaw,...}`. It has no `tasks/`, no graders, no notion of Pass^3. It predates the Claw-Eval academic release and shares no code or task definitions with `claw-eval/`.

### `openclaw-adapter/openclaw_adapter/clawbench.py` and `hermes-adapter/hermes_adapter/clawbench.py`

These build a `clawbench`-compatible `agent_fn` from a single `scenario_yaml` (one prompt + optional `fixtures` dict) and dispatch a **single agent turn** per invocation. The contract is:
```
build_clawbench_agent_fn(scenario_yaml={"prompt": str, "system_prompt": str?}, fixtures={...})
```
There is no 300-task loop, no `grader.py` invocation, no trial-level aggregation, no Pass^3 logic. The 13-task total visible in the result JSON (see below) is the size of the local scenario set, not a Claw-Eval split.

### `benchmark_results/latest/clawbench__*.json`

All five (`eliza`, `hermes`, `openclaw`, `half_v1`, `perfect_v1`, `wrong_v1`) carry `"total": 13`, `"passed": N/13`, a single trajectory JSON, `"llm_call_count": 1-2`. They are outputs of the in-house 13-task scenario harness, **not** Claw-Eval. They cannot be used to compute Pass^3 because:

- only **13 tasks**, not 300;
- only **k=1 trial** per task (single `trajectory_*.json` artifact);
- no per-task grader scores in the expected `grading_result` JSONL format.

To produce a Claw-Eval-style row in the user's table we need a new adapter codepath that drives the upstream `claw-eval batch` runner, not these.

---

## 3. Metric definitions (from `score_summary.py` + README)

- **Per-trial task_score**: float in `[0,1]`, written by each task's `grader.py` as a `grading_result` event into the JSONL trace. A trial passes when `task_score >= 0.75`.
- **Avg (Pass@1 mean)**: arithmetic mean of `task_score` across 300 tasks, taking the first (or only) trial per task. Reported as a percentage.
- **Pass^3 (Pass-power, k=3)**: for each task run the model 3 independent times; the task counts as passed only if **all three** trials cleared the 0.75 threshold. Pass^3 is `passed_tasks / 300`. Network/API failures are re-triggered upstream to guarantee exactly 3 successful trajectories.

---

## 4. Task layout

```
tasks/<task_id>/
  task.yaml      # task_id, category, prompt.text, tools[], tool_endpoints[],
                 # user_agent {persona, max_rounds, system_prompt_suffix} for
                 # multi_turn tasks, fixture list for multimodal.
  grader.py      # produces task_score + scores dict; emitted into JSONL as
                 # {"type": "grading_result", "task_id", "task_score",
                 #  "passed", "scores"}.
```

- 300 tasks total, IDs prefixed `C01..C300` with `zh`/`en` language tag and a slug, e.g. `C01zh_mortgage_prepay`, `C15en_structural_seismic_design`.
- 9 categories spanning communication, finance, ops, productivity, multimodal generation, document extraction, video QA, multi-turn dialog.

---

## 5. Runner CLI & scripts

- Entry point: `claw-eval batch --config <model_config.yaml> --sandbox --trials 3 --parallel 16` (installed by `pyproject.toml` console script; sources under `src/`).
- `config_general.yaml` / `config_multimodal.yaml` / `config_user_agent.yaml` — per-split runner configs. Default model client is OpenRouter (`base_url: https://openrouter.ai/api/v1`), with `google/gemini-3-flash-preview` as the LLM judge for general/multimodal tasks and `claude-opus-4.6` for `multi_turn`. `extra_body.reasoning.effort: high` is set.
- `scripts/test_sandbox.sh` — bring up the sandbox stack; must run first.
- `scripts/validate_tasks.py` — task-yaml schema check.
- `scripts/cleanup_containers.sh` — tear down docker containers between runs.
- `score_summary.py` — post-hoc aggregator: walks a traces root, picks the latest dated folder per model, extracts `grading_result` events from each JSONL, computes per-task and aggregate stats (Pass@1 mean, Pass^3 at `EXPECTED_TRIALS=3`).
- `cleanup_traces.py` — prune raw trajectory junk.

---

## 6. Docker + sandbox dependency

`Dockerfile.agent` plus `mock_services/` defines the per-task sandbox: each task spins up an isolated container with mocked SaaS endpoints (mail, calendar, web search via `SERP_DEV_KEY`, etc.). The runner must have Docker available and `OPENROUTER_API_KEY` (and `SERP_DEV_KEY` for tasks needing live web search) exported.

`requirements-sandbox-server.txt` is the sandbox server's pinned dep set, separate from the host-side `requirements.txt`.

---

## 7. Pass^3 feasibility of current results

Current `clawbench__*.json` artifacts in `benchmark_results/latest/` **cannot** produce Pass^3 numbers:

| Requirement                                                    | Current state                                       |
| -------------------------------------------------------------- | --------------------------------------------------- |
| 300 tasks                                                      | 13 tasks                                            |
| k=3 independent trials per task                                | k=1 (single `trajectory_*.json`)                    |
| Per-task `grading_result` from upstream `grader.py`            | Absent — uses the in-house scenario score field     |
| Trace dir layout expected by `score_summary.py`                | Different (Eliza run-group dir, not `traces/<model>/<date>`) |

To populate a Claw-Eval column we need fresh runs against the upstream harness; the existing `clawbench__*` results stay as evidence for the unrelated scenario harness and should not be relabeled.

---

## 8. Integration plan

Create a new adapter codepath per agent, distinct from the legacy `clawbench.py` modules. Suggested naming: `claw_eval.py` (do not overload `clawbench`).

1. **`eliza-adapter/eliza_adapter/claw_eval.py`** — wraps `claw-eval batch`. Builds a Claw-Eval model config that points at the Eliza HTTP shim (OpenAI-compatible chat endpoint exposed by the running runtime), invokes the upstream runner with `--trials 3`, then parses each `traces/<model>/<dated>/*.jsonl` for `grading_result` events to populate the standard `{score, passed, total, ...}` result envelope expected by `benchmark_results/`.
2. **`hermes-adapter/hermes_adapter/claw_eval.py`** — same shape; spins up `HermesClient`, exposes it as an OpenAI-compatible local endpoint (Hermes already speaks the protocol), points the Claw-Eval config at it.
3. **`openclaw-adapter/openclaw_adapter/claw_eval.py`** — same shape; uses `OpenClawClient` behind an OpenAI-compatible shim.
4. **Shared aggregator helper** (in `claw-eval/INTEGRATION.md`-adjacent `eliza/packages/benchmarks/lib/` or `standard/`): wraps `claw_eval/score_summary.py` so each adapter can emit two numbers — `metrics.avg_pass1` and `metrics.pass_power_3` — landing them as `score = pass_power_3` (primary metric) plus a `metrics.avg_pass1` field so the user's table can display both columns.
5. **Registry entry** in `benchmarks/registry.py` for `claw_eval` benchmark id, with adapters for `eliza` / `hermes` / `openclaw`. Keep the legacy `clawbench` registry entry untouched so the existing 13-task scenario harness keeps working under its own name.
6. **Sandbox bootstrap step** in `scripts/`: ensure `bash claw-eval/scripts/test_sandbox.sh` runs once before the first batch, gated by an env flag so CI without Docker can skip cleanly.

Leave the existing `*-adapter/*/clawbench.py` modules alone — they remain the implementation of the in-house scenario harness.

---

## 9. Runtime cost estimate — Cerebras `gpt-oss-120b`, full 300-task run

Anchors from the existing `clawbench__openclaw.json` row (Cerebras gpt-oss-120b):

- `mean_latency_ms` ~= 32,852 ms per agent turn.
- `duration_seconds` ~= 33s for a 2-turn task.

Claw-Eval tasks span 1–8 turns (`user_agent.max_rounds: 8` for multi-turn). Assume an average of 4 turns/task incl. grader-driven follow-ups + tool round-trips.

| Configuration                                | Wall time estimate                               |
| -------------------------------------------- | ------------------------------------------------ |
| 1 trial, 300 tasks, `--parallel 1`           | 300 × 4 × 33s ≈ **6.6 hours**                    |
| 3 trials, 300 tasks, `--parallel 1`          | 3 × 6.6h ≈ **20 hours**                          |
| 3 trials, 300 tasks, `--parallel 16` (rec.)  | ~20h / 16 ≈ **~75 min** wall, dominated by the slowest tasks (multi-turn, multimodal video). Realistic target: **90–120 minutes**. |
| 3 trials, 300 tasks, `--parallel 32`         | ~45–60 minutes if Cerebras rate-limit and Docker host both keep up; expect throttling. |

Network latency to Cerebras dominates over compute; multimodal/video tasks add fixture-download time (use Hugging Face fixtures snapshot — see README note on video fixtures missing from the GitHub mirror). Budget **~2 hours per full Pass^3 sweep** as the planning number.

---

## 10. References

- Upstream README: `claw-eval/README.md`
- Score aggregation: `claw-eval/score_summary.py`
- Task schema example: `claw-eval/tasks/C01zh_mortgage_prepay/task.yaml`
- Default runner config: `claw-eval/config_general.yaml`
- Legacy in-house scenario adapter (do not confuse): `openclaw-adapter/openclaw_adapter/clawbench.py`, `hermes-adapter/hermes_adapter/clawbench.py`
- Existing 13-task scenario results (unrelated to Claw-Eval): `benchmark_results/latest/clawbench__*.json`
