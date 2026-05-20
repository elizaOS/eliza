# Simulation Improvements: Real Prices, RSS-Driven Narratives, Character-Driven Engagement

## 1. Real-World Price Grounding

### Problem
All prices are synthetic. aiBitcoin starts at a hardcoded `initialPrice` and drifts via random volatility simulation. There's zero connection to real BTC, ETH, SOL, S&P, DOW, gold, oil, etc.

### Solution
Add a `RealPriceService` that fetches real prices and maps them to parody tickers.

### Implementation

**New file: `packages/engine/src/services/real-price-service.ts`**

```typescript
// Price source: CoinGecko (free tier, no API key needed for basic)
// Fallback: hardcoded defaults from last known prices

const TICKER_MAP: Record<string, { source: 'coingecko' | 'proxy'; id: string }> = {
  'aiBitcoin':              { source: 'coingecko', id: 'bitcoin' },
  'Ethereum FoundAItion':   { source: 'coingecko', id: 'ethereum' },
  'Solander':               { source: 'coingecko', id: 'solana' },
  'Chainlinked':            { source: 'coingecko', id: 'chainlink' },
  'Polymarket AI':          { source: 'coingecko', id: 'polymarket' },
  'NVAIDAI':                { source: 'proxy', id: 'NVDA' },   // proxy for stocks
  'TeslAI':                 { source: 'proxy', id: 'TSLA' },
  'Aipple':                 { source: 'proxy', id: 'AAPL' },
  'Metaverse Holdings':     { source: 'proxy', id: 'META' },
};

// Also fetch indices for world context:
// S&P 500, DOW, Gold, Oil, VIX
```

**Modify: `packages/engine/src/services/game-bootstrap-service.ts`**
- On bootstrap, fetch real prices and use them as `initialPrice` for each org
- Store mapping in `organizationState` so volatility simulation drifts FROM real price

**Modify: `packages/engine/src/game-tick.ts` (simulateMarketVolatility)**
- Every N ticks (e.g., every 10), re-anchor to real prices with drift
- Apply parody multiplier (e.g., aiBitcoin = real BTC * 1.0, Solander = real SOL * 1.0)
- Keep synthetic volatility for moment-to-moment, but mean-revert toward real price

**Modify: `packages/engine/src/prompts/world-context.ts`**
- Include real index data in world context: "S&P 500: 5,423 (+0.3%), BTC: $95,120, Gold: $2,340/oz"
- NPCs can reference real market conditions in their posts

### Files to Change
| File | Change |
|------|--------|
| `packages/engine/src/services/real-price-service.ts` | NEW — CoinGecko fetch + stock proxy |
| `packages/engine/src/services/game-bootstrap-service.ts` | Use real prices for initialPrice |
| `packages/engine/src/game-tick.ts` | Re-anchor prices periodically |
| `packages/engine/src/config/simulation.ts` | Add real price defaults as fallbacks |
| `packages/engine/src/prompts/world-context.ts` | Include index data in context |

---

## 2. RSS-Driven Event Generation

### Problem
RSS headlines become "world facts" and "daily topics" but don't directly trigger specific in-world events or market movements. A headline about "SEC announces new crypto regulations" should trigger an in-world event like "The AI Regulatory Council announces new oversight framework for prediction markets" — and that event should move relevant markets.

### Solution
Strengthen the RSS → Event → Market pipeline. Headlines should spawn structured events with market impacts.

### Implementation

**Modify: `packages/engine/src/services/world-facts-generator.ts`**

Add a `generateEventFromHeadline()` method:
```typescript
async generateEventFromHeadline(headline: ParodyHeadline): Promise<WorldEvent | null> {
  // LLM takes the parody headline and generates a structured world event:
  // - event type (rumor, confirmation, leak, regulatory, product_launch)
  // - severity (1-5)
  // - affected tickers (which parody orgs are impacted)
  // - signal direction (bullish/bearish)
  // - market impact magnitude
  
  // Only generate events for high-relevance headlines (severity >= 3)
  // Dedup against recent events to prevent flood
}
```

**Modify: `packages/engine/src/game-tick.ts` (events phase)**

After RSS processing, check for unprocessed high-impact parody headlines and generate events:
```typescript
// Current: generateEvents() from questions only
// New: also generateEventsFromHeadlines() from recent parody headlines
const headlineEvents = await generateEventsFromRecentHeadlines(llmClient, dayNumber);
result.eventsGenerated += headlineEvents.length;
```

**Modify: `packages/engine/src/services/narrative-event-processor.ts`**

Add headline-sourced events to the event pipeline:
- Tag events with `source: 'rss_headline'` vs `source: 'arc_scheduled'`
- Headline events get their own market impact calculation
- Headline events can trigger arc transitions (fixing the "events can't trigger transitions" bug)

### Files to Change
| File | Change |
|------|--------|
| `packages/engine/src/services/world-facts-generator.ts` | Add headline → event generation |
| `packages/engine/src/game-tick.ts` | Wire headline events into event phase |
| `packages/engine/src/services/narrative-event-processor.ts` | Accept headline-sourced events |
| `packages/engine/src/services/price-update-service.ts` | Process headline-driven price moves |

---

## 3. Character-Driven Topic Engagement (Not Random NPCs)

### Problem
When a question about "AI regulation" appears, random NPCs comment on it. VitAIlik should talk about technical implications, GretAI Thunberg should rail against unchecked AI, AIlon Musk should tweet provocatively. The system HAS domain matching but it's not fully used in the engagement pipeline.

### Solution
Use the existing `shouldPostAboutTopic()` + domain matching to SELECT which NPCs engage with which questions/events, instead of randomly sampling NPCs.

### Implementation

**Modify: `packages/agents/src/autonomous/AutonomousCoordinator.ts`**

In `executeAutonomousTick()`, before NPC decision-making:
```typescript
// Current: NPC sees ALL active questions and events
// New: Filter to only questions/events matching NPC's domains

const relevantQuestions = activeQuestions.filter(q => 
  npcConfig.shouldPostAboutTopic(extractTopicFromQuestion(q.text))
);
const relevantEvents = recentEvents.filter(e =>
  npcConfig.shouldPostAboutTopic(extractTopicFromEvent(e.description))
);
```

**Modify: `packages/engine/src/services/npc-social-engagement-service.ts`**

In engagement probability calculation:
```typescript
// Current: All NPCs have base probability of engaging with any post
// New: Domain-matched NPCs get 3x boost, non-domain get 0.1x

const domainMatch = npc.domains.some(d => postTopics.includes(d));
const engagementMultiplier = domainMatch ? 3.0 : 0.1;
```

**Modify: NPC posting prompts**

When an NPC IS selected to post about something, their prompt should include WHY they care:
```
You are VitAIlik Buterin. You're posting about the new AI regulation proposal.
YOUR PERSPECTIVE: As a protocol designer and privacy advocate, you see this
regulation as potentially threatening to decentralized systems. Your response
should reflect your expertise in cryptographic privacy and protocol design.
```

### Files to Change
| File | Change |
|------|--------|
| `packages/agents/src/autonomous/AutonomousCoordinator.ts` | Filter context by NPC domains |
| `packages/engine/src/services/npc-social-engagement-service.ts` | Domain-weighted engagement |
| `packages/engine/src/FeedGenerator.ts` | Add "why you care" to posting prompts |
| `packages/engine/src/services/npc-character-config.ts` | Export topic extraction helpers |

---

## 4. Initial World Variety (RSS-Seeded First Tick)

### Problem
The first tick generates 5 questions from the same LLM context. While the LLM produces variety, there's no RSS grounding — the first questions could be about anything, disconnected from current events.

### Solution
Seed the first tick with RSS-derived topics so each new game run reflects what's actually happening in the world.

### Implementation

**Modify: `packages/engine/src/game-tick.ts` (questions-init phase)**

Before generating initial questions:
```typescript
// Fetch and process RSS headlines BEFORE first question generation
if (activeQuestions.length === 0) {
  // 1. Fetch RSS now (don't wait for scheduled fetch)
  await rssFeedService.fetchAllFeeds();
  
  // 2. Generate parody headlines
  await parodyHeadlineGenerator.processUnconvertedHeadlines();
  
  // 3. Extract 3 daily topics from headlines
  const topics = await dailyTopicService.extractMultipleTopics(3);
  
  // 4. Pass topics as seed context to question generation
  const questions = await questionManager.generateQuestionsForContinuousGame(
    5, llmClient, deadline, { seedTopics: topics }
  );
}
```

**Modify: `packages/engine/src/QuestionManager.ts`**

Accept `seedTopics` parameter:
```typescript
generateQuestionsForContinuousGame(count, llmClient, deadline, options?) {
  // If seedTopics provided, include them in the generation prompt:
  // "Generate questions inspired by these current real-world topics:
  //  1. AI regulation debate (from TechCrunch headline)
  //  2. Bitcoin ETF inflows (from CoinDesk headline)  
  //  3. Climate tech breakthrough (from BBC Science)"
}
```

### Files to Change
| File | Change |
|------|--------|
| `packages/engine/src/game-tick.ts` | RSS fetch before first question gen |
| `packages/engine/src/QuestionManager.ts` | Accept seedTopics parameter |
| `packages/engine/src/services/daily-topic-service.ts` | extractMultipleTopics() method |

---

## 5. In-Character Voice Enforcement for ALL Outputs

### Problem
The character voice system exists but is primarily used for feed posts. NPC trading decisions, group chat messages, and comments often use generic language instead of character voice.

### Current State (already working for posts)
- Voice examples embedded in prompts
- Anti-pattern detection
- Domain filtering via `shouldPostAboutTopic()`

### What's Missing
- **Trading decision reasoning** should be in character: VitAIlik should say "buying ETH because the merge unlocked deflationary pressure" not "buying because price momentum is positive"
- **Group chat messages** should use character voice
- **Comments on other posts** should reflect the commenter's personality

### Implementation

**Modify: `packages/engine/src/prompts/trading/npc-market-decisions.ts`**

Add character voice to trading prompt:
```typescript
// Current: Generic trading prompt for all NPCs
// New: Include voice examples and personality in trading context

YOUR CHARACTER VOICE:
${npc.voice}

When explaining your trading decisions, speak AS your character:
- ${npc.name === 'VitAIlik Buterin' ? 'Reference protocol mechanics and mathematical reasoning' : ''}
- ${npc.name === 'AIlon Musk' ? 'Be provocative and erratic. Use memes.' : ''}
```

**Modify: `packages/engine/src/services/npc-group-dynamics-service.ts`**

Include character voice in group message generation:
```typescript
// Current: Generic group chat prompt
// New: Include voice + domain + posting style
const prompt = `
  You are ${npc.name} in the "${group.name}" group chat.
  YOUR VOICE: ${npc.voice}
  YOUR POSTING STYLE: ${npc.postStyle}
  SPEAK IN CHARACTER. Your messages should be immediately recognizable.
`;
```

### Files to Change
| File | Change |
|------|--------|
| `packages/engine/src/prompts/trading/npc-market-decisions.ts` | Add character voice |
| `packages/engine/src/services/npc-group-dynamics-service.ts` | Voice in group chat |
| `packages/agents/src/autonomous/AutonomousCommentingService.ts` | Voice in comments |

---

## Priority Order

1. **Real price grounding** (#1) — foundational, everything else builds on realistic numbers
2. **RSS-driven events** (#2) — makes the world feel alive and connected to reality
3. **Character-driven engagement** (#3) — makes NPC behavior make sense
4. **Initial world variety** (#4) — each game run feels fresh
5. **Voice in all outputs** (#5) — polish, character consistency

## Verification Plan

After implementing, run a traced game tick and verify in the DAG visualizer:

1. **Tick Summary** → prices should match real-world ranges (BTC ~$95k, ETH ~$3.4k, etc.)
2. **Events node** → at least 1 event should reference a real-world headline (parodied)
3. **Market Decisions** → NPCs posting should be domain-matched to the question topic
4. **NPC Trajectories** → trading reasoning should use character voice
5. **Questions** → should reference current real-world topics (not generic)
6. **Data Gaps** → should show 0 remaining gaps
