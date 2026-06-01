# @elizaos/plugin-mysticism

Mystical divination engines for elizaOS agents — Tarot, I Ching, and Astrology readings with progressive revelation, emotional attunement, and optional payment integration.

## Overview

This plugin gives elizaOS agents the ability to perform three classical divination systems as interactive, multi-turn conversations:

- **Tarot** — Full 78-card Rider-Waite deck with multiple spread layouts (Three Card, Celtic Cross, Horseshoe, Single Card, Relationship), card-by-card progressive reveal, and positional interpretation.
- **I Ching** — Three-coin method hexagram casting with full 64-hexagram corpus, changing line detection, and transformed hexagram support.
- **Astrology** — Natal chart calculation from birth data with planetary positions, house placements, aspect detection, and sign-by-sign interpretation.

Each system follows a phased reading lifecycle: **intake → casting → interpretation → synthesis → closing**, allowing the agent to pace the experience naturally and respond to user feedback between revelations.

No external APIs are required — all computation uses bundled static data.

## Installation

```bash
bun add @elizaos/plugin-mysticism
```

### Peer Dependencies

- `@elizaos/core` (workspace or published `alpha` dist-tag)

## Quick Start

Add the plugin to your agent's character configuration:

```json
{
  "plugins": ["@elizaos/plugin-mysticism"]
}
```

Or import and register it directly:

```typescript
import { mysticismPlugin } from "@elizaos/plugin-mysticism";

const character = {
  plugins: [mysticismPlugin],
};
```

## Actions

The plugin registers two actions. Both are expanded via `promoteSubactionsToActions` before the runtime sees them.

| Action | Contexts | Min Role | Description |
|--------|----------|----------|-------------|
| `MYSTICISM_READING` | `knowledge`, `general` | `USER` | Reading router. Set `type` to `tarot`, `astrology`, or `iching`; set `action` to `start`, `followup`, or `deepen`. |
| `PAYMENT` | `finance`, `payments` | `OWNER` | Payment router. Set `action` to `check` (read payment status) or `request` (ask user to pay). |

### MYSTICISM_READING parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `type` | yes | `tarot` \| `astrology` \| `iching` |
| `action` | yes | `start` \| `followup` \| `deepen` |
| `question` | no | Focus question for the reading |
| `context` | no | Additional context (e.g., birth data hint for astrology) |

Similes (trigger phrases): `READING`, `TAROT_READING`, `READ_TAROT`, `DRAW_CARDS`, `ICHING_READING`, `CAST_HEXAGRAM`, `ASTROLOGY_READING`, `BIRTH_CHART`, `NATAL_CHART`, `READING_FOLLOWUP`, `CONTINUE_READING`, `DEEPEN_READING`, `EXPLORE_DEEPER`, and more.

## Providers

All three providers are dynamic and keyword-gated — they return empty text when the current message is not relevant, keeping context window usage low.

| Provider | Description |
|----------|-------------|
| `READING_CONTEXT` | Injects active reading session state (progress, revealed elements, payment status, user feedback) |
| `ECONOMIC_CONTEXT` | Injects user payment history, configured prices, and current session payment status |
| `MYSTICAL_KNOWLEDGE` | Injects practitioner guidelines, reader personality adaptation, and crisis-awareness rules |

## Forms

The plugin exports three `FormDefinition` objects for use with a form service:

| Export | ID | Description |
|--------|----|-------------|
| `tarotIntakeForm` | `tarot_intake` | Collects the user's question and preferred spread |
| `astrologyIntakeForm` | `astrology_intake` | Collects birth date, time, and location |
| `readingFeedbackForm` | `reading_feedback` | Captures user reflection after each revealed element |

## REST API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/readings/tarot` | default | Start a tarot reading |
| `POST` | `/api/readings/iching` | default | Start an I Ching reading |
| `POST` | `/api/readings/astrology` | default | Start an astrology reading |
| `GET` | `/api/readings/status` | public | Poll active session status (`entityId` + `roomId` query params) |

### Example: Start a Tarot Reading

```bash
curl -X POST http://localhost:3000/api/readings/tarot \
  -H "Content-Type: application/json" \
  -d '{
    "entityId": "user-uuid",
    "roomId": "room-uuid",
    "question": "What should I focus on this month?",
    "spreadId": "celtic_cross"
  }'
```

Valid `spreadId` values: `three_card`, `celtic_cross`, `horseshoe`, `single_card`, `relationship`.

### Example: Start an Astrology Reading

```bash
curl -X POST http://localhost:3000/api/readings/astrology \
  -H "Content-Type: application/json" \
  -d '{
    "entityId": "user-uuid",
    "roomId": "room-uuid",
    "birthYear": 1990,
    "birthMonth": 6,
    "birthDay": 15,
    "birthHour": 14,
    "birthMinute": 30,
    "latitude": 40.7128,
    "longitude": -74.006,
    "timezone": -5
  }'
```

## Configuration

Optional pricing parameters, readable via `runtime.getSetting()` or environment variables:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `MYSTICISM_PRICE_TAROT` | `0.01` | Base price in SOL for a tarot reading |
| `MYSTICISM_PRICE_ICHING` | `0.01` | Base price in SOL for an I Ching reading |
| `MYSTICISM_PRICE_ASTROLOGY` | `0.02` | Base price in SOL for an astrology reading |

These are configured suggestions — the agent decides the final amount when issuing a `PAYMENT` action with `action=request`. Invalid or negative values are logged as warnings and the default is used instead.

## Architecture

```
src/
  index.ts            Plugin registration + dynamic provider wrappers
  types.ts            All shared types (ReadingSession, TarotCard, Hexagram, NatalChart, ...)
  actions/            MYSTICISM_READING + PAYMENT action handlers
  engines/
    tarot/            TarotEngine — deck, spreads, interpretation
    iching/           IChingEngine — coin casting, 64 hexagrams, changing lines
    astrology/        AstrologyEngine — natal chart calculation, aspects, houses
  forms/              tarotIntakeForm, astrologyIntakeForm, readingFeedbackForm
  providers/          READING_CONTEXT, ECONOMIC_CONTEXT, MYSTICAL_KNOWLEDGE
  routes/             REST routes via createReadingRoutes()
  services/           MysticismService — session lifecycle, crisis detection, payments
  utils/              Shared reading helpers
```

### Engine Design

The engines (`TarotEngine`, `IChingEngine`, `AstrologyEngine`) are pure TypeScript classes with no elizaOS runtime dependency. They operate on bundled static data (card decks, hexagram tables, zodiac definitions) and return typed results — independently testable in isolation.

### Service Layer

`MysticismService` (service type key `"MYSTICISM"`) manages reading session lifecycle per `entityId:roomId` pair, delegates computation to the engines, tracks progressive reveal state, records user feedback for emotional attunement, and handles payment status transitions.

### Crisis Safety

The service includes built-in crisis detection that scans user input for distress indicators across three severity tiers (high/medium/low). High-severity matches immediately halt the reading and provide mental health resource referrals (988 Suicide & Crisis Lifeline, Crisis Text Line) rather than continuing the divination flow.

## Development

```bash
bun run --cwd plugins/plugin-mysticism build        # compile
bun run --cwd plugins/plugin-mysticism dev          # watch build
bun run --cwd plugins/plugin-mysticism test         # vitest
bun run --cwd plugins/plugin-mysticism typecheck    # tsc --noEmit --noCheck
bun run --cwd plugins/plugin-mysticism lint         # biome check + fix
bun run --cwd plugins/plugin-mysticism format       # biome format
```