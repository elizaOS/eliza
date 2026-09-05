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
- **register-literalism** — a playful roll call or obvious bit gets answered
  dead-literal ("I'm awake, how can I help?") instead of one light line back;
  a shitpost that hides a real idea gets either an earnest feasibility essay
  or a joke-explanation instead of the-joke-plus-one-beat.
- **reply-guy default** — the agent treats every human beat as an invitation:
  answering rhetorical questions nobody asked it, dropping fun-facts into
  other people's riffs, replying to closers ("lol", a bare emoji) with a
  paragraph. The register skill on the LOW end: knowing when a reaction or
  silence beats a message.
- **multi-agent pile-on** — with several assistants in one channel, every human
  beat draws two or three bot replies, and bots start replying to each other's
  replies with no new human input, until the channel reverbs with agent
  chatter. One speaker per human message is the contract.

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

## Continuous-conversation regression

`convq.continuous-conversation` uses seven real model turns in one owner room:

1. State a new tea preference and a plan, without requesting app-side changes.
2. Correct the guest count without restating the plan.
3. Digress into a joke.
4. Ask an elliptical follow-up requiring arithmetic from the corrected history.
5. Ask for the Spanish name of a favorite color present only in durable facts,
   never in the user transcript. Repeating the current message cannot pass.
6. Ask about a fact never supplied; require an honest, natural admission.
7. Return to the original plan and the new preference.

Database readback separately requires the new tea preference to exist as a fact
and every stored owner message to remain in the same room. The color seed proves
retrieval, not extraction; the tea readback proves new persistence. A live judge
checks natural register without mandating exact acknowledgement phrases.
The isolated agent also has a deliberately ambiguous `User` display alias; the
tea preference must still be attributed to the actual owner, never the agent.

```bash
# Use a Cerebras-only test environment with a resolved CEREBRAS_API_KEY.
# A vault:// reference is not an API credential. Automatic provider discovery
# selects the OpenAI-compatible adapter; --provider openai instead asserts
# that the endpoint is OpenAI and rejects a Cerebras endpoint.
OPENAI_BASE_URL=https://api.cerebras.ai/v1 \
OPENAI_SMALL_MODEL=qwen-3.8-27b OPENAI_LARGE_MODEL=qwen-3.8-27b \
CEREBRAS_JUDGE_MODEL=qwen-3.8-27b \
bun --conditions eliza-source packages/scenario-runner/src/cli.ts run \
  packages/test/scenarios/conversation-quality \
  --scenario convq.continuous-conversation \
  --report /tmp/eliza-continuous-conversation.json
```

This command uses the same model family for acting and judging, not an
independent-model quality assessment. Inspect the trajectory and mechanical
checks alongside the judge score. The author filter in the database check is
`authorEntityIds`; `entityId` establishes access context, not row authorship.

This in-process scenario does **not** prove UI routing, reload restoration,
semantic/vector retrieval, graph extraction, physical voice, or VPS/Pixel
deployment. Its default runner profile disables embeddings. Keep those as
separate acceptance gates rather than inferring them from correct reply text.

For browser acceptance, use the existing personal chat: save a real preference,
switch Notes → Calendar → Home with natural-language requests, reload, and ask
an elliptical follow-up about that preference. Check the visible destination,
retained transcript, conversation/room IDs in trajectories, unchanged
conversation count, durable fact readback, and per-stage timings. Do not seed the
synthetic scenario persona into a user's actual chat or delete old conversations.
Test voice on that same identity only when microphone/playback is authorized.
