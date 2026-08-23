# Conversation-quality / character-register scenarios

This domain covers **how the agent talks**, not **what it does**. The rest of the
scenario corpus (`payments/`, `messaging.*/`, `reminders/`, `relationships/`,
most of `cross-cutting/`) exercises *actions and tools*: did the agent send the
gmail draft, call the cloud-status route, create the todo, extract the right
parameter. Those are necessary but they don't catch a whole class of live
regressions where the action-selection is fine but the **register is wrong** —
the agent says a thing a good conversational partner would never say.

## The gap this fills

We repeatedly caught register regressions in production that no action-level
scenario could see, because the agent picked the right action (usually just
`REPLY`) and still produced a bad turn:

- **clock-narration** — the user's local time is in the prompt context, and the
  agent starts narrating it ("it's 1am, you should sleep") when the user never
  raised time.
- **answered-nag** — a standing reminder the user *just resolved* gets re-raised
  a turn or two later, as if it were still open.
- **memory-machinery narration** — the agent narrates its own retrieval /
  extraction internals ("updating my memory", "my records show", "let me
  check my stored facts") instead of just... knowing the thing, like a person.
- **stale-context** — old dated notes outnumber a fresh correction, and the
  agent parrots the stale majority instead of the current truth.
- **quoted-content literalism** — the user shares a song lyric or movie line and
  the agent treats the first-person line as a sincere life-state claim
  (condolences for a lyric).
- **no-restraint-in-groups** — in a group surface, a question aimed at other
  humans gets a full agent answer instead of silence.
- **proportionality / lecturing** — a casual honest mention of a slip gets a
  multi-sentence pattern-sermon the user didn't ask for.
- **verbosity** — an emotional or banter beat gets a wall of text instead of a
  short, human reply.

These are all *character-register* failures. This directory makes each one a
native, reproducible scenario so it can't silently regress.

## How these scenarios assert

Register is not deterministic, so each scenario pairs two kinds of assertion:

1. **Mechanical guards** (`responseExcludes` with a RegExp, `responseIncludesAny`,
   and an inline `assertResponse` length budget) catch the crisp, objective part
   of the failure — a literal clock reference, a re-nag phrase, a memory-machinery
   verb, a blown character budget. These run without a judge.
2. **A `judgeRubric` final check** (cerebras LLM-as-judge) grades the qualitative
   register line the regex can't express — "sits with it instead of fixing it",
   "engages the lyric as art", "answers then steps back".

Because the qualitative half needs a live judge, these scenarios are
`lane: "live-only"`. The mechanical half still runs and fails fast in the live
lane before the judge is invoked. Where a scenario's core claim is *fully*
mechanical (clock-narration, answered-nag re-ask phrasing), the `responseExcludes`
guard alone is the load-bearing assertion and the rubric is corroboration.

Persona/context is seeded as durable owner facts via plain-text `memory` seeds
(`{ type: "memory", content: { text: "..." } }`), which the core FACTS provider
retrieves during turns — the same path a real deployment's stored facts take.

All personas here are **fully invented synthetics** (Priya Raman, Marcus
Oyelaran, Ines Duarte, and fixture names like Tessa/Dee/Toph). No real person,
project, or place appears in any file.

## Running

```bash
# Live lane (needs a model key + judge; register is not deterministic):
OPENAI_API_KEY=sk-... \
  eliza-scenarios run packages/test/scenarios/conversation-quality

# A single scenario:
OPENAI_API_KEY=sk-... \
  eliza-scenarios run packages/test/scenarios/conversation-quality \
    --scenario convq.clock-narration

# Load-only sanity (discovers + typechecks the definitions, no model):
eliza-scenarios list packages/test/scenarios/conversation-quality
```

The mechanical `responseExcludes` / length guards will fail the turn immediately
if the register regresses, regardless of what the judge would have said.
