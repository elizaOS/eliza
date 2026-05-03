# @elizaos/plugin-mysticism

Mystical divination engines for ElizaOS agents — Tarot, I Ching, and Astrology readings with progressive revelation, emotional attunement, and optional payment integration.

## Overview

This plugin gives ElizaOS agents the ability to perform three classical divination systems as interactive, multi-turn conversations:

- **Tarot** — Full 78-card Rider-Waite deck with multiple spread layouts (Three Card, Celtic Cross, etc.), card-by-card progressive reveal, and positional interpretation.
- **I Ching** — Three-coin method hexagram casting with full 64-hexagram corpus, changing line detection, and transformed hexagram support.
- **Astrology** — Natal chart calculation from birth data with planetary positions, house placements, aspect detection, and sign-by-sign interpretation.

Each system follows a phased reading lifecycle: **intake → casting → interpretation → synthesis → closing**, allowing the agent to pace the experience naturally and respond to user feedback between revelations.

## Installation

```bash
npm install @elizaos/plugin-mysticism@next
# or
bun add @elizaos/plugin-mysticism@next
```

### Peer Dependencies

- `@elizaos/core` (v2.x)
- `@elizaos/plugin-form` (v2.x) — required for intake forms and payment flows

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

// Add to your agent's plugin list
const character = {
  plugins: [mysticismPlugin],
};
```

## Actions

| Action | Similes | Description |
|--------|---------|-------------|
| `TAROT_READING` | `READ_TAROT`, `DRAW_CARDS`, `TAROT_SPREAD`, `CARD_READING` | Initiate a tarot card reading |
| `ICHING_READING` | `CAST_HEXAGRAM`, `CONSULT_ICHING`, `THROW_COINS`, `ORACLE_READING` | Initiate an I Ching divination |
| `ASTROLOGY_READING` | `BIRTH_CHART`, `NATAL_CHART`, `HOROSCOPE_READING`, `ZODIAC_READING` | Initiate a natal chart reading |
| `READING_FOLLOWUP` | `CONTINUE_READING`, `NEXT_CARD`, `NEXT_LINE`, `PROCEED_READING` | Reveal the next element in an active reading |
| `DEEPEN_READING` | `EXPLORE_DEEPER`, `TELL_MORE`, `ELABORATE_READING` | Provide deeper interpretation of a specific element |
| `REQUEST_PAYMENT` | `CHARGE_USER`, `ASK_FOR_PAYMENT` | Request payment for a reading session |
| `CHECK_PAYMENT` | `VERIFY_PAYMENT`, `PAYMENT_STATUS` | Verify payment status for the current session |

## Providers

| Provider | Description |
|----------|-------------|
| `READING_CONTEXT` | Injects active reading session state into the agent's context |
| `ECONOMIC_CONTEXT` | Provides payment history and revenue facts |
| `MYSTICAL_KNOWLEDGE` | Grounds the agent's interpretations with domain-specific symbolism |

## Forms

| Form | Description |
|------|-------------|
| `tarot-intake` | Collects the user's question and preferred spread |
| `astrology-intake` | Collects birth date, time, and location |
| `reading-feedback` | Captures user reflection after each revealed element |

## REST API Routes

The plugin registers HTTP routes on the agent's API server:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/readings/tarot` | Start a tarot reading |
| `POST` | `/api/readings/iching` | Start an I Ching reading |
| `POST` | `/api/readings/astrology` | Start an astrology reading |
| `GET` | `/api/readings/status` | Poll reading session status |

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

Optional pricing parameters can be set via `agentConfig.pluginParameters` or environment variables:

| Parameter | Description | Default |
|-----------|-------------|---------|
| `READING_PRICE_TAROT` | Price in USDC base units for a tarot reading | `0` (free) |
| `READING_PRICE_ICHING` | Price in USDC base units for an I Ching reading | `0` (free) |
| `READING_PRICE_ASTROLOGY` | Price in USDC base units for an astrology reading | `0` (free) |

When prices are set to `0`, the payment actions (`REQUEST_PAYMENT`, `CHECK_PAYMENT`) are effectively no-ops and readings proceed without a payment gate.

## Architecture

```
plugin-mysticism/
├── typescript/           # TypeScript implementation (published to npm)
│   ├── src/
│   │   ├── actions/      # Agent actions (tarot, iching, astrology, payment, followup)
│   │   ├── engines/      # Pure divination logic, no runtime dependencies
│   │   │   ├── tarot/    # 78-card deck, spreads, interpretation
│   │   │   ├── iching/   # 64 hexagrams, trigrams, coin casting
│   │   │   └── astrology/# Chart calculation, zodiac, aspects, houses
│   │   ├── forms/        # Intake and feedback form definitions
│   │   ├── providers/    # Context providers for the LLM
│   │   ├── routes/       # REST API endpoints
│   │   ├── services/     # MysticismService — session and state management
│   │   └── types.ts      # Shared type definitions
│   └── __tests__/        # Vitest test suite
├── python/               # Python implementation of divination engines
├── rust/                 # Rust implementation of divination engines
└── package.json          # Root package (monorepo orchestration)
```

### Engine Design

The engines (`TarotEngine`, `IChingEngine`, `AstrologyEngine`) are pure computational modules with no ElizaOS runtime dependency. They operate on structured data (JSON card decks, hexagram tables, zodiac definitions) and return typed results. This makes them independently testable and reusable outside the plugin context.

### Service Layer

`MysticismService` manages reading session lifecycle, tracks per-entity active sessions, handles progressive reveal state, records user feedback, detects crisis language (with severity tiers and appropriate referral messaging), and integrates with the payment flow.

### Safety

The service includes built-in crisis detection that scans user input for indicators of distress. When detected, the agent pauses the reading and provides appropriate mental health resource referrals rather than continuing with potentially harmful mystical interpretations.

## Multi-Language Support

The divination engines are implemented in three languages for cross-platform use:

- **TypeScript** — Primary implementation, published as `@elizaos/plugin-mysticism`
- **Python** — `python/elizaos_plugin_mysticism/` with pytest test suite
- **Rust** — `rust/src/` with integration tests

## Development

```bash
# Install dependencies
bun install

# Build
bun run build

# Run tests
bun run test

# Type check
bun run typecheck

# Lint & format
bun run lint
bun run format
```

## License

MIT
