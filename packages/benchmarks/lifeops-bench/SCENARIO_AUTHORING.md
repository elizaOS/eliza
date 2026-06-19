# LifeOpsBench — Scenario Authoring Guide

How to add a new scenario to the corpus. The canonical Python-level
contract is in `eliza_lifeops_bench/types.py::Scenario`; this guide is
the operator-facing playbook for using it well.

## Table of contents

- [Static vs Live mode](#static-vs-live-mode)
- [Persona design](#persona-design)
- [Ground-truth actions: umbrella vs fine-grained](#ground-truth-actions-umbrella-vs-fine-grained)
- [First-question fallback](#first-question-fallback)
- [Live-mode extras: success_criteria, world_assertions, disruptions](#live-mode-extras-success_criteria-world_assertions-disruptions)
- [The candidate-generator workflow](#the-candidate-generator-workflow)
- [Validation](#validation)
- [The fallback-ratio rule](#the-fallback-ratio-rule)

## Static vs Live mode

| Choose STATIC when                                     | Choose LIVE when                                          |
| ------------------------------------------------------ | --------------------------------------------------------- |
| The task is fully specified by the instruction         | The task naturally needs back-and-forth (negotiation)     |
| You can predict ground-truth actions deterministically | The world should mutate mid-run (REALM-style disruptions) |
| You want cheap, fast, large-scale eval                 | You're testing satisfaction-of-intent, not just correctness |
| The fallback can answer the most likely clarifier      | Neither side can be canned without breaking realism       |

STATIC scenarios are cheap (no per-turn LLM calls on the user side
once the agent commits to a plan; one optional fallback turn). LIVE
scenarios are slower and more expensive — every agent turn triggers a
simulated-user turn, plus a judge call from the configured
`live_judge_min_turn` onward.

## Persona design

Personas live in `eliza_lifeops_bench/scenarios/_personas.py`. There
are 10 today; add a new one only if existing personas don't fit. Each
persona carries:

- `id` — snake_case lowercase, used for cross-references (`PERSONA_RIA_PM` → `ria_pm`).
- `name`, `traits`, `background` — surface in the simulated user prompt.
- `communication_style` — concrete: "terse, drops articles" beats "casual".
- `patience_turns` — when the simulated user gives up.

Pick the persona whose `communication_style` matches the instruction
text. A `PERSONA_OWEN_RETIREE` instruction that says "yo just kill
that meeting" is wrong — Owen says "Could you please cancel the 3pm
appointment". Match the register.

## Ground-truth actions: umbrella vs fine-grained

The runner's `_execute_action` dispatches two parallel vocabularies
(see `runner.py::_ACTION_HANDLERS` and
[`LIFEOPS_BENCH_GAPS.md`](./LIFEOPS_BENCH_GAPS.md) for the canonical
list):

### Umbrella (preferred for new scenarios)

Single name per domain with a discriminator inside `kwargs`:

```python
Action(name="CALENDAR", kwargs={"subaction": "create_event", "details": {...}})
Action(name="MESSAGE",  kwargs={"operation": "send", "source": "gmail", ...})
Action(name="ENTITY",   kwargs={"subaction": "add", "name": "...", ...})
Action(name="LIFE_CREATE", kwargs={"subaction": "create", "details": {"kind": "reminder", ...}})
```

Discriminator field is `subaction` for most umbrellas; **`MESSAGE`
uses `operation`** because that matches the Eliza message handler.

Supported (action, subaction) pairs at time of writing:

| Umbrella               | Subactions / operations                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `CALENDAR`             | `create_event`, `update_event`, `delete_event`, `propose_times`, `search_events`, `check_availability`, `next_event`, `update_preferences` |
| `MESSAGE`              | `send`, `draft_reply`, `manage`, `triage`, `search_inbox`, `list_channels`, `read_channel`, `read_with_contact` (with `source` discriminator) |
| `ENTITY`               | `add`, `set_identity`, `log_interaction`, `list`                                                                              |
| `LIFE_CREATE`          | `create` with `details.kind` ∈ `{reminder, alarm, workout, health_metric}`                                                    |
| `LIFE_COMPLETE` / `LIFE_SNOOZE` | reminder targets only                                                                                                |
| `LIFE_REVIEW`          | read-only no-op                                                                                                               |
| `HEALTH`, `PAYMENTS`, `SUBSCRIPTIONS_AUDIT` | read-only no-op (state hash matches trivially)                                                           |
| `SUBSCRIPTIONS_CANCEL` | resolves by `serviceSlug` first, then `serviceName` (case-insensitive)                                                        |
| `BOOK_TRAVEL`          | offer-return, no booking                                                                                                      |
| `APP_BLOCK`, `WEBSITE_BLOCK` | focus blocks; not modeled in LifeWorld; no-op for state                                                                 |
| `SCHEDULED_TASK_CREATE` | folded into reminders on `list_personal`                                                                                     |

### Fine-grained (legacy / inline conformance)

Domain-prefixed verbs (`CALENDAR.create`, `MAIL.archive`,
`REMINDER.complete`) are kept for the inline conformance corpus and
adapters that emit explicit tool ids. Prefer umbrella for new
scenarios.

The full list of supported names is the keys of `_ACTION_HANDLERS` in
`runner.py`; `runner.supported_actions()` is the programmatic entry
point.

## First-question fallback

A `FirstQuestionFallback` answers the agent's likely clarifying
question on turn 1 of a STATIC scenario.

```python
FirstQuestionFallback(
    canned_answer="Personal calendar — and yes, keep the existing attendees.",
    applies_when="agent asks which calendar or whether to keep attendees",
)
```

Good `applies_when` is short, specific, and action-shaped:

- `"agent asks which calendar or whether to keep attendees"` — yes
- `"agent asks for confirmation before canceling"` — yes
- `"clarifying question"` — too vague, no
- `"if agent says hi"` — greeting != clarifier, no

If the instruction is fully specified and no realistic clarifier
exists, leave `first_question_fallback=None`. At least 30% of static
scenarios should carry one (see [The fallback-ratio rule](#the-fallback-ratio-rule)).

## Live-mode extras: success_criteria, world_assertions, disruptions

Live scenarios use three extra fields to drive judging:

- `success_criteria: list[str]` — natural-language predicates the judge model evaluates against the running history. Keep them concrete: `"the assistant proposed a Friday 9-10am slot"` beats `"the assistant did the right thing"`.
- `world_assertions: list[str]` — explicit world-state predicates (used by the scorer in addition to the state hash). E.g. `"there exists a calendar event titled 'Dentist' starting Friday 10:00 UTC"`.
- `disruptions: list[Disruption]` — REALM-style mid-run perturbations. Each fires `at_turn=N` and carries a `kind` ∈ `{new_message, calendar_change, reminder_due, rule_change}`. Disruption payload shapes are documented in `types.py::Disruption`.

Example disruption:

```python
Disruption(
    at_turn=3,
    kind="new_message",
    payload={
        "message_id": "email_dis_001",
        "thread_id": "thread_dis_001",
        "from_email": "boss@example.test",
        "subject": "Move our 4pm to tomorrow?",
        "body": "Need to push it — sorry for the late notice.",
    },
    note_for_user="By the way, your boss just emailed about the 4pm.",
)
```

The disruption is applied AFTER the agent's turn 3 completes; the
note is prepended to the next simulated-user turn.

## The candidate-generator workflow

Hand-authoring 250 scenarios per mode is impractical. Use the pipeline
under `eliza_lifeops_bench/scenarios/_authoring/`:

```bash
# 1. Generate candidates (calls Cerebras gpt-oss-120b)
python3 -m eliza_lifeops_bench.scenarios._authoring.generate_candidates \
    --domain calendar --n 20 --output candidates/calendar_batch_001.json

# 2. Review candidates by hand. Open the JSON, prune bad ones, fix small issues.
$EDITOR candidates/calendar_batch_001.json

# 3. Re-validate + import survivors into scenarios/calendar.py
python3 -m eliza_lifeops_bench.scenarios._authoring.import_reviewed \
    candidates/calendar_batch_001.json --domain calendar
```

What the generator feeds to Cerebras (assembled by `generate_candidates.py`):

1. The contents of `_authoring/spec.md` verbatim.
2. The list of valid action names + their parameter schemas from `manifests/actions.manifest.json`.
3. The list of valid persona ids and a one-line summary of each.
4. A summary of the requested world snapshot (entity counts and a few sampled ids per kind).
5. Up to 5 hand-authored scenarios from the target domain as in-context examples.
6. The target domain name and the requested batch size N.

The validator (`validate.py`) enforces:

- Action name exists in the manifest.
- Every kwarg key appears in the action's `parameters.properties`.
- Every `*_id` field references a real entity in the cited snapshot.
- ISO timestamps parse cleanly.
- Persona id resolves.

Anything failing validation is dropped (in candidate review) or aborts
the import (in `import_reviewed.py`). The script never overwrites
existing scenarios; duplicate ids abort the whole batch.

## Validation

Before committing a hand-edited scenario, run the corpus tests:

```bash
python3 -m pytest tests/test_scenarios_corpus.py -v
```

These tests check:

- Every action name exists in the manifest dump (`manifests/actions.manifest.json`).
- Every entity id referenced in `ground_truth_actions` resolves in the corresponding snapshot.
- Personas referenced are in `_personas.py`.
- The static fallback ratio stays above the corpus threshold.

## The fallback-ratio rule

At least 30% of static scenarios should carry a
`first_question_fallback`. Reasoning: real users almost never specify
every detail upfront, and an agent that handles clarification well is
more useful than one that pattern-matches to the most common
interpretation. The corpus test enforces this rule across the whole
static set, not per-domain — but if you add 10 fully-specified
scenarios in one domain and zero fallbacks, the global ratio will
slip.

When in doubt, ask: "is there a realistic question the agent might
ask first?" If yes, write a fallback. If no, leave it null.
