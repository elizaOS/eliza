# Training Data Quality: Observability & Reporting Plan

> The simulation generates training data across posts, trades, events, markets, and social interactions. If the data has systematic biases (repetitive topics, formulaic structure, entity concentration), models trained on it will inherit those biases. This plan defines what to measure, how to measure it, and what "healthy" looks like.

---

## Why This Matters

Every LLM prompt in the system has shared components (reality grounding, name mappings, character descriptions). If these components dominate the signal, a model trained on the output will learn the scaffolding instead of the content. Examples of what goes wrong:

- Every prompt starts with "You are [name]" → model learns name is the primary signal, not the content
- Every post references AIlon Musk → model thinks all social media is about one person
- Every prediction market question follows "Will [ENTITY] [ACTION] by [DATE]?" → model learns a single question template
- Every world event is a "scandal" or "rumor" → model has no concept of positive developments
- Every trade is buy_yes → model thinks prediction markets are one-sided

We need to detect these patterns before they become training artifacts.

---

## Measurement Categories

### Category 1: Entity Distribution

**What**: How concentrated are actor/organization mentions across all generated content?

**Metrics**:

| Metric | Formula | Healthy Range | Warning Threshold |
|--------|---------|---------------|-------------------|
| **Gini coefficient** | Standard Gini on entity mention counts | 0.3–0.6 (moderate inequality matching tier weighting) | > 0.75 (severe concentration) |
| **Top-1 share** | mentions(top entity) / total mentions | < 15% | > 25% |
| **Top-5 share** | mentions(top 5) / total mentions | < 40% | > 60% |
| **Entity coverage** | unique entities mentioned / total entities available | > 50% | < 30% |
| **HHI (Herfindahl)** | Σ(share_i²) across all entities | < 0.10 | > 0.15 |

**Where to measure**:
- Posts (author distribution + mentioned entities in content)
- World events (actors[] field)
- Prediction market questions (affiliated actors/orgs)
- Trading decisions (which NPCs trade, which markets)
- Comments/replies (who responds to whom)

**Visualization**:
- Bar chart: top 30 entities by mention frequency
- Lorenz curve: entity mention inequality
- Heatmap: entity × content-type co-occurrence matrix

---

### Category 2: Content Structural Diversity

**What**: Are outputs following templates or are they genuinely varied in structure?

**Metrics**:

| Metric | Formula | Healthy Range | Warning Threshold |
|--------|---------|---------------|-------------------|
| **Unique opening trigrams** | unique first-3-words / total posts | > 0.7 | < 0.5 |
| **Opening repetition rate** | max(count(opening)) / total posts | < 5% | > 10% |
| **Sentence type distribution** | % questions vs statements vs exclamations | Each > 10% | Any < 5% or > 70% |
| **Post length std dev** | σ of character count across posts | > 40 chars | < 20 chars |
| **Post length skewness** | Skew of length distribution | -0.5 to 0.5 | |skew| > 1.5 |
| **200-char ceiling hits** | % of posts at exactly 195-200 chars | < 15% | > 30% |
| **Vocabulary richness (TTR)** | unique words / total words (per 1000-word window) | > 0.4 | < 0.25 |
| **Pairwise Jaccard (consecutive)** | avg Jaccard between consecutive posts by same actor | < 0.15 | > 0.25 |

**Where to measure**:
- All NPC posts
- World event descriptions
- Prediction market question texts
- Trading decision reasoning fields
- Article/news content

**Visualization**:
- Histogram: post length distribution (overall + per-tier)
- Histogram: opening trigram frequency (top 20)
- Scatter: post length vs sentiment (should show no correlation)
- Time series: vocabulary richness over sliding window (should be stable, not declining)

---

### Category 3: Topic & Theme Concentration

**What**: Is the simulation stuck on one topic or cycling through diverse themes?

**Metrics**:

| Metric | Formula | Healthy Range | Warning Threshold |
|--------|---------|---------------|-------------------|
| **Daily topic HHI** | Σ(topic_share²) across active markets per day | < 0.15 | > 0.25 |
| **Topic persistence** | days a topic remains dominant before rotation | 1-2 days | > 3 days |
| **Cross-day topic overlap** | Jaccard(today's topics, yesterday's topics) | < 0.4 | > 0.6 |
| **Event type distribution** | % per event type (scandal, rumor, development, etc.) | Each 10-25% | Any > 40% or < 5% |
| **Market category balance** | markets per category (tech, crypto, politics, etc.) | Each > 10% | Any > 50% or < 5% |
| **Question near-duplicate rate** | % of questions with Jaccard > 0.4 to another active question | < 10% | > 20% |
| **Satirical theme usage** | unique themes referenced / total themes available | > 40% per day | < 20% |

**Where to measure**:
- Daily topics (from dailyTopics table)
- Active prediction markets (topicKey, category)
- World events (eventType distribution)
- Post content (topic extraction via keyword analysis)

**Visualization**:
- Stacked area chart: topic distribution over time
- Heatmap: day × topic intensity matrix
- Pie chart: event type distribution
- Time series: topic HHI over days (should stay below threshold)

---

### Category 4: Action & Decision Distribution

**What**: Are NPC behaviors diverse or do they all do the same thing?

**Metrics**:

| Metric | Formula | Healthy Range | Warning Threshold |
|--------|---------|---------------|-------------------|
| **Trade action balance** | distribution of buy_yes / buy_no / open_long / open_short / hold | No action > 40% | Any > 50% |
| **Contrarian rate** | % of trades against market consensus | 20-35% | < 10% or > 50% |
| **Post type balance** | ambient / reaction / reply / commentary / conspiracy | No type > 40% | Any > 50% |
| **Engagement type balance** | likes / comments / reposts ratio | Each > 15% | Any < 5% |
| **Active NPC coverage** | unique NPCs that posted or traded / total NPCs | > 40% per day | < 20% |
| **Decision reasoning diversity** | unique reasoning tokens / total reasoning tokens | > 0.5 | < 0.3 |
| **Hold rate** | % of trading decisions that are "hold" | 20-50% | > 70% (all passive) or < 10% (all active) |
| **Market-side balance** | YES vs NO positions across all prediction markets | 40-60% split | < 30% or > 70% |

**Where to measure**:
- NPC trades (npcTrades table)
- Post creation (type, authorId)
- Social engagement (reactions, comments, reposts)
- Trading decision reasoning (from LLM output)

**Visualization**:
- Stacked bar: trade actions per tick
- Pie: post type distribution
- Time series: contrarian rate over ticks
- Histogram: NPC activity frequency (posts per NPC per day)

---

### Category 5: Voice Consistency & Differentiation

**What**: Do actors maintain consistent voices AND sound different from each other?

**Metrics**:

| Metric | Formula | Healthy Range | Warning Threshold |
|--------|---------|---------------|-------------------|
| **Intra-actor consistency** | avg cosine similarity between an actor's posts | > 0.3 | < 0.15 (no consistent voice) |
| **Inter-actor differentiation** | avg cosine similarity between different actors' posts | < 0.3 | > 0.5 (all sound the same) |
| **Voice fingerprint accuracy** | % of posts correctly attributed to actor by a classifier | > 60% | < 40% |
| **Caps usage per actor** | % of chars that are uppercase, per actor | Varies by actor (Trump ~60%, Vitalik ~5%) | All actors within 10% of each other |
| **Avg post length per actor** | mean chars per actor | Varies (Trump ~150, Vitalik ~30) | All actors within 20 chars of each other |
| **Slang/jargon signature** | unique terms per actor that other actors don't use | > 3 per actor | < 1 per actor |

**Where to measure**:
- All posts grouped by authorId
- Post examples (ground truth) vs generated posts (output)
- Cross-actor comparison of style metrics

**Visualization**:
- Scatter: post length mean vs std per actor (should show spread, not clustering)
- Heatmap: actor × actor cosine similarity matrix (diagonal should be bright, off-diagonal dark)
- Bar chart: caps rate per actor (should match their character — Trump high, Vitalik low)
- Radar chart: per-actor style fingerprint (length, caps, question rate, exclamation rate, @mention rate)

---

### Category 6: Temporal Patterns

**What**: Are there artificial periodicities or clustering that a model would learn?

**Metrics**:

| Metric | Formula | Healthy Range | Warning Threshold |
|--------|---------|---------------|-------------------|
| **Posts per hour uniformity** | coefficient of variation across hours | CV < 0.5 (active hours vary) | CV > 1.0 (extreme bunching) |
| **Event clustering** | max events in any 5-minute window / avg events per 5-min | < 5x | > 10x |
| **Market creation spacing** | std dev of time between market creations | > 30 min | < 5 min (all created at once) |
| **Resolution timing** | distribution of resolution hour-of-day | Spread across hours | > 50% in one hour |
| **Activity autocorrelation** | lag-1 autocorrelation of posts per tick | < 0.3 | > 0.6 (predictable pattern) |
| **Weekend/weekday ratio** | posts on weekends / posts on weekdays | 0.5-1.0 | < 0.2 or > 1.5 |

**Where to measure**:
- Posts, events, trades, market creations/resolutions by timestamp
- Activity rate per tick/hour/day

**Visualization**:
- Heatmap: hour × day-of-week activity intensity
- Time series: posts per hour over 7 days
- Autocorrelation plot: lag vs correlation for post frequency

---

### Category 7: Training-Specific Concerns

**What**: Patterns that specifically corrupt model training.

**Metrics**:

| Metric | Formula | Healthy Range | Warning Threshold |
|--------|---------|---------------|-------------------|
| **Prompt prefix concentration** | % of training examples starting with identical tokens | < 5% for any prefix | > 15% |
| **Label balance (sentiment)** | distribution of sentiment values | Roughly normal around 0 | > 60% positive or negative |
| **Label balance (pointsToward)** | true vs false vs null ratio | Each > 20% | Any < 10% |
| **Market outcome balance** | YES vs NO resolution ratio | 40-60% | < 30% or > 70% |
| **Reasoning length distribution** | chars in trading reasoning field | Normal-ish, mean ~50 | Bimodal (empty or max length) |
| **Cross-feature correlation** | correlation between entity and action | < 0.3 | > 0.5 (entity predicts action) |
| **Data leakage indicators** | mentions of "predetermined", "scripted", game mechanics | 0 | Any > 0 |
| **Parody name compliance** | % of posts using real names instead of parody | 0% | > 5% |
| **Hashtag/emoji leakage** | % of posts containing hashtags or emojis | 0% | > 2% |

**Where to measure**:
- Full training export (posts + metadata)
- Trading decisions + reasoning
- Market resolutions

**Visualization**:
- Histogram: sentiment distribution (should be roughly normal)
- Bar: pointsToward distribution (should be balanced)
- Scatter: entity vs action frequency (should show no pattern)
- Flagged examples: actual posts containing real names, hashtags, or game mechanic leaks

---

## Implementation Plan

### Tool 1: `report:training-quality` (Text Report)

```bash
bun run report:training-quality                    # Full report
bun run report:training-quality -- --category entities   # Just entity metrics
bun run report:training-quality -- --days 7         # Last 7 days
bun run report:training-quality -- --export json    # Machine-readable output
bun run report:training-quality -- --warnings-only  # Just the problems
```

Output format:
```
=== TRAINING DATA QUALITY REPORT ===
Period: 2026-03-25 to 2026-03-31 (7 days)
Total: 4,821 posts | 892 trades | 147 events | 42 markets

ENTITY DISTRIBUTION
  Gini coefficient: 0.62 ✅ (target: 0.3-0.6)
  Top-1 share: AIlon Musk 18% ⚠️ WARNING (target: <15%)
  Top-5 share: 41% ⚠️ WARNING (target: <40%)
  Entity coverage: 67% ✅ (89/133 actors mentioned)
  HHI: 0.08 ✅

STRUCTURAL DIVERSITY
  Unique opening trigrams: 73% ✅
  Post length std dev: 52 chars ✅
  200-char ceiling hits: 22% ⚠️ WARNING (target: <15%)
  Vocabulary richness: 0.47 ✅
  ...

WARNINGS SUMMARY
  ⚠️ 3 warnings found
  1. AIlon Musk appears in 18% of all content (target: <15%)
  2. 22% of posts hit 200-char ceiling (consider varying limits)
  3. Event type "scandal" is 38% of all events (target: <25%)
```

### Tool 2: `report:training-viz` (HTML Visualization)

```bash
bun run report:training-viz                        # Generate HTML report
bun run report:training-viz -- --open              # Generate and open in browser
bun run report:training-viz -- --days 30           # 30-day analysis
```

Generates a self-contained HTML file with inline SVG charts:
- Entity frequency bar chart
- Post length histogram
- Topic heatmap
- Action distribution pie
- Actor similarity matrix
- Temporal activity heatmap
- Sentiment distribution
- All with healthy ranges shaded in green

### Tool 3: `report:training-compare` (Before/After)

```bash
bun run report:training-compare -- --before 2026-03-24 --after 2026-03-31
```

Compares metrics between two time periods to show improvement:
```
ENTITY DISTRIBUTION
  Gini: 0.78 → 0.62 ✅ IMPROVED (-20%)
  Top-1 share: 31% → 18% ✅ IMPROVED (-42%)

STRUCTURAL DIVERSITY
  Opening diversity: 0.42 → 0.73 ✅ IMPROVED (+74%)
  Length std dev: 18 → 52 ✅ IMPROVED (+189%)
```

---

## Data Sources

| Source | Table | Key Fields | Volume |
|--------|-------|------------|--------|
| Posts | `Post` | authorId, content, type, sentiment, createdAt | ~500/day |
| Trades | `NPCTrade` | npcActorId, action, marketType, ticker, amount, reason | ~200/tick |
| Events | `WorldEvent` | eventType, description, actors[], relatedQuestion | ~10/tick |
| Markets | `Question` | text, topicKey, status, outcome, resolvedOutcome | ~5-10 active |
| Positions | `Position` | userId, side, avgPrice, shares | ~100-500 active |
| Comments | `Comment` | authorId, content, postId | ~50/day |
| Reactions | `Reaction` | userId, type, postId | ~100/day |
| Headlines | `ParodyHeadline` | parodyTitle, originalSource, qualityScore | ~20/tick |
| DailyTopics | `DailyTopic` | topicKey, topicLabel, sourceType | 1/day |

---

## Alert Thresholds (Automated CI)

For continuous monitoring, these checks should run after each game tick or as a periodic job:

```typescript
interface TrainingQualityAlert {
  metric: string;
  value: number;
  threshold: number;
  severity: 'warning' | 'critical';
  message: string;
}

const ALERT_RULES = [
  // Entity concentration
  { metric: 'entity_gini', threshold: 0.75, severity: 'warning' },
  { metric: 'entity_top1_share', threshold: 0.25, severity: 'critical' },

  // Structural diversity
  { metric: 'opening_trigram_diversity', threshold: 0.5, severity: 'warning', direction: 'below' },
  { metric: 'post_length_stddev', threshold: 20, severity: 'warning', direction: 'below' },
  { metric: 'ceiling_hit_rate', threshold: 0.30, severity: 'warning' },

  // Topic concentration
  { metric: 'daily_topic_hhi', threshold: 0.25, severity: 'warning' },
  { metric: 'question_near_duplicate_rate', threshold: 0.20, severity: 'critical' },

  // Action balance
  { metric: 'trade_action_max_share', threshold: 0.50, severity: 'warning' },
  { metric: 'hold_rate', threshold: 0.70, severity: 'warning' },

  // Training-specific
  { metric: 'real_name_leakage', threshold: 0.05, severity: 'critical' },
  { metric: 'hashtag_leakage', threshold: 0.02, severity: 'critical' },
  { metric: 'sentiment_skew', threshold: 1.5, severity: 'warning' },
  { metric: 'market_outcome_imbalance', threshold: 0.70, severity: 'warning' },
];
```

---

## Implementation Priority

### Phase 1: Text Report (Highest Value, Fastest)
- `report:training-quality` script
- Entity distribution metrics
- Structural diversity metrics
- Topic concentration metrics
- Warning system with thresholds
- JSON export for CI integration

### Phase 2: Visualizations
- HTML report generator
- Entity bar chart + Lorenz curve
- Post length histogram
- Topic heatmap
- Actor similarity matrix

### Phase 3: Temporal Analysis
- Activity pattern detection
- Autocorrelation analysis
- Periodicity warnings

### Phase 4: Training-Specific
- Label balance checking
- Data leakage detection
- Cross-feature correlation
- Prompt prefix analysis

### Phase 5: Continuous Monitoring
- Alert system integration
- Per-tick quality scoring
- Dashboard (optional — could be Grafana or simple HTML)

---

## What "Good" Looks Like

A healthy simulation producing quality training data should have:

- **Entity mentions**: Power-law distribution (natural), not uniform (artificial) or single-peak (biased)
- **Post lengths**: Bimodal or multimodal (different actors write differently), not unimodal at 200 chars
- **Topics**: Rotating daily with 2-3 concurrent themes, not stuck on one
- **Event types**: Spread across scandal/rumor/development/announcement/leak, not dominated by one
- **Trade actions**: 20-30% contrarian, 20-50% hold, rest distributed across buy/sell
- **Voices**: High intra-actor consistency, low inter-actor similarity
- **Temporal**: Activity spread across active hours, no artificial clustering
- **Labels**: Sentiment roughly normal, pointsToward balanced, outcomes 40-60% YES/NO
- **Compliance**: 0% real name leakage, 0% hashtags, 0% game mechanic exposure

A model trained on this data should learn:
- How different personalities communicate differently
- How market events influence social discourse
- How trading decisions relate to information signals
- How social dynamics (allies/rivals) affect behavior
- Natural language patterns for prediction markets

A model should NOT learn:
- That every post starts with "You are [name]"
- That AIlon Musk is the only person who matters
- That all questions follow "Will X do Y by Z?"
- That markets always resolve YES
- That every event is a scandal
