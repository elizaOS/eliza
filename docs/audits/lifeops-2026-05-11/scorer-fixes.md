# Scorer fixes (W4-A, 2026-05-11)

Three scorer bugs identified by W2-9's re-baseline (`rebaseline-report.md`,
"Identified judge bugs (4)") caused false negatives for granular-action
agents. All three are fixed in
`packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scorer.py`.

## Summary

| Agent    | mean before | mean after | Δ      | pass@1 before | pass@1 after | scenarios moved |
|----------|------------:|-----------:|-------:|--------------:|-------------:|----------------:|
| eliza    |      0.0000 |     0.0000 | +0.000 |         0.000 |        0.000 |               0 |
| hermes   |      0.3940 |     0.4020 | +0.008 |         0.000 |        0.040 |               1 |
| openclaw |      0.2587 |     0.4967 | +0.238 |         0.000 |        0.040 |              14 |

openclaw — the granular-action agent — gains **+23.8 percentage points**
on mean score. Hermes (umbrella-action agent) sees only the single
`intent`-only scenario flip. Eliza is unchanged because every eliza
scenario already scored 0 due to the upstream bench-server LLM endpoint
issue (not a scorer problem; see `rebaseline-report.md`).

No false positives were introduced. Verified two ways:

1. PerfectAgent/WrongAgent conformance suite (1064 parameterized tests across
   the full registry) still passes — PerfectAgent scores 1.0, WrongAgent
   scores 0.0 on every supported scenario.
2. Re-scored every saved trajectory: zero scenarios with `state_hash_match=False`
   reach ≥ 0.99, zero scenarios with `error=True` or
   `terminated_reason in {error,timeout,cost_exceeded}` see a score lift.

## Bug 1: Granular vs umbrella action-name mismatch

### Root cause

The manifest exporter promotes `CALENDAR(subaction=check_availability)`
into a top-level action name `CALENDAR_CHECK_AVAILABILITY`. The bench
executor accepts both forms (see `runner._UMBRELLA_HANDLERS`), but
`compare_actions` did string-equality on `action.name`. When the agent
emitted `CALENDAR_CHECK_AVAILABILITY` and the scenario's GT used
`CALENDAR(subaction=check_availability, ...)`, the names didn't match,
`compare_actions` returned 0.0, and the STATIC-mode triviality guard
zeroed the entire score even though `state_hash_match=True`.

### Fix

Added `_canonicalize_action(action: Action) -> Action` that folds
`<UMBRELLA>_<SUBACTION>` (uppercased) names into umbrella form, copying
the discriminator into kwargs:

```python
_UMBRELLA_SUBACTIONS: dict[str, tuple[str, frozenset[str]]] = {
    "CALENDAR": ("subaction", frozenset({
        "create_event", "update_event", "delete_event",
        "propose_times", "search_events", "check_availability",
        "next_event", "update_preferences",
    })),
    "MESSAGE": ("operation", frozenset({
        "send", "draft_reply", "manage", "triage",
        "search_inbox", "list_channels", "read_channel",
        "read_with_contact",
    })),
}


def _canonicalize_action(action: Action) -> Action:
    name = action.name
    for umbrella, (field, subactions) in _UMBRELLA_SUBACTIONS.items():
        prefix = f"{umbrella}_"
        if not name.startswith(prefix):
            continue
        candidate = name[len(prefix):].lower()
        if candidate not in subactions:
            continue
        new_kwargs = dict(action.kwargs)
        new_kwargs.setdefault(field, candidate)
        return Action(name=umbrella, kwargs=new_kwargs)
    return action
```

`compare_actions` canonicalizes both predicted and ground-truth before
matching:

```python
canon_predicted = [_canonicalize_action(p) for p in predicted]
canon_truth = [_canonicalize_action(g) for g in ground_truth]
```

The `_UMBRELLA_SUBACTIONS` table is the same set declared by
`runner._DISCRIMINATORS` and the promoted `CALENDAR_*` entries in
`runner._UMBRELLA_HANDLERS`. Keep them in lockstep when extending.

### Impact

openclaw flips on 4 read-only granular scenarios:

- `calendar.check_availability_thursday_morning` 0.0 → 0.8
- `calendar.search_pitch_meetings_this_quarter` 0.0 → 0.8
- `calendar.propose_meeting_with_alex` 0.0 → 0.8
- `calendar.propose_coffee_chat` 0.0 → 0.8

Plus 10 write-scenario partial credits (0.0 → 0.2-0.3) where openclaw
emitted a structurally correct CALENDAR_* action but the world state
didn't match (real agent gap — partial credit was already deserved).

## Bug 2: `intent` kwarg required everywhere

### Root cause

Many GT scenarios encode `intent: "<free-form prose>"` as a sibling of
`subaction` (e.g. `intent: "what is the next upcoming event on my
calendars"`). The original `_kwargs_match` required every expected key
to be present on predicted, including `intent`. No agent reliably emits
a verbatim free-form intent string, so every read-only scenario capped
at 0.5*1.0 + 0.4*0.5 + 0.1*1.0 = **0.80** even when the agent was
structurally correct.

### Fix

Introduced a `_SOFT_KWARGS` set of documentation-only fields whose
absence on predicted no longer breaks the match. When the agent DOES
emit a soft kwarg, the value still has to be equivalent (to avoid
silently accepting a contradicting `intent`).

```python
_SOFT_KWARGS: frozenset[str] = frozenset(
    {"intent", "rationale", "thought", "reasoning"}
)


def _kwargs_match(predicted: dict[str, Any], expected: dict[str, Any]) -> bool:
    for key, exp_value in expected.items():
        if key not in predicted:
            if key in _SOFT_KWARGS:
                continue
            return False
        if not _values_equivalent(predicted[key], exp_value):
            return False
    return True
```

### Impact

One scenario — `calendar.next_event_today` — where the ONLY GT/agent
diff was `intent`. The scenario flips from 0.8 → 1.0 for both hermes
and openclaw, contributing both `pass@1` gains in the table above.

Most other hermes 0.8s do NOT flip because they have additional
parameter-naming gaps (e.g. agent emits `start`/`end`, GT requires
`startAt`/`endAt`/`durationMinutes`/`slotCount`). Those remain at 0.8
correctly — that's a real agent gap (W4-D's planner-disambiguation
scope), not a scorer artifact.

## Bug 3: Triviality guard double-penalizes granular-action agents

### Root cause

The triviality guard in `score_scenario` zeroed `state_component` and
`substring_component` whenever `action_component == 0.0` and the
scenario had ground-truth actions. With Bug 1 unfixed, granular-action
agents got `action_component=0.0` even on correct work, which triggered
the guard and zeroed everything.

### Fix

With Bug 1's canonicalization layer in place, a structurally-correct
granular action now produces `action_component >= 0.5`, so the guard
no longer fires on those cases. The guard still correctly fires for:

- Do-nothing agents (no agent_actions at all on read-only scenarios).
- Wrong-action agents (emitted `MAIL.send` for a CALENDAR scenario).

This is verified by the negative-control tests
`test_score_scenario_triviality_guard_still_zeros_wrong_action` and
`test_score_scenario_triviality_guard_still_zeros_no_action`.

A clarifying comment was added to the guard explaining the carve-out:

```python
# Carve-out: if the agent emitted at least one structurally correct
# action (name canonicalizes to a GT name), it isn't trivial — the
# agent did real work. The triviality guard is reserved for the
# "no action OR wrong action" case.
```

## Files modified

- `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scorer.py`
  - Added `_SOFT_KWARGS`, `_UMBRELLA_SUBACTIONS`, `_canonicalize_action`.
  - Updated `_kwargs_match` for soft kwargs.
  - Updated `compare_actions` to canonicalize both sides.
  - Updated triviality-guard comment in `score_scenario`.

## Files added

- `packages/benchmarks/lifeops-bench/tests/test_scorer_fixes.py`
  - 13 unit tests covering the three bugs and negative controls.

## Verification

```bash
cd packages/benchmarks/lifeops-bench
python3 -m pytest tests/test_scorer_fixes.py -q          # 13 passed
python3 -m pytest tests/test_scaffold.py -q              # existing passed
python3 -m pytest tests/test_metrics_schema.py -q        # existing passed
python3 -m pytest tests/test_conformance.py -q           # 1064 passed (PerfectAgent=1.0, WrongAgent=0.0)
```

Re-score script (not committed; for reproducibility):
`/tmp/rescore_w4a.py` loads each saved JSON from
`~/.milady/runs/lifeops/lifeops-multiagent-best/{eliza,hermes,openclaw}/`,
rebuilds `ScenarioResult`s, and runs `score_scenario` against the live
scenarios registry.

## Per-scenario score moves (saved-run re-score)

```
hermes     calendar.next_event_today                         0.800 → 1.000  +0.200
openclaw   calendar.next_event_today                         0.800 → 1.000  +0.200
openclaw   calendar.check_availability_thursday_morning      0.000 → 0.800  +0.800
openclaw   calendar.propose_coffee_chat                      0.000 → 0.800  +0.800
openclaw   calendar.propose_meeting_with_alex                0.000 → 0.800  +0.800
openclaw   calendar.search_pitch_meetings_this_quarter       0.000 → 0.800  +0.800
openclaw   calendar.cancel_dentist_appointment               0.000 → 0.300  +0.300
openclaw   calendar.cancel_team_sync_monday                  0.000 → 0.300  +0.300
openclaw   calendar.cancel_tentative_launch_checklist        0.000 → 0.300  +0.300
openclaw   calendar.cancel_yoga_class                        0.000 → 0.250  +0.250
openclaw   calendar.create_meeting_john_next_monday          0.000 → 0.300  +0.300
openclaw   calendar.delete_lunch_sarah_family                0.000 → 0.200  +0.200
openclaw   calendar.reschedule_dentist_friday                0.000 → 0.300  +0.300
openclaw   calendar.reschedule_dentist_to_friday             0.000 → 0.300  +0.300
openclaw   calendar.reschedule_team_sync_tuesday_to_thursday 0.000 → 0.300  +0.300
```

## False-positive checks (all clean)

- Score went UP on errored/timeout/cost-exceeded trajectories: **0** cases.
- Score reached ≥ 0.99 with `state_hash_match=False`: **0** cases.
- Conformance suite (PerfectAgent=1.0, WrongAgent=0.0): **all pass** across
  the full registry.

## What this fix DOES NOT solve

These remain real agent / scenario gaps, in scope for other waves:

- The remaining hermes 0.8 ceilings (`propose_*`, `check_availability_*`,
  `search_*`) reflect a real parameter-naming gap: agent emits
  `start`/`end`/`start_date`/`end_date`, GT requires
  `startAt`/`endAt`/`windowStart`/`windowEnd`/`durationMinutes`. W4-D's
  planner-disambiguation work is the right place for that.
- eliza scoring 25 zeros remains the bench-server LLM-endpoint bug
  documented in `rebaseline-report.md` (eliza section). Not a scorer
  issue.
- The `BLOCK_*` action-name confusion on `smoke_static_calendar_01`
  remains — both hermes and openclaw infer `BLOCK`/`BLOCK_BLOCK` for
  "focus block" when the correct call is `CALENDAR(subaction=create_event)`.
  W3 follow-up.
