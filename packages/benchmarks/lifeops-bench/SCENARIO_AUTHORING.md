# LifeOpsBench — Scenario Authoring Guide

How to add a new scenario to the corpus. The canonical Python-level
contract is in `eliza_lifeops_bench/types.py::Scenario`; this guide is
the operator-facing playbook for using it well.

For LifeOps persona-pack scenarios, also follow
`../../../plugins/plugin-personal-assistant/test/scenarios/_catalogs/LIFEOPS_PERSONA_SCENARIO_AUTHORING.md`
and update the owning pack catalog.

## Table of contents

- [Static vs Live mode](#static-vs-live-mode)
- [Static semantic expectations](#static-semantic-expectations)
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
| One terminal response can be judged after execution   | You're testing satisfaction across a continuing dialogue    |
| The fallback can answer the most likely clarifier      | Neither side can be canned without breaking realism       |

Publishable STATIC runs generate a simulated opening when
`opening_mode="simulated"` and make one semantic judge call after execution.
LIVE runs generate a user turn after every executor turn and may judge
satisfaction repeatedly from `live_judge_min_turn` onward. The explicit
`--offline-conformance` lane instead uses authored STATIC openings and literal
output canaries; its artifacts cannot be published as benchmark results.

Whenever `opening_mode="simulated"`, `instruction` is a hidden user goal. The
independent persona model renders the opening and continuations in its own
words. Edge-expanded runs also supply `opening_challenge`, which asks the model
for vague referents, corrections, colloquial/noisy language, code switching,
underspecification, stress, relative time, or a fragmented handoff without
changing the goal. The executor never receives the authored goal verbatim, and
near-verbatim generated openings fail before execution.

Success criteria, world assertions, required outputs, and static rubrics are
judge-only data. They must never be copied into the simulated-user prompt; the
persona receives only its profile, hidden user goal, optional language
challenge, and current world snapshot.

## Static semantic expectations

Use `required_outputs` for facts or outcomes the terminal response must
communicate, not keywords it must contain. Publishable runs grade each item by
meaning, so an accurate paraphrase passes and a sentence that repeats the right
token with the wrong date, person, quantity, or status fails.

Use `static_rubric` for response qualities such as a consent explanation,
grounded uncertainty, or appropriate tone. Keep machine-verifiable details in
`ground_truth_actions`: IDs, subactions, timestamps, recurrence, approval
flags, and other structural parameters do not belong in prose criteria.

The judge returns every `output_N` and `rubric_N` ID exactly once. A positive
grade must cite a meaningful verbatim fragment from an eligible executor or
tool transcript line. User text, invented line IDs, tiny common-word quotes,
missing criteria, duplicates, and extra criteria fail closed.

## Persona design

Personas live in `eliza_lifeops_bench/scenarios/_personas.py`. There
are 32 registered personas; add a new one only if existing personas don't fit. Each
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
| `LIFE_REVIEW`          | modeled review that stamps list review metadata                                                                               |
| `HEALTH`               | `by_metric` is modeled; other projections fail explicitly until implemented                                                   |
| `MONEY`                | `list_transactions` is modeled; other projections fail explicitly until implemented                                          |
| `SUBSCRIPTIONS_CANCEL` | resolves by `serviceSlug` first, then `serviceName` (case-insensitive)                                                        |
| `BOOK_TRAVEL`          | `search` / `prepare` project provider offers; `hold` persists an approval-gated reservation; purchase/cancellation remain external |
| `BLOCK` / `BLOCK_*`    | `block`, `request_permission`, `unblock`, and `release` persist rule state; `status` / `list_active` are projections          |
| `SCHEDULED_TASK_CREATE` / `UPDATE` / `SNOOZE` and `SCHEDULED_TASKS/*` | first-class scheduled-task state; mutations require a seeded or earlier-created target |

Scheduled-task create actions must omit `taskId`, which is server-owned.
Create-then-mutate scenarios must take the later target from the create tool
receipt; the deterministic executor exposes the same lineage through its
stable receipt ID. Corpus validation rejects invented mutation targets.

### Fine-grained (legacy / inline conformance)

Domain-prefixed verbs (`CALENDAR.create`, `MAIL.archive`,
`REMINDER.complete`) are kept for the inline conformance corpus and
adapters that emit explicit tool ids. Prefer umbrella for new
scenarios.

The full list of recognized names is the keys of `_ACTION_HANDLERS` in
`runner.py`; `runner.supported_actions()` is the programmatic entry point.
Recognition does not imply modeled semantics. Consult `corpus-audit.json`:
unmodeled dispatches return `ok=false`, `status=unsupported`, and
`noEffect=true`.

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

With evaluator models configured, the persona model applies the
natural-language `applies_when` contract and renders the fallback facts in
character. Static-only offline runs retain a deterministic punctuation check
and canned answer so schema conformance does not require network inference.

## Live-mode extras: success_criteria, world_assertions, disruptions

Live scenarios use four extra fields to drive judging:

- `success_criteria: list[str]` — natural-language predicates the judge model evaluates against the running history. Keep them concrete: `"the assistant proposed a Friday 9-10am slot"` beats `"the assistant did the right thing"`.
- `world_assertions: list[str]` — explicit world-state predicates (used by the scorer in addition to the state hash). E.g. `"there exists a calendar event titled 'Dentist' starting Friday 10:00 UTC"`.
- `disruptions: list[Disruption]` — REALM-style mid-run perturbations. Each fires `at_turn=N` and carries a `kind` ∈ `{new_message, calendar_change, reminder_due, rule_change}`. Disruption payload shapes are documented in `types.py::Disruption`.
- `expected_world_mutation` — explicit `changed`, `unchanged`, or `optional`.
  Never derive it from words in an assertion; the scorer does not route by
  scanning natural-language criteria.

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
python3 -m pytest tests/test_scenarios_corpus.py tests/test_corpus_audit.py -v
python3 -m eliza_lifeops_bench.corpus_audit --output corpus-audit.json
```

These tests check:

- Every action name exists in the manifest dump (`manifests/actions.manifest.json`).
- Every entity id referenced in `ground_truth_actions` resolves in the corresponding snapshot.
- Personas referenced are in `_personas.py`.
- The static fallback ratio stays above the corpus threshold.
- Every LIVE opening is model-generated and every scenario id is a stable
  `[a-z0-9_.-]` identifier.
- Edge variants preserve the exact hidden goal and structural contracts while
  using a model-generated language challenge rather than a fixed prefix.
- Scheduled-task updates, snoozes, and state changes target seeded state or a
  task created earlier in the same authored action sequence.
- Every unmodeled LifeWorld operation returns explicit non-success, while
  modeled read/terminal no-mutation exceptions are inventoried separately.

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
