# @elizaos/plugin-mysticism

Mystical divination engines for elizaOS agents — Tarot, I Ching, and Astrology readings with progressive revelation, emotional attunement, and optional payment integration.

## Purpose / Role

Adds three classical divination systems to any Eliza agent as interactive, multi-turn conversations. Load it by listing `@elizaos/plugin-mysticism` in the character's `plugins` array. It is opt-in (not default-enabled) and requires no external APIs — all computation is pure TypeScript.

## Plugin Surface

### Actions

Both top-level actions are expanded with `promoteSubactionsToActions` before registration, so the runtime sees their promoted sub-actions as individual actions.

| Name | File | Description |
|------|------|-------------|
| `MYSTICISM_READING` | `src/actions/reading-op.ts` | Reading router: `type` in `{tarot,astrology,iching}`, `action` in `{start,followup,deepen}`. Gated to contexts `knowledge`, `general`; min role `USER`. |
| `PAYMENT` | `src/actions/payment-op.ts` | Payment router: `action` in `{check,request}`. Gated to contexts `finance`, `payments`; min role `OWNER`. |

### Providers (dynamic, relevance-gated)

| Name | File | Description |
|------|------|-------------|
| `READING_CONTEXT` | `src/providers/reading-context.ts` | Injects active session state (spread progress, revealed cards/lines/planets, payment status, user feedback) into context. |
| `ECONOMIC_CONTEXT` | `src/providers/economic-context.ts` | Injects user payment history, per-reading configured prices, and current session payment status. |
| `MYSTICAL_KNOWLEDGE` | `src/providers/mystical-knowledge.ts` | Injects practitioner guidelines, personality-type adaptation tips, and crisis-awareness rules. |

### Services

| Name | Service type key | Description |
|------|-----------------|-------------|
| `MysticismService` | `"MYSTICISM"` | Session lifecycle manager; owns `TarotEngine`, `IChingEngine`, `AstrologyEngine`; crisis detection; payment tracking. |

### Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/readings/tarot` | default | Start a tarot reading |
| `POST` | `/api/readings/iching` | default | Start an I Ching reading |
| `POST` | `/api/readings/astrology` | default | Start an astrology reading |
| `GET` | `/api/readings/status` | public | Poll active session status by `entityId` + `roomId` |

## Layout

```
src/
  index.ts                  Plugin export + inline provider wrappers (lazy dynamic import)
  types.ts                  All shared types: ReadingSession, TarotCard, Hexagram, NatalChart, etc.
  actions/
    reading-op.ts           MYSTICISM_READING action (start/followup/deepen per type)
    payment-op.ts           PAYMENT action (check/request)
  engines/
    tarot/
      index.ts              TarotEngine class (startReading, getNextReveal, getDeepening, getSynthesis)
      deck.ts               78-card Rider-Waite deck data
      spreads.ts            Spread definitions (three_card, celtic_cross, horseshoe, single_card, relationship)
      interpreter.ts        Card meaning + prompt generation
    iching/
      index.ts              IChingEngine class
      divination.ts         Three-coin casting + hexagram lookup
      interpreter.ts        Line-by-line and hexagram interpretation
    astrology/
      index.ts              AstrologyEngine class + AstrologyReadingState type
      chart.ts              Natal chart calculation (planetary positions, houses, aspects)
      zodiac.ts             Zodiac sign corpus
      interpreter.ts        Sign/house/aspect interpretation prompts
  forms/
    tarot-intake.ts         tarotIntakeForm (FormDefinition)
    astrology-intake.ts     astrologyIntakeForm (FormDefinition)
    feedback.ts             readingFeedbackForm (FormDefinition)
  providers/
    reading-context.ts      readingContextProvider — builds per-session context text
    economic-context.ts     economicContextProvider — payment history + pricing
    mystical-knowledge.ts   mysticalKnowledgeProvider — practitioner guidelines
  routes/
    readings.ts             createReadingRoutes() — 4 routes
  services/
    mysticism-service.ts    MysticismService — session map, engine delegation, crisis detection
  utils/
    reading-helpers.ts      getCurrentElement() and other session helpers
```

## Commands

All scripts come from `package.json` in this package:

```bash
bun run --cwd plugins/plugin-mysticism build        # compile via build.ts
bun run --cwd plugins/plugin-mysticism dev          # watch build (bun --hot)
bun run --cwd plugins/plugin-mysticism test         # vitest run
bun run --cwd plugins/plugin-mysticism typecheck    # tsc --noEmit
bun run --cwd plugins/plugin-mysticism lint         # biome check --write --unsafe
bun run --cwd plugins/plugin-mysticism lint:check   # biome check (read-only)
bun run --cwd plugins/plugin-mysticism format       # biome format --write
bun run --cwd plugins/plugin-mysticism clean        # rm -rf dist .turbo
```

## Config / Env Vars

Read by `MysticismService.start()` via `runtime.getSetting()`. All optional.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `MYSTICISM_PRICE_TAROT` | number (string) | `"0.01"` | Base price in USDC for a tarot reading |
| `MYSTICISM_PRICE_ICHING` | number (string) | `"0.01"` | Base price in USDC for an I Ching reading |
| `MYSTICISM_PRICE_ASTROLOGY` | number (string) | `"0.02"` | Base price in USDC for an astrology reading |

Also declared in `package.json#agentConfig.pluginParameters` so the elizaOS agent config UI surfaces them. Prices are suggestions only — the agent decides what to charge at request time.

## How to Extend

### Add a new action

1. Create `src/actions/<name>.ts` exporting a const that satisfies the `Action` type from `@elizaos/core`.
2. Import and add it to the `actions` array in `src/index.ts`. Use `promoteSubactionsToActions(yourAction)` if the action has sub-actions; otherwise spread directly.
3. If the action needs `MysticismService`, retrieve it via `runtime.getService<MysticismService>("MYSTICISM")` and guard for null.

### Add a new provider

1. Create `src/providers/<name>.ts` exporting a `Provider` object.
2. In `src/index.ts`, add a dynamic inline wrapper (pattern already used for the three existing providers) or import and push directly to the `providers` array.

### Add a new divination engine

1. Create a directory under `src/engines/<system>/` with `index.ts` exposing an engine class.
2. Register it inside `MysticismService` constructor and wire up `startXReading`, `getNextXReveal`, `recordXFeedback`, and `getXSynthesis` methods following the pattern of the existing three.
3. Extend the `ReadingSystem` union in `src/types.ts` and update the `READING_OP` action handler's `ReadingType` guard.

## Conventions / Gotchas

- **Session key is `entityId:roomId`** — one active reading per entity per room. Starting a new reading on an existing session silently ends the previous one.
- **Crisis detection runs on every message** in `handleStart` and `handleFollowup`. High-severity detection ends the session and withholds the reading output. Do not bypass this check when modifying the action handler.
- **Providers are dynamic and relevance-gated** — the inline wrappers in `index.ts` short-circuit to `{ text: "" }` when keywords don't match the current message. The actual provider logic lives in the imported module files.
- **Engines have no elizaOS runtime dependency** — they are plain TypeScript classes operating on static data. Test them in isolation without a runtime fixture.
- **Payment amounts are strings** throughout (not numbers) to avoid floating-point representation issues.
- **No external API calls** — astrology chart calculation, tarot deck, and I Ching corpus are all bundled static data; no network requests are made.
- **`promoteSubactionsToActions`** expands parent actions into individual registered actions — the agent sees the promoted forms, not the parent wrapper. Keep this in mind when checking which action names are actually registered at runtime.
