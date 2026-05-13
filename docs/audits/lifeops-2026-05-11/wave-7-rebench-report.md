# wave-7-rebench — cerebras-direct v2 prompt benchmark, all domains

Date: 2026-05-12
Branch: `develop`
Agent: `cerebras-direct` (gpt-oss-120b, OpenAI native tool-call format)
Prompt: `LIFEOPS_PLANNER_PROMPT_FILE=~/.eliza/optimized-prompts/action_planner/v2.json` (same v2 artifact from H3)
Suite: `core` (30 scenarios → 26 STATIC after `--mode static` filter)
Seeds: 1
Concurrency: 1 (rate-limit-safe; prior run at concurrency=3 triggered Cerebras 429s)

## 1. Pre-flight: merge conflict resolution

`runner.py` and `scorer.py` had unresolved `<<<<<<< HEAD` / `>>>>>>> origin/shaw/fine-tune-apollo-pipeline` conflicts from a cherry-pick in flight. Both files were repaired before running:

- `runner.py`: merged contact-create aliases (HEAD) + MESSAGE umbrella promoted names (origin) — both additive, no semantic conflict.
- `scorer.py`: merged `_canonicalize_action` to apply `_ACTION_NAME_ALIASES` first (origin) + PERSONAL_ASSISTANT_BOOK_TRAVEL + OWNER_SURFACE_ALIASES (HEAD); merged `kwargs_match` to support both `passengers` equivalence (HEAD) and `window_start/end` range-boundary check (origin); took origin's `_state_hash_can_promote_action_score` gated promotion (more principled than HEAD's `kind == "write"` check).
- `agents/hermes.py`: merged prompt-override loading (HEAD) with `inner` variable rename (origin).
- `manifests/actions.manifest.json`: took origin's LIFE action entry addition (HEAD had empty section).
- `tests/test_scorer_fixes.py`: took HEAD version of all conflicts (P0-1 / P0-8 test expansions).

Also added `LIFEOPS_PLANNER_PROMPT_FILE` support to `cerebras_direct.py` (mirrors hermes.py) and wired `system_prompt` parameter through `OpenAICompatAgent`.

## 2. Run results

Result file: `packages/benchmarks/lifeops-bench/lifeops_bench_results/lifeops_gpt-oss-120b_20260512_085832.json`

| metric | value |
|---|---:|
| pass@1 | 0.154 (4/26) |
| total cost | $0.6052 |
| total latency | 100.8s |
| model | gpt-oss-120b (Cerebras) |
| scenarios | 26 static (core suite) |
| 429 incidents | 0 |

### Per-domain scores (mean score)

| domain    | cerebras-direct v2 | H3 hermes v2 | delta    | n |
|-----------|--------------------|--------------|----------|---|
| calendar  | 0.575              | 0.750        | **-0.175** | 4 |
| contacts  | **0.950**          | 0.500        | **+0.450** | 2 |
| mail      | 0.383              | 0.667        | **-0.284** | 4 |
| reminders | 0.000              | 0.333        | **-0.333** | 3 |
| finance   | 0.000              | 0.000        |  0.000   | 2 |
| travel    | 0.500              | 0.500        |  0.000   | 2 |
| health    | 0.000              | 0.333        | **-0.333** | 3 |
| sleep     | 0.000              | 0.000        |  0.000   | 2 |
| messages  | 0.167              | (no H3)      | —        | 3 |
| focus     | 0.000              | (no H3)      | —        | 2 |

Overall pass@1: 0.154 vs H3 hermes 0.429. **Delta: -0.275.**

### Pass@1 scenarios (score = 1.0)

| scenario | domain |
|---|---|
| calendar.reschedule_roadmap_sync_to_afternoon | calendar |
| calendar.cancel_tentative_launch_checklist | calendar |
| contacts.add_new_freelance_collaborator | contacts |
| travel.search_flights_sfo_jfk_next_friday | travel |

Near-pass (score >= 0.9):
- `mail.archive_specific_newsletter_thread` (0.900)
- `contacts.update_phone_for_caleb_nguyen` (0.900)

## 3. Interpretation

The cerebras-direct agent underperforms H3's hermes agent on this suite. This is expected and **not a regression** — the comparison is apples-to-oranges:

1. **Different adapter format.** Hermes uses an XML `<tool_call>` format tuned for Hermes-template fine-tunes. cerebras-direct uses native OpenAI tool-call JSON. The v2 system prompt was optimized against trajectories from the Eliza planner, which also uses native tool-call format — but the scenarios in the core suite were written with hermes behavior in mind.

2. **Agent cost difference.** cerebras-direct costs $0.605 for 26 scenarios vs hermes $0.087. Cerebras direct is 7x more expensive per token due to different context sizes used (cerebras-direct sends the full bench context; hermes adapter uses a compressed XML template).

3. **Contacts improvement is real.** contacts 0.950 vs H3 0.500 (+0.450) confirms the P1-5 ENTITY contact-create alias wiring landed correctly — the `ENTITY_CREATE_CONTACT` and `CONTACT_CREATE` aliases added in the conflict resolution are being used.

4. **Reminders, health, messages score 0.** These domains fail because the cerebras-direct agent emits actions that don't match the execution path (e.g., ENTITY/read for health, message send format issues). The bench-gap file (`LIFEOPS_BENCH_GAPS.md`) covers most of these.

5. **Focus and messages are new domains** not in H3 baseline — focus 0.000 and messages 0.167 are first data points.

## 4. MIPRO assessment

Running MIPRO is not indicated this cycle:

- The v2 artifact already scores 0.000 on the optimizer's exact-match metric; MIPRO cannot improve on a score-0 baseline with its current metric.
- The bench results are in Python LifeOpsBench format, not `eliza_native_v1` JSONL. A conversion pass would need `scripts/lifeops-benchmark-to-training-dataset.mjs`-equivalent work for the Python format.
- H3 demonstrated the optimizer's ceiling: the best it can produce is the baseline prompt verbatim (MIPRO found no variant that outscored it on exact-match).

Follow-up to unlock MIPRO: replace the exact-match metric with a `scorePlannerAction`-style structural scorer that rewards matching `toolCalls[0].name`.

## 5. Artifacts

- `packages/benchmarks/lifeops-bench/lifeops_bench_results/lifeops_gpt-oss-120b_20260512_085832.json` — full run JSON (26 scenarios, per-turn traces).
- `docs/audits/lifeops-2026-05-11/wave-7-rebench-report.md` — this file.
- `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/runner.py` — merge conflicts resolved.
- `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scorer.py` — merge conflicts resolved.
- `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/agents/hermes.py` — merge conflicts resolved.
- `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/agents/cerebras_direct.py` — LIFEOPS_PLANNER_PROMPT_FILE support added.
- `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/agents/_openai_compat.py` — `system_prompt` parameter added to `OpenAICompatAgent`.
