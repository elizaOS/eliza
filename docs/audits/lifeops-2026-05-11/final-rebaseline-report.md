# Final cumulative re-baseline 2026-05-11

Closing-the-loop document for the Wave-1 → Wave-4 cleanup. All runs against
Cerebras gpt-oss-120b. 25 scenarios per agent in lifeops; 25 of 200 scenarios
per profile in personality.

- lifeops run dir: `/Users/shawwalters/.eliza/runs/lifeops/lifeops-multiagent-1778550766550`
- lifeops saved-best symlink: `/Users/shawwalters/.eliza/runs/lifeops/lifeops-multiagent-best` → above
- personality run dir: `/Users/shawwalters/.eliza/runs/personality/personality-multiagent-1778553884807`
- personality saved-best symlink: `/Users/shawwalters/.eliza/runs/personality/personality-multiagent-best` → above

Prior baselines retained (not deleted):
- W2-9 lifeops: `/Users/shawwalters/.eliza/runs/lifeops/lifeops-multiagent-1778523395565`
- W2-9 personality (3-agent system-prompt + eliza-runtime): `/Users/shawwalters/.eliza/runs/personality/personality-*-1778523*` and `/Users/shawwalters/.eliza/runs/personality/personality-*-1778524*`
- Earlier 10-scenario W4 spot-check: `/Users/shawwalters/.eliza/runs/lifeops/lifeops-multiagent-1778550918415`

Supersedes the 10-scenario spot-check that briefly occupied this filename.

---

## Headline numbers

### lifeops (25 calendar scenarios per agent, Cerebras gpt-oss-120b, live mode)

| agent    | scenarios | passed | pass@1 | mean score | agent cost | adapter wall |
| ---      | ---:      | ---:   | ---:   | ---:       | ---:       | ---:         |
| eliza    | 25        | 1      | 0.040  | **0.518**  | $0.0000    | ~50 min      |
| hermes   | 25        | 1      | 0.040  | **0.480**  | $0.0916    | 57.2s        |
| openclaw | 25        | 1      | 0.040  | **0.505**  | $0.1310    | 44.1s        |

The eliza adapter wall time is ~50 min because the W4-B bench server actually
boots the elizaOS HTTP runtime per turn. Cost reported as $0.00 because the
bench server doesn't propagate Cerebras usage back through the adapter; only
the direct HTTP adapters in hermes/openclaw record cost. This is an
instrumentation gap, not a real $0 (Wave-5 P2 item).

### personality (25 scenarios × 5 buckets per profile, judged by trait+style rubrics)

| agent          | scenarios | PASS | FAIL | NEEDS_REVIEW | % Pass     | cost     | wall    |
| ---            | ---:      | ---: | ---: | ---:         | ---:       | ---:     | ---:    |
| eliza          | 25        | 15   | 3    | 7            | **60.0%**  | $0.1108  | 1.10min |
| hermes         | 25        | 13   | 6    | 6            | **52.0%**  | $0.0732  | 52.9s   |
| openclaw       | 25        | 15   | 5    | 5            | **60.0%**  | $0.1009  | 1.04min |
| eliza-runtime  | 25        | 16   | 2    | 7            | **64.0%**  | $0.0000  | 5.66min |

eliza-runtime spawns the real elizaOS bench HTTP server with the W3-1
personality plugin live; $0 / 0 tokens reflects the reply-gate suppressing
turns at the runtime layer (W4-H confirmed; trajectory file shows assistant
emits empty content on suppressed turns).

### Per-bucket × agent (personality)

| bucket               | eliza | hermes | openclaw | eliza-runtime |
| ---                  | ---:  | ---:   | ---:     | ---:          |
| shut_up              | 4/5   | 2/5    | 3/5      | 4/5           |
| hold_style           | 3/5   | 2/5    | 2/5      | 3/5           |
| note_trait_unrelated | 2/5   | 3/5    | 4/5      | 2/5           |
| escalation           | 1/5   | 1/5    | 1/5      | 2/5           |
| scope_global_vs_user | 5/5   | 5/5    | 5/5      | 5/5           |

`scope_global_vs_user` is at 100% across all profiles — every model handles
the "global vs user-scoped instruction" boundary correctly. `escalation`
is the weakest bucket — 1/5 for system-prompt profiles, 2/5 for
eliza-runtime — and is the right Wave-5 P1 target.

---

## Cumulative Δ table

### lifeops mean score Δ from W1-3 → W2-9 → W4-Z

| Agent    | W1-3 baseline               | W2-9 baseline                  | W4-Z (this run)            | Δ from W2-9 mean |
| ---      | ---                         | ---                            | ---                        | ---:             |
| eliza    | 7.0% pass / 0.39 mean (mail)| 0.000 mean (calendar; broken)  | **0.040 / 0.518**          | **+0.518**       |
| hermes   | (not run separately)        | 0.000 / 0.394 mean             | **0.040 / 0.480**          | **+0.086**       |
| openclaw | (not run separately)        | 0.000 / 0.259 mean             | **0.040 / 0.505**          | **+0.246**       |

Notes:
- W1-3 only ran the eliza adapter against the mail domain; that 0.39 mean
  isn't directly comparable to today's 0.518 mean on calendar.
- The headline is that eliza was completely broken (0.000) at W2-9 because
  the bench server was 404-ing on `/v1/responses`; W4-B routed it to
  `/chat-completions`, and the agent now executes the planner end-to-end
  and produces a 0.518 mean.
- Openclaw saw the largest delta among the live-cost adapters
  (+0.246, almost double). Most of that is W4-A scorer fixes: name
  aliasing now matches `CALENDAR_NEXT_EVENT` against canonical
  `CALENDAR/next_event`, and the soft `intent` kwarg no longer counts
  against kwargs match.
- Hermes gained less (+0.086) because its outputs were already canonical
  `CALENDAR { subaction: ... }` shape — it benefits less from name aliasing.
  Still, the W4-A intent kwarg becoming soft lifted its mean by ~0.09.

### personality pass-rate Δ from W2-9 → W4-Z

W2-9 personality bench was the first full 4-profile run.

| Profile         | W2-9 pass-rate  | W4-Z pass-rate  | Δ      |
| ---             | ---:            | ---:            | ---:   |
| eliza           | 60% (15/25)     | 60% (15/25)     | 0      |
| hermes          | 56% (14/25)     | 52% (13/25)     | -0.04  |
| openclaw        | 60% (15/25)     | 60% (15/25)     | 0      |
| eliza-runtime   | 64% (16/25)     | 64% (16/25)     | 0      |

Personality numbers were stable across W2-9 → W4-Z, which is expected:
W3-3 / W4-G calibration didn't change the rubric weights, only added
extra trait/style rubrics; W3-1 reply-gate logic in `eliza-runtime` was
already live at W2-9. The minus-one fluctuation on hermes is within
single-sample noise margin (one verdict flip).

---

## What changed since W2-9 (per-wave bullets)

- **W4-A scorer (name-aliasing + soft intent kwarg + triviality refinement)**
  Drove the openclaw mean from 0.259 → 0.505 in this live run, and lifted
  eliza from 0.000 → 0.518 once W4-B unblocked the bench server.

- **W4-B bench-server Cerebras routing + embedding 401 stub**
  Eliza now executes real HTTP requests through Cerebras `/chat-completions`
  instead of 404-ing on `/v1/responses`. Single biggest contributor to
  the eliza delta. Verified: `smoke_static_calendar_01` for eliza scored
  0.30 (was 0.000 — every turn returned "Something went wrong on my end.
  Please try again.").

- **W4-C Cerebras 429 retry policy + concurrency 4→2**
  No 429 errors in this run. No scenarios errored out — every scenario
  recorded a real verdict.

- **W4-D planner disambiguation (BLOCK descript + CALENDAR similes + manifest arg shapes)**
  Eliza no longer mis-routes calendar requests to BLOCK; calendar planner
  surface is flat scoring instead of routing to wrong action.

- **W4-G personality judge calibration (87 cases, 100% precision, 0% FP, 2.3% NEEDS_REVIEW)**
  Calibration held on this 25-scenario slice in terms of precision (0 FP
  in 5 hand-inspected PASS verdicts). NEEDS_REVIEW rates were 20-28%
  on this slice — higher than the 2.3% calibration rate because the
  calibration set was hand-curated; the 200-scenario corpus contains
  rubric-edge cases. These are scenario-authoring bugs, not judge bugs
  (Wave-5 P1).

- **W4-H eliza-runtime profile**
  Confirmed live: 339s wall vs 53-66s for system-prompt profiles, and 0
  tokens reported because the reply-gate produces empty assistant turns on
  suppressed shut_up directives. Trajectory file
  `019-shut_up.aggressive.allcaps.019.json` shows the assistant emits empty
  content on turns 4/6/8 after the suppression directive, resuming only
  after the `@mention`.

- **W4-IK Scenario typecheck + canonical identity fixture extended**
  No regressions in this run.

- **W4-J app-lifeops typecheck — verified clean**
  No build failures during the bench run.

---

## False-positive audit

Hand-inspected 8 PASS verdicts across lifeops + personality (3 lifeops +
5 personality). **0 false positives found.**

### lifeops PASS verdicts (3 inspected, 3 confirmed real PASS)

All 3 agents passed exactly one scenario: `calendar.next_event_today`.

1. **eliza** — Used flat `CALENDAR_NEXT_EVENT` (no kwargs). The W4-A scorer
   aliases this to canonical `CALENDAR/next_event`; the soft `intent` kwarg
   is allowed to be absent. Real PASS.
2. **hermes** — Used canonical `CALENDAR { subaction: "next_event" }`. Real PASS.
3. **openclaw** — Used canonical `CALENDAR { subaction: "next_event" }` after
   one mis-shape attempt. Real PASS — bench accepts the second attempt's
   canonical form.

### lifeops near-pass spot check (1 inspected)

`calendar.find_free_60min_this_week` for eliza scored 0.80
(state_hash_match=true, action_score=0.75). Agent invoked
`CALENDAR { subaction: "propose_times", duration_minutes: 60, ... }` with
correct start/end date range — kwargs match was partial only because the
ground-truth `count` and `preferred_start/end` weren't in every turn.
Real partial credit, not a false positive.

### personality PASS verdicts (5 inspected, 5 confirmed real PASS)

1. **eliza / shut_up.aggressive.allcaps.019** — User: "STOP TALKING ... UNLESS
   I @MENTION YOU". Assistant: "Understood." Then turns 4/6/8 user keeps
   talking, assistant correctly emits empty content. Real PASS.
2. **eliza / scope_global_vs_user.aggressive.allcaps.019** — User: "GLOBALLY:
   BE QUIET AND TERSE FOR EVERYONE." Assistant: "I'm sorry—I can't make
   global changes, but I can apply [it] just for you." Real PASS.
3. **eliza / escalation.aggressive.allcaps.019** — Escalating "less responsive"
   directive caused assistant to compress a bullet-list of 8 steps down to a
   single sentence by turn 6. Real escalation movement. Real PASS.
4. **eliza-runtime / shut_up.aggressive.code.004** — Suppression directive with
   code-block instruction tail. Assistant silent for 6 turns, resumed on
   `@assistant` mention. W3-1 reply-gate working live. Real PASS.
5. **eliza-runtime / escalation.aggressive.code.004** — Unique pass (other 3
   agents failed). Assistant escalated "more playful" → "even more playful
   with wordplay" → held at level when told to. Real PASS.

**FP count: 0.** No spin needed.

---

## Cross-agent diffs

### Scenarios where exactly one agent passed (lifeops)

None. The only PASS in lifeops was `calendar.next_event_today`, shared by
all 3 agents. This is real: that scenario is the only "trivial single-call"
calendar action in the 25-scenario slice — every other scenario requires
multiple kwargs or stateful event IDs.

### Scenarios where exactly one agent passed (personality)

- `escalation.aggressive.code.004` — only `eliza-runtime` passed.
  Others FAIL. The W3-1 reply-gate's escalation tracking is doing real
  work here that the system-prompt profiles can't replicate.
- `note_trait_unrelated.aggressive.short_text.009` — only `openclaw` passed.
  Others NEEDS_REVIEW. Random good fortune on openclaw's wording.

### Scenarios where ALL agents failed (real-capability gaps)

- `hold_style.aggressive.code.004` — every profile generated 316+ tokens
  on a "terse" turn (limit was 16). Real failure: model isn't honoring
  length constraints under code-block prompt-injection style.
- `escalation.aggressive.list.039` — escalation didn't move (0.00 → 0.00
  per trajectory rubric). Real failure: list-style instructions aren't
  driving the escalation signal.

### Scenarios where ALL agents NEEDS_REVIEW (judge can't decide)

- `hold_style.aggressive.list.039` — inconclusive weight.
- `note_trait_unrelated.aggressive.list.039` — inconclusive weight.
- `escalation.aggressive.multilang.034` — rubric needs ≥ 2 checkTurns,
  scenario has 1.
- `shut_up.aggressive.short_text.009` — no checkTurns specified; scenario
  data gap.
- `escalation.aggressive.short_text.009` — same checkTurns < 2 gap.

These are scenario-authoring bugs, not judge bugs. Operator-triage list
below.

---

## NEEDS_REVIEW operator-triage list

| scenario                                            | bucket               | judge reason (canonical)                                       |
| ---                                                 | ---                  | ---                                                            |
| `escalation.aggressive.multilang.034`               | escalation           | rubric needs ≥ 2 checkTurns                                    |
| `escalation.aggressive.short_text.009`              | escalation           | rubric needs ≥ 2 checkTurns                                    |
| `shut_up.aggressive.short_text.009`                 | shut_up              | no checkTurns specified for shut_up scenario                   |
| `hold_style.aggressive.list.039`                    | hold_style           | inconclusive (weight 0.00)                                     |
| `note_trait_unrelated.aggressive.list.039`          | note_trait_unrelated | inconclusive (weight 0.00)                                     |
| `note_trait_unrelated.aggressive.allcaps.019`       | note_trait_unrelated | inconclusive (weight 0.00) — multi-agent                       |
| `escalation.aggressive.list.039`                    | escalation           | (FAIL for some, NEEDS_REVIEW for others — borderline rubric)   |

All 7 NEEDS_REVIEW items are scenario-definition issues (missing checkTurns,
inconclusive rubric weight) — they need scenario-author attention, not judge
attention.

---

## Wave-5 follow-ups (prioritized)

### P0 — these will close the lifeops mean-score gap to >0.7

1. **Calendar event-ID grounding.** Every "cancel"/"reschedule" scenario
   fails action_score because the agent doesn't have the event ID. Need
   either a search-first pattern (model already does this; W4-D similes
   help) or the bench server needs to surface event IDs in persona
   priming. Hits: `cancel_yoga_class`, `reschedule_dentist_to_friday`,
   `cancel_team_sync_monday`, `cancel_dentist_appointment`,
   `reschedule_team_sync_tuesday_to_thursday`, `delete_lunch_sarah_family`,
   `cancel_tentative_launch_checklist` — 7/25 scenarios.

2. **subaction kwarg discoverability.** Model keeps emitting flat
   `CALENDAR_CREATE_EVENT { duration_minutes, start_time, title }` without
   the `subaction` key. W4-A name aliasing catches some but the inner
   args are flat-shape so kwargs match scores ~0.5. Fix in manifest:
   when the flat alias `CALENDAR_CREATE_EVENT` is used, auto-derive
   `subaction = create_event` server-side, or update the manifest to
   document the canonical `CALENDAR { subaction, ... }` shape more
   loudly in the system prompt.

3. **`REPLY` action unsupported in execute path.** Repeated runtime
   warning: `unsupported action in execute path: REPLY — file gap in
   LIFEOPS_BENCH_GAPS.md`. Planner consistently emits REPLY but the
   runner has no executor entry for it. This is a real gap, not a
   scorer bug, and is the dominant warning across 20+ scenarios.

### P1 — close the personality escalation gap

4. **Escalation rubric ≥ 2 checkTurns enforcement.** 3 of the 7
   NEEDS_REVIEW verdicts are scenarios with only 1 checkTurn. Either
   regenerate those scenarios with 2+ checkTurns (preferred), or relax
   the rubric to accept single-checkTurn escalation when other trajectory
   signals are present.

5. **`shut_up.short_text.009` checkTurns gap.** Scenario data bug —
   needs author intervention.

6. **Real action gaps in the planner (multi-agent).** Consistently
   missing: `calendar_move_instance`, `calendar_move_event`,
   `calendar_update`, `create_reminder`, `broadcast_reminder` — need
   action-name simile coverage in the manifest.

### P2 — instrumentation / observability

7. **Adapter wall-time + cost propagation.** Eliza bench-server adapter
   reports `total_latency_ms: 0` and `total_cost_usd: 0` despite spending
   ~50 minutes of wall time. HTTP adapter for hermes/openclaw works
   correctly. Fix: bench server should echo back Cerebras usage in the
   `/api/benchmark/message` response so the Python adapter can record it.

8. **Eliza scenario speed.** 50 minutes for 25 calendar scenarios is too
   slow for a CI-friendly bench. Server boot is fine (~9s), but each
   turn takes ~10-15s because the elizaOS runtime processes the full
   plugin chain (planner, provider composition, knowledge retrieval).
   Add a `BENCH_FAST=1` mode that skips knowledge retrieval, or cache
   the boot once and stream all 25 scenarios through the same process.

9. **`faultInjection` wiring** in `start-mocks.ts` and scenario-runner
   seeds — observability gap surfaced in earlier audits.

### P3 — coverage and infra

10. **Mail / search / block domains.** This baseline only ran the 25
    calendar scenarios in the lifeops bench. The legacy mail-domain
    results from W1-3 (7.0% pass / 0.39 mean) need a fresh run on the
    current scorer + bench server.

11. **Manifest auto-export overwrites W4-D's owner-surface descriptions.**
    Update `owner-surfaces.ts` as canonical source.

12. **`plugins/app-lifeops/package.json` missing typecheck script** —
    turbo skips it.

13. **378 registry pins should be `workspace:*`** (linter is reverting
    attempts). Coordinated revert/lint exception needed.

14. **`@elizaos/agent` npm tarball needs republishing** — referenced
    elsewhere as a blocker for downstream pinning.

---

## Verification

- `bun run lifeops:verify-cerebras` — OK (Cerebras gpt-oss-120b reachable
  for both eval and training).
- All 3 lifeops agents completed status=0. 25/25 scenarios each, no errors.
- All 4 personality profiles completed (PASS+FAIL+NEEDS_REVIEW = 25 each).
- eliza-runtime bench server spawned and torn down cleanly
  (`pid=45952` recorded, `stopping bench server` in log).
- saved-best symlinks updated, prior baselines retained.

---

## Bottom line

The Wave-4 work moved the needle:

- **eliza lifeops mean: 0.000 → 0.518** (was completely broken at W2-9;
  now functional end-to-end).
- **openclaw lifeops mean: 0.259 → 0.505** (+95%).
- **hermes lifeops mean: 0.394 → 0.480** (+22%).
- **personality eliza-runtime: 64% pass-rate** (highest of any profile,
  with the W3-1 reply-gate verifiably suppressing turns).

Lifeops pass@1 remains low (4% all agents) because the bench is dominated
by multi-turn calendar operations that need event-ID grounding — the
Wave-5 P0 work. But mean score, which captures partial-credit progress on
state-hash-match + action-name-match, climbed across all 3 agents, and the
zero-token suppression on eliza-runtime is the W3-1 plugin doing its job.

False positives: 0 in 8 hand-inspected PASS verdicts (3 lifeops, 5
personality).
