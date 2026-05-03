# plugin-mysticism — Architecture & Research Plan

## 1. Goal

Build `plugin-mysticism` — an ElizaOS plugin that gives agents the ability to perform **I Ching**, **Tarot**, and **Astrology** readings as a paid service. The plugin should enable:

- Full-fidelity divination engines (not toy demos)
- Conversational, interactive reading flows (small pieces, not one-shot scripts)
- Integration with `plugin-form` for onboarding and structured data collection
- Paywall via x402 routes for monetized readings
- A companion benchmark (`woobench`) that evaluates the agent's ability to conduct readings, navigate adversarial/skeptical users, and earn revenue

---

## 2. Library Research & Recommendations

### 2.1 Tarot

| Library | Type | Verdict |
|---------|------|---------|
| **tarot.js** (MarketingPipeline) | npm, MIT | Best option for mechanics. Deck management, custom spreads, automated drawing, shuffle/state. Active (Oct 2025). |
| **tarotapi.dev** (ekelen) | REST API, CC0 | Good card data (Rider-Waite-Smith, Waite's Pictorial Key). Upright + reversed meanings for all 78 cards. Unreliable for production (external dependency). |
| **dariusk/corpora** `tarot_interpretations.json` | Static JSON, CC0 | Excellent supplementary data — keywords and interpretations per card. Bundle as local data. |
| **Dajeki/tarot-api** | JSON data files | Good for astrological correspondences per card (modality, elements, zodiac). Bundle as local data. |
| **@ceejbot/tarot** | npm, older | CLI-focused, stale. Skip. |
| **kaabalah** | npm, AGPL-3.0 | v0.1.0, covers everything but AGPL license is viral. **Avoid** — license incompatible with MIT plugins. |

**Recommendation:** Vendor deck mechanics (~50 lines of code for shuffle/draw) + bundle **dariusk/corpora** interpretations JSON + **Dajeki** correspondences JSON for rich meaning data. All MIT/CC0 compatible. Taking a dependency on tarot.js (25 stars, single maintainer) adds risk for minimal value.

### 2.2 I Ching

| Library | Type | Verdict |
|---------|------|---------|
| **i-ching** (npm, strobus) | npm v0.3.5 | Best option. `iChing.ask(question)` returns hexagram + changing lines + transformed hexagram. All 64 hexagrams with names, binary, trigrams. |
| **hermetechnics/i-ching** | GitHub | Interesting approach but thin on interpretation text. |
| **jesshewitt/i-ching** | GitHub PWA | Uses Wilhelm-Baynes translation, good reference for interpretation texts but not a library. |
| **kaabalah** | npm, AGPL-3.0 | License problem (see above). |

**Recommendation:** Use **i-ching** npm package for divination mechanics. Supplement with bundled interpretation texts (our own summaries of the traditional meanings — the original Chinese text is public domain).

### 2.3 Astrology

| Library | Type | Verdict |
|---------|------|---------|
| **@swisseph/node** | npm v1.2.1 | Best for accuracy. Modern TypeScript wrapper around Swiss Ephemeris. Calculates planetary positions, houses, aspects. Type-safe enums. |
| **swisseph** | npm (older) | Same engine, callback-based API. Less ergonomic than @swisseph/node. |
| **circular-natal-horoscope-js** | npm | Known accuracy issues (3-4 deg Moon offset, house assignment bugs). Avoid for production. |
| **@goldenius/hades-js** | npm v2.1.2 | Calculates planets, ASC, MC, houses, aspects. Last updated 6 years ago. Simpler than swisseph but less accurate. |
| **@astrodraw/astrochart** | npm | SVG visualization only. No calculation engine. |

**Recommendation:** Use **@swisseph/node** for planetary calculations. Default to Moshier method (built-in, no extra data files needed, 0.1 arcsec precision, covers 3000 BC to 3000 AD — more than sufficient for natal charts). Swiss Ephemeris full data (90MB, 0.001 arcsec) available as optional upgrade.

---

## 3. Plugin Architecture

### 3.1 Directory Structure

```
plugins/plugin-mysticism/
├── package.json
├── README.md
├── LICENSE (MIT)
├── .gitignore
├── typescript/
│   ├── package.json
│   ├── tsconfig.json
│   ├── tsconfig.build.json
│   ├── biome.json
│   ├── build.ts
│   ├── index.ts
│   ├── src/
│   │   ├── index.ts                    # Plugin definition + exports
│   │   ├── types.ts                    # All type definitions
│   │   ├── engines/
│   │   │   ├── tarot/
│   │   │   │   ├── index.ts            # TarotEngine class
│   │   │   │   ├── deck.ts             # Deck management, shuffling, drawing
│   │   │   │   ├── spreads.ts          # Spread definitions
│   │   │   │   ├── interpreter.ts      # LLM-powered interpretation
│   │   │   │   └── data/               # cards.json, interpretations.json, correspondences.json
│   │   │   ├── iching/
│   │   │   │   ├── index.ts            # IChingEngine class
│   │   │   │   ├── divination.ts       # Hexagram casting
│   │   │   │   ├── hexagrams.ts        # 64 hexagram data
│   │   │   │   ├── interpreter.ts      # LLM-powered interpretation
│   │   │   │   └── data/               # hexagrams.json, trigrams.json
│   │   │   └── astrology/
│   │   │       ├── index.ts            # AstrologyEngine class
│   │   │       ├── chart.ts            # Natal chart calculation
│   │   │       ├── zodiac.ts           # Signs, houses, aspects
│   │   │       ├── interpreter.ts      # LLM-powered interpretation
│   │   │       └── data/               # signs.json, planets.json, houses.json, aspects.json
│   │   ├── actions/
│   │   │   ├── tarot-reading.ts        # TAROT_READING
│   │   │   ├── iching-reading.ts       # ICHING_READING
│   │   │   ├── astrology-reading.ts    # ASTROLOGY_READING
│   │   │   └── reading-followup.ts     # READING_FOLLOWUP + DEEPEN_READING
│   │   ├── providers/
│   │   │   ├── reading-context.ts      # Active reading state
│   │   │   └── mystical-knowledge.ts   # Domain expertise context
│   │   ├── evaluators/
│   │   │   └── reading-evaluator.ts    # Detects intent, emotional state
│   │   ├── services/
│   │   │   └── mysticism-service.ts    # Manages engines + sessions
│   │   ├── forms/
│   │   │   ├── tarot-intake.ts         # Question focus, spread pref
│   │   │   ├── astrology-intake.ts     # Birth date/time/place
│   │   │   └── feedback.ts            # Post-reading feedback
│   │   └── routes/
│   │       └── readings.ts            # x402 paywall routes
│   └── __tests__/
│       ├── engines/ (tarot.test.ts, iching.test.ts, astrology.test.ts)
│       ├── actions/ (tarot-reading.test.ts, iching-reading.test.ts, astrology-reading.test.ts)
│       ├── services/ (mysticism-service.test.ts)
│       └── integration/ (reading-flow.test.ts)
├── python/
│   ├── pyproject.toml
│   ├── elizaos_plugin_mysticism/
│   │   ├── __init__.py
│   │   ├── engines/ (tarot.py, iching.py, astrology.py)
│   │   ├── plugin.py
│   │   └── types.py
│   └── tests/
└── rust/ (Cargo.toml, src/lib.rs)
```

### 3.2 Reading Session Flow

A reading is NOT one-shot. It is a multi-turn conversation with five phases:

**Phase 1: INTAKE** (via plugin-form)
- Detect reading intent from user message
- Ask clarifying questions ("What's on your mind?")
- Collect required data (question for tarot/iching, birth data for astrology)
- Build rapport, show genuine curiosity

**Phase 2: CASTING**
- Perform the divination (draw cards, cast hexagram, calculate chart)
- Present initial result with dramatic pacing
- Reveal ONE piece at a time (not the whole spread at once)

**Phase 3: INTERPRETATION** (iterative — this is the core loop)
- Interpret current card/line/planet position
- Ask: "Does this resonate?" / "What comes up for you?"
- Listen to user response
- Incorporate feedback into next interpretation
- Reveal next element
- Repeat until all elements covered

**Phase 4: SYNTHESIS**
- Weave themes into coherent narrative
- Offer actionable insights
- Invite deeper exploration

**Phase 5: CLOSING**
- Summarize key takeaways
- Offer follow-up options
- Collect feedback (via plugin-form)

### 3.3 Session State

```typescript
interface ReadingSession {
  id: UUID;
  entityId: UUID;
  roomId: UUID;
  type: 'tarot' | 'iching' | 'astrology';
  phase: 'intake' | 'casting' | 'interpretation' | 'synthesis' | 'closing';
  
  tarot?: {
    spread: SpreadDefinition;
    drawnCards: DrawnCard[];
    revealedIndex: number;
    userFeedback: FeedbackEntry[];
  };
  iching?: {
    question: string;
    hexagram: HexagramReading;
    changingLines: number[];
    transformedHexagram?: HexagramReading;
    revealedLines: number;
    userFeedback: FeedbackEntry[];
  };
  astrology?: {
    birthData: BirthData;
    chart: NatalChart;
    revealedPlanets: string[];
    revealedHouses: string[];
    userFeedback: FeedbackEntry[];
  };
  
  rapport: number;  // 0-1
  createdAt: number;
  updatedAt: number;
  meta: Record<string, unknown>;
}
```

### 3.4 Plugin Components

**Actions:** TAROT_READING, ICHING_READING, ASTROLOGY_READING, READING_FOLLOWUP, DEEPEN_READING

**Providers:** READING_CONTEXT (active session state), MYSTICAL_KNOWLEDGE (domain expertise to ground LLM)

**Evaluator:** reading-evaluator (classifies emotional resonance, engagement, red flags, intent shifts)

**Service:** MysticismService (manages engines, sessions, coordinates reading flow)

### 3.5 Dependencies

```json
{
  "dependencies": {
    "@elizaos/core": "workspace:*",
    "@elizaos/plugin-form": "workspace:*",
    "i-ching": "^0.3.5",
    "@swisseph/node": "^1.2.1"
  }
}
```

Tarot deck mechanics vendored (~50 LOC). All interpretation data bundled as JSON.

### 3.6 Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Vendor tarot deck mechanics | Shuffling is trivial code. tarot.js (25 stars, 1 maintainer) adds dep risk. |
| Avoid kaabalah | AGPL-3.0 is viral — would infect entire ElizaOS project. |
| swisseph over hades-js | hades-js is 6 years stale. @swisseph/node is modern, accurate, typed. |
| Moshier default | 0 extra files, 0.1 arcsec, covers 6000 years. Swiss Ephemeris (90MB) optional. |
| Iterative reveal not dump | One element at a time with check-ins = dramatically more engaging. |
| plugin-form for intake | Birth data has required fields and validation. plugin-form handles it. |
| RWS tarot deck | Rider-Waite-Smith (1909) is public domain and the standard. |
