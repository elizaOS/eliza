# #10199 / #10193 — One-operator registry review on gemma-4-31b (Cerebras)

One-operator `benchmarks.orchestrator review` close-out for the gemma-4-31b
cutover: preflight inventory → run → validate-latest-readiness →
review-package → verify-artifacts, over the confirmed bridge-wired
eliza-harness core set. The reviewed `scorecard.md` + `manifest.json` live in
[`review-package/`](review-package/).

- Provider/model: `cerebras` / `gemma-4-31b` (131k context, reasoning opt-in)
- Harness: `eliza` (bench server → AgentRuntime → planner path)
- Branch: `feat/cerebras-gemma-4-31b-cutover`
- Date: 2026-07-02

## Score table (review run group `rg_20260702T075855Z_603eb7e7`)

| benchmark | harness | score | provider/model | notes |
| --- | --- | --- | --- | --- |
| mmlu | eliza | 0.70 | cerebras / gemma-4-31b | 40 items; also hermes 0.75, openclaw 0.75 (multi-harness parity proven for this benchmark) |
| gsm8k | eliza | 0.975 | cerebras / gemma-4-31b | 40 items; strict `#### <int>` parse |
| humaneval | eliza | 0.75 | cerebras / gemma-4-31b | 20 problems; **0.35 → 0.75** after the reply-flattening fix below |
| mt_bench | eliza | 0.90 | cerebras / gemma-4-31b | 8 items; gemma-4-31b judge |
| bfcl | eliza | 0.86 | cerebras / gemma-4-31b | multiple + parallel, 25/category |
| action-calling | eliza | 1.00 | cerebras / gemma-4-31b | 20 examples |
| agentbench | eliza | 0.00 | cerebras / gemma-4-31b | OS env, 5 tasks, `no_docker`; **real completed run** (error=None, real tokens) — genuine hard-agentic-task performance, not a harness failure |
| tau_bench | eliza | 0.00 | cerebras / gemma-4-31b | retail, 5 tasks, 1 trial, grounded user; **real completed run** — genuine hard-agentic-task performance, not a harness failure |
| mint | eliza | 1.00 | cerebras / gemma-4-31b | reasoning category, 5 tasks |
| context_bench | eliza | 0.75 | cerebras / gemma-4-31b | context lengths 1024/8192, middle position |

Reviewed rows: 12 (10 eliza-harness benchmarks + mmlu on hermes/openclaw).
All rows `status: succeeded` with real trajectories. The reviewed
`scorecard.md` + `manifest.json` are in [`review-package/`](review-package/).

**Review-package status: `blocked` — on multi-harness comparability, not data
quality.** The one-operator `review` gate requires every benchmark to carry
`hermes` **and** `openclaw` rows (4-harness comparability) plus a clean
inventory. This run has all three harnesses only for `mmlu`; the other nine are
eliza-only, and the inventory still lists two adapter-less legacy dirs
(`loca-bench`, `qwen-claw-bench`, pre-existing). Standing up the hermes /
openclaw external agent stacks is the infra-gated successor scope called out in
the #10199 / #10193 analysis — it is **not** closeable in a model-cutover
campaign. The eliza-harness gemma-4-31b baseline itself is real, complete, and
hand-reviewed.

Every benchmark's trajectory/telemetry artifacts were opened and
spot-reviewed by hand (`benchmark_results/<run-group>/<dir>/run_*/output/`):
real prompts, real model completions with token usage, real failure records.
No empty-output or flat-score larp survived unexplained (see observations).

## Reply-path bug found and fixed during this review

The discovery pass scored humaneval **0.35** with every failure a
`SyntaxError` on code whose newlines were gone. Root cause (traced through
live probe server + runtime trajectory `tj-cb9ca595914cf5.json`):
`sanitizeReplyTextAfterMediaDelivery` in
`packages/core/src/services/message.ts` ran `.replace(/\s{2,}/g, " ")` on
**every** planner reply — even with zero delivered media URLs — flattening all
multiline output (code bodies, lists, paragraphs) to one line. The model's
raw structured output and the REPLY action args had correct `\n`s all the way
through; the final egress sanitizer destroyed them.

Fix: return media-free replies untouched; collapse only same-line whitespace
gaps (`[^\S\n]{2,}`) in the media case. Regression tests added in
`packages/core/src/__tests__/media-reply-sanitize.test.ts`.
**humaneval 0.35 → 0.75** after the fix (same limit 20, same model).

## Excluded benchmarks and reasons

### Host-gated off (adapter's own compatibility probe marks them not runnable here)

| benchmark | gate (canonical adapter reason) |
| --- | --- |
| gauntlet | no `surfpool` binary — real mainnet-clone Solana backend unavailable |
| hyperliquid_bench | `HL_PRIVATE_KEY` unset — Hyperliquid live execution unavailable |
| vision_language | real multimodal runtime/input bundle not selected (`VISION_LANGUAGE_PROVIDER`) |
| voicebench | real audio assets unavailable |
| voicebench_quality | real audio inputs unavailable |
| voiceagentbench | real audio dataset unavailable |

### Input-artifact-gated (adapter runs only against a pre-existing capture)

| benchmark | gate |
| --- | --- |
| eliza_replay | requires `per_benchmark.eliza_replay.capture_path` pointing at an existing replay capture |
| trajectory_replay | requires `extra.traj_set` pointing at existing trajectory JSONs |

### Out of this review's lane (runnable on this host, not part of the confirmed bridge-wired eliza-harness core)

| benchmark | reason |
| --- | --- |
| swe_bench, swe_bench_orchestrated, terminal_bench, osworld | heavy Docker suites (multi-GB image pulls, hours per pass) — separate dedicated lanes |
| hermes_swe_env, hermes_tblite, hermes_terminalbench_2, hermes_yc_bench | Hermes agent-stack lane (sandbox-backed), not the eliza harness under review |
| clawbench, openclaw_bench | OpenClaw agent-stack lane |
| lifeops_bench | registry requires `ANTHROPIC_API_KEY` (not provisioned); known lost-manifest gap documented in #8795 evidence |
| interrupt_bench | already separately evidenced this campaign on gemma-4-31b: 97.07 twice (`interrupt-bench-cerebras-report-2026-07-02-run{1,2}.md` in this directory) |
| mind2web, visualwebbench, webshop, mmau | large external datasets / web+audio environment stacks not validated on this branch |
| solana, social_alpha, woobench, realm | external environment stacks (chain gym, social/commerce sims) not validated on this branch |
| abliteration-robustness, adhdbench, app-eval, configbench, eliza_1, experience, framework, orchestrator_lifecycle, personality_bench, recall_bench, rlm_bench, scambench, three_agent_dialogue, trust, vending_bench | eliza-compatible adapter-sims outside the confirmed bridge-wired core; not validated end-to-end on this branch — follow-up lane for a full `--all` certification pass |

`--all` was deliberately not used: the review flow fails the whole package on
any failed run, and an honest, spot-reviewed core set beats a timed-out or
larp-padded full pass. The out-of-lane set above is the backlog for the next
certification wave.

## Exact commands

Discovery pass (plain `run`, all 10 succeeded):

```bash
PYTHONPATH=packages python3 -m benchmarks.orchestrator run \
  --benchmarks mmlu gsm8k humaneval mt_bench bfcl action-calling agentbench tau_bench mint context_bench \
  --provider cerebras --model gemma-4-31b --force \
  --extra "$(cat review-extras.json)"   # per_benchmark limits below
```

Final one-operator review (re-ran all 10 fresh with the reply-path fix):

```bash
PYTHONPATH=packages python3 -m benchmarks.orchestrator review \
  --benchmarks mmlu gsm8k humaneval mt_bench bfcl action-calling agentbench tau_bench mint context_bench \
  --provider cerebras --model gemma-4-31b --force \
  --extra "$(cat review-extras.json)" \
  --out .github/issue-evidence/10199-gemma-4-31b-cutover/review-package \
  --reviewed-by "claude-fable-5 (gemma-4-31b cutover campaign)" \
  --reviewer-note "…"   # full note recorded in review-package/manifest.json
```

`review-extras.json` (`--extra` payload — real, non-smoke limits):

```json
{
  "per_benchmark": {
    "mmlu": {"limit": 40, "max_tokens": 2048},
    "gsm8k": {"limit": 40, "max_tokens": 2048},
    "humaneval": {"limit": 20, "max_tokens": 2048, "timeout_s": 10},
    "mt_bench": {"limit": 8, "max_tokens": 1024, "temperature": 0.0, "judge_max_tokens": 512, "judge_provider": "cerebras", "judge_model": "gemma-4-31b", "judge_api_key_env": "CEREBRAS_API_KEY"},
    "bfcl": {"categories": ["multiple", "parallel"], "max_per_category": 25},
    "action-calling": {"max_examples": 20, "max_new_tokens": 512},
    "agentbench": {"elizaos": true, "env": ["os"], "max_tasks": 5, "no_docker": true},
    "tau_bench": {"agent_max_turns": 14, "domain": "retail", "max_tasks": 5, "num_trials": 1, "pass_k_values": [1], "user_strategy": "grounded"},
    "mint": {"agent": "eliza", "categories": ["reasoning"], "max_tasks": 5, "max_turns": 3, "timeout": 120, "no_ablation": true},
    "context_bench": {"quick": true, "context_lengths": [1024, 8192], "positions": ["middle"], "tasks_per_position": 2}
  }
}
```

`CEREBRAS_API_KEY` was provided via environment (`$CEREBRAS_API_KEY`), never
written to files.
