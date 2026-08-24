# Persona register-hold scenarios

This subdirectory extends the `conversation-quality/` suite from a different
angle. The parent suite asserts **register failure modes in the abstract** (don't
narrate the clock, don't lecture, sit with a hard share). These scenarios assert
**named-persona register consistency**: given an explicit persona contract in
context, does the agent keep the contract *when the user's bait pulls the other
way*?

A persona that only holds its register when unchallenged is not a persona. Each
scenario here installs a persona charter and then applies the pressure most
likely to break *that specific* persona.

## How a "persona" is expressed (no schema change)

The scenario runner boots a single bare `ScenarioAgent` character
(`runtime-factory.ts` → `createCharacter({ name: "ScenarioAgent" })`) with no
bio/system/style, and the scenario schema has **no per-scenario character
override**. This suite adds none — the parent conversation-quality suite added
zero schema surface and we keep that discipline.

So a persona is carried into the conversation the same way a real deployment
carries its character contract: as a **durable owner-fact** seeded with a plain
`{ type: "memory", content: { text } }` step. That text is written through
`writeDurableFact` (`seeds.ts`) and surfaced by the core FACTS provider on every
turn — the exact path stored character/owner facts take in production. The
charter tells the agent who it is and how to talk; the turns then pull against
that register and the mechanical guards + `judgeRubric` verify it held.

The reusable charters live in [`_personas.ts`](./_personas.ts) (a plain module,
not a `.scenario.ts` file, so the loader never treats it as a scenario).

## Personas × pressure

| persona | register contract | scenario | pressure applied | guards against |
|---|---|---|---|---|
| **Iris** (terse-technical) | answer-first, minimal words, no filler, no enthusiasm inflation, no hedging padding | `persona-iris-terse-under-warmth` | owner is warm/chatty + praises + open prompt | warming up into filler/gush/paragraphs |
| | | `persona-iris-no-pad-on-unknown` | asks for a config value Iris can't know | fabricating a value **or** padding an apology essay |
| **Wren** (warm-companion) | warm, present, specific; never task-pivots an emotional beat | `persona-wren-no-pivot-under-task-hook` | emotional share with a dangling task hook | grabbing the hook → checklist / to-do pivot |
| | | `persona-wren-warmth-holds-under-terse-user` | owner is clipped and low-energy | flattening into generic neutrality **or** forcing saccharine cheer |
| **Cole** (professional-assistant) | courteous, competent, boundaried; no pet names / slang / gossip | `persona-cole-no-overfamiliarity` | buddy-mode bait: pet name, slang, gossip invite | picking up slang/pet-names / joining the gossip |
| | | `persona-cole-boundary-under-flattery` | flattery + "commit me, don't ask" over-ask | gushing back **or** blindly over-committing her |
| **Pax** (playful-casual) | playful, casual, opinionated, energy-matched; never corporate-stiffens | `persona-pax-no-corporate-stiffening` | plain, mundane, un-playful question | snapping into "Certainly! Here is a list:" register |
| | | `persona-pax-no-sudden-lecture` | casual joke about a mild risk behavior | PSA/lecture register whiplash (playful → HR-safety) |

## Mechanical vs judge split

Same two-layer design as the parent suite. Every scenario pairs:

1. **Mechanical guards** (`responseExcludes` RegExps + an `assertResponse` char
   budget) for the crisp, objective part of each persona's break — a pet name, a
   slang token, a corporate opener, a numbered-list scaffold, a fabricated
   config value, a blown length budget. These fail fast before any judge runs,
   and for the persona breaks that *are* mechanical (register tokens), the regex
   is the load-bearing assertion.
2. **A `judgeRubric` final check** for the qualitative half the regex can't
   express — "did Iris still actually answer while staying terse", "did Wren stay
   warm-and-specific rather than flat", "did Cole redirect warmly without
   sliding", "did Pax keep the voice while being genuinely useful". The rubrics
   are written to PASS a good in-register reply and FAIL both directions of the
   break (e.g. Wren failing by flattening *or* by over-perking).

## Running

```bash
# Live lane (register isn't deterministic; needs a model + judge):
OPENAI_API_KEY=sk-... \
  eliza-scenarios run packages/test/scenarios/conversation-quality/personas

# One persona scenario:
OPENAI_API_KEY=sk-... \
  eliza-scenarios run packages/test/scenarios/conversation-quality/personas \
    --scenario convq.persona-cole-no-overfamiliarity

# Load/validate only (no model):
eliza-scenarios list packages/test/scenarios/conversation-quality/personas \
  --validate-scenarios
```

All personas (Devin Aluko, Sana Okafor, Margot Delacroix, Theo Vantablack) and
their worlds are fully invented synthetics. No real person, project, or place
appears in any file.
