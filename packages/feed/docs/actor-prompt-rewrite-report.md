# Actor Prompt Rewrite: Before vs After

> Phase 1 of the actor system overhaul. Measured using `prompt-diff` and `context-inspector` dev tools.

---

## The Problem

The old prompts buried actor identity under 1,200 tokens of generic shared rules that were identical across all 140+ actors. Every NPC sounded the same because the rules dominated the signal.

**Old prompt structure (v5):**
```
[800 tokens of reality grounding]
=== ALL CHARACTERS IN WORLD ===         ← empty
=== CHARACTER'S FULL PROFILE ===        ← actor data buried here
=== CHARACTER'S RELATIONSHIPS ===       ← empty
=== COMPLETE NARRATIVE CONTEXT ===      ← empty
=== ONGOING STORYLINES ===              ← empty
=== RESOLVED QUESTIONS ===              ← empty
=== DAY X/30 CONTEXT ===
=== CHARACTER'S POST HISTORY ===        ← empty
[400 tokens: IMPORTANT_RULES — "no hashtags" stated 4 different ways]
[200 tokens: CONTENT_REQUIREMENTS — "MUST reference", "MUST mention"]
[200 tokens: ANTI_REPETITION_RULES — "NEVER repeat", "build on"]
=== YOUR TASK ===
[6-item DO list]
[6-item DO NOT list]
CHARACTER LIMIT: Post MUST be 200 characters or less.
[VALUE_RANGES]
[XML format]
CRITICAL: Return exactly ONE post...
[200 tokens: FINAL_REMINDERS — repeating IMPORTANT_RULES again]
```

**New prompt structure (v6):**
```
You are {name}.

{full character info — voice, examples, personality, relationships, positions}

{per-actor anti-repetition patterns}
{per-actor rules — ignoreTopics, tone guardrails, finance guardrails}

WHAT'S HAPPENING:
{compact context}

WORLD:
{actors, markets, predictions}

RULES (5 lines):
- Parody names only
- No hashtags, no emojis
- Max 200 characters
- Sound like YOUR examples
- Reference events naturally

Write ONE post as {name}.

{XML format}
```

---

## Prompt-by-Prompt Comparison

All measurements from `bun scripts/prompt-diff.ts --section-only`.

### ambient-posts (main post generation)

| Metric | Before (v5) | After (v6) | Delta |
|--------|------------|-----------|-------|
| **Max Tokens** | 8,000 | 1,500 | **-81%** |
| **Template tokens** | 1,368 | 206 | **-1,162 (-85%)** |
| Empty sections removed | 7 | 0 | -7 |
| Shared rule blocks | IMPORTANT_RULES, CONTENT_REQUIREMENTS, ANTI_REPETITION_RULES, FINAL_REMINDERS | 5 inline rules | -4 blocks |

**Sections removed:** ALL CHARACTERS IN WORLD, CHARACTER'S RELATIONSHIPS, COMPLETE NARRATIVE CONTEXT, ONGOING STORYLINES, RESOLVED QUESTIONS, DAY X/30 CONTEXT, CHARACTER'S POST HISTORY, CHARACTER'S EVENT INVOLVEMENT, ABSOLUTELY NO HASHTAGS, NO EMOJIS, PARODY NAMES ONLY, NAME USAGE EXAMPLES, ANTI-REPETITION RULES, YOUR TASK, DO, DO NOT

### reactions (event reaction)

| Metric | Before (v5) | After (v6) | Delta |
|--------|------------|-----------|-------|
| **Max Tokens** | 8,000 | 1,500 | **-81%** |
| **Template tokens** | 1,281 | 182 | **-1,099 (-86%)** |

### commentary (in-character take)

| Metric | Before (v6-old) | After (v6-new) | Delta |
|--------|------------|-----------|-------|
| **Max Tokens** | 8,000 | 1,500 | **-81%** |
| **Template tokens** | 1,366 | 164 | **-1,202 (-88%)** |

### replies (reply to post)

| Metric | Before (v5) | After (v6) | Delta |
|--------|------------|-----------|-------|
| **Max Tokens** | 6,000 | 1,500 | **-75%** |
| **Template tokens** | 1,316 | 169 | **-1,147 (-87%)** |

### reply (lightweight thread reply)

| Metric | Before (v3) | After (v6) | Delta |
|--------|------------|-----------|-------|
| **Max Tokens** | 5,000 | 1,000 | **-80%** |
| **Template tokens** | 1,110 | 98 | **-1,012 (-91%)** |

### conspiracy (contrarian take)

| Metric | Before (v5) | After (v6) | Delta |
|--------|------------|-----------|-------|
| **Max Tokens** | 6,000 | 1,500 | **-75%** |
| **Template tokens** | 1,259 | 200 | **-1,059 (-84%)** |

### minute-ambient (quick ambient)

| Metric | Before (v3) | After (v6) | Delta |
|--------|------------|-----------|-------|
| **Max Tokens** | 500 | 500 | unchanged |
| **Template tokens** | 1,123 | 71 | **-1,052 (-94%)** |

---

## Aggregate Impact

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Total template tokens (all 7 prompts) | 8,823 | 1,090 | **-7,733 (-88%)** |
| Total maxTokens budget | 41,500 | 9,000 | **-78%** |
| Empty section headers | 49 (7 per prompt) | 0 | **-100%** |
| Shared rule imports | 6 per prompt | 0 | **-100%** |
| Per-actor guardrails | 0 | 4 systems wired | **+4** |

---

## Actor Context Comparison (from context-inspector)

All measurements from `bun run inspect:context -- --npc <id> --type posting`.

### Context by actor (tokens)

| Section | AIlon Musk | Trump Terminal | VitAIlik Buterin |
|---------|-----------|---------------|-----------------|
| characterInfo (identity) | 885 | 848 | 683 |
| comprehensiveContext | 350 | 252 | 256 |
| fullCharacterContext | 1,253 | 1,119 | 956 |
| realityGrounding | 789 | 789 | 789 |
| worldActors | 376 | 359 | 377 |
| phaseContext | 58 | 58 | 58 |
| timeEnergy | 17 | 17 | 16 |
| personalEvents | 32 | — | — |
| recentEvents | 100 | 100 | 100 |
| relationships | 90 | 165 | 113 |
| marketPositions | 3 | 3 | 3 |
| **Total** | **2,096** | **1,947** | **1,803** |

Key observation: each actor gets a **different total token count** based on their actual data richness. AIlon Musk has 63 post examples so characterInfo is larger. VitAIlik has 31 examples and fewer relationships, so his context is smaller. This is correct — the prompt adapts to the actor.

---

## What's Now Wired In (Previously Built But Unused)

### 1. NPCAntiRepetitionService
- Tracks last 20 posts per character
- Detects overused opening phrases (first 3 words)
- Detects overused vocabulary (words appearing in 50%+ of posts)
- Injects: `"Do NOT start with: 'the future is', 'just saw'. Reduce these words: tremendous, winning"`

### 2. formatActorToneGuardrails
- Checks actor's voice/style/examples for generic slang tokens (W, L, dawg, bro, fam, fr fr, no cap, rizz, ratio)
- If NOT in their corpus, bans them: `"For THIS character, DO NOT use: W, L, dawg, bro, fam"`

### 3. formatActorFinanceGuardrails
- Checks if actor is a "degen speaker" (trading domain, ticker patterns, degen keywords)
- If NOT, bans ticker/trading jargon: `"DO NOT talk in tickers: no $OPENAGI / $NVDAI"`

### 4. ignoreTopics
- Actor data field (e.g., VitAIlik: `['politics', 'entertainment', 'sports', 'celebrity', 'fashion']`)
- Previously only used as a pre-generation gate
- Now injected as prompt rule: `"You never talk about: politics, entertainment, sports, celebrity, fashion"`

---

## Relevance-Filtered Feed (New)

**Before:** All NPCs saw the same 15 most recent posts regardless of who they are.

**After:** `getRelevantFeedForNPC(npcId)` prioritizes posts from actors the NPC cares about:
1. Posts from actors sharing affiliations (same org) — up to 10 slots
2. Posts from actors in relationship table (allies/rivals)
3. Remaining slots filled with general recent posts

Example: AIlon Musk (affiliations: teslai, aix, neurailink, spaicex) sees posts from other TeslAI/AIX actors first, then general feed.

---

## Remaining Phases

| Phase | Status | Description |
|-------|--------|-------------|
| Phase 1: Prompt rewrite | **Done** | 7 prompts rewritten, guardrails wired, feed filtered |
| Phase 2: Unified context builder | Planned | Single ActorContextBuilder for all actions |
| Phase 3: Per-actor rules | Planned | `rules` array in actor data files |
| Phase 4: Unified action loop | Planned | One LLM call per actor per tick |
| Phase 5: Dynamic world | Planned | Update stale reality grounding |
