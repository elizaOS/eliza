# Deep Analysis: Stories & Prediction Markets Systems

> Audited against the codebase on 2026-03-30. Each finding is annotated with its verification status.

## Architecture Overview

Stories and markets are tightly coupled — every prediction market question spawns a **narrative arc** with pre-planned events, and those events drive NPC trading and feed content. The system maintains exactly **10 active markets** across fixed timeframe slots (15min to 3 days), all tied to a single **daily topic** (when one exists).

---

## Root Causes of Repetitive Stories

### 1. Single Daily Topic Bottleneck

**[CONFIRMED]** `daily-topic-service.ts` selects **one topic per day** — the `dailyTopics` table has a unique constraint on `date`, enforced via `upsertTopic()` with `onConflictDoUpdate`. Sources are RSS headlines (weighted +3 per token match) and parody headlines (weighted +1), with fallbacks to the previous day's topic or a hardcoded `"general"` default.

**[PARTIALLY CONFIRMED]** The `isTextOnTopic()` filter is applied to generated questions but is **not absolute**:
- If no daily topic is set (`resolvedDailyTopic` is null), all questions pass (`QuestionManager.ts` line 379: `!resolvedDailyTopic || isTextOnTopic(...)`)
- The token matching is loose — a single token from the topic label appearing anywhere in the question text is sufficient (`daily-topic-service.ts` lines 278-293)
- When the filter is active, it still funnels all 10 markets toward one theme, creating the echo-chamber effect

**Impact**: When a topic is active (the common case), all new markets orbit the same theme. The fallback to "previous day's topic" can perpetuate the same topic across multiple days.

### 2. Arc Phases: Not Identical, But Still Formulaic

**[CORRECTED]** The original claim that "every question follows the identical arc pattern" was **wrong**. There are actually **4 distinct arc structures** depending on timeframe (`timeframe-arc-planner.ts` `PHASE_CONFIGS`):

| Timeframe | Phases | Signal Ratios (correct %) |
|-----------|--------|--------------------------|
| Flash (15-30min) | `live` (1 phase) | 50% |
| Intraday (1-6h) | `active → climax` (2 phases) | 55% → 85% |
| Daily (12-48h) | `setup → peak → resolution` (3 phases) | 45% → 60% → 90% |
| Weekly (2-7d) | `early → middle → late → climax` (4 phases) | 43% → 55% → 78% → 100% |

The standard 30-day arc in `question-arc-planner.ts` uses `early → middle → late → climax` (not "setup → tension → escalation → crisis → revelation → resolution" as originally stated — those are the `LongTermArcState` labels used for arc state tracking in `narrative-event-processor.ts`, a separate system).

**What remains true and problematic:**
- Within each timeframe category, every market uses the **same** phase structure and signal ratios — there is zero variation between two weekly markets or two daily markets
- The pattern is always "misleading early, truthful late" regardless of timeframe
- Players who understand the formula can exploit it: ignore early signals, trust late signals

### 3. Predetermined Outcomes Remove Genuine Emergence

**[CONFIRMED]** All outcomes are predetermined at question creation time by the LLM:
- `generateDailyQuestions()` path: `outcome: q.expectedOutcome` (line 393)
- `generateQuestionsForContinuousGame()` path: `outcome: expectedOutcome` parsed from LLM response (line 1451)
- At resolution time, `resolveQuestion()` always uses the original `question.outcome` — there is no dynamic resolution logic

The entire arc is reverse-engineered from a known answer. Events are pre-scripted to converge on this answer. No simulation dynamics can alter the outcome.

### 4. Insider/Deceiver Casting is Shallow

**[CONFIRMED with corrections]** Counts are accurate:
- Insiders: `2 + Math.floor(rng() * 2)` = 2-3 per question (line 327)
- Deceivers: `1 + Math.floor(rng() * 2)` = 1-2 per question (line 357)
- Flash markets get 0 deceivers, intraday gets max 1

Deceiver selection criteria are slightly broader than originally stated — 4 conditions checked (`question-arc-planner.ts` lines 347-354):
1. `personality?.includes('contrarian')`
2. `personality?.includes('conspiracy')`
3. `domain?.includes('politics')`
4. `description?.toLowerCase().includes('conspiracy')`

The casting is still narrow: it relies on string matching against static personality/domain/description fields with no consideration of the actor's relationship to the specific question topic, their tier, or their history. The same NPCs with "contrarian" or "conspiracy" traits get cast as deceivers repeatedly.

### 5. In-Memory Deduplication Resets on Restart

**[CONFIRMED]** The `arcEventPacer` is a module-level singleton (`event-generation-helpers.ts` line 49) backed by `NewsArticlePacingEngine` which stores all state in private in-memory `Map` and array fields. The code comments (lines 37-48) explicitly acknowledge: _"In-memory only... The state is NOT persisted to the database and will be lost on: Server restart/redeploy, Serverless cold start, Process termination."_

### 6. Event Types: Varied But Limited

**[CORRECTED]** The original claim of "7 event types" was wrong. There are multiple type systems:

| Context | Types | Count |
|---------|-------|-------|
| ScheduledEvent (`question-arc-planner.ts`) | `leak`, `rumor`, `scandal`, `confirmation`, `red_herring` | 5 |
| CausalEventType (`GameWorld.ts`) | `leak`, `rumor`, `scandal`, `development`, `deal`, `announcement` | 6 |
| WorldEvent.type (`game-types.ts`) | `announcement`, `meeting`, `leak`, `development`, `scandal`, `rumor`, `deal`, `conflict`, `revelation`, `development:occurred`, `news:published` | 11 |

Event types do vary by phase (`question-arc-planner.ts` lines 447-455):
- `early`: `['rumor', 'rumor', 'leak']` — heavily rumor-biased
- `middle`: `['rumor', 'leak', 'scandal', 'leak']`
- `late`: `['leak', 'confirmation', 'scandal']`
- `climax`: `['confirmation', 'confirmation']` — always confirmation

**What remains problematic:** The phase-to-type mapping is hardcoded. Every weekly market's early phase generates the same weighted mix of rumors and leaks. The climax is always double-confirmation. This predictability compounds the formulaic arc structure.

---

## Root Causes of Repetitive Markets

### 1. Fixed Market Slot System

**[CONFIRMED]** `MARKET_STRUCTURE` at `markets-tick/route.ts` line 172 defines exactly 10 slots:
```
'3d': 1, '2d': 1, '1d': 1, '12h': 1, '6h': 1, '1h': 1, '30m': 2, '15m': 2
```
Hardcoded const, not configurable via env. When a market resolves, a same-timeframe replacement is created immediately (line 679-680), and a gap-filling phase (lines 845-919) ensures deficits are always filled. The structure never varies.

### 2. Question Generation: Prompt-Only Dedup in Production

**[CONFIRMED]** `ANTI_REPETITION_RULES` (defined in `shared-sections.ts` line 254) is included in the question generation prompt. It contains 4 rules about not repeating content.

**[FIXED]** The production paths now shuffle actors and organizations before slicing:
- `generateQuestionsForContinuousGame()`: actors and orgs shuffled via `shuffleArray()` before `.slice(0, 30)`
- `generateTimeframeQuestion()`: same shuffle applied before `.slice(0, 20)`
- This prevents the LLM from seeing the same ordered list every tick, reducing deterministic question patterns.

There are no structural dedup checks (e.g., embedding similarity) on generated questions — dedup is purely prompt-based.

### 3. Static Actor/Organization Roster

**[CONFIRMED with nuance]** Actors and organizations come from `StaticDataRegistry` (`static-data-registry.ts` lines 4-6: _"Provides in-memory access to all static game data that doesn't change during gameplay"_). The default roster is pack-owned, with actor source files now living in `packages/pack-default/src/actors/`. There is no code for creating, retiring, or dynamically adding actors or organizations at runtime.

**[CORRECTED]** The claim that "the world is static" was overstated. The world does evolve through:
- `RelationshipEvolutionEngine` — dynamically evolves NPC relationships based on in-game interactions
- World facts — generated context about current game state
- Daily topics — driven by real RSS feeds, changing daily
- `TopicDiversityService` — tracks topic saturation with cooldown periods and saturation penalties
- `bias-engine.ts` — implements exponential decay on biases (`decayFactor = Math.exp(-bias.decayRate * ageInHours)`)

**What remains true and problematic:** The character roster and company roster are completely fixed. The same ~30-50 NPCs and organizations appear in every question. No new entities are ever introduced, and stale entities are never retired. This is a primary driver of repetition — the LLM must generate novel questions about the same cast indefinitely.

### 4. Sub-Market Spawning is Template-Based

**[CONFIRMED]** `SUB_MARKET_TRIGGERS` in `market-timeframes.ts` (lines 319-496) are a fixed `Record<MarketCategory, SubMarketTrigger[]>` with static `questionTemplate` strings using `{variable}` placeholder substitution (`sub-market-service.ts` lines 516-527). No LLM-based question generation for sub-markets.

### 5. Resolution Events: Nominally Varied, Structurally Identical

**[CORRECTED]** The resolution prompt (`question-resolution-validation.ts`) offers 4 resolution types: `announcement | disclosure | action | outcome` (line 50). However:
- The prompt always requires "a definitive resolution event that PROVES the outcome" (line 38)
- Requirements are always: "concrete and observable", "logically conclude the narrative arc", "feel like a natural climax" (lines 43-46)
- No resolution styles like quiet expiry, gradual resolution, or inconclusive outcome exist

**[CORRECTED]** Confidence scoring base is **0.95** (not 0.85 as originally stated): `BASE_CONFIDENCE: 0.95` in `packages/shared/src/constants/markets.ts` line 23. The formula is `confidence = max(0.2, 0.95 - totalWeight)` where weights range 0.08-0.25 for speculative signal words. Manual review threshold is 0.7.

---

## The Looping Problem

The "looping" behavior stems from the interaction of several confirmed issues:

```
Day N: Topic "AI regulation" selected
  → New markets created about AI regulation (those matching isTextOnTopic)
  → Arc events fire about AI regulation
  → NPCs post about AI regulation
  → Feed is dominated by AI regulation

Day N+1: Topic changes to "tech earnings"
  → But multi-day markets (3d, 2d, 1d) are still about AI regulation
  → New short-timeframe markets about tech earnings
  → Events still firing for old AI regulation arcs
  → Feed mixes stale AI regulation events with new tech earnings content

Day N+2: Old AI regulation markets resolve
  → Resolution events generate MORE AI regulation content (dramatic proof events)
  → Meanwhile, same actors/orgs involved in new topic (static roster)
  → Questions look like rewordings of previous ones because same cast + similar topics
```

**[PARTIALLY CONFIRMED]** The claim of "no freshness decay" is mostly correct for question generation — the daily topic context provided to the LLM contains no age information. However, the broader content system does have `TopicDiversityService` with saturation tracking and `bias-engine.ts` with exponential decay. These mitigate content-level repetition but do not address question-level repetition.

**Additional looping factor discovered in audit:** When no new RSS headlines produce a viable topic, `DailyTopicService` falls back to the **previous day's topic** (`fallback_previous_day`, line 468). This can chain across multiple days, extending the same topic's dominance even further.

---

## Structural Weaknesses Summary

| Issue | Location | Verified | Impact |
|-------|----------|----------|--------|
| Single daily topic | `daily-topic-service.ts` | CONFIRMED | All content converges on one theme; fallback reuses previous day's topic |
| Formulaic arc phases | `question-arc-planner.ts`, `timeframe-arc-planner.ts` | PARTIALLY — 4 arc types exist, but each is rigid within its timeframe | Markets of same timeframe are structurally identical |
| Predetermined outcomes | `QuestionManager.ts:393,1451` | CONFIRMED | No emergent narrative; stories are on rails |
| Fixed market slots | `markets-tick/route.ts:172` | CONFIRMED | No structural variety; same 10 slots forever |
| Prompt-only dedup | `question-generation.ts`, `shared-sections.ts:254` | CONFIRMED | No structural uniqueness enforcement |
| Static entity roster | `StaticDataRegistry`, `data/actors/` | CONFIRMED | Same cast indefinitely; no introductions or retirements |
| No actor/org shuffling in production | `QuestionManager.ts:1072-1097` | CONFIRMED | LLM sees same ordered list every generation |
| In-memory event pacing | `event-generation-helpers.ts:49`, `NewsArticlePacingEngine.ts` | CONFIRMED | Resets on restart/cold start; explicitly documented |
| Template sub-markets | `market-timeframes.ts:319-496` | CONFIRMED | Formulaic child questions with placeholder substitution |
| Limited freshness decay | `daily-topic-service.ts`, question generation prompts | MOSTLY CONFIRMED | Topic diversity exists for content but not for question generation |
| Hardcoded phase event types | `question-arc-planner.ts:447-455` | CONFIRMED | Same event type distribution per phase across all markets |
| Previous-day topic fallback | `daily-topic-service.ts:468` | CONFIRMED | Can chain same topic across multiple days |

---

## What the System Does Right (discovered in audit)

These existing mechanisms partially mitigate repetition but are insufficient alone:

1. **TopicDiversityService** — tracks topic saturation with cooldown periods for content generation
2. **Bias decay engine** — exponential decay on biases over time (`Math.exp(-decayRate * ageInHours)`)
3. **Relationship evolution** — NPC relationships change dynamically based on in-game events
4. **Multiple arc structures** — 4 distinct timeframe arc patterns (not one universal pattern)
5. **Sub-market spawn logging** — dedup via `SubMarketSpawnLog` with unique constraints and skip reasons
6. **World facts service** — provides evolving context about current game state
7. **Daily topic rotation** — topics do change (when RSS provides candidates), driven by real headlines

---

## Recommendations for Rework

### High Impact (address primary repetition drivers)

1. **Multi-topic system**: Support 3-5 concurrent active topics with weighted rotation, not a single daily topic. The `TopicDiversityService` already tracks saturation — extend it to manage multiple simultaneous topic slots.

2. **Structural question dedup**: Add embedding-based or hash-based similarity checking against active AND recently-resolved questions. The prompt-based `ANTI_REPETITION_RULES` cannot enforce uniqueness — a cosine similarity threshold can.

3. **Shuffle actors/orgs in production paths**: `generateQuestionsForContinuousGame()` and `generateTimeframeQuestion()` load actors in fixed order from `StaticDataRegistry`. Add the same shuffling that `generateDailyQuestions()` already does (lines 431-440).

4. **Dynamic entity roster**: Introduce a mechanism to create new actors/organizations and retire stale ones over time. The `StaticDataRegistry` should become a seed, not the permanent state.

### Medium Impact (reduce formulaic feel)

5. **Arc variety within timeframes**: Add 2-3 arc templates per timeframe category (e.g., "slow burn", "sudden revelation", "false resolution then reversal") instead of one fixed pattern per timeframe.

6. **Emergent outcomes**: For some percentage of markets, determine outcomes based on simulation dynamics (NPC trading patterns, event outcomes, world state) rather than predetermining at creation.

7. **Variable resolution styles**: The prompt always demands "dramatic proof events". Add quiet resolutions, gradual conclusions, and inconclusive outcomes to the resolution type system.

8. **Break the previous-day topic fallback chain**: When the daily topic falls back to the previous day, apply a diversity penalty or force a category rotation instead of reusing the identical topic.

### Lower Impact (quality-of-life fixes)

9. **Persist event pacing to database**: The `NewsArticlePacingEngine` explicitly documents it loses state on restart. Move tracking to a lightweight DB table or Redis.

10. **Variable market structure**: Don't always maintain exactly 10 markets in fixed slots. Allow the world state to influence how many markets exist and in what timeframes.

11. **Freshness decay for question generation**: The daily topic context given to the LLM includes no age information. Add a "topic age" or "days active" field so the LLM can naturally vary its approach for aging topics.

12. **Diversify phase event type mappings**: The hardcoded `phaseEventTypes` (line 447-455) should support multiple distributions per phase, selected randomly or based on market category.
