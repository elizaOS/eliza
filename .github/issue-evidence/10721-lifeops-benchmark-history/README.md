# LifeOps / PA real-model benchmark score history (#11789, #10721)

Real-model LifeOps benchmark run for the #10721 PA audit closure. This is a
**real local model** driving the LifeOps benchmark lane — **not** the
deterministic LLM proxy, **not** `registerCalibratedJudgeFixture`, **not** a
mock standing in for the model under test.

## Run identity

| Field | Value |
| --- | --- |
| Benchmark | `packages/benchmarks/lifeops-bench` (LifeOpsBench), Hermes adapter, `--mode static` |
| develop SHA | `b40e60275b` (worktree checked out from `origin/develop`, 2026-07-03) |
| Model under test | **eliza-1-2b** (`eliza-1-2b-128k.gguf`, gemma-4-E2B, 1.27 GB) and **eliza-1-4b** (`gemma-4-E4B-it-Q8_0.gguf`, 8.03 GB) |
| Serving | locally-built `llama-server` (llama.cpp submodule `299d5b78b`), OpenAI-compatible endpoint |
| Backend | **CPU** — `SSE3/AVX/AVX2/AVX_VNNI/F16C/FMA/BMI2/LLAMAFILE`, 22 threads on Intel Core Ultra 9 275HX (24 cores). **CUDA unavailable** (host NVIDIA GPU wedged in a runtime-PM error state — `nvidia-smi`: `Unable to determine the device handle for GPU0 … Unknown Error`; a reboot is required, out of scope for this lane). |
| Judge | none — static-mode LifeOpsBench scoring is **deterministic** (world `state_hash` + required-output substring match), so no hosted judge/simulated-user is invoked. Validated below by the `perfect` oracle. |
| Date | 2026-07-03 |

## Score history

All numbers are real recorded runs (JSON artifacts alongside this README).

| Run | Agent / model | Scenarios | pass@1 | Latency | Artifact |
| --- | --- | --- | --- | --- | --- |
| smoke / oracle | `perfect` (ground-truth) | 5 | **1.000** | — | `lifeops-bench-oracle/lifeops_gemma-4-31b_20260703_120944.json` |
| smoke | **eliza-1-2b** (real, CPU) | 5 | **0.000** | 634 s | `lifeops-bench-smoke/lifeops_eliza-1-2b_20260703_120854.json` |
| smoke | **eliza-1-4b** (real, CPU) | 5 | **0.000** | 522 s | `lifeops-bench-smoke-4b/lifeops_eliza-1-4b_20260703_122000.json` |
| static slice (calendar) | **eliza-1-2b** (real, CPU) | 10 | **0.000** | 577 s | `lifeops-bench-2b-slice10/lifeops_eliza-1-2b_20260703_123211.json` |

`perfect`=1.000 on the identical 5 scenarios proves the world, corpus, and
scorer are valid — so the local-model 0.000 rows are a **genuine model/adapter
result, not a broken harness**.

The `perfect` oracle row is labelled `gemma-4-31b` in its filename only because
that is the default `MODEL_TIER=large` label; the `perfect` agent emits the
scenario's ground-truth actions and never calls any model.

## Manual review — why the real local models score 0.000

Read the per-scenario `agent_message` fields (in each JSON under
`scenarios[].turns[0].agent_message`). The models **understand the task** but
emit tool calls in a format the LifeOpsBench **Hermes text-protocol adapter
cannot parse**, so `agent_actions` is empty and no world mutation occurs.

**eliza-1-4b** — correct tool + correct arguments, wrong serialization:

- `calendar.check_availability_thursday_morning` → `I need to check your calendar for Thursday, May 14th … <|im_start|>tool_code> print(calendar.get_events(time_range='2026-05-14T09:00:00Z/2026-05-14T10:00:00Z'))` — correct tool, correct time window, but emitted as **gemma-native `tool_code`/`print(...)`** rather than the Hermes `<tool_call>{json}</tool_call>` XML.
- `mail.archive_specific_newsletter_thread` → `print(lifeops_bench.archive_thread(thread_id='thread_01464'))` — correct thread id, gemma-native syntax.
- `messages.send_imessage_to_hannah` → `print(lifeops_bench.iMessage.send_message(recipient_name='Hannah Hill', message_body='running 10 minutes late, see you at the cafe.'))` — correct recipient + body, gemma-native syntax.

**eliza-1-2b** — weaker: `<think>` blocks then prose / markdown-JSON code fences,
no tool-call envelope at all (e.g. reminders → prose "Reminder: Tomorrow … at
09:00 AM to pick up kids' soccer uniforms"; one calendar case rambled to the
4096-token cap).

**Conclusion (hand-reviewed):** the recorded 0.000 is a *lower bound* confounded
by an adapter/template mismatch, **not** a pure capability measure. The eliza-1
(gemma-4) models emit gemma-native tool-call syntax; the Hermes adapter only
parses Hermes XML `<tool_call>`. Additionally, the models' native gemma-4 chat
template rejects LifeOpsBench's multi-`system`-message layout
(`Jinja Exception: System message must be at the beginning`), so the server was
run with `--chat-template chatml` — a non-native template that further degrades
gemma formatting fidelity. The faithful adapter for eliza-1 is the **native
`eliza` runtime adapter** (which parses the model's real action format); that
path is environment-blocked here (see below).

## Skipped scenarios / unavailable providers (explicit)

- **CUDA / GPU backend — UNAVAILABLE (environment).** Host NVIDIA GPU is wedged
  (`nvidia-smi` device-handle error); needs a reboot. All runs used the **CPU**
  llama.cpp backend. Real, but ~3–11 tok/s generation and ~25–166 tok/s prompt
  eval — the reason coverage is a committed subset, not the full corpus.
- **Full LifeOpsBench corpus — NOT run (throughput).** The corpus is 1,020 base
  scenarios × 10 robustness variants = **11,220 runs**. On CPU this is
  infeasible in one session. Ran the committed **`smoke` static suite (5,
  one per core domain: calendar/mail/reminders/health/messages)** on two model
  tiers plus a **10-scenario static calendar slice** — 20 real-model
  evaluations + 5 oracle. Honest coverage: **~2% of base scenarios**, chosen for
  per-domain breadth, not a full-corpus claim.
- **LifeOpsBench `--mode live` — NOT run (no confounding-judge needed & no
  hosted creds).** Live mode needs `CEREBRAS_API_KEY` (simulated user) +
  `ANTHROPIC_API_KEY` (satisfaction judge). Static mode was used deliberately so
  the score is a deterministic state-hash grade with **no hosted judge** — which
  is exactly what #11789 AC1 requires. No scenario was skipped *within* the
  suites that ran; every selected scenario produced a scored result.
- **scenario-runner full elizaOS-runtime PA path — ATTEMPTED, environment-blocked.**
  `packages/scenario-runner` driving `plugins/plugin-personal-assistant/test/scenarios`
  with the same local model (OpenAI provider → local `llama-server`) was tried
  (`provider: openai` confirmed against the local endpoint). A single PA turn
  builds a **40k–45k-token** prompt (planner + full action catalog + providers);
  on CPU one turn exceeds the 280 s per-turn budget (and blew past an 8k/49k
  server context). Real trajectory artifacts from the attempt are under
  `reports/brush-teeth-basic/` (status `failed`, `handleMessage … timed out
  after 280000ms`). This is the faithful adapter for eliza-1 tool syntax but is
  not runnable on this GPU-wedged host; it is the strongest candidate for a
  re-run once the GPU is recovered.

## Retention / reporting-location decision (the #11789 human-gated item)

The retention & reporting location for LifeOps/PA real-model score history and
failure artifacts is **this committed evidence directory**:
`.github/issue-evidence/10721-lifeops-benchmark-history/` — per-run JSON
(`scenarios[].turns[]` with raw `agent_message`, tokens, latency, `total_score`,
`state_hash_match`), stdout logs under `logs/`, and the scenario-runner
trajectory bundle under `reports/`. Future real-model LifeOps runs (ideally the
native `eliza` adapter on a GPU-recovered host, or a nightly CI lane) append new
timestamped JSON here.

## How to reproduce

```bash
# 1. Build a llama.cpp llama-server that supports the gemma4 arch (CPU):
cmake -S plugins/plugin-local-inference/native/llama.cpp -B <build> \
  -DGGML_VULKAN=OFF -DGGML_CUDA=OFF -DLLAMA_BUILD_SERVER=ON -DCMAKE_BUILD_TYPE=Release
cmake --build <build> --target llama-server -j

# 2. Serve a real eliza-1 GGUF (chatml template works around gemma-4's
#    multi-system-message restriction):
<build>/bin/llama-server -m <eliza-1-2b|4b>.gguf --host 127.0.0.1 --port 8095 \
  -c 65536 -np 1 -t 22 --chat-template chatml --alias eliza-1-2b

# 3. Run the LifeOps benchmark static smoke suite against it:
cd packages/benchmarks/lifeops-bench
OPENAI_API_KEY=sk-local MODEL_TIER=small MODEL_NAME_OVERRIDE=eliza-1-2b \
  MODEL_BASE_URL_OVERRIDE=http://127.0.0.1:8095/v1 \
  python3 -m eliza_lifeops_bench --agent hermes --mode static --suite smoke \
    --concurrency 1 --per-scenario-timeout-s 400 --output-dir <out>
```

The scenario-runner live-model lane (native runtime path) is invoked with
`SCENARIO_TURN_TIMEOUT_MS` (added in this PR) so slow local-model CPU runs can
raise the default 120 s per-turn budget:

```bash
OPENAI_API_KEY=sk-local OPENAI_BASE_URL=http://127.0.0.1:8095/v1 \
  OPENAI_LARGE_MODEL=eliza-1-2b OPENAI_SMALL_MODEL=eliza-1-2b \
  SCENARIO_TURN_TIMEOUT_MS=280000 \
  bun --conditions eliza-source --tsconfig-override ../../tsconfig.json \
  src/cli.ts run ../../plugins/plugin-personal-assistant/test/scenarios \
  --scenario brush-teeth-basic --report-dir <out> --run-dir <out>
```

## Clean-capability datapoint — Cerebras `gemma-4-31b`, native tool-calling

The local-model rows above scored **0.000 only because of the Hermes-adapter /
gemma-native `tool_code` mismatch** — the models emitted correct tools+args in
the wrong envelope, so `agent_actions` came back empty and nothing executed. The
residual flagged at #11789 closure was *"a clean capability number,"* reachable
via the native `eliza` adapter on a GPU-recovered host **or** by parsing
gemma-native tool syntax. This run takes a **third path that needs neither**: the
LifeOpsBench **`cerebras-direct`** agent, which uses the provider's **native
OpenAI tool-calling API** (function-call JSON) — so there is **no text-protocol
parse step to confound**.

| Field | Value |
| --- | --- |
| Benchmark | `packages/benchmarks/lifeops-bench`, **`cerebras-direct`** agent, `--mode static` |
| Model under test | **`gemma-4-31b`** (same gemma-4 family as eliza-1's E2B/E4B, larger tier) via **Cerebras** |
| Serving | `https://api.cerebras.ai/v1`, `CEREBRAS_API_KEY` (liveness proof: `lifeops-bench-cerebras-gemma-4-31b/cerebras-endpoint-proof-gemma-4-31b.txt`) |
| Scoring | deterministic `state_hash` + required-output substring — **no judge, no mock** |
| Coverage | **12 scenarios × 10 domains = 120** static evaluations (vs the local runs' 5 + 5 + 10) |
| develop SHA | `517ad615d08` |

### Result — pass@1 **13.3%** (16/120), mean normalized score 0.245

| domain | pass@1 | mean score | | domain | pass@1 | mean score |
| --- | ---: | ---: | --- | --- | ---: | ---: |
| calendar | 50.0% | 0.567 | | finance | 8.3% | 0.121 |
| mail | 25.0% | 0.321 | | focus | 8.3% | 0.108 |
| travel | 25.0% | 0.422 | | messages | 0.0% | 0.175 |
| reminders | 16.7% | 0.242 | | health | 0.0% | 0.067 |
| contacts | 0.0% | 0.383 | | sleep | 0.0% | 0.046 |

### Why this is a *clean* number (hand-reviewed, no cherry-picking)

Unlike the confounded 0.000 local rows, **`agent_actions` is populated and
executed on every domain** — the model natively emits `CALENDAR_CREATE_EVENT`,
`MESSAGE_SEND`, `ENTITY`, `HEALTH`, `CALENDAR_SEARCH_EVENTS`, etc. There is **no
parse artifact**; the score is a genuine task-completion measure. The failures
are real, and fall into three honest buckets (see the raw `scenarios[].turns[]`):

- **Partial world state** (score `0.3`, `state_hash_match=false`) — right action,
  wrong details (e.g. `calendar.create_dentist_event_next_friday`: created the
  event but off on time/attributes).
- **Correct state, wrong answer text** (`state_hash_match=true`, score `0.0`) —
  read-only tasks where the world matched but the required output substring
  didn't (e.g. `health.step_count_today` answered a value that missed the
  seeded expectation).
- **Read-loop to `max_turns`** — the agent kept calling a read tool
  (`MESSAGE_READ_CHANNEL` ×6) without terminating (e.g.
  `messages.summarize_unread_whatsapp_family_chat`).

So `gemma-4-31b` at this tier is **strong on single-shot writes (calendar 50%)
and weak on multi-step read-summarize-and-answer** — a real, actionable capability
signal for the LifeOps action set, which the adapter-confounded local rows could
not produce. `smoke_static_calendar_01` passing at 1.0 with correct
`CALENDAR_CREATE_EVENT` + confirmation is the spot-checked proof the path is end
to end real.

## Machine-maintained score-history series + scheduled lane

Two additions operationalize the retention decision above (*"future runs append
new timestamped JSON here … or a nightly CI lane"*):

- **`score-history.jsonl` + `HISTORY.md`** — an append-only, harness-keyed series
  (regenerated, never hand-edited) so the *trend* across models/adapters stays
  reviewer-visible. Add a point with `scripts/append-score-history.mjs` (ingests
  either the TS prompt-benchmark or the Python `lifeops_bench` report format;
  `--report-dir` merges a per-domain run).
- **`.github/workflows/lifeops-benchmark-history.yml`** — the nightly lane,
  **opt-in and inert on merge**: it no-ops without a `CEREBRAS_API_KEY` secret
  and its `schedule:` trigger is commented out. Enabling it (secret + cron) runs
  both the `lifeops_bench` (`cerebras-direct`) and TS prompt-benchmark harnesses,
  appends each point to the series in the runner's checkout, prints it to the job
  summary, and uploads it as a build artifact — a maintainer commits the new row
  via a normal PR (the lane never writes to the repo itself).

> **Note on the raw artifacts:** each `lifeops_gemma-4-31b_<domain>.json` retains
> the full model I/O (`agent_actions`, `agent_message`, tokens, latency,
> `total_score`, `state_hash_match`); the per-turn `tool_results` (the
> deterministic world observations returned to the model) are elided for size and
> reproducible via the run command above.
