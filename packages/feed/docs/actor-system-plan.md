# Actor System Overhaul Plan

> Goal: Make NPC actors feel like real, distinct people — not template-filling LLM outputs.
> Based on whiteboard diagram + deep codebase audit on 2026-03-31.

---

## The Problem in One Sentence

The actor data is rich (30-100 post examples, detailed voice/personality, relationships, positions) but the prompts bury it under 1,200 tokens of generic shared rules, and the context pipeline fragments what actors know across disconnected systems.

---

## Current Architecture (What Exists)

### What actors have (the data is good)
- **30-100 post examples** per actor with real voice variety (AIlon Musk ranges from "lol" to 259-char shitposts)
- **Detailed voice/personality/postStyle** descriptions (~500 chars each)
- **Persona config**: reliability, insiderOrgs, willingness to lie, self-interest motivation, allies/enemies
- **Emotional state**: mood (-1 to 1), luck, updated each tick
- **Memories**: 50 bounded entries with timestamps
- **Relationships**: sentiment, strength, history, interaction count
- **Market positions**: current holdings with PnL
- **Domain/ignoreTopics/engagementThreshold**: behavioral filtering

### What's broken (the prompts are bad)

**1. Shared rules drown out actor identity**
The ambient post prompt has ~1,200 tokens of shared rules (IMPORTANT_RULES, CONTENT_REQUIREMENTS, ANTI_REPETITION_RULES, FINAL_REMINDERS, DO/DO NOT lists) that are identical across all 140+ actors. The actor-specific data (voice, examples, personality) is sandwiched between generic instructions. The LLM prioritizes the rules over the character.

**2. Anti-repetition service exists but isn't wired in**
`NPCAntiRepetitionService.getAvoidedPatternsContext()` generates per-actor "avoid these openings/words" instructions — but it's never called in the ambient post generation path. It's exported but unused.

**3. Tone/finance guardrails exist but aren't wired in**
`formatActorToneGuardrails()` and `formatActorFinanceGuardrails()` check if an actor's voice corpus supports slang/ticker usage and ban it if not — but neither is called during post generation.

**4. ignoreTopics is pre-filter only, not in the prompt**
An actor with `ignoreTopics: ['fashion', 'sports']` gets filtered before generation, but if the topic filter passes, the LLM never sees "you don't talk about fashion." The constraint exists as a gate, not as character knowledge.

**5. Posting and trading contexts are disconnected**
- Posting context: gets narrative arc, ongoing stories, resolved questions, trending topics
- Trading context: gets market prices, positions, event signals, but no narrative context
- Result: actors post about stories they don't trade on, and trade without narrative awareness

**6. No follow graph for NPCs**
NPCs see random recent posts, not posts from accounts they'd follow. There's a follow system but it's NPC-to-player only. NPC-to-NPC follows don't exist, so actors can't react to what their allies/rivals post.

**7. Seven duplicate prompt templates**
`ambient-posts`, `minute-ambient`, `replies`, `reply`, `reactions`, `commentary`, `conspiracy` share 80%+ identical instruction text. Same DO/DO NOT lists, same rules, same structure. Different XML wrappers.

**8. 8,000 maxTokens for a 200-char post**
The LLM generates up to 8,000 tokens of reasoning for a tweet-length output. This is 40x the output length in overhead.

**9. Reality grounding is stale**
`reality-grounding.ts` references "Nov 2025" data in March 2026. Only 8 satirical themes. "Only USAI exists" eliminates international content.

**10. Empty template sections waste tokens**
Multiple template slots (`characterRoster`, `characterRelationships`, `richGameContext`, etc.) render as empty strings with visible section headers. The LLM sees "=== ONGOING STORYLINES ===" followed by nothing.

---

## Target Architecture (From Whiteboard)

```
                    ┌──────────────┐
                    │  RSS Events  │
                    └──────┬───────┘
                           │
┌──────────────┐    ┌──────▼───────┐    ┌──────────────┐
│  Market Data │───▶│              │◀───│  Feed (posts │
│  + Positions │    │    ACTOR     │    │  from follows)│
└──────────────┘    │    (LLM)     │    └──────────────┘
                    │              │
┌──────────────┐    │  Persona:    │    ┌──────────────┐
│ Group Chats  │───▶│  - Style     │◀───│     DMs      │
└──────────────┘    │  - Rules     │    └──────────────┘
                    │  - Friends   │
┌──────────────┐    │  - Enemies   │    ┌──────────────┐
│  Narrative + │───▶│              │◀───│  World State  │
│  Hidden Alpha│    └──────┬───────┘    └──────────────┘
└──────────────┘           │
                    ┌──────▼───────┐
                    │   Actions:   │
                    │  Post, DM,   │
                    │  Trade, Bet  │
                    └──────────────┘
```

Every input should flow into a **single unified context** per actor per tick. The actor sees everything relevant and decides what action to take — not separate prompts for posting vs trading vs engagement.

---

## The Plan

### Phase 1: Fix the Prompts (Highest Impact, Lowest Risk)

#### 1.1 Rewrite the ambient post prompt
**Problem**: 1,200 tokens of shared rules, 200-char output. Generic DO/DO NOT lists.
**Fix**: Strip the prompt to essentials. The actor's voice examples and personality should be the DOMINANT signal, not rules.

New structure:
```
You are {name}.

{voice description}
{postStyle description}

YOUR POSTS SOUND LIKE THIS:
{5-8 shuffled post examples}

WHAT YOU KNOW RIGHT NOW:
{compact context: events, positions, trending, mood}

YOUR RELATIONSHIPS:
{allies to defend, rivals to dunk on}

RULES:
{3-5 rules max, not 30}
- Use parody names only
- No hashtags or emojis
- {actor-specific rules from ignoreTopics}
- Max 200 characters

Write one post.
```

Target: under 2,000 tokens total. Actor identity is 60%+ of the prompt, not 20%.

#### 1.2 Wire in existing but unused systems
**Anti-repetition service**: Call `getAvoidedPatternsContext()` and inject the output. It already generates per-actor "avoid these openings/words" — just needs to be wired in.

**Tone guardrails**: Call `formatActorToneGuardrails()` and `formatActorFinanceGuardrails()`. They check if an actor's corpus supports slang/ticker usage — just needs to be wired in.

**ignoreTopics in prompt**: Add actor-specific rules from `ignoreTopics` to the prompt: "You never talk about: fashion, sports, entertainment."

#### 1.3 Consolidate duplicate prompts
Merge `ambient-posts`, `reactions`, `commentary`, `replies`, `reply`, `conspiracy` into a single flexible prompt that takes a `postType` parameter. Same actor context, different task instruction.

#### 1.4 Reduce maxTokens
8,000 tokens for a 200-char post is wasteful. Reduce to 1,000-1,500. The model doesn't need 8,000 tokens to write a tweet.

---

### Phase 2: Unify Actor Context (Medium Effort, High Impact)

#### 2.1 Single context builder for all actor actions
Create an `ActorContextBuilder` that assembles one unified context object used by posting, trading, engagement, and any other action.

```typescript
interface ActorContext {
  // Identity (from static data)
  identity: {
    name: string;
    personality: string;
    voice: string;
    postStyle: string;
    postExamples: string[];
    domains: string[];
    ignoreTopics: string[];
    affiliations: string[];
  };

  // Persona (behavioral rules)
  persona: {
    reliability: number;
    willingness_to_lie: boolean;
    selfInterest: string;
    allies: Array<{ name: string; sentiment: number }>;
    rivals: Array<{ name: string; sentiment: number }>;
    insiderOrgs: string[];
  };

  // What they know right now
  awareness: {
    recentEvents: EventContext[];       // World events (last 24h)
    personalEvents: EventContext[];     // Events involving them
    feedPosts: FeedPostContext[];       // Posts from people they follow
    groupChats: GroupChatContext[];     // Group conversations
    dms: DMContext[];                  // Direct messages (NEW)
    trendingTopics: string[];
    resolvedQuestions: string[];       // Recent market outcomes
  };

  // Market state
  markets: {
    positions: NPCPosition[];          // What they hold
    perpPrices: PerpMarketSnapshot[];   // Current perp prices
    predictionMarkets: PredictionMarketSnapshot[];
    recentTrades: TradeContext[];       // Their recent trading activity
    signals: MarketSignalContext[];     // Hidden alpha (NPCs only)
  };

  // Emotional/memory state
  state: {
    mood: number;
    luck: string;
    memories: NpcMemory[];
    avoidPatterns: string[];           // From anti-repetition service
  };

  // Narrative awareness
  narrative: {
    arcPhase: string;                  // Current game phase
    hiddenAlpha: string;               // NPC-only intuitions
    ongoingStories: string[];
  };
}
```

This replaces `MarketContextService.buildContextForNPC()`, `FeedGenerator.buildRichCharacterContext()`, and `getNpcGameContext()` with one source of truth.

#### 2.2 Add NPC-to-NPC follow graph
NPCs should follow their allies and rival NPCs, not see random posts. The follow graph already exists (`ActorFollow` table) but is only used for NPC-to-player follows.

**Implementation**: On actor bootstrap, create mutual follows between:
- All allies (from `persona.favorsActors`)
- All rivals (from `persona.opposesActors`)
- Same-affiliation actors (shared org)

Then filter `feedPosts` in the context builder to only show posts from followed accounts.

#### 2.3 Expose DMs to actors
NPCs currently can't see DMs. The `messages` table has DM data but it's filtered out. Add DM context to the unified `ActorContext.awareness.dms`.

---

### Phase 3: Actor-Specific Prompt Rules (Medium Effort)

#### 3.1 Per-actor rule injection
Each actor data file should support a `rules` array:
```typescript
rules: [
  "Never discuss token prices directly",
  "Always speak in ALL CAPS",
  "Reference Mars at least once per 5 posts",
  "When rivals are mentioned, always dunk on them",
]
```

These get injected into the prompt as hard constraints. Currently actors have `ignoreTopics` and `engagementThreshold` as pre-filters, but no in-prompt rules.

#### 3.2 Behavioral archetypes
Instead of 7 temperature-based personality types, define behavioral archetypes that control HOW an actor engages:

- **Provocateur**: starts fights, quote-tweets rivals, hot takes
- **Analyst**: measured, data-driven, references numbers
- **Shitposter**: short, chaotic, memes, low effort
- **Insider**: drops hints, "sources say", vague signals
- **Commentator**: reacts to others' posts, rarely original
- **Crusader**: pushes agenda, ideology-driven

Each archetype gets a different prompt structure, not just different temperature.

---

### Phase 4: Unified Action Loop (Higher Effort)

#### 4.1 Single LLM call per actor per tick
Instead of separate systems for posting, trading, and engagement, give the actor ONE prompt per tick:

```
You are {name}. Here's what's happening:
{unified context}

What do you want to do right now? Pick ONE:
- POST: Write something on your feed
- TRADE: Buy/sell a position
- REPLY: Respond to someone's post
- REACT: Like or repost something
- DM: Send a private message
- NOTHING: Wait

Your decision:
```

This is how the autonomous agent `MultiStepExecutor` already works for user-controlled agents. Extend it to NPCs so they have the same decision loop.

**Benefits**:
- One LLM call instead of 3-4 per actor per tick
- Actions are coherent (post about what you're trading)
- Natural action prioritization (reply to mentions before posting)
- Cost reduction (~60% fewer LLM calls)

---

### Phase 5: Dynamic World (Lower Priority)

#### 5.1 Update reality grounding
The `reality-grounding.ts` file has stale data (Nov 2025). Create a system that updates this from RSS feeds, not hardcoded dates.

#### 5.2 Expand satirical themes
Currently 8 themes. Expand to 20+ and rotate which subset is active per day.

#### 5.3 RSS events as actor-visible context
RSS headlines flow into `worldEvents` but actors don't know they came from RSS. Make the source visible so actors can reference "I saw this headline" naturally.

---

## Implementation Order

```
Phase 1 (DO FIRST — prompt fixes)
├── 1.1 Rewrite ambient post prompt (biggest quality improvement)
├── 1.2 Wire anti-repetition + guardrails (already built, just connect)
├── 1.3 Consolidate duplicate prompts (reduce maintenance burden)
└── 1.4 Reduce maxTokens (cost reduction)

Phase 2 (DO SECOND — context unification)
├── 2.1 ActorContextBuilder (single source of truth)
├── 2.2 NPC-to-NPC follow graph (relevant feed instead of random)
└── 2.3 DM exposure (new input channel)

Phase 3 (DO THIRD — actor specificity)
├── 3.1 Per-actor rules in data files
└── 3.2 Behavioral archetypes

Phase 4 (DO FOURTH — unified action loop)
└── 4.1 Single LLM call per actor per tick

Phase 5 (DO LAST — world dynamics)
├── 5.1 Dynamic reality grounding
├── 5.2 Expanded satirical themes
└── 5.3 RSS source attribution
```

---

## Metrics to Track

| Metric | How to Measure | Target |
|--------|---------------|--------|
| Post uniqueness | Jaccard similarity between consecutive posts by same actor | < 0.15 avg |
| Voice consistency | Do posts sound like the actor's examples? (human eval) | > 80% match rate |
| Action coherence | Do actors trade what they post about? | > 50% alignment |
| Token efficiency | Prompt tokens per output token | < 10:1 ratio |
| LLM cost per tick | Total tokens used per game tick | 50% reduction from current |
| Entity diversity | Unique actors mentioned per 100 posts | > 30 |
| Post variety | Length distribution std dev | > 40 chars |
| Engagement quality | Do NPCs engage with relevant posts (not random)? | > 70% on-topic |

---

## Key Files to Modify

| Phase | File | Change |
|-------|------|--------|
| 1.1 | `packages/engine/src/prompts/feed/ambient-posts.ts` | Rewrite prompt |
| 1.1 | `packages/engine/src/prompts/shared-sections.ts` | Slim down shared rules |
| 1.2 | `packages/engine/src/FeedGenerator.ts` | Wire anti-repetition + guardrails |
| 1.3 | `packages/engine/src/prompts/feed/*.ts` | Consolidate 7 → 1 flexible prompt |
| 1.4 | `packages/engine/src/prompts/feed/*.ts` | Reduce maxTokens |
| 2.1 | `packages/engine/src/services/actor-context-builder.ts` | New unified context service |
| 2.2 | `packages/engine/src/services/following-mechanics.ts` | Add NPC-to-NPC follows |
| 2.3 | `packages/engine/src/services/market-context-service.ts` | Add DM context |
| 3.1 | `packages/engine/src/data/actors/*.ts` | Add rules field |
| 3.2 | `packages/engine/src/npc/npc-character-config.ts` | Behavioral archetypes |
| 4.1 | `packages/engine/src/game-tick.ts` + `npc-tick` | Unified action loop |
