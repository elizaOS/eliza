# Social Alpha Benchmark

## A Benchmark for Evaluating Trust-Score Systems on Real-World Crypto Recommendation Data

> *Companion benchmark to the paper: "A Marketplace of Trust: Extracting Reliable Recommendations through Social Evaluation"*

---

## 1. Overview

This benchmark evaluates a system's ability to **identify who is trustworthy** from noisy, real-world Discord chat data about cryptocurrency tokens. It measures four core capabilities:

| Suite | What it measures | Why it matters |
|-------|-----------------|----------------|
| **EXTRACT** | Can you pull actionable recommendations from messy chat? | The system is useless if it can't distinguish a shill from small-talk |
| **RANK** | Do computed trust scores match actual P&L outcomes? | The entire paper thesis depends on this |
| **DETECT** | Can you spot rug pulls, scam promoters, and bad actors? | Protecting the agent from catastrophic losses |
| **PROFIT** | Would following the system's output have made money? | The ultimate real-world validation |

---

## 2. Dataset: Trenches Chat

**Source:** ElizaOS Discord `#price-talk-trenches` channel  
**Period:** October 26, 2024 -- January 2, 2025  
**Scale:**

| Statistic | Count |
|-----------|-------|
| Raw messages | 267,183 |
| Identified trading calls | 61,011 |
| Unique tokens mentioned | 3,481 |
| Tokens with price history | 1,748 |
| Active users (made calls) | 1,790 |
| Users with 10+ calls | ~400 |

Each call is enriched with:
- **LLM-derived labels:** sentiment (positive/negative/neutral), conviction (high/medium/low), certainty, reasoning
- **Price data:** price at call, best price in 30-day window, worst price, ideal profit/loss %
- **User metrics:** success rate, avg P&L, total calls, token diversity

---

## 3. Ground Truth Construction

Ground truth is derived from **price outcomes**, not human opinion. This is the key insight: we don't need to know someone's *motivation* -- we just measure whether following their call would have made or lost money.

### 3.1 Message-Level Labels

For each message in the dataset:

| Field | Type | Source |
|-------|------|--------|
| `is_recommendation` | bool | Derived from `is_call` flag + quality filter |
| `recommendation_type` | BUY / SELL / NOISE | Derived from sentiment |
| `conviction` | HIGH / MEDIUM / LOW / NONE | From LLM extraction |
| `token_address` | string | From enrichment |
| `price_at_call` | float | From price data |
| `outcome` | WIN / LOSS / NEUTRAL | From price performance |
| `profit_pct` | float | `idealProfitLossPercent` |
| `is_rug_token` | bool | Token dropped >80% from call price |
| `extraction_difficulty` | EASY / MEDIUM / HARD | Based on message clarity |

**Outcome thresholds:**
- **WIN:** `bestPrice` >= 1.05x `calledPrice` (5%+ gain achievable)
- **LOSS:** `worstPrice` <= 0.90x `calledPrice` (10%+ drawdown)
- **NEUTRAL:** Neither threshold hit within 30-day window

### 3.2 User-Level Labels

For each user with 5+ calls on 3+ distinct tokens:

| Field | Type | Source |
|-------|------|--------|
| `actual_win_rate` | float | Wins / total evaluated calls |
| `actual_avg_profit` | float | Mean P&L across all calls |
| `actual_rank` | int | Rank by avg_profit * sqrt(num_calls) |
| `is_trustworthy` | bool | win_rate > 0.50 AND avg_profit > 0 |
| `archetype` | string | Behavioral classification (see below) |
| `rug_promotion_rate` | float | % of calls on tokens that rugged |
| `scam_warned_rate` | float | % of negative calls on rug tokens (good!) |

### 3.3 User Archetypes (Ground Truth)

Based on quantitative behavior patterns:

| Archetype | Criteria |
|-----------|----------|
| `alpha_caller` | win_rate > 0.65, avg_profit > 20%, 10+ calls, <10% rug rate |
| `solid_trader` | win_rate > 0.55, avg_profit > 5%, 10+ calls |
| `noise_maker` | 50+ calls, win_rate ~0.50 (+/- 5%), avg_profit near 0 |
| `rug_promoter` | rug_promotion_rate > 0.30 |
| `fud_artist` | 70%+ negative sentiment, token_diversity < 3 |
| `scam_hunter` | 30%+ negative calls AND scam_warned_rate > 0.50 |
| `one_hit_wonder` | 1-3 calls, best_call > 50% |
| `degen_gambler` | high variance (std > 40%), low consistency |
| `low_info` | < 5 calls, no clear pattern |

### 3.4 Token-Level Labels

| Field | Type | Source |
|-------|------|--------|
| `is_rug` | bool | Dropped >80% from peak within dataset period |
| `is_pump_dump` | bool | Rose >200% then fell >70% within 48h |
| `peak_mcap_category` | MICRO/SMALL/MID/LARGE | Based on estimated market cap |

---

## 4. Benchmark Suites

### 4.1 EXTRACT — Recommendation Extraction Quality

Tests the system's NLP pipeline for pulling structured signals from raw chat.

**Task A: Call Detection** (Binary classification)
- Input: Raw message text
- Output: Is this a trading recommendation? (yes/no)
- Ground truth: `is_call` flag from enriched dataset
- Metrics: **Precision, Recall, F1, Accuracy**
- Target: F1 > 0.80

**Task B: Sentiment Classification** (3-class)
- Input: Messages identified as calls
- Output: positive / negative / neutral
- Ground truth: LLM-derived sentiment (validated by price outcome)
- Metrics: **Macro-F1, per-class Precision/Recall**
- Target: Macro-F1 > 0.75

**Task C: Conviction Estimation** (3-class ordinal)
- Input: Call messages
- Output: HIGH / MEDIUM / LOW
- Ground truth: LLM-derived conviction (validated by language intensity)
- Metrics: **Ordinal Correlation (Kendall's tau), Accuracy**
- Target: tau > 0.60

**Task D: Token Extraction** (NER + Resolution)
- Input: Call message text
- Output: Token ticker + resolved address
- Ground truth: Enriched `token_address`
- Metrics: **Extraction accuracy, resolution accuracy**
- Target: Extraction > 0.90, Resolution > 0.70

### 4.2 RANK — Trust Score Ranking Quality

Tests whether the computed trust scores actually order users correctly.

**Task A: Global Ranking Correlation**
- Input: System-computed trust scores for all qualified users
- Ground truth: Users ranked by actual avg P&L (weighted by sqrt(call_count))
- Metrics: **Spearman rho, Kendall tau**
- Target: rho > 0.65

**Task B: Top-K Precision**
- Input: System's top-K ranked users (K = 10, 25, 50)
- Ground truth: Users who are actually in the top-K by performance
- Metrics: **Precision@K, NDCG@K**
- Target: P@10 > 0.60

**Task C: Bottom-K Precision**
- Input: System's lowest-K ranked users
- Ground truth: Users who actually lost money consistently
- Metrics: **Precision@K for detecting bad actors**
- Target: P@10 > 0.70

**Task D: Trustworthy/Untrustworthy Classification**
- Input: System trust scores with a threshold
- Ground truth: `is_trustworthy` label
- Metrics: **AUROC, F1 at optimal threshold**
- Target: AUROC > 0.75

### 4.3 DETECT — Scam and Bad Actor Detection

Tests the system's ability to protect the agent from catastrophic losses.

**Task A: Rug Pull Token Detection**
- Input: Token address and available market data
- Ground truth: `is_rug` label
- Metrics: **Precision, Recall, F1**
- Target: Recall > 0.80 (catching rugs is more important than false positives)

**Task B: Scam Promoter Identification**
- Input: User's recommendation history
- Ground truth: `rug_promoter` archetype
- Metrics: **Precision, Recall, F1**
- Target: F1 > 0.70

**Task C: Archetype Classification**
- Input: User's full recommendation + outcome history
- Ground truth: Assigned archetype
- Metrics: **Macro-F1 across archetypes, Confusion Matrix**
- Target: Macro-F1 > 0.55

### 4.4 PROFIT — Real-World Profitability Simulation

Tests whether the system's output would have actually made money.

**Task A: Follow-the-Leaders Portfolio**
- Simulation: At each timestamp, take the BUY recommendations from the top-10 trust-scored users, equal-weight invest, sell after 24h
- Ground truth: Actual prices
- Metrics: **Total return, Sharpe ratio, max drawdown, vs. equal-weight-all baseline**
- Target: Positive return AND Sharpe > 0.5

**Task B: Avoid-the-Losers Filter**
- Simulation: Filter OUT recommendations from bottom-10 trust-scored users
- Ground truth: Performance difference vs. unfiltered
- Metrics: **Return improvement, loss avoidance rate**
- Target: Measurable improvement

**Task C: Trust-Weighted Strategy**
- Simulation: Weight each recommendation by the recommender's trust score
- Metrics: **Return vs. equal-weight, information ratio**
- Target: Outperforms equal-weight

---

## 5. Scoring

Each suite produces a normalized score 0-100:

```
EXTRACT_score = 0.30 * F1_detection + 0.30 * F1_sentiment + 0.15 * tau_conviction + 0.25 * acc_token
RANK_score    = 0.30 * rho_rank + 0.30 * NDCG@10 + 0.20 * AUROC_trust + 0.20 * P@10_bottom
DETECT_score  = 0.35 * recall_rug + 0.35 * F1_promoter + 0.30 * F1_archetype
PROFIT_score  = 0.40 * sharpe_leaders + 0.30 * improvement_filter + 0.30 * IR_weighted
```

**Composite Trust Marketplace Score:**
```
TMS = 0.25 * EXTRACT + 0.30 * RANK + 0.25 * DETECT + 0.20 * PROFIT
```

---

## 6. Running the Benchmark

```bash
# Install
cd benchmarks/social-alpha
pip install -e .

# Run all suites
python -m benchmark.harness --data-dir ./trenches-chat-dataset/data --output results/

# Run individual suite
python -m benchmark.harness --suite extract --data-dir ./trenches-chat-dataset/data

# Run with custom plugin
python -m benchmark.harness --plugin path/to/plugin --data-dir ./trenches-chat-dataset/data
```

---

## 7. Relation to the Paper

| Paper Section | Benchmark Suite |
|--------------|-----------------|
| 3.1 Information Extraction | EXTRACT |
| 3.2 Trust Evaluation | RANK |
| 3.3 Trust Score Rules | RANK (all tasks) |
| 4.3 Perverse Incentives / Sybil | DETECT |
| 5.1 Investing and Trading | PROFIT |
| Social Reinforcement | RANK (leaderboard accuracy) |

---

## 8. Extending the Benchmark

To add new test suites or modify thresholds, edit `benchmark/config.py`. The harness discovers and runs all registered suites automatically.

To benchmark a new system, implement the `SocialAlphaSystem` protocol (see `benchmark/protocol.py`) and pass it to the harness.
