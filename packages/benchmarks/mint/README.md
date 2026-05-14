# MINT Benchmark (ElizaOS port)

Faithful port of the UIUC **MINT** benchmark for evaluating LLMs in
**M**ulti-turn **INT**eraction with tools and language feedback
(Wang et al., ICLR 2024,
[arXiv:2309.10691](https://arxiv.org/abs/2309.10691)).

The upstream implementation
([xingyaoww/mint-bench](https://github.com/xingyaoww/mint-bench), Apache 2.0)
is vendored under [`upstream/`](./upstream/) so this package can reuse the
upstream task loaders, sandboxed code execution, and feedback prompt template
without re-implementing them. See [`upstream/README.md`](./upstream/README.md)
for attribution.

---

## 1. The 8 subtasks

| Subtask    | Task type        | Samples (paper) | Metric            |
|------------|------------------|-----------------|-------------------|
| HumanEval  | code_generation  | 45              | `code_test`       |
| MBPP       | code_generation  | 91              | `code_test`       |
| MATH       | reasoning        | 100             | `numeric`         |
| GSM8K      | reasoning        | 48              | `numeric`         |
| HotpotQA   | reasoning        | 43              | `partial_match`   |
| MMLU       | reasoning        | 76              | `multiple_choice` |
| TheoremQA  | reasoning        | 49              | `theoremqa`       |
| AlfWorld   | decision_making  | 134 (lazy)      | `exact_match`     |

The 4-bucket category enum that previously lived in this package
(`REASONING` / `CODING` / `DECISION_MAKING` / `INFORMATION_SEEKING`) was
invented and has been removed. `MINTSubtask` is now the canonical unit and
`MINTCategory` is kept only as a back-compat alias.

The HumanEval / MBPP / MATH / GSM8K / HotpotQA / MMLU / TheoremQA samples
ship pre-sampled in [`upstream/data/processed/<subtask>/test_prompts.json`](./upstream/data/processed/),
mirroring the paper's evaluation set (~452 samples in total). AlfWorld is
loaded lazily because it depends on `textworld` + downloaded game files.

---

## 2. Feedback modes

| Mode         | Behaviour                                                       |
|--------------|-----------------------------------------------------------------|
| `templated`  | Deterministic metric-aware hint. No network calls. **Default**. |
| `llm`        | Uses the upstream GPT-4 feedback prompt template — see [`upstream/mint/prompt/templates/template_feedback_agent.txt`](./upstream/mint/prompt/templates/template_feedback_agent.txt) — through a `ModelRuntime`. |

Set via `MINTConfig.feedback_mode` or the CLI `--feedback templated|llm`
flag. Falling back from `llm` to `templated` happens automatically if the
runtime errors so a flaky network never silently zeros out feedback turns.

---

## 3. Turn-k success rate (the headline metric)

`MINTMetrics.turn_1_success_rate`, `turn_2`, `turn_3`, `turn_4`,
`turn_5_success_rate` (and a generic `per_turn_success_rates` list) are now
populated by counting tasks whose **cumulative** correctness becomes True by
turn *k*. The plumbing:

1. `MINTAgent.solve_task` records the proposed answer at each assistant
   turn into `MINTTrajectory.per_turn_answers`.
2. `MINTEvaluator.evaluate_trajectory` re-grades each per-turn answer with
   the same grader the final answer uses and stores cumulative flags on
   `MINTResult.cumulative_success_per_turn`.
3. `MetricsCalculator.calculate` averages those flags into the Turn-k SRs.

Comparable to the paper's Table 2 / Table 3 once you run on the upstream
samples.

---

## 4. Tool execution & safety

* Default executor is `PythonExecutor` with Docker sandboxing when Docker
  is available, otherwise a restricted in-process fallback with a deny-list
  for `os` / `subprocess` / `shutil` / `eval` / `exec` etc. The upstream
  `check_correctness` sandbox (a fork of OpenAI's HumanEval sandbox) is
  used for HumanEval / MBPP grading — see
  [`upstream/mint/utils/exec.py`](./upstream/mint/utils/exec.py).
* `MockExecutor` is opt-in via `MINTConfig.use_mock_executor=True` (or the
  CLI `--mock` flag). The previous "default `42`" behaviour was removed:
  unmatched code returns failure so metrics never silently report fake
  successes.
* `MINTAgent.allow_ground_truth_mock` defaults to `False`. Tests that need
  the mock answer path opt in explicitly.

---

## 5. CLI

```
python packages/benchmarks/mint/run_benchmark.py \
    --subtasks humaneval gsm8k math \
    --max-tasks 5 \
    --feedback templated \
    --provider openai \
    --model gpt-4
```

Key flags:

```
--subtasks <subtask> [<subtask>...]   # default: all (except alfworld)
--max-tasks N                          # limit per subtask
--use-sample-tasks                     # tiny offline smoke set (3 tasks)
--mock                                 # MockExecutor (no real code exec)
--feedback {templated,llm}             # feedback mode
--provider {mock,eliza,openai,groq,
            openrouter,cerebras}
--no-docker                            # disable docker sandbox
--no-tools / --no-feedback / --no-ablation
```

---

## 6. Leaderboard / paper comparison

`types.LEADERBOARD_SCORES` is intentionally empty. The previous hardcoded
table referenced the invented 4-bucket categories and was apples-to-oranges
with the rebuilt subtask metric. The `MINTReporter` instead links to the
paper (`types.PAPER_RESULTS_URL`) so comparisons go through the actual
upstream Table 2 / Table 3 rather than a fabricated reference.

---

## 7. Tests

```
pytest packages/benchmarks/mint/
```

Notable suites:

* `tests/test_dataset.py` — loads from the vendored upstream JSON.
* `tests/test_turn_k_metrics.py` — end-to-end smoke that exercises the
  multi-turn protocol with templated feedback and asserts that
  `turn_1_success_rate` etc. are actually populated.
* `tests/test_evaluator.py` — covers every metric including the upstream
  `code_test` and `theoremqa` graders.
* `tests/test_validation.py` — ensures `allow_ground_truth_mock` is off by
  default and the legacy `category=` keyword still works.

73 tests pass on Python 3.12.
