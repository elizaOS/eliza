# #10193 — Benchmark re-validation on `gpt-oss-120b` / Cerebras

**Date:** 2026-06-29
**Model:** `gpt-oss-120b`
**Provider:** Cerebras (`https://api.cerebras.ai/v1`, key `CEREBRAS_API_KEY`)
**Scope of this run:** the *baseline re-validation* half of #10193 — prove that
benchmarks actually grade `gpt-oss-120b` on Cerebras with **real** model I/O
(not shim/flat-`1.00` passes), via both the direct-model path and the real
`eliza` AgentRuntime harness. Run artifacts are gitignored; only this report and
the one harness bug-fix are committed.

> The HITL multi-account codex / `gpt-5.5` runner, the viewer playback mode, the
> smithers diff column, and the `RESULTS_MATRIX.md`↔registry sync test are
> separate build deliverables in #10193 and are **not** part of this run — see
> "What this run does *not* cover" at the bottom.

---

## 1. Real graded scores (this run)

Every cell below is a **live Cerebras `gpt-oss-120b` call** with a captured
trajectory (prompt + raw output + usage tokens + latency). Nothing here is a
mock or a fixture-replay unless explicitly marked.

### Direct-model path (`HTTPOpenAICompatibleClient` → Cerebras, no runtime)

| Benchmark | Score | Detail | n | Real? |
|---|---|---|---|---|
| `mmlu` | **0.925** | 37 correct | 40 | ✅ live |
| `gsm8k` | **0.975** | 39 correct, format-ok 1.0 | 40 | ✅ live |
| `humaneval` | **1.000** | 30 passed, **sandbox-executed** | 30 | ✅ live (verified, see §3) |
| `mt_bench` | **0.85** | mean rating 8.5/10 (turn-1 10.0, turn-2 7.0); **judge = Cerebras gpt-oss-120b** | 6 | ✅ live |
| `bfcl` | **0.567** | AST 0.60, Exec 0.60, 12/20; best=irrelevance 1.00, worst=relevance 0.00 | 20 | ✅ live |
| `action-calling` | **1.000** | native-tool-call-ok 1.0, tool-name-match 1.0 — **smoke fixture only (1 record)** | 1 | ⚠️ smoke (real dataset absent; see §4) |

### Eliza-harness path (real `AgentRuntime` booted on Cerebras, server reused)

| Benchmark | Score | Detail | n | Real? |
|---|---|---|---|---|
| `mint` | **0.417** | full (tools+feedback), 5/12 passed; humaneval+mbpp+gsm8k subtasks, max-turns 5 | 12 | ✅ live — **required a grader fix**, see §5 |
| `tau_bench` (retail) | — gated — | harness reuse **confirmed** (server connected), but env data absent → no score | 0 | ⛔ dataset-gated, see §6 |

The eliza harness server was booted **once** on Cerebras and reused for both
`mint` and `tau_bench` via `ELIZA_BENCH_URL` + a shared `ELIZA_BENCH_TOKEN`
(§4) — no per-benchmark cold boot.

### The headline finding for #10193

The committed `RESULTS_MATRIX.md` carried flat **`1.00 / 1.00 / 1.00`** rows for
`bfcl`, `mmlu`, etc. across eliza/hermes/openclaw. A real Cerebras
`gpt-oss-120b` run does **not** reproduce them:

- **`bfcl` is 0.567, not 1.00.** Function-name/argument matching genuinely
  fails on 8/20 tasks (relevance category 0/?, irrelevance 1.0). The old `1.00`
  was the exact "harness shim returns a trivial pass" pattern #10193 / #9475
  flagged.
- **`mmlu` 0.925, `gsm8k` 0.975** — strong but clearly *graded*, not pinned to 1.0.
- **`humaneval` 1.000 *is* real** (frontier model, 30 easy problems,
  sandbox-executed) — and it opens to a genuine, correct, model-authored
  solution (§3). This is the "spot-check a flat 1.00 and find a real trajectory
  that earned it" criterion, satisfied.

---

## 2. Proof the calls are live (usage + latency)

First two `mmlu` trajectory records (`trajectories.jsonl`):

```
usage={'prompt_tokens':164,'completion_tokens':143,'total_tokens':307,
       'completion_tokens_details':{'reasoning_tokens':132}}  latency_ms=25647  model=gpt-oss-120b
usage={'prompt_tokens':176,'completion_tokens':466,'total_tokens':642,
       'completion_tokens_details':{'reasoning_tokens':455}}  latency_ms=400    model=gpt-oss-120b
```

`reasoning_tokens` > 0 and `model=gpt-oss-120b` confirm the live Cerebras
reasoning model. First call 25.6 s (cold), subsequent ~0.4 s.

`gsm8k` trajectory shows the model's real chain-of-thought:

```
Janet has 16 eggs each day. She uses 3 for breakfast and 4 for muffins,
leaving 16 - 3 - 4 = 9 eggs to sell. At $2 per egg, she earns 9 × 2 = 18 dollars.
#### 18
```

---

## 3. Flat-`1.00` audit: `humaneval` opens to real code

`humaneval` = 1.000 (30/30). Spot-checking trajectory[0] (`HumanEval/0`,
`has_close_elements`) returns genuine, correct, model-authored Python that the
sandbox actually executed:

```python
if threshold <= 0 or len(numbers) < 2:
    return False
sorted_nums = sorted(numbers)
prev = sorted_nums[0]
for cur in sorted_nums[1:]:
    if cur - prev < threshold:
        return True
    prev = cur
return False
```

usage `{prompt_tokens:245, completion_tokens:244, reasoning_tokens:171}`,
`model=gpt-oss-120b`. The 1.00 is earned, not shimmed.

---

## 4. Harness infrastructure findings (Cerebras path)

1. **The `eliza` benchmark server (`packages/app-core/src/benchmark/server.ts`)
   boots correctly on Cerebras** and auto-wires it:
   `OPENAI_BASE_URL=…cerebras…`, `OPENAI_LARGE_MODEL=gpt-oss-120b`,
   `ELIZA_PROVIDER=cerebras`, all model handlers → openai plugin / Cerebras
   endpoint, embeddings → deterministic local fallback (Cerebras serves no
   `/v1/embeddings`). Final log: `ELIZA_BENCH_READY … agent=Kira, plugins=10`.

2. **Cold boot is ~13 min** and `ElizaServerManager.start()` **purges the tsx
   transform cache on every boot** (server_manager.py L321-334). So the
   orchestrator's "one fresh server per benchmark" model pays the full ~13 min
   *per benchmark* — untenable for a 43-benchmark sweep. The viable pattern is
   **one long-lived server + `ELIZA_BENCH_URL` reuse** (this run used it for
   `mint`/`tau_bench`).

3. **Server reuse needs a shared `ELIZA_BENCH_TOKEN`.** A tokenless server
   returns `403 "requires ELIZA_BENCH_TOKEN to be set"` on `/api/benchmark/*`.
   Booting with a fixed token + exporting the same token to clients makes reuse
   work.

4. **Reuse wiring is inconsistent across adapters.** `mint`, `tau_bench`,
   `standard/_base.py`, `code_agent_matrix` honor `ELIZA_BENCH_URL` (reuse);
   **`agentbench` and `context_bench` spawn their own server unconditionally**
   (no `ELIZA_BENCH_URL` guard) — so they cold-boot even when a shared server
   exists. This is a concrete "single reusable runner" gap for #10193.

5. **`action-calling`'s real dataset is absent in this checkout** — it requires
   `training/data/native/records/hermes-fc-v1.jsonl`, which is not present, so
   only the 1-record `fixtures/smoke.jsonl` ran. Its `1.00` is therefore
   smoke-only and **must not** be promoted to a real matrix cell.

---

## 5. Harness bug found **and fixed**: MINT code grader

Running `mint` through the eliza harness, every code-execution subtask
(`humaneval`, `mbpp`) silently failed with:

```
[MINTEvaluator] check_correctness raised Can't pickle local object
    <function check_correctness.<locals>.unsafe_execute>
```

**Root cause:** `benchmarks/mint/upstream/mint/utils/exec.py` runs the untrusted
solution in a `multiprocessing.Process(target=unsafe_execute)` where
`unsafe_execute` is a **local closure** (the OpenAI human-eval pattern, which
assumes `fork`). Under macOS/Python-3.14's default **`spawn`** start method the
target is pickled → `Can't pickle local object` → the process never runs →
result empty → scored as failed. So **every** MINT code task was a false
failure, independent of model quality.

**Fix (committed):** use an explicit `fork` context for the Manager + Process,
falling back to the default context where `fork` is unavailable:

```python
try:
    ctx = multiprocessing.get_context("fork")
except ValueError:
    ctx = multiprocessing.get_context()
manager = ctx.Manager(); result = manager.list()
p = ctx.Process(target=unsafe_execute)
```

**Verified directly:**

```
correct-code  -> {'success': True,  'result': 'passed'}
wrong-code    -> {'success': False, 'result': 'failed: '}
```

Post-fix MINT (eliza harness, full tools+feedback) = **0.417 (5/12)** — a real,
differentiated score (e.g. `humaneval-2` PASS in 5 turns / 3 tool calls;
`gsm8k-0` PASS in 2 turns; hard tasks genuinely fail). This is exactly the
"per-harness 'no harness issues' is asserted, not proven per-run" gap #10193
calls out — here it was proven *false*, then fixed.

---

## 6. tau_bench (retail) — eliza harness reuse confirmed, dataset-gated

`tau_bench` drove the **eliza agent against a Cerebras user-simulator + Cerebras
LLM judge**, reusing the shared server. The runtime side worked end-to-end —
`eliza_adapter.client | Eliza benchmark server is ready` — but every task
auto-failed at env construction:

```
ERROR elizaos_tau_bench.runner | Failed to construct env for retail task 0
FileNotFoundError: .../elizaos_tau_bench/upstream/envs/retail/data/orders.json
```

So the `pass^k = 0.0 / avg_reward = 0.0` is **not a model score** — the retail
domain data (`upstream/envs/retail/data/*.json`, registry req
`benchmark-data/tau-bench`) is absent in this checkout, so the agent never got a
conversation (trajectories have 0 messages). **Classification: gated on the
tau-bench upstream dataset**, *not* a graded 0.0. What this run *did* prove for
tau_bench: the eliza-harness **reuse path works for a second adapter**, and the
benchmark needs `elizaos_tau_bench` + `eliza_adapter` on `PYTHONPATH` (the
orchestrator sets this; a bare `python -m` does not — a single-runner packaging
gap).

---

## 7. Full registry classification (44 ids)

`python -m benchmarks.orchestrator list-benchmarks` → **51 adapters / 43 dirs**;
`get_benchmark_registry()` returns **44 ids** (the extra is `recall_bench`, which
is **registered but missing from `ci_coverage.py`** — a registry↔coverage drift
worth a sync test). Classification of every id for a Cerebras `gpt-oss-120b` run:

### A. Ran real on Cerebras this session (7)
`mmlu`, `gsm8k`, `humaneval`, `mt_bench`, `bfcl` (direct, real graded) ·
`action-calling` (direct, smoke-only) · `mint` (eliza harness, real graded
after the §5 fix). `tau_bench` exercised the eliza harness-reuse path but is
**dataset-gated** (§6, listed in C).

### B. Eliza-harness-compatible, runnable on Cerebras, not run this session (needs a server boot/reuse)
`agentbench`, `context_bench` (spawn own server — no `ELIZA_BENCH_URL` reuse) ·
`configbench` (Bun + eliza handler) · `woobench`, `social_alpha`, `trust`,
`webshop`, `visualwebbench` (eliza bridge) · `clawbench`,
`orchestrator_lifecycle` (fixtures, deterministic, no LLM judge) ·
`abliteration-robustness`, `scambench` (need HF/training datasets) ·
`rlm_bench` (needs RLM plugin) · `realm` (`data/realm`) · `mind2web`
(dataset+key) · `recall_bench` (secret-free; not in ci_coverage).

### C. Gated — heavy external dependency (machine-checkable reason)
| Benchmark(s) | Gate |
|---|---|
| `hermes_swe_env`, `hermes_tblite`, `hermes_terminalbench_2`, `hermes_yc_bench` | NousResearch hermes-agent venv at `~/.eliza/agents/hermes-agent-src` |
| `osworld` | VM provider (Docker+KVM / VMware / VirtualBox) |
| `openclaw_bench` | Docker containers |
| `swe_bench`, `swe_bench_orchestrated`, `terminal_bench` | SWE/terminal datasets + Docker |
| `mmau`, `voicebench`, `voicebench_quality`, `voiceagentbench` | real audio + STT (Groq Whisper / local) |
| `solana`, `gauntlet` | Surfpool Solana validator (localhost:8899) |
| `hyperliquid_bench` | eliza `--demo --testnet` works keyless; live needs Rust toolchain |
| `vision_language` | image datasets + `IMAGE_DESCRIPTION` runtime (Cerebras serves no vision) |
| `vending_bench` | long-horizon agent loop |
| `trajectory_replay` | requires `traj_set` dir + `baseline` recorded outputs |
| `tau_bench` | tau-bench upstream env data (`upstream/envs/{retail,airline}/data/*.json`) absent — harness reuse works, scoring blocked (§6) |

(Several of B/C also have deterministic `--mock`/oracle smoke paths, but those
are explicitly **not** publishable real-matrix scores.)

---

## 8. How to reproduce

```bash
export CEREBRAS_API_KEY=…
cd packages

# direct-model (no runtime) — fast, real:
python -m benchmarks.standard.mmlu      --provider cerebras --model gpt-oss-120b --api-key-env CEREBRAS_API_KEY --output OUT --limit 40 --max-tokens 4096
python -m benchmarks.standard.gsm8k     --provider cerebras --model gpt-oss-120b --api-key-env CEREBRAS_API_KEY --output OUT --limit 40 --max-tokens 4096
python -m benchmarks.standard.humaneval --provider cerebras --model gpt-oss-120b --api-key-env CEREBRAS_API_KEY --output OUT --limit 30 --max-tokens 4096
python -m benchmarks.standard.mt_bench  --provider cerebras --model gpt-oss-120b --judge-provider cerebras --judge-model gpt-oss-120b --api-key-env CEREBRAS_API_KEY --judge-api-key-env CEREBRAS_API_KEY --output OUT --limit 12
python -m benchmarks.bfcl run           --provider cerebras --model gpt-oss-120b --sample 20 --output OUT

# eliza harness (real runtime) — boot ONE shared server, then reuse it:
export ELIZA_BENCH_TOKEN=$(openssl rand -hex 32) ELIZA_BENCH_PORT=39517
BENCHMARK_MODEL_PROVIDER=cerebras BENCHMARK_MODEL_NAME=gpt-oss-120b \
  node --import tsx app-core/src/benchmark/server.ts   # wait for ELIZA_BENCH_READY (~13 min cold)
export BENCHMARK_HARNESS=eliza ELIZA_BENCH_URL=http://127.0.0.1:39517
python -m benchmarks.mint.run_benchmark --provider eliza --model gpt-oss-120b --subtasks humaneval mbpp gsm8k --max-tasks 4 --no-ablation --output-dir OUT
```

---

## 9. Calibration — "perfect" / "wrong" oracle + no-leak proof

The point of a perfect/wrong oracle: prove the grader **can** award full marks in
the exactly-correct configuration (no impossible/broken scorer), prove it
**discriminates** (a wrong agent scores 0, not a trivial pass), and prove the
oracle's ground-truth **does not leak** into what the real `gpt-oss-120b` model
sees.

### 9a. Scorer-level calibration (synthetic `perfect_v1` / `wrong_v1` / `half_v1`)
`python -m benchmarks.orchestrator run --harnesses perfect_v1 wrong_v1 half_v1` over
10 benchmarks (`mmlu gsm8k humaneval bfcl mint action-calling mt_bench
context_bench agentbench tau_bench`) → **30 runs, 0 failures**, every scorer hit
its endpoints exactly:

| harness | every benchmark |
|---|---|
| `perfect_v1` | **1.0** |
| `wrong_v1` | **0.0** |
| `half_v1` | **0.5** |

`orchestrator calibration-report` now marks those 10 `calibration=valid`. This
proves each scorer can *represent* full-right / full-wrong / midpoint — it does
**not** drive the agent loop (synthetic harnesses write the result payload the
scorer reads).

### 9b. End-to-end perfect oracle (real grader, real agent loop)
The standard benchmarks ship a `--mock` ground-truth path that feeds **correct
answers through the real grader** (not a synthetic payload):

| benchmark | `--mock` oracle | meaning |
|---|---|---|
| `mmlu` | **1.0** (3/3) | letter-match grader awards full marks on correct answers |
| `gsm8k` | **1.0** (3/3) | `#### <int>` numeric grader awards full marks |
| `humaneval` | **1.0** (2/2) | **sandbox-execution** grader passes correct code (not a shim) |

So for the three benchmarks where `gpt-oss-120b` scored 0.925 / 0.975 / 1.000,
the **exact-correct system provably reaches 1.0** — the model's non-perfect
scores are real misses, not a capped grader.

### 9c. No-leak proof (the model never sees the answer)
Checked the **real** `gpt-oss-120b` trajectories:

- **humaneval:** `0 / 30` prompts contain the hidden test harness (`def check(` /
  `candidate(`). The model sees only the function signature + docstring (whose
  doctest examples are part of the public problem); the grading tests are
  withheld.
- **gsm8k:** the only `####` in any prompt is the **format instruction**
  (`"conclude with a line of the form '#### <integer>'"`); **`0 / 40`** prompts
  contain a concrete `#### <number>` (the gold value). The model's `#### 18` is
  its own computation.
- **mmlu:** the system message says "respond with … the correct answer" (an
  instruction); the user message is the bare question + lettered choices, no
  answer key.

Ground-truth lives only on the grader side; the model path is the question only.

### 9d. Finding — MINT's end-to-end "perfect oracle" is broken (≠ 1.0)
`mint --use-sample-tasks --provider mock` (which sets
`allow_ground_truth_mock=True`, "agent returns ground-truth answers") scores only
**1/3** on its own smoke set: `gsm8k-smoke-0` PASS, `humaneval-smoke-0` and
`mmlu-smoke-0` FAIL (both ran the full 5 turns without a recognized submission).

Precise root cause — **the grader is fine; the answer never reaches it intact:**
- The MINT evaluator is correct: feeding it the raw ground-truth directly,
  `evaluate(predicted=GT, expected=GT)` returns `success=True / 1.0` for **all
  three** smoke tasks (the MC matcher even accepts `b`, `B`, `(B)`, and
  "The answer is B").
- But the mock returns the raw `ground_truth` string, and the multi-turn loop
  passes it through `MINTAgent._extract_answer` first, which for a fenced code
  block does `...splitlines()[0]` — it **keeps only the first line**, truncating
  the humaneval solution to `def check(candidate):`. And the raw `"b"` /
  multi-line code is not wrapped in the MINT "Propose Solution" action the loop
  recognizes as a final submission, so the run burns all 5 turns and fails.
- (`gsm8k` survives because its numeric answer is a single token the loop's
  numeric path still picks up.)

So the gap is the **mock oracle + answer-extraction protocol**, not the scorer.
Note the **real** `gpt-oss-120b` path is unaffected: a real model emits fenced
```python``` blocks that `_extract_code` captures and *executes* in full (never
first-line-truncated), so the live MINT 0.417 in §1 stands — only the unfenced
mock-oracle answer hits the truncation. A real fix makes the oracle emit a fenced
solution wrapped in the recognized submission action. Left as a focused follow-up
(deeper vendored-`mint` change, multiple interacting pieces) rather than bundled
with the §5 grader-execution fix; the standard-benchmark perfect oracle in §9b
already proves the "exact-correct-system reaches 1.0" property for the suite.

---

## What this run does *not* cover (still open in #10193)

- HITL multi-account **codex / `gpt-5.5`** runner (no codex adapter / account
  pool wired to benchmarks yet).
- Viewer **playback** mode + **smithers** diff column.
- `RESULTS_MATRIX.md`↔registry **sync test**.
- A single `certify-all` entrypoint that drives all four harnesses + the HITL
  pass and rewrites the committed scoreboard.
- Filling missing hermes/openclaw/smithers `agent_fn` factories.
- Wiring `ELIZA_BENCH_URL` reuse into `agentbench`/`context_bench`.

These remain the build-out half of the issue; this run establishes the real
`gpt-oss-120b`/Cerebras baseline they should sit on top of, and removes the
flat-`1.00` fiction from the headline cells.
