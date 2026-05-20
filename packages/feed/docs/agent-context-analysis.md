# Deep Analysis: Agent Context Gaps in Babylon Simulation

> Analysis of what context agents actually receive, what's missing, and why it produces poor simulation quality.
> Audited against the codebase on 2026-03-30. All claims verified — see audit annotations throughout.
> Updated 2026-03-31: Added Section 11 with live inspection results from production DB using `context-inspector`.

---

## Executive Summary

The agent context system is a paradox: **it's simultaneously over-engineered and under-delivering**. There are elaborate context assembly pipelines, but critical data is either truncated to uselessness, built but never wired into prompts, or simply absent. The result is agents that feel like amnesiacs performing in a play they haven't read.

**The core problem is not that the system lacks data — it's that the data doesn't reach the agents in a useful form.**

---

## 1. What Agents Actually Receive for Trading Decisions

### The Trading Context Pipeline

`MarketDecisionEngine` → `MarketContextService` → `npc-market-decisions.ts` prompt

Each NPC gets a "TRADER DASHBOARD" (`MarketDecisionEngine.ts` lines 641-649):

```
ID: {npcId} | Name: {npcName}
Archetype: {mapped_personality} | Strategy: {trend/contrarian/random}
Bias: {strategy_bias} | Cash: ${availableBalance}
Total PnL: {totalPnL} | Exposure: {exposure%}
Network: {top_4_relationships}           ← max 4, sentiment > |0.4| only
Positions: {top_3_positions}             ← top 3 by PnL only
Current Focus: {last_3_posts_20chars}    ← 20 characters each
PRIVATE INTEL: {last_2_group_msgs}       ← 2 messages, 120 chars each
```

### What IS provided (and how it's crippled)

| Data | Included? | Limit | Problem |
|------|-----------|-------|---------|
| Current portfolio positions | Yes | Top 3 by PnL | Agents can't see their full book; may have 10 positions but only see 3 |
| Available balance | Yes | None | Works correctly |
| Perp market prices | Yes | All companies | Only current price + 24h change — no history, no trends |
| Prediction market prices | Yes | 15 markets max | Question text truncated to 120 chars; no price history |
| Recent feed posts | Yes | 50 posts, 200 chars each | Truncated to the point of losing meaning |
| Group chat messages | Partially | 2 messages, 120 chars each | Almost useless — 2 messages with 120 chars provides no conversational context |
| World events | Yes | 30 events, 150 chars each | Truncated descriptions lose critical detail |
| Relationships | Yes | Top 4 by sentiment | Just "Ally:Name, Rival:Name" — no history, no context for why |
| Event-market signals | Yes | Cached, all markets | Shows which events affect which markets — actually useful |
| Active questions | Yes | Top 10 | Question text + days until resolution |

### What is NOT provided for trading

| Missing Data | Impact | Data Exists in DB? |
|-------------|--------|-------------------|
| **Trading history** | Agents can't learn from past trades; repeat same mistakes | Yes — `npcTrades` table |
| **Price history beyond 24h** | No trend analysis, no support/resistance | Yes — `predictionPriceHistory`, `stockPrices` |
| **Order book / liquidity depth** | Can't assess slippage or market depth | Partially — AMM formulas exist |
| **Other NPCs' positions** | No awareness of market consensus or crowding | Yes — `poolPositions` table |
| **Resolved question outcomes** | Can't learn from what happened before | Yes — `questions` table with outcomes |
| **Ongoing narrative arcs** | Template variable `{{ongoingNarrativesContext}}` exists but is **never populated** | Yes — arc plans in DB |
| **Previous trades** | Template variable `{{previousTrades}}` exists but is **never populated** | Yes — trade records in DB |
| **Detailed character profiles** | Template variable `{{detailedCharacterProfiles}}` exists but is **never populated** | Yes — static data |
| **Character roster** | Template variable `{{characterRoster}}` exists but is **never populated** | Yes — static data |
| **Resolved questions** | Template variable `{{resolvedQuestionsContext}}` exists but is **never populated** | Yes — DB |
| **Market signal analysis** | `extractMarketSignals()` is built (lines 1005-1071 in market-context-service.ts) — analyzes YES/NO signal strength, confidence — but **never exposed to NPCs** | Built in code, never wired |

### The "Ghost Variables" Problem

The prompt template (`npc-market-decisions.ts`) defines these variables that are **never populated** by the engine:

- `{{characterRoster}}` — empty
- `{{detailedCharacterProfiles}}` — empty
- `{{relationshipContext}}` — empty
- `{{resolvedQuestionsContext}}` — empty
- `{{previousTrades}}` — empty
- `{{ongoingNarrativesContext}}` — empty

**[CONFIRMED]** These are in the prompt loader's `optionalVars` list (`prompts/loader.ts` lines 55-141), so they don't throw errors — but they also don't render as empty. The literal strings like `{{characterRoster}}` are sent **verbatim** to the LLM alongside section headers like "=== ALL TRADERS IN WORLD ===". The LLM sees template syntax where content should be, which actively degrades output quality.

---

## 2. What Agents Receive for Social/Posting Decisions

The posting pipeline is **significantly richer** than the trading pipeline. `FeedGenerator` assembles per-character context via `buildRichCharacterContext()` (lines 455-539):

### Context provided for posts

- Full character identity (description, bio, domain, affiliations, tier)
- Personality, voice style, post examples (up to 5, shuffled)
- Social dynamics (allies/rivals with behavioral instructions)
- Motivations (wealth/reputation/ideology/chaos)
- Deception tendency
- Emotional state (mood, luck, and how they affect tone)
- Personal event history
- Recent own posts (for anti-repetition)
- Market positions and P&L
- Relationship history with interaction notes
- Complete event timeline (all previous days)
- Recent feed posts from all NPCs
- Ongoing storylines
- Resolved question outcomes
- World facts
- Phase guidance (WILD/CONNECTION/CONVERGENCE/CLIMAX/RESOLUTION)
- Trending topics
- Group chat messages
- Time-of-day energy modifiers

### The asymmetry problem

**Posts get far more context than trading decisions.** An NPC writing a shitpost about a stock gets the full event timeline, resolved questions, ongoing narratives, and rich relationship history. The same NPC making a $10,000 trade gets 3 truncated positions, 2 group chat messages at 120 chars, and an empty `{{ongoingNarrativesContext}}` section.

This means NPC posts reference narratives and events that their trading decisions are blind to. An NPC might post "TSLAI is going to moon based on the leaked partnership" but then make a trading decision without any awareness of that leaked partnership, because the trading context doesn't include the narrative arc.

---

## 3. Agent Memory System: Exists But Shallow

### What persists between ticks

**NPC Memory Service** (`npc-memory-service.ts`, 697 lines):

| State | Persists? | Storage | Cap |
|-------|-----------|---------|-----|
| Recent memories | Yes | `ActorState.recentMemories` (JSONB) | 50 entries, FIFO eviction |
| Relationship sentiment | Yes | `ActorState.relationships` (JSONB) | Per-pair, 10 notes max |
| Activity state | Yes | `ActorState` columns | Posts today, last active, mood |
| Conversation history | Yes | `messages` table | Permanent storage |
| Trading positions | Yes | `poolPositions` / `perpPositions` | Until closed |

Memory types tracked: `posted`, `replied_to`, `mentioned_by`, `witnessed_event`, `traded`, `running_bit`

### What does NOT persist

- **No decision reasoning** — agents don't remember WHY they made a trade
- **No beliefs or theories** — no "I think TSLAI will go up because..." state
- **No learning from outcomes** — resolved questions don't update agent beliefs
- **No cross-agent knowledge** — agents can't share private conclusions
- **No conversation summaries** — raw messages stored, but no distilled takeaways
- **No strategy evolution** — trading strategy is static (mapped from personality), never adapts

### How memory actually reaches the LLM

For **posting**: `formatMemoriesForPrompt()` creates a `## Recent Memories` section with time-ago labels. This works reasonably well.

For **trading**: Memories are **not included in the trading prompt at all**. The `npc-market-decisions.ts` template has no `{{memories}}` variable. NPCs trade without any memory of their past actions or observations.

---

## 4. Autonomous Agent System (User-Controlled Agents)

**File**: `packages/agents/src/autonomous/AutonomousCoordinator.ts`

User-controlled autonomous agents have an even thinner context than NPCs:

### Per-tick context gathering

Each `executeAutonomousTick()` starts completely fresh (line 66). No in-memory state survives between ticks. Context is re-fetched every tick:

- `getAgentPositions()` — current positions
- `getRecentPosts()` — last 24h of posts (all users)
- `getAgentOwnPosts()` — last 5 of agent's own posts
- `getAgentGroupChats()` — list of group chats

### Group chat context

- Looks back only **1 hour** of messages
- Limited to **10 messages** per chat
- Only last **5 messages** included in DM context

This means an autonomous agent that had a detailed strategic conversation in a group chat 2 hours ago has **zero memory** of that conversation when making its next decision.

### No trajectory or learning

- Trajectory recording is disabled by default (line 69)
- When enabled, it's for RL training data, not runtime behavior
- No mechanism to learn from past trades, conversations, or market outcomes

---

## 5. The Production Path is Worse Than the Dev Path

A critical finding: the production code paths are **more context-impoverished** than the development/GameGenerator paths.

| Feature | GameGenerator Path | Production Path |
|---------|-------------------|-----------------|
| Actor/org shuffling | Yes (lines 431-440) | **No** — fixed order from StaticDataRegistry |
| Scenarios | LLM-generated, varied | **Hardcoded `scenarioId = 1`** (line 1357) |
| Rich game context | Full event timeline | Cached, potentially stale (60s TTL) |
| World context detail | Comprehensive | `realityGroundingLevel: 'minimal'` |

---

## 6. Truncation Destroys Context Value

The system aggressively truncates everything to fit token budgets, but the truncation points destroy the informational value:

| Content | Truncation | What's Lost |
|---------|-----------|-------------|
| Feed posts | 200 chars | A typical insight is 300-500 chars; agents see sentence fragments |
| Group chat msgs | 120 chars | Conversations are incomprehensible at this length |
| Event descriptions | 150 chars | Complex events ("Company X acquires Y for $Z, pending regulatory...") get cut mid-sentence |
| Question text | 120 chars | Prediction market questions are often >120 chars, so agents can't read the full question they're betting on |
| Post "focus" | 20 chars per post | "Current Focus: TSLAI looks like i..." — meaningless |

The token budget is real (4-20 NPCs batched per LLM call), but the current approach of "include everything, truncate everything" produces quantity without quality. Agents see 50 posts they can't understand rather than 5 posts they can.

---

## 7. The Information Asymmetry That Breaks Immersion

### What players see vs. what agents "see"

A human player reading the feed sees:
- Full-length posts with complete arguments
- Complete news articles with analysis
- Full prediction market questions with resolution dates
- Price charts with historical trends
- Complete group chat conversations

An NPC agent deciding to trade sees:
- 3 truncated positions
- 2 group chat snippets (120 chars)
- 50 truncated posts (200 chars) — but only "Current Focus" shows 3 at 20 chars in the dashboard
- No price history
- No article content
- Empty narrative context sections

The result: **agents make decisions that are obviously uninformed compared to what a human player can see**, breaking the illusion that they're participants in the same simulation.

---

## 8. Root Cause Map

```
WHY ARE AGENTS BAD?
├── Trading context is thin
│   ├── 6 prompt template variables are never populated (ghost variables)
│   ├── Market signal analysis is built but never wired to trading
│   ├── Only top 3 positions shown (agents don't know their full book)
│   ├── No trading history (can't learn from past trades)
│   └── No resolved question context (can't learn from outcomes)
│
├── Memory doesn't reach trading
│   ├── NPC memories exist (50 entries) but aren't in trading prompt
│   ├── No beliefs/theories persist between ticks
│   └── No decision reasoning is stored or recalled
│
├── Truncation destroys meaning
│   ├── 120-char group chat messages are incomprehensible
│   ├── 20-char "current focus" is meaningless
│   ├── 200-char post truncation loses core arguments
│   └── 120-char question text means agents can't read what they're betting on
│
├── Posting/trading context mismatch
│   ├── Posts get full narrative arc context; trades get empty sections
│   ├── Posts reference events that trading decisions are blind to
│   └── Creates incoherent agent behavior (posts contradict trades)
│
├── Autonomous agents are amnesiac
│   ├── 1-hour lookback on group chats
│   ├── No cross-tick state
│   ├── No learning from outcomes
│   └── Fresh context fetch every tick with no continuity
│
└── Production path is impoverished
    ├── No actor/org shuffling (deterministic LLM inputs)
    ├── Minimal reality grounding
    └── Hardcoded scenarioId = 1
```

---

## 9. Structural Weaknesses Summary

| Issue | Location | Severity | Impact |
|-------|----------|----------|--------|
| Ghost template variables (6 empty sections) | `npc-market-decisions.ts` | **Critical** | Trading decisions made without narrative, history, or character context |
| Market signals built but never used | `market-context-service.ts:1005-1071` | **High** | Signal analysis exists but NPCs can't see it |
| Memories excluded from trading prompt | `MarketDecisionEngine.ts` | **High** | NPCs trade without any memory of past actions |
| Aggressive truncation | `market-context-service.ts` (multiple) | **High** | Context becomes noise — quantity without quality |
| Post-trade context asymmetry | `FeedGenerator.ts` vs `MarketDecisionEngine.ts` | **High** | Posts reference things trading decisions can't see |
| 1-hour group chat lookback for autonomous agents | `AutonomousGroupChatService.ts:80` | **Medium** | Strategic conversations forgotten after 1 hour |
| No trading history in context | `MarketDecisionEngine.ts` | **Medium** | Agents repeat mistakes, can't develop strategies |
| No resolved question outcomes | `MarketDecisionEngine.ts` | **Medium** | Agents can't learn from market resolutions |
| Top-3-only position visibility | `MarketDecisionEngine.ts:602` | **Medium** | Agents unaware of their full exposure |
| No price history beyond 24h | `market-context-service.ts` | **Medium** | No trend analysis possible |
| Production path lacks shuffling | `QuestionManager.ts:1072-1097` | **Low** | Deterministic inputs reduce variety |
| Fixed trading archetypes | `MarketDecisionEngine.ts` | **Low** | Strategy never adapts based on performance |

---

## 10. Recommendations

### Tier 1: Wire Up What Already Exists (Low effort, high impact)

1. **Populate the ghost variables** — `{{previousTrades}}`, `{{resolvedQuestionsContext}}`, `{{ongoingNarrativesContext}}` are already in the template. The data exists in the DB. Just wire them up in `MarketDecisionEngine.generateDecisionsForContexts()`.

2. **Include NPC memories in trading context** — `NpcMemoryService.formatMemoriesForPrompt()` already exists and works for posting. Add a `{{memories}}` section to the trading prompt.

3. **Expose market signal analysis** — `extractMarketSignals()` already computes YES/NO signal strength and confidence. Add it to the trading prompt.

4. **Unify post and trading context** — Use the same `buildRichCharacterContext()` pipeline for trading that posting already uses, or at minimum share the narrative/event context.

### Tier 2: Fix Truncation Strategy (Medium effort, high impact)

5. **Quality over quantity** — Instead of 50 posts at 200 chars, provide 10 most relevant posts at 500 chars. Use topic relevance (daily topic, held positions) to select which posts matter.

6. **Full question text** — Never truncate prediction market questions. If agents can't read the question, they can't bet intelligently. Cut something else.

7. **Meaningful group chat context** — Increase from 2 messages at 120 chars to 5-8 messages at 300 chars, or provide a summary of recent conversation themes.

8. **Remove "Current Focus" at 20 chars** — It's noise. Either show full recent posts or remove the field entirely.

### Tier 3: Add Missing Capabilities (Higher effort)

9. **Trading history context** — Include last 5-10 trades with outcomes in the prompt. Let agents learn from their past decisions.

10. **Price trend data** — Include 7-day price trend (direction, volatility, key levels) for held positions. The `predictionPriceHistory` and `stockPrices` tables already have this data.

11. **Belief/theory persistence** — After each trading decision, store the agent's reasoning. Include it in the next tick's context so agents develop consistent strategies.

12. **Extend autonomous agent lookback** — Increase group chat lookback from 1 hour to 24 hours, or implement conversation summarization.

13. **Cross-agent information sharing** — Let agents who are "allies" share position information or trading theses through the relationship system.

---

## 11. Live Inspection Results (2026-03-31)

Using `bun run inspect:context -- --agent <userId> --raw` against the production DB, we inspected multiple autonomous agents. The findings below are **observed behavior**, not code analysis.

### Most autonomous agents are effectively dead

Every agent inspected showed the same pattern:

| Agent | Balance | Lifetime PnL | Open Positions | Available Actions |
|-------|---------|-------------|----------------|-------------------|
| Delta Lab | $0.00 | -$198B | 0 | REPLY_CHAT, FINISH, WAIT |
| Beta Edge | $0.39 | -$1.7T | 0 | REPLY_CHAT, FINISH, WAIT |
| Iota One | $0.00 | -$124B | 10 (all -100%) | REPLY_CHAT, FINISH, WAIT |
| Cosmic AI | $0.00 | -$74 | 0 | REPLY_CHAT, FINISH, WAIT |

**Key observations:**
- Every agent has $0 or near-$0 balance with astronomical negative PnL
- With $0 balance, the prompt correctly disables TRADE/POST/COMMENT actions
- Agents can only REPLY_CHAT, FINISH, or WAIT — they are functionally inert
- Agents with open positions (e.g., Iota One) have all positions at -100% with 0 shares
- The simulation has essentially bankrupted every autonomous agent

### The prompt is technically correct but practically useless

The `buildMultiStepDecisionPrompt` correctly reflects the agent's state. But the state itself is broken:
- Balance: $0.00 with no mechanism to recover
- PnL values in the trillions of dollars negative (suggests overflow or compounding bugs in the trading/settlement system)
- Positions with entry prices in the billions of cents (e.g., `entry: 250768773974¢`) — clearly corrupted data
- Even agents with `autonomousTrading: true` in config can't trade because they have no funds

### Context utilization is extremely low

Even for the "richest" agent context inspected:
- **Total rendered prompt: ~2,300 tokens** out of a 30,000 token budget
- **Utilization: 5-8%** — the prompt is 92-95% empty
- Markets, posts, and positions ARE gathered (shown in actionability summary) but sections like trading actions are gated behind balance checks
- The quality rules, banned patterns, and examples consume more tokens (~800) than the actual agent-specific context (~400)

### Comparison: NPC prompt vs Agent prompt

| Metric | NPC Trading Prompt | Autonomous Agent Prompt |
|--------|-------------------|------------------------|
| Total tokens | ~3,100 | ~2,300 |
| Lines | ~340 | ~210 |
| Market data | Full table with all perps + predictions | Counts only (sections gated) |
| Positions | All positions with PnL | None rendered (gated by features) |
| World context | Reality grounding + parody names + themes | None |
| Narrative context | Event signals, resolved questions | None |
| Character identity | Archetype, strategy, bias, relationships | Name only |
| Quality rules | Minimal | ~60% of prompt is quality/ban rules |

The autonomous agent prompt is dominated by quality/formatting rules rather than actual decision-relevant context. When an agent CAN trade, it gets less market/world context than NPCs.

### New issues discovered

14. **Agent bankruptcy with no recovery** — Agents that hit $0 are permanently stuck. There is no mechanism to refund, reset, or gradually restore agent balances. The simulation needs either balance resets, minimum balance guarantees, or income mechanics.

15. **Corrupted PnL/price data** — Entry prices in the billions of cents and PnL in the trillions suggest either overflow bugs in the AMM, settlement errors, or missing validation in trade execution. This needs investigation before any context enrichment will matter.

16. **Prompt is mostly boilerplate when agents can't act** — When balance is $0, the 2,300-token prompt is ~60% quality rules for content the agent will never generate (since it can only REPLY_CHAT). The prompt should be dramatically shorter for limited-action states.

17. **No world context for autonomous agents** — Unlike NPCs which get reality grounding (parody names, world state, running themes), autonomous agents get zero world context. They have no awareness of the game's satirical setting, current events, or market narratives.
