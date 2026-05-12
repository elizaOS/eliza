# Re-baseline 2026-05-11 (W2-9)

Closing-the-loop run after waves W1-9 / W1-10 / W1-11 (agent emit fixes),
W1-4 / W1-4b (Mockoon substrate), W1-7 / W1-8 (PRD similes / DOC umbrella),
W2-1..W2-7 (scenario corpus + new actions + runner fix).

- **Run dir:** `/Users/shawwalters/.eliza/runs/lifeops/lifeops-multiagent-1778523395565`
- **Best symlink:** `/Users/shawwalters/.eliza/runs/lifeops/lifeops-multiagent-best`
- **Model:** Cerebras `gpt-oss-120b` (judge `claude-opus-4-7`)
- **Scenarios per agent:** 25 (first slice — all CALENDAR domain due to suite order)
- **Mockoon:** auto-started, 18 connectors

## Headline

| agent    | scenarios | pass@1 | mean score | total cost | wall time | state_hash matches | Δ vs W1-3 baseline (`mail` 25) |
|----------|----------:|-------:|-----------:|-----------:|----------:|-------------------:|--------------------------------|
| eliza    |        25 |  0.000 |      0.000 |    $0.0000 |       0ms |              11/25 | mean=0.000 (W1-3 baseline also 0; 25 zeros) |
| hermes   |        25 |  0.000 |      0.394 |    $0.0771 |   1.59min |               9/25 | W1-3 mail mean=0.494 → calendar mean=0.394 (different domain) |
| openclaw |        25 |  0.000 |      0.259 |    $0.1346 |   1.21min |              11/25 | W1-3 mail mean=0.562 → calendar mean=0.259 (different domain) |

> The corpus split is different from W1-3 (those ran `mail`, ours ran `calendar` — both are the first 25 scenarios under their respective suites). Same model, same judge, same harness.

### Score distribution

| agent    | 0.0 | (0, 0.3) | [0.3, 0.6) | [0.6, 0.9) | [0.9, 1.0) | ≥ 0.99 |
|----------|----:|---------:|-----------:|-----------:|-----------:|-------:|
| eliza    |  25 |        0 |          0 |          0 |          0 |      0 |
| hermes   |   4 |        9 |          3 |          9 |          0 |      0 |
| openclaw |  14 |        3 |          1 |          7 |          0 |      0 |

The hard ceiling is **0.80** for every "partial pass". That isn't noise — it's a structural scorer artifact (see Judge bugs below).

## Per-agent failure modes

### eliza (25 zeros, all REPLY)

`eliza` is configured to use the elizaOS runtime via the bench server. The server boots, loads `@elizaos/plugin-openai` with `OPENAI_BASE_URL=https://api.cerebras.ai/v1`, and the OpenAI plugin's `getApiKey` helper resolves `CEREBRAS_API_KEY`. But every turn returns:

> `AI_APICallError: Not Found` → falls back to "Something went wrong on my end. Please try again." → planner emits `REPLY`.

This means the openai plugin is calling an endpoint Cerebras doesn't expose (likely `/v1/responses` instead of `/v1/chat/completions`, since the python adapter that uses `chat/completions` does work fine on the same key). The `ELIZA_BENCH_FORCE_TOOL_CALL=1` gate (W1-9) is active in the bench server, but the planner never gets a chance to pick a tool because the model call itself fails on stage 1.

Note: state_hash matches in **11/25** scenarios despite zero tool calls. Those are all read-only scenarios (`next_event_today`, `check_availability_*`, `search_*`, `propose_*`, `find_free_*`, `update_preferences_*`, `check_monday_morning_block`) where the ground-truth actions don't mutate world state, so a "do nothing" passes the state-hash check. The scorer's triviality guard correctly zeroes those out because `action_score == 0` AND `len(ground_truth_actions) > 0`. So the resulting `total_score = 0` is honest, not a false negative.

### hermes (4 zero, 21 partial, 3 errored)

Hermes is hitting `state_hash=True` on 9/25, with top score capped at **0.80** for nine of those. Pattern: emits the correct umbrella `CALENDAR` action with the correct `subaction` kwarg, but misses the GT's `intent` kwarg → `_kwargs_match` returns False → `compare_actions` falls back to 0.5 partial credit → `0.5*1.0 + 0.4*0.5 + 0.1*1.0 = 0.80`.

Concrete examples:
- `calendar.next_event_today` — hermes emits `CALENDAR(subaction=next_event)`, GT requires `CALENDAR(subaction=next_event, intent="...")` → 0.80.
- `calendar.update_preferences_blackout_evenings` — hermes emits the full preferences blob, but kwargs structure differs subtly (`preferred_meeting_hours` vs GT shape) → 0.70.

The 3 errored scenarios are Cerebras `429 queue_exceeded` rate-limit hits at concurrency=4. Not a hermes bug — a runner concurrency setting.

The 4 zero scenarios:
- `smoke_static_calendar_01` — hermes emits `BLOCK(name=deep work, start_time=..., duration_minutes=30)` instead of `CALENDAR(subaction=create_event, ...)`. **Real agent gap** — hermes inferred the wrong umbrella tool name.
- `calendar.cancel_tentative_launch_checklist`, `calendar.find_free_60min_this_week`, `calendar.check_availability_thursday_morning` — empty actions due to 429 errors.

### openclaw (14 zero, 11 partial)

OpenClaw's W1-11 legacy text-tool parser fix is engaging — it emits structured tools like `CALENDAR_SEARCH_EVENTS`, `CALENDAR_CHECK_AVAILABILITY`, `CALENDAR_NEXT_EVENT`, `CALENDAR_PROPOSE_TIMES`, etc. Some of these are mixed with raw `CALENDAR` umbrella calls. Current Eliza-native comparisons should prefer OpenAI-compatible `tool_calls` rather than text-embedded tool-call protocols.

The 11 partials cap at 0.80 with the same intent-kwarg issue as hermes.

The 14 zero scenarios fall into three buckets:

1. **Granular-action / umbrella scorer mismatch** (judge bug): openclaw emits `CALENDAR_CHECK_AVAILABILITY(start, end)` and `state_hash=True`, but GT requires `CALENDAR(subaction=check_availability, ...)`. The scorer requires exact `action.name` match — `CALENDAR_CHECK_AVAILABILITY != CALENDAR` — so `action_score=0` and the triviality guard zeros the state component. Affected: `calendar.check_availability_thursday_morning`, `calendar.search_pitch_meetings_this_quarter`, `calendar.propose_meeting_with_alex`, `calendar.propose_coffee_chat`.
2. **`BLOCK_*` action naming** (real agent gap): `smoke_static_calendar_01` — openclaw emits `BLOCK_BLOCK`, `BLOCK_REQUEST_PERMISSION` for "focus block". Same root cause as hermes' BLOCK confusion.
3. **State mismatch on write scenarios**: `create_dentist`, `cancel_dentist`, `delete_lunch`, `cancel_yoga`, `cancel_team_sync_monday`, `create_meeting_john`, `reschedule_team_sync_tuesday_to_thursday`, `cancel_tentative_launch_checklist`, `reschedule_dentist_to_friday`, `reschedule_dentist_friday` — agent emits CALENDAR write but `calendarId` / `eventId` resolution fails. The fake backend rejects with messages like `"unknown calendar_id: user"` or `"missing required field 'eventId' in kwargs=[]"`. Real agent gap: openclaw / hermes don't search-then-act, they guess calendar IDs.

## Identified judge bugs (4)

These are scenario/scorer issues, not agent issues. They produce false negatives.

1. **Granular vs umbrella action naming** — scenarios encode the canonical action as `CALENDAR(subaction=...)` but PRD-named action variants `CALENDAR_CHECK_AVAILABILITY`, `CALENDAR_NEXT_EVENT`, etc. are equally correct for elizaOS-style agents. The scorer's exact-name match falsely fails openclaw on `calendar.check_availability_thursday_morning`, `calendar.search_pitch_meetings_this_quarter`, `calendar.propose_meeting_with_alex`, `calendar.propose_coffee_chat`. **Fix path:** map granular CALENDAR_* names to `CALENDAR(subaction=…)` in scorer pre-processing, OR record both forms as valid ground truth.

2. **`intent` kwarg required for every match** — `_kwargs_match` requires every key in `expected` to be in `predicted`. GT scenarios include `intent: "what is the next upcoming event on my calendars"` as a sibling of `subaction`. No agent emits a free-form `intent` string. Hardcoded 0.8 ceiling on every read-only scenario. **Fix path:** mark `intent` as soft / non-load-bearing in `_kwargs_match`, or drop it from ground truth.

3. **Action-triviality guard double-penalizes openclaw read-only scenarios** — when openclaw correctly identifies the read-only intent, calls a granular tool, and the world state ends up correct (state_hash=True), the scorer zeros out **everything** because action.name doesn't match. The triviality guard is the right idea (prevents WrongAgent free credit) but interacts badly with granular naming. **Fix path:** loosen the guard's name-match to include the granular forms.

4. **`smoke_static_calendar_01` requires text "scheduled, deep work"** in the response — this is the only scenario with `required_outputs` for the calendar slice. It's correctly behaving as designed (substring credit), but combined with both agents' BLOCK/CALENDAR_BLOCK confusion, every agent gets 0.0 substring × 0.4 wrong-action = always 0. Not a bug per se but a noisy first-scenario indicator.

## Cross-agent diffs

Scenarios where exactly one agent reached score ≥ 0.70:

| scenario                                          | only top-scorer | hermes | openclaw |
|---------------------------------------------------|-----------------|-------:|---------:|
| `calendar.find_free_60min_this_week`              | openclaw (0.70) | ERR    |     0.70 |
| `calendar.search_pitch_meetings_this_quarter`     | hermes (0.80)   | 0.80   |     0.00 |
| `calendar.propose_meeting_with_alex`              | hermes (0.80)   | 0.80   |     0.00 |
| `calendar.propose_coffee_chat`                    | hermes (0.80)   | 0.80   |     0.00 |

- hermes wins three because openclaw used granular `CALENDAR_*` actions and got false-zero from judge bug #1.
- openclaw wins one because hermes errored on Cerebras 429.

**Strong-signal scenarios (all agents ≥ 0.70):** none. This is the headline gap — there isn't a single calendar scenario in this slice where all three agents pass cleanly.

## Real action gaps (consistently fails all 3 agents)

`smoke_static_calendar_01` — every agent including the production runtime gets 0.0. The scenario asks for a "30-minute focus block tomorrow at 10am UTC called 'deep work'". Hermes/openclaw both default to `BLOCK` or `BLOCK_BLOCK` action names. The action contract is: there is no `BLOCK` action — focus blocks are `CALENDAR(subaction=create_event, ...)` with the title `"deep work"`. **W3 follow-up:** either add a real `BLOCK` simile / wrapper that delegates to `CALENDAR.create_event`, or rewrite the scenario instruction to nudge toward `CALENDAR`.

`calendar.delete_lunch_sarah_family` / `calendar.cancel_*` / `calendar.reschedule_*` — every agent attempts the write but the backend rejects with `missing required field 'eventId' in kwargs=[]`. The agents don't search for the event first to get its ID — they hallucinate `eventId` or omit it. **W3 follow-up:** prompt-side guidance for "search-then-act" sequencing, or scenarios that pre-seed an event ID into context.

## Rate-limit incident

Cerebras returned 429 `queue_exceeded` on 3 calls during the hermes run. At concurrency=4 the python bench can spike to 8+ requests/sec, which exceeds the free-tier burst quota. 3/25 hermes scenarios errored. **Mitigation for future runs:** add `--concurrency 2` flag to the orchestrator, or add a retry-with-backoff in `hermes_adapter/lifeops_bench.py:_agent_fn`. No fake results were emitted — the harness honestly reported `error=True, total_score=0`.

## NEEDS_REVIEW scenarios

None. Every scenario received a deterministic score from the scorer. There's no judge call in STATIC mode — scores come from `state_hash_match` + `compare_actions` + `output_substring_match`, all of which are deterministic functions of the recorded turns and ground truth.

## Saved-best symlinks

```
lifeops-multiagent-best → lifeops-multiagent-1778523395565
```

Created at `/Users/shawwalters/.eliza/runs/lifeops/`.

Historical baselines preserved (per mission rules):
- `lifeops-eliza-baseline-1778515576`
- `lifeops-hermes-baseline-1778514429`
- `lifeops-openclaw-baseline-1778514437`
- `lifeops-cerebras-multi-1778378803`
- (and all anthropic / cerebras / opt* runs)

## Wave-3 follow-ups (prioritized)

1. **[P0] Scorer name-aliasing layer.** Map `CALENDAR_*` granular action names to `CALENDAR(subaction=*)` umbrella form (and `MESSAGE_*` → `MESSAGE(operation=*)`, etc.) before `compare_actions` runs. Without this, granular-action agents (the canonical elizaOS pattern) get false zeros on every read-only scenario. Impact: would flip 4 openclaw zeros to 0.7-0.8 immediately.
2. **[P0] Mark `intent` as soft in `_kwargs_match`.** The free-form `intent` string is documentation, not behavior. Currently it caps every partial pass at 0.80. Removing it (or treating it as soft) would let real passes break the 0.99 threshold. Impact: 9 hermes scenarios and 7 openclaw scenarios would move from 0.80 to 1.00.
3. **[P0] Fix eliza bench-server LLM endpoint.** The OpenAI plugin path calls a Cerebras endpoint that returns 404, so eliza runs zero everywhere. Either pin to `/v1/chat/completions` (instead of Responses API), or add `@elizaos/plugin-cerebras` to the bench server's plugin chain so Cerebras gets first-class routing.
4. **[P1] Concurrency / backoff for Cerebras.** Default `--concurrency 4` → 429s. Either lower default to 2, or add exponential-backoff retry in the adapters. The python bench has retry but the in-process hermes adapter (`hermes_adapter/lifeops_bench.py`) wraps `client.send_message` once and re-raises.
5. **[P1] Fix `BLOCK` simile.** Every agent confuses "focus block" with a `BLOCK` action. Either add `BLOCK` as a CALENDAR simile or rewrite the smoke scenario's prompt.
6. **[P1] Search-then-act pattern in prompts.** Every cancel/reschedule/delete scenario fails because agents skip the search step. Adding a one-liner to system prompts ("when modifying an existing event, search for it first to get the eventId") would unlock most write-mode scenarios.
7. **[P2] Run other domains.** Calendar slice is 25/25; the suite has 100+ scenarios across mail, reminders, contacts, finance, travel, health. Need full-corpus runs to compare per-domain strengths (W1-3 saw very different per-domain numbers — hermes peaked on mail at 0.494; calendar is harder).
8. **[P2] Plumb hermes usage data.** The hermes adapter's in-process bridge currently surfaces `total_cost_usd` (we got $0.0771), so this is partially fixed since W1-3. Still missing: per-turn `cost_usd` and `latency_ms` in `MessageTurn` for granular debugging.

## Verification commands run

```bash
bun run lifeops:verify-cerebras                  # OK — both eval and train Cerebras reachable
ELIZA_BENCH_LIMIT=25 ELIZA_BENCH_SKIP_JS=1 \
LIFEOPS_USE_MOCKOON=1 \
OPENAI_BASE_URL=https://api.cerebras.ai/v1 \
ELIZA_PROVIDER=cerebras \
BENCHMARK_MODEL_PROVIDER=cerebras BENCHMARK_MODEL_NAME=gpt-oss-120b \
bun run lifeops:full                              # full run, status=0
```

## Personality bench (Phase 2)

Ran 10 scenarios × 3 agents (30 total) on the W3-2 personality corpus, judged
by the W3-3 layer.

- **Run dir:** `/Users/shawwalters/.eliza/runs/personality/personality-multiagent-1778523895524`
- **Best symlink:** `/Users/shawwalters/.eliza/runs/personality/personality-multiagent-best`

| agent    | scenarios | PASS | FAIL | NEEDS_REVIEW | %Pass | cost     | wall   |
|----------|----------:|-----:|-----:|-------------:|------:|---------:|-------:|
| eliza    |        10 |    8 |    2 |            0 | 80.0% | $0.0222  | 59.4s  |
| hermes   |        10 |    5 |    4 |            1 | 50.0% | $0.0146  | 31.6s  |
| openclaw |        10 |    8 |    2 |            0 | 80.0% | $0.0198  | 36.7s  |

### Per-bucket × agent

| bucket                | eliza | hermes | openclaw |
|-----------------------|------:|-------:|---------:|
| shut_up               | 2/2   | 0/2    | 2/2      |
| hold_style            | 1/2   | 1/2    | 1/2      |
| note_trait_unrelated  | 2/2   | 1/2    | 2/2      |
| escalation            | 1/2   | 1/2    | 1/2      |
| scope_global_vs_user  | 2/2   | 2/2    | 2/2      |

### Cross-agent diffs (personality)

- Scenarios where exactly one agent passed: **none**.
- Scenarios where all agents failed (real capability gap):
  - `hold_style.aggressive.code.004` — judge: "not terse: 307 > 16 tokens" (every agent over-explains under aggressive instruction).
  - `escalation.aggressive.code.004` — judge: "escalation went the wrong way: 1.75 → 0.00" (every agent reverses escalation).

### Personality NEEDS_REVIEW

- `note_trait_unrelated.aggressive.allcaps.019` (hermes) — judge weight 0.00, inconclusive.

### Personality headline

- **`shut_up` bucket is the biggest hermes weakness** (0/2 vs 2/2 for eliza/openclaw). Hermes' system prompt encourages verbose responses, which directly conflicts with terse-on-demand scenarios.
- Eliza and openclaw tie at 80% — the elizaOS pure-LLM path (no tools) handles personality well.
- **Two real capability gaps** are model-level, not agent-level: every agent fails the "aggressive + code + terse" combination on hold_style and escalation. Possible Cerebras gpt-oss-120b limitation on instruction-following under aggressive register.
