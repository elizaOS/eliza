# LifeOpsBench LIVE scenario authoring spec

LIVE scenarios test judgment under conversation, not exact action verbs. The
user side is itself an LLM-driven persona that can respond freely. The judge
scores satisfaction in spirit using `success_criteria` and `world_assertions`.

This document is the prompt the live candidate generator hands to Cerebras
gpt-oss-120b. It is the human reference for what a "good" live scenario
looks like.

## Top-level shape

Every candidate must be a single JSON object with the following keys (all
required unless noted as nullable):

```jsonc
{
  "id": "live.calendar.find_focus_block",        // unique snake.lower with `live.<domain>.` prefix
  "name": "Find me a 1-hour focus block tomorrow",
  "domain": "calendar",                           // one of the 10 Domain enum values
  "mode": "live",                                 // ALWAYS "live"
  "persona_id": "ria_pm",                         // must match a Persona id from _personas.py
  "instruction": "I have three meetings tomorrow. Find me a 1-hour focus block, ideally before lunch. I'll reveal hard constraints only if asked.",
  "ground_truth_actions": [],                     // ALWAYS empty (live scenarios are scored by judge)
  "required_outputs": [],                          // ALWAYS empty (no exact-string matching in live mode)
  "first_question_fallback": null,                 // ALWAYS null (the live persona answers freely)
  "world_seed": 2026,                              // 2026 (medium) or 42 (tiny)
  "max_turns": 30,                                 // 20-40 typical for live
  "description": "Open-ended slot-finding. Persona pushes back if agent picks before 9am.",
  "success_criteria": [
    "Executor proposes at least one concrete 1-hour window on 2026-05-11.",
    "Executor either creates the focus event after persona accepts, OR explicitly confirms the slot for manual add.",
    "The accepted slot is between 09:00 and 12:30 local time."
  ],
  "world_assertions": [
    "If executor created the event: a new calendar_event on cal_work for 2026-05-11 between 09:00 and 12:30 with title containing 'focus' or 'deep work'."
  ]
}
```

## Hard constraints

1. **`mode` is always `"live"`.** Never use `"static"` here.
2. **`ground_truth_actions` is always `[]`.** Live scoring uses the judge,
   not action comparison. Do NOT invent actions.
3. **`required_outputs` is always `[]`.** Live mode scores by criteria,
   not substring match.
4. **`first_question_fallback` is always `null`.** The live persona is
   itself an LLM and can answer clarifying questions on the fly.
5. **`success_criteria` must have 2-4 entries.** Each is a single,
   specific, judge-verifiable claim about agent behavior. Examples:
   - "Executor proposes at least one concrete date+time before mutating."
   - "Executor confirms before sending money or canceling a paid subscription."
   - "Executor surfaces the conflict before silently overwriting."
6. **`world_assertions` must have 1-3 entries.** Each describes an
   observable post-condition of the LifeWorld snapshot — what should
   exist or have changed (or NOT changed) after the run. Examples:
   - "A new calendar_event on cal_personal for 2026-05-15 19:00-20:00 with title mentioning 'doctor'."
   - "No transaction created in the snapshot if persona declined the transfer."
   - "Reminder marked complete on list_inbox for the 'send invoice' item."
7. **Persona realism.** Pick a persona whose `communication_style` matches
   the instruction. Match register.
8. **No PII.** Never use real names of public figures or fictional
   characters. Snapshot contacts use `*.example.test`.
9. **ID prefix in scenario id:** start with `live.<domain>.` (e.g.
   `live.mail.batch_archive_low_priority`).

## What makes a good live scenario

### Open-ended judgment, not pre-scripted plans
The whole point of LIVE is to test what the agent does under realistic
ambiguity. Good instructions include:
- a vague-on-purpose ask ("help me get through this morning's inbox")
- a hint that constraints will emerge ("I'll narrate priorities as we go")
- room for legitimate alternative approaches

Bad live instructions:
- a fully-specified single-action ask (that's a static scenario)
- a clearly-multi-step plan with exact steps (also static)
- vague to the point of being meaningless ("help me with my day")

### Persona-driven constraint reveal
A great live scenario hides 1-2 important constraints inside the persona,
to be revealed mid-conversation. The `description` should hint at this.
Example: persona-revealed constraints that the agent should discover by
asking or by getting pushed back on:
- "the 11am meeting is non-negotiable"
- "I prefer Venmo over Zelle for this"
- "the kid pickup is at 3pm, work around it"

### Success criteria precision
Each criterion is verifiable from the conversation log alone. Good:
- "Executor confirms total cost in USD before booking."
- "Executor names at least one specific transaction by date or amount."

Bad (too vague to judge):
- "Executor is helpful."
- "Executor is appropriate."
- "Executor uses good judgment."

### World assertions match what executors can do
World assertions describe the FINAL world state. They are matched
against the LifeWorld snapshot after the run. Use the same id prefixes
the snapshot uses (`event_*`, `email_*`, `txn_*`, etc.) but you may
describe them generically — the judge does fuzzy matching against the
diff, not strict id lookup.

## Anti-patterns to avoid

- **Don't hide a static scenario inside a live scenario.** If your
  scenario reduces to "the agent must call `CALENDAR_CREATE` with these
  exact kwargs", make it a static scenario instead.
- **Don't write success criteria that test the world generator.** "There
  is a contact named X" — that's a snapshot fact, not an agent behavior.
- **Don't include `ground_truth_actions` even as a hint.** Always empty.
- **Don't use real action names as if they're verbs.** Live scoring
  ignores action names; describe behavior, not invocations.
- **Don't write success criteria longer than 25 words each.** Long
  criteria are fuzzy criteria.

## Domain-specific live patterns

| Domain    | Good live test                                                     |
|-----------|---------------------------------------------------------------------|
| calendar  | conflict resolution, slot-finding under hidden constraints          |
| mail      | triage with judgment, drafting tone, urgent-pivot                   |
| messages  | summarize-then-respond, multi-thread context, tone matching         |
| contacts  | reconciliation, dedup decisions, missing-info workflows             |
| reminders | prioritization across lists, snooze vs reschedule judgment          |
| finance   | transfer confirmation, subscription audit, anomaly explanation      |
| travel    | trip planning under budget/preference constraints, OOO comms        |
| health    | trend interpretation, lifestyle suggestions, gentle accountability  |
| sleep     | bedtime negotiation, alarm conflict resolution, weekend variance    |
| focus     | block-design across goals, app-allowlist judgment, exception flow   |

## Output format the LLM must return

Return a single JSON array of N candidate objects. No prose, no markdown
fences, no comments. The validator rejects the whole batch on JSON
parse failure.

```json
[
  { ... candidate 1 ... },
  { ... candidate 2 ... }
]
```

## What the live candidate generator script feeds you

1. This spec verbatim.
2. The list of valid persona ids and a one-line summary of each.
3. A summary of the requested world snapshot (entity counts and a few
   sampled ids per kind).
4. Up to 3 hand-authored live scenarios from the target domain as
   in-context examples.
5. The target domain name and the requested batch size N.

Stay inside that envelope. Anything outside it (random ids, made-up
contacts, ground-truth actions, non-empty required_outputs) is wrong.
