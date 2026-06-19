# Agent Context System Audit v2

> Fresh audit conducted 2026-03-31 against `feat/agent-context-enrichment-v2` branch.
> Validates all changes from PRs #1388, #1389, #1392, #1394, #1399, #1401.

---

## What's Fixed (Verified)

### NPC Trading Context

| Original Issue | Status | Evidence |
|---|---|---|
| Ghost variables sent as literal `{{varName}}` to LLM | **FIXED** | `loader.ts` cleanup loop strips unpopulated optional vars |
| `{{resolvedQuestionsContext}}` empty | **FIXED** | `getCachedResolvedQuestions()` queries resolved questions with `resolvedOutcome` |
| `{{previousTrades}}` empty | **FIXED** | `getCachedPreviousTrades()` fetches last 24h from `npcTrades` table |
| `{{marketSignalAnalysis}}` not wired | **FIXED** | `formatMarketSignals()` formats signal data into prompt |
| NPC memories excluded from trading | **FIXED** | Batched `IN(...)` query on `actorState`, appended to dashboards |
| Posts: 50 at 200 chars | **FIXED** | Now 15 at 500 chars |
| Events: 30 at 150 chars | **FIXED** | Now 20 at 300 chars |
| Group chat: 2 msgs at 120 chars | **FIXED** | Now 8 msgs at 300 chars in context service |
| Question text truncated at 120 chars | **FIXED** | Never truncated; `buildPredictionMarketSnapshot()` called without `maxQuestionLength` |
| "Current Focus" at 20 chars | **FIXED** | Field removed from dashboard |
| Top-3 position limit | **FIXED** | All positions shown |
| Reality grounding: `'minimal'` | **FIXED** | Upgraded to `'concise'` |
| 4 empty section headers in template | **FIXED** | Removed `characterRoster`, `detailedCharacterProfiles`, `relationshipContext`, `ongoingNarrativesContext` headers |
| Market table: no trend data | **FIXED** | 24h range column added |
| Market table: prediction IDs only | **FIXED** | Full question text + days remaining |

### Autonomous Agent Context

| Original Issue | Status | Evidence |
|---|---|---|
| No world context | **FIXED** | `generateWorldContext()` called in `MultiStepExecutor.gatherContext()`, injected as `# World Context` |
| 1-hour group chat lookback | **FIXED** | Now 24 hours, 15 messages |
| Quality rules always included (800 tokens) | **FIXED** | Conditional on `canGenerateContent` |

### Dev Tools

| Tool | Status |
|---|---|
| `context-inspector` — NPC trading | Working, uses real engine formatters |
| `context-inspector` — NPC posting | Working, labeled as approximation |
| `context-inspector` — Autonomous agents | Working, includes world context |
| `market-diversity-report` | Working |
| `prompt-diff` | Working, git ref support fixed |

---

## What's Still Broken

### S1: Author names are raw IDs (single-NPC path + feed posts)

**Location**: `market-context-service.ts` lines 574-575, 527-528, 733-734

Feed posts return `author: post.authorId, authorName: post.authorId`. The single-NPC group chat path (`getInsiderInfo()`) uses `msg.senderId` as `fromName`. Previous trades format as `t.npcActorId: action...`.

**Note**: The batch path (`buildContextForAllNPCs`) at line 306 DOES resolve group chat names via `actorNameById`. So this is inconsistent between paths, not universally broken.

**Impact**: Medium. The LLM sees opaque IDs like `ailon-musk` in some contexts but resolved names in others.

### S2: Autonomous agents get no narrative context

**Location**: `MultiStepExecutor.ts` `gatherContext()`, `AgentTickContext` interface

NPCs now get `resolvedQuestionsContext`, `previousTrades`, `eventMarketSignals`, and `richGameContext` in their trading prompt. Autonomous agents get none of these. Their `AgentTickContext` has no fields for narrative data.

**Impact**: High. Autonomous agents trade without any awareness of what questions resolved, what trades happened, or what events are moving markets. They're blind to the simulation's narrative.

### S3: Group chat sender names are "User" for all participants

**Location**: `AutonomousGroupChatService.ts` lines 116-122

Messages are formatted as `${m.senderId === agentUserId ? 'You' : 'User'}: ${m.content}`. In a 5-person group chat, every other participant is labeled "User". The agent can't tell who said what.

**Impact**: Medium. Multi-party conversations are incomprehensible when everyone else is "User".

### S4: Batch vs single-NPC path inconsistency for group chats

**Location**: `market-context-service.ts` `buildContextForAllNPCs()` vs `getInsiderInfo()`

The batch path fetches 500 total messages across all chats with no content truncation. The single-NPC path fetches 8 messages at 300 chars. These produce substantially different context for the same NPC depending on which code path runs.

**Impact**: Low-Medium. Could cause inconsistent NPC behavior between batch and individual processing.

### S5: Private intel shows 5 messages but dashboard formatter discards context-service data

**Location**: `trading-dashboard-format.ts` line 124, `market-context-service.ts` line 517

The context service fetches 8 messages at 300 chars. The dashboard formatter shows 5. The other 3 messages are fetched from DB but never reach the prompt.

**Impact**: Low. 5 messages is reasonable, but the mismatch wastes DB queries.

### S6: No time windowing on feed posts

**Location**: `market-context-service.ts` `getRecentFeed()` line 551

Posts are fetched with `lte(posts.timestamp, now)` and ordered by recency, but there's no lower bound. If the feed is slow, the 15 most recent posts could span weeks.

**Impact**: Low. In practice the simulation generates enough posts, but stale posts could mislead agents about current market state.

### S7: Agent bankruptcy with no recovery mechanism

**Location**: System-wide

Every autonomous agent has $0 balance with PnL in the negative trillions. No code exists to refund, reset, or top up agent balances. Agents are permanently stuck.

**Impact**: Critical. All autonomous agents are functionally dead.

### S8: Corrupted PnL/price data

**Location**: `trade-execution-service.ts`, AMM pricing layer

Entry prices in billions of cents, PnL in negative trillions. Likely caused by `avgPrice * 100` conversion combined with `doublePrecision` storage and compound settlement errors.

**Impact**: Critical. Even if we fix context, agents can't trade because their financial state is corrupted.

---

## Priority Order for Remaining Fixes

### Immediate (this branch)

1. **S1: Resolve author names** — Use `StaticDataRegistry` for NPC names, query `users` table for agent names. Apply in feed posts, group chats, and trade history formatting.
2. **S3: Fix group chat sender names** — Look up sender display names in `AutonomousGroupChatService` instead of labeling everyone "User".
3. **S5: Align context-service and dashboard limits** — Reduce context-service group chat fetch to 5 (matching dashboard) to avoid wasting queries.

### Next PR

4. **S2: Add narrative context to autonomous agents** — Extend `AgentTickContext` with resolved questions, previous trades, and event signals. Fetch in `gatherContext()`.
5. **S6: Add time window to feed posts** — Add a 48-hour lower bound to `getRecentFeed()`.

### Separate Investigation

6. **S7 + S8: Agent bankruptcy and corrupted prices** — Needs AMM/settlement audit. Root cause in `trade-execution-service.ts` price conversion.
