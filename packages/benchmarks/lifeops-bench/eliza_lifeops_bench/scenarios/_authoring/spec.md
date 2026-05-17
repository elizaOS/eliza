# LifeOpsBench scenario authoring spec

This document is the prompt the candidate generator hands to Cerebras
gpt-oss-120b. It is also the human reference for what a "good" hand-authored
scenario looks like.

A LifeOpsBench scenario tests an agent's ability to do a concrete life-task
across a realistic seeded world. Each scenario is a Python dataclass instance
(`Scenario`) that the runner replays against an in-memory `LifeWorld`.

## Top-level shape

Every candidate must be a single JSON object with the following keys (all
required unless noted as nullable):

```jsonc
{
  "id": "calendar.move_dentist_friday_morning",        // unique snake.lower with domain prefix
  "name": "Move dentist appointment to Friday morning",
  "domain": "calendar",                                 // one of the 10 Domain enum values
  "mode": "static",                                     // "static" or "live"
  "persona_id": "ria_pm",                               // must match a Persona id from _personas.py
  "instruction": "Move my dentist appointment to Friday at 10am UTC.",
  "ground_truth_actions": [
    {
      "name": "CALENDAR",                               // must exist in actions.manifest.json
      "kwargs": { "subaction": "update_event", ... }   // must satisfy the action's parameter schema
    }
  ],
  "required_outputs": ["dentist", "Friday"],            // substrings the agent's RESPOND must contain (use sparingly)
  "first_question_fallback": {                          // null if not provided
    "canned_answer": "Personal calendar.",
    "applies_when": "agent asks which calendar"
  },
  "world_seed": 2026,                                   // 2026 (medium) or 42 (tiny)
  "max_turns": 8,
  "description": "Single-event reschedule on the personal calendar."
}
```

## Hard constraints

1. **Action names.** Every `name` in `ground_truth_actions` must appear in
   `manifests/actions.manifest.json`. Do NOT invent new action names. If
   you need a capability that does not exist, log it in `GAPS.md` and
   skip the scenario.
2. **Action kwargs.** Every kwarg key must appear in the action's
   `parameters.properties` block. Required parameters from the manifest
   must be present. Numeric and boolean fields must use the right JSON
   types.
3. **World ids.** Any `*_id` field (event_id, contact_id, message_id,
   reminder_id, conversation_id, calendar_id, etc.) must reference a
   real entity in the cited `world_seed` snapshot. Do NOT fabricate ids.
4. **ISO timestamps.** All times are UTC ISO-8601, anchored to
   `2026-05-10T12:00:00Z`. Never use natural language like "tomorrow at
   3pm" inside an `Action.kwargs` value — only inside the user's
   `instruction` text.
5. **No PII.** Never use real names of public figures, fictional
   characters, or anything that looks like a real person's contact info.
   Snapshot contacts use the `*.example.test` domain — stay inside it
   for any new addresses you reference.

## What makes a good scenario

### Persona realism
Pick a persona whose `communication_style` matches the instruction. A
`PERSONA_OWEN_RETIREE` instruction that says "yo just kill that meeting"
is wrong — Owen says "Could you please cancel the 3pm appointment".
Match register.

### Ground-truth-actions consistency
The action sequence is the *minimum* a perfect agent must call. Do not
include actions that are not strictly required to achieve the
instruction. If the user only asks "what's on my calendar today", the
ground truth is one read action — not a read + a respond + a "summarize".

When the action is destructive (cancel, send, delete, transfer money,
book travel), include the appropriate `confirmed: true` flag if the
manifest requires it AND the persona supplies confirmation in the
instruction (or the fallback). Do not silently skip confirmation.

### First-question fallback design
A fallback exists for the case where the agent asks a clarifying
question instead of just doing the task. The `canned_answer` should
*answer* the most likely clarifying question in the persona's voice.
The `applies_when` is a short natural-language predicate the evaluator
checks.

Examples of good `applies_when`:
- `"agent asks which calendar or whether to keep attendees"`
- `"agent asks for confirmation before canceling"`
- `"agent asks about cabin or passenger count"`

Examples of bad `applies_when`:
- `"clarifying question"` (too vague)
- `"if agent says hi"` (greeting != clarifier)

A fallback is appropriate ~50% of the time. Do not add one if the
instruction is already fully specified (no realistic clarifier exists).

### Description
1-2 sentences explaining the test goal — what bug or capability gap
this scenario is designed to surface. The description is the
maintainer's hint; treat it like a docstring on a unit test.

## Anti-patterns to avoid

- **Don't smuggle multi-step plans into a single scenario.** If the
  user task naturally requires three independent decisions, that's three
  scenarios, not one.
- **Don't test the world generator.** Scenarios test the agent. If your
  scenario fails because the snapshot doesn't have the right data,
  pick different data — don't add a "first the agent should generate
  the world" step.
- **Don't include the answer in `required_outputs`.** That field is for
  facts the agent must communicate (e.g. "Tuesday" when the agent
  rescheduled to Tuesday). It is not for keywords from the instruction.
  Fewer required_outputs is better; an empty list is fine.
- **Don't paste vendor names without checking the snapshot.** The
  seed has Netflix, Spotify, Apple iCloud, NYT, Disney+, YouTube
  Premium, Github Pro, ChatGPT Plus. If you reference something else,
  the scenario will not be reproducible.
- **Don't write fake-looking ids.** Fake ids: `event_xyz`,
  `contact_alex_smith`, `email_001234567890`. Real ids:
  `event_00040`, `contact_00001`, `email_000002`.
- **Don't use real action names that aren't in the manifest.** It is
  easy to invent something plausible like `CALENDAR_LIST_TODAY` —
  resist. Read the manifest.

## Domain coverage

The current snapshot supports realistic scenarios for:

| Domain    | Strong support                    | Weak support               |
|-----------|-----------------------------------|----------------------------|
| calendar  | events, propose_times, prefs      | recurring rules            |
| mail      | inbox triage, threads, drafts     | label management           |
| messages  | imessage/whatsapp/slack/etc       | reactions / edits          |
| contacts  | people, family/work/friend tags   | birthdays, photos          |
| reminders | per-list, overdue, snooze         | smart-list rules           |
| finance   | txn lists, dashboard, subs        | recurring detection        |
| travel    | flight stubs, OOO blocks          | hotels (no entity)         |
| health    | metrics, trends                   | workouts (uses LIFE)       |
| sleep     | bedtime alarms, conflicts         | sleep-stage detail         |
| focus     | app + website blocks              | per-friend allowlists      |

If you want to write a "weak support" scenario, file a GAPS.md note
first and skip the scenario.

## Action discriminator pattern

Most LifeOps actions are *umbrella* actions with a `subaction` (or
`operation` for MESSAGE) discriminator. The umbrella name is the action
the planner sees; the discriminator routes to a sub-handler.

Examples:
- Calendar create: `CALENDAR` + `subaction: "create_event"`
- Mail draft reply: `MESSAGE` + `operation: "draft_reply"` + `source: "gmail"`
- Reminder complete: `LIFE_COMPLETE` + `subaction: "complete"` (the verb
  is encoded in the action *name* AND the subaction; both are accepted)

Both forms (umbrella `LIFE` + `subaction: "complete"` AND specialized
`LIFE_COMPLETE`) are present in the manifest. Prefer the specialized
form when the manifest exposes it; fall back to the umbrella for verbs
that don't have a specialized name.

## Mode

- `mode: "static"` — the simulator drives the user side from a script:
  the `instruction` plus (if present) the `first_question_fallback`.
  The agent gets at most one canned answer per scenario.
- `mode: "live"` — the user side is itself an LLM-driven persona that
  can respond freely. Use sparingly; live scenarios are slower and more
  expensive to evaluate.

## Output format the LLM must return

When generating, return a single JSON array of N candidate objects.
No prose, no markdown fences, no comments. The validator will reject
the whole batch if the JSON parse fails.

```json
[
  { ... candidate 1 ... },
  { ... candidate 2 ... }
]
```

## What the candidate generator script feeds you

The Python pipeline assembles the prompt from:
1. This spec verbatim.
2. The list of valid action names + their parameter schemas.
3. The list of valid persona ids and a one-line summary of each.
4. A summary of the requested world snapshot (entity counts and a few
   sampled ids per kind).
5. Up to 5 hand-authored scenarios from the target domain as
   in-context examples.
6. The target domain name and the requested batch size N.

Stay inside that envelope. Anything outside it (random ids, made-up
contacts, free-form invented action names) is wrong.
