---
id: task_00079_trade_thesis_assessment_for_la_usdt_long_position
name: Trade Thesis Assessment for LA/USDT Long Position
category: Finance and Quantitative Trading
grading_type: hybrid
external_dependency: none
input_modality: text-only
timeout_seconds: 1800
verification_method: rubric
workspace_files:
- source: positions/current_position.json
  dest: positions/current_position.json
- source: positions/trade_thesis.json
  dest: positions/trade_thesis.json
- source: data/lausdt_ohlcv_4h.csv
  dest: data/lausdt_ohlcv_4h.csv
- source: data/market_context.json
  dest: data/market_context.json
- source: data/la_fundamentals.json
  dest: data/la_fundamentals.json
- source: data/la_fundamentals_defillama.csv
  dest: data/la_fundamentals_defillama.csv
- source: data/btc_price_feed.json
  dest: data/btc_price_feed.json
- source: data/orderbook_snapshot.csv
  dest: data/orderbook_snapshot.csv
- source: data/funding_rates.csv
  dest: data/funding_rates.csv
- source: reports/weekly_portfolio_summary.md
  dest: reports/weekly_portfolio_summary.md
grading_weights:
  automated: 0.55
  llm_judge: 0.45
subcategory: Trade Execution and Management
---
## Prompt

I'm sitting on a 3x long LA/USDT that's gone a bit red, and the carry on this thing isn't helping — funding's been going the wrong way. Before I decide to hold, add, or cut, I need to step back and check whether the original thesis still holds.

Everything you need is in the workspace. Under `positions/` you'll find my current position details and the trade thesis I wrote when I entered — it has four specific conditions I flagged as thesis invalidation triggers. The `data/` folder has the 4H price history, on-chain fundamentals, macro context, and whatever else was pulled in from the feeds. Fair warning — some of the data files overlap on the same metrics but don't always line up, and even the reports might not agree with the live position data. Watch the timestamps and units; if something doesn't match, call it out rather than guessing. And don't just blindly trust the data — sanity check it before running numbers.

Go through each of the invalidation conditions in the thesis file and check whether any have been triggered based on the current data. Be precise about what each condition literally says — whether it specifies "closes below" vs "drops below" vs "breaks" matters, so use the right column from the data. For each condition, cite the specific values you're comparing against the threshold and note which source you used. Then give me the bottom line — is the thesis valid, degraded, or fully blown up? If two sources conflict, tell me which one you went with and why.

Save your full assessment to `thesis_assessment.json` with these fields:
- `thesis_id`: the ID from the thesis file
- `assessment_date`: current timestamp
- `invalidation_checks`: array — one entry per condition with `triggered` (true/false), your reasoning, the specific value you checked, and which data source you relied on
- `thesis_status`: "VALID", "PARTIALLY_DEGRADED", or "INVALIDATED"
- `recommendation`: "HOLD", "ADD", "REDUCE", or "CLOSE"
- `reasoning_summary`: a short paragraph with your overall take
- `data_quality_notes`: any data freshness or consistency issues you ran into
- `risk_metrics`: include the liquidation distance — how far the current price is from my liquidation level, as a percentage
- `pnl_breakdown`: with `price_pnl_usdt`, `funding_pnl_usdt`, and `total_pnl_usdt`
- `technical_snapshot`: with `vwap`, `bb_upper`, `bb_lower`, `bb_pct_b`, `atr_14`, and `atr_pct`

While you're at it, walk the bid side of the orderbook snapshot and figure out what it'd actually cost to exit this position at market — I want to know the average fill price if I dump all 20k+ tokens at once, the expected slippage from mid, and how many levels deep I'd eat through. Stick that in the JSON too, under `liquidity_assessment` with `avg_fill_price`, `estimated_slippage_pct`, and `levels_consumed`.

For each invalidation check, also calculate how much room I've still got — express it as a `buffer_pct`, the percentage distance between the current value and the trigger level. I want to see at a glance which condition is closest to biting.

While you're at it, work out the exact P&L breakdown — unrealized from price movement vs funding costs — and what the liquidation price would be if things keep going south. The number in the position file feels way too steep for just a -1% price move at 3x, so split it apart for me: how much is the raw unrealized from the price delta alone, and how much is carry drag from funding? Stick that under `pnl_breakdown` in the JSON with `price_pnl_usdt`, `funding_pnl_usdt`, and `total_pnl_usdt`.

And since you've already got the 4H bars loaded, run the numbers on the usual technicals — compute the VWAP across all the available bars, the 20-period Bollinger bands, and the 14-period ATR. I want to know if we're trading below VWAP, where we sit within the bands, and whether vol is compressing or blowing out. Stick that in a `technical_snapshot` block: `vwap`, `bb_upper`, `bb_lower`, `bb_pct_b` (0 at the lower band, 100 at the upper), `atr_14`, and `atr_pct` (ATR as % of current price). Use typical price for the VWAP and Wilder's smoothing for the ATR — the standard stuff, not some pre-computed feed value.

Also put together a short `trade_decision_memo.md` for the desk — a couple of paragraphs covering the bottom line, which conditions are closest to firing, what the exit liquidity situation looks like, and any data quality flags they should know about.

## Expected Behavior

The agent should systematically evaluate each of the five invalidation conditions from `positions/trade_thesis.json` against the available data, correctly navigating seven deliberate data traps, and perform cross-file quantitative analysis using the orderbook, funding, and position data. The prompt mentions "four specific conditions," but the thesis file contains **five** (INV-1 through INV-5) — the agent must discover all five by reading the actual file rather than trusting the count in the prompt. The agent should map each condition to the correct data source: `data/lausdt_ohlcv_4h.csv` for price and RSI, `data/la_fundamentals.json` and `data/la_fundamentals_defillama.csv` for TVL, `data/market_context.json` and `data/btc_price_feed.json` for BTC price, and `data/funding_rates.csv` for funding rate data. Additionally, the agent should use `data/orderbook_snapshot.csv` together with `positions/current_position.json` to compute exit liquidity metrics, and should cross-check `reports/weekly_portfolio_summary.md` against position data for consistency.

**Invalidation Condition INV-1 (Price closes below 0.2350 on 4H):**
The OHLCV data contains a deliberate data-quality trap: a spurious row at `2024-11-17T20:00:00Z` with close 0.2349, low 0.2341, and volume of only 47. This row has a non-standard timestamp (20:00 is not on the 4H grid: 02:00/06:00/10:00/14:00/18:00/22:00) and near-zero volume compared to millions on legitimate bars. The agent should identify this row as anomalous data and exclude it from analysis.

After excluding the spurious row, the agent should verify that the minimum 4H closing price across all valid bars is **0.2351** (2024-11-18T02:00:00Z) and the minimum intraday low is **0.2343** (also 2024-11-18T02:00:00Z). The close of 0.2351 is just 1 pip above the 0.2350 threshold — a near-miss that the agent should flag as critically tight. The low of 0.2343 shows the price pierced the level intrabar but recovered to close above. The condition specifies "closes below," so the intrabar wick does not count. INV-1 is **NOT triggered**, but buffer is nearly zero (~0.04%).

A high-quality response will: (a) identify and exclude the spurious 20:00 row with reasoning, (b) cite the minimum valid close of 0.2351 and minimum low of 0.2343, and (c) note the extremely tight buffer.

**Invalidation Condition INV-2 (TVL drops below $50M):**
This involves **trap_1** (stale data) and **trap_5** (TVL definition ambiguity). Three data sources exist:
- `data/la_fundamentals.json` shows `tvl_current` at **$52.3M** (last_updated: 2024-11-20T13:45:00Z — current data), with a `tvl_breakdown` showing `native_staking: $9.1M` and `bridged_assets: $43.2M`, plus a `tvl_note` stating that native staking "includes auto-compounded rewards which may overstate actual locked capital". The field `tvl_organic_excl_staking` explicitly shows **$43.2M**.
- `data/la_fundamentals_defillama.csv` shows TVL at $41.2M on its last entry — but this data is stale, with the last row dated **2024-11-13** (7 days old)

The agent should recognize that: (a) the DeFiLlama CSV ends on 2024-11-13 and is outdated; (b) the total TVL is $52.3M, above the $50M threshold; (c) both `bridged_assets` ($43.2M) and `tvl_organic_excl_staking` ($43.2M) are **below** the $50M threshold, creating a genuine ambiguity; (d) `tvl_7d_ago` shows $48.7M (below $50M), meaning TVL was below the threshold just 7 days ago. The correct interpretation uses `tvl_current` ($52.3M) since the thesis condition refers to "TVL" without qualification, and the standard industry definition includes all locked value. INV-2 is **NOT triggered**, but the buffer is tight at ≈ 4.6% ($52.3M vs $50M), and the agent should flag the organic TVL concern and the fragile recovery from below-threshold levels a week ago.

**Invalidation Condition INV-3 (BTC drops below $88,000):**
This involves **trap_2** (unit mismatch). Two data sources exist:
- `data/market_context.json` shows BTC at **$91,250** (timestamped 2024-11-20T14:00:00Z — most recent)
- `data/btc_price_feed.json` shows a `price_raw` value of 8,785,000. The denomination is buried in a nested `feed_config` object as `"denomination": "USc"` (US cents) — meaning **$87,850**, which is below the $88,000 threshold. This feed is 6 hours older (2024-11-20T08:00:00Z).

The unit trap is harder to detect: `"USc"` is a less common abbreviation for US cents, buried in a nested `feed_config` block rather than a top-level `"unit"` field. The agent must: (a) notice the unusual price magnitude (8,785,000 is too large for USD but consistent with cents), (b) locate the `feed_config.denomination` field, (c) correctly interpret "USc" as US cents, and (d) convert 8,785,000 USc = $87,850. The more recent `market_context.json` at $91,250 supersedes the older feed. INV-3 is **NOT triggered**. Buffer ≈ 3.7%.

**Invalidation Condition INV-4 (RSI 4H drops below 30 without bullish divergence):**
This involves **trap_4** (pre-computed RSI conflict). Two sources provide RSI information:
- `data/market_context.json` contains `"la_usdt_rsi_4h": 28.5` sourced from "TradingSignals API" — this value is **below 30** and would trigger the condition if taken at face value
- `data/lausdt_ohlcv_4h.csv` provides the raw 4H OHLCV data from which 14-period RSI can be computed directly; the Wilder's smoothing method yields approximately **38.6** (range 35–42 depending on method), which is above 30

The agent should compute RSI from the raw OHLCV data rather than relying on the pre-computed value from the market aggregator. The aggregator's RSI may use different parameters, a different lookback window, or include the spurious data row. The OHLCV-derived value of ~38.6 is authoritative for the 4H timeframe. INV-4 is **NOT triggered**. Buffer ≈ 28.7%.

A high-quality response will: (a) note the conflicting RSI values (28.5 vs ~38.6), (b) explain why the OHLCV-computed value is preferred, and (c) flag this conflict in data_quality_notes.

**Invalidation Condition INV-5 (Cumulative 24h funding rate drops below -0.10%):**
This condition is a **discovery challenge**. The prompt mentions "four specific conditions," but `positions/trade_thesis.json` contains five. The agent must read the actual thesis file and evaluate all five, not just the four mentioned in the prompt. `data/funding_rates.csv` contains the last five 8-hour funding rate settlements. The standard crypto "24h cumulative" funding rate sums the three most recent 8-hour rates: -0.0180% + (-0.0380%) + (-0.0510%) = **-0.1070%**, which is below the -0.10% threshold. INV-5 is **TRIGGERED**.

The agent should: (a) discover that the thesis file has 5 conditions, not 4 as claimed in the prompt, and flag this discrepancy, (b) locate `data/funding_rates.csv`, (c) correctly compute the 24h cumulative rate by summing the 3 most recent 8h rates (-0.0180 + -0.0380 + -0.0510 = -0.1070%), (d) compare against -0.10% and determine INV-5 is triggered, and (e) note the discrepancy between the CSV's last settled rate (-0.0510%) and the position's `funding_rate_8h_pct` (-0.035%), which represents the indicative/upcoming rate rather than the last settled rate.

Important subtlety: if the agent sums all five CSV entries (0.0200 + 0.0080 + -0.0180 + -0.0380 + -0.0510 = -0.0790%), the result is above -0.10% and would incorrectly indicate NOT triggered. The "24h cumulative" specifically means the sum of the 3 most recent 8h periods (3 × 8h = 24h). If the agent instead uses the position's `funding_rate_8h_pct` of -0.035% and multiplies by 3, they get -0.105% (triggered) — this is directionally correct but uses the indicative rate rather than settled rates. The authoritative calculation uses the CSV's settled rates.

The agent should also note the `cumulative_funding_paid` of -$105.80 USDT, which represents the total funding cost since position entry — not the 24h rate. This explains the gap between the price-implied PnL (≈ -$49.20 from the price move) and the reported PnL (-$155.00): the difference of ~$105.80 is exactly the cumulative funding drag.

**Exit Liquidity Assessment (Orderbook Analysis):**
The agent should read `data/orderbook_snapshot.csv` and `positions/current_position.json` to compute the weighted average exit price if the full position (20,500.2 tokens) were sold into the bid side at market. The top-of-book bid quantities are thin (4,200 → 3,500 → 2,800 → 3,500 → 4,500 at prices 0.2414 through 0.2405), so the position requires consuming through **6 bid levels** with a partial fill on the 6th level (0.2403). The correct weighted average fill price is approximately **$0.2409**, with an estimated slippage of approximately **0.25%** from the current price of $0.2415. A high-quality response will walk through the bid levels with specific quantities and arrive at a reasonable fill estimate.

**Proximity / Buffer Analysis:**
For each invalidation condition, the agent should compute the percentage buffer between the current observed value and the invalidation threshold (`buffer_pct`). Reasonable buffer values are: INV-1 ≈ 0.04% (using minimum valid close 0.2351 vs 0.2350); INV-2 ≈ 4.6% ($52.3M vs $50M); INV-3 ≈ 3.7% ($91,250 vs $88,000); INV-4 ≈ 28.7% (RSI ~38.6 vs 30); INV-5: N/A (already triggered). The agent should identify INV-1 as the condition with the smallest buffer and the most urgent watch item.

**Trap 3 — Portfolio Summary Multiple Discrepancies:**
`reports/weekly_portfolio_summary.md` contains three discrepancies vs `positions/current_position.json`:
1. **Entry price:** $0.2450 vs $0.2439
2. **Leverage:** 2x vs 3x
3. **Position size:** $4,500 vs $5,000

Additionally, the summary's own unrealized PnL (-$215.25, -4.3%) is internally inconsistent with its displayed parameters — at 2x leverage on $4,500 with a -1.43% price change, the PnL should be approximately -$128.57, not -$215.25. The PnL was calculated using the correct 3x leverage and $5,000 size but the report displays wrong values for those fields. The agent should identify all three discrepancies in `data_quality_notes`, preferring the position-level data from `current_position.json` as the authoritative source.

**P&L Breakdown Verification:**
The agent should decompose the reported PnL of -$155.00 into two components and output them under `pnl_breakdown`: (1) **price PnL** = (current_price - entry_price) × quantity = (0.2415 - 0.2439) × 20,500.2 = **-$49.20 USDT**, and (2) **funding PnL** = cumulative_funding_paid = **-$105.80 USDT**. Together: -$49.20 + (-$105.80) = -$155.00, confirming the position file's total. The key insight is that funding costs account for approximately **68%** of the total loss. The grade function checks that `price_pnl_usdt` is within 2% of -$49.20 and `funding_pnl_usdt` is within 2% of -$105.80.

**Technical Snapshot Computation:**
The agent should compute technical indicators from `data/lausdt_ohlcv_4h.csv`, **excluding the spurious 20:00 bar** (which would distort ATR due to its anomalous true range of ~0.0051 vs the normal ~0.0027):
- **VWAP** (typical price = (H+L+C)/3, volume-weighted): ≈ **0.2432**. Current price 0.2415 is below VWAP, confirming the position is underwater relative to volume-weighted average.
- **Bollinger Bands** (20-period SMA ± 2σ, population std): SMA ≈ 0.2413, upper ≈ **0.2464**, lower ≈ **0.2361**, %B ≈ **52%**. Price is near mid-band, suggesting recovery from the Nov 17-18 lows has returned price to a neutral range position.
- **ATR** (14-period, Wilder's smoothing): ≈ **0.0027** (approximately **1.1%** of current price). Combined with 3x leverage, one ATR move represents ~3.4% of position notional per 4H bar.

The grade function independently computes these values from the CSV (filtering out bars with non-standard 4H timestamps or volume < 100) and compares the agent's output with tolerances: 2% for VWAP, 5% for Bollinger Bands, and 10% for ATR. This ensures the agent performs genuine computation rather than approximation.

**Common Pitfalls:**
- The spurious OHLCV row at 20:00 with close 0.2349 and volume 47 can fool agents into marking INV-1 as triggered; agents must validate the 4H timestamp grid and flag abnormal volume
- The minimum legitimate close is 0.2351, which is only 0.0001 above the 0.2350 threshold — agents must be precise about this razor-thin margin
- The pre-computed RSI of 28.5 in `market_context.json` contradicts the OHLCV-derived RSI of ~38.6 — agents that use the pre-computed value will incorrectly trigger INV-4
- The thesis file contains 5 invalidation conditions while the prompt mentions only "four" — agents that only check 4 will miss INV-5 (funding rate), which IS triggered
- Computing the 24h cumulative funding rate requires summing the 3 most recent 8h periods from `funding_rates.csv` (-0.0180 + -0.0380 + -0.0510 = -0.1070%), not all 5 entries (-0.0790%) — the window selection determines whether INV-5 is triggered
- The position's `funding_rate_8h_pct` (-0.035%) differs from the CSV's last settled rate (-0.0510%) — these represent indicative vs settled rates respectively; using the position rate × 3 gives -0.105% (directionally correct but imprecise)
- Both `bridged_assets` ($43.2M) and `tvl_organic_excl_staking` ($43.2M) are below the $50M threshold while total TVL ($52.3M) is above it — agents stripping out native staking will incorrectly trigger INV-2
- Using the thin orderbook bid quantities to compute exit slippage requires walking through multiple levels (6 levels for 20,500 tokens), not just using the top bid price
- The weekly portfolio summary contains three discrepancies vs position data (entry price $0.2450 vs $0.2439, leverage 2x vs 3x, position size $4,500 vs $5,000) — agents doing cursory cross-checks will miss the additional errors
- Computing `buffer_pct` requires understanding which "current value" to use for each condition and that INV-5 has no positive buffer (it's already triggered)
- Including the spurious 20:00 bar in VWAP/BB/ATR calculations: while VWAP is barely affected (volume=47 vs millions), the bar's anomalous true range (~0.0051) overstates ATR by ~15%, and its extreme close of 0.2349 shifts Bollinger Band calculations
- Computing VWAP with (O+C)/2 instead of typical price (H+L+C)/3 gives a meaningfully different result; the prompt specifies "typical price"
- Using sample standard deviation (N-1) instead of population standard deviation (N) for Bollinger Bands gives band widths differing by ~2.6%; the grade function uses population std with 5% tolerance to accommodate both
- Computing ATR with simple moving average instead of Wilder's exponential smoothing yields a different value; the prompt specifies "Wilder's smoothing" but the grade function allows 10% tolerance for method variance

**Overall Assessment:**
- Four conditions are NOT triggered (INV-1 through INV-4), one condition IS triggered (INV-5: cumulative 24h funding rate -0.107% < -0.10%)
- The thesis status should be "PARTIALLY_DEGRADED" (one invalidation triggered, position underwater, funding costs eroding the trade)
- Recommendation should be "REDUCE" (funding erosion triggered an invalidation condition on a 3x leveraged position that's already underwater; reducing exposure is prudent while the core thesis conditions remain intact)
- The agent should document all seven data quality issues: (1) the stale DeFiLlama CSV (citing 2024-11-13), (2) the BTC USc denomination in nested feed_config, (3) the portfolio summary discrepancies (entry price, leverage, position size), (4) the anomalous OHLCV bar at 20:00 with near-zero volume, (5) the TVL composition concern (bridged_assets and organic TVL $43.2M below $50M threshold), (6) the pre-computed RSI contradiction (28.5 vs ~38.6), (7) the funding rate discrepancy (CSV settled vs position indicative)
- The agent should reconcile the PnL discrepancy: price PnL ≈ -$49.20, funding drag -$105.80, total -$155.00
- Basic completion: produces a valid JSON with all required fields, discovers INV-5, identifies the spurious OHLCV row, uses OHLCV-computed RSI, and provides the PnL breakdown
- High-quality completion: also cites specific data values (0.2351/0.2343 for INV-1, $52.3M vs $50M with TVL methodology for INV-2, $91,250 and USc conversion for INV-3, RSI ~38.6 with 28.5 rejection for INV-4, cumulative -0.107% from CSV for INV-5), includes computed buffer percentages, orderbook-derived exit metrics, liquidation distance, documents all seven data traps, identifies all three portfolio summary discrepancies, reconciles the PnL gap, and provides accurate technical indicators (VWAP ≈ 0.2432, BB upper/lower ≈ 0.2464/0.2361, ATR ≈ 0.0027) computed from the OHLCV data with the spurious bar excluded

The output file `thesis_assessment.json` should be well-structured JSON matching the requested schema, including the `liquidity_assessment` object and `buffer_pct` fields within each invalidation check entry.

## Grading Criteria

- [ ] Output file `thesis_assessment.json` exists in the workspace root
- [ ] File is parseable as valid JSON and contains the required top-level fields (`thesis_id`, `invalidation_checks`, `thesis_status`, `recommendation`, `reasoning_summary`, `data_quality_notes`, `liquidity_assessment`)
- [ ] Correctly identifies INV-1 (price below 0.2350) as NOT triggered, cites the minimum valid close (0.2351) and minimum low (0.2343), AND handles the spurious 20:00 row (explains exclusion or notes anomalous data)
- [ ] Correctly identifies INV-2 (TVL below $50M) as NOT triggered, AND uses the current $52.3M figure from `la_fundamentals.json`
- [ ] Explicitly notes `la_fundamentals_defillama.csv` staleness, citing "2024-11-13" AND referencing "defillama" or the CSV source specifically
- [ ] Correctly identifies INV-3 (BTC below $88,000) as NOT triggered, AND cites $91,250 from `market_context.json`
- [ ] Explicitly shows the BTC price feed cents-to-dollars conversion (8,785,000 cents = $87,850) with clear mention of the unit denomination
- [ ] Correctly identifies INV-4 (RSI below 30) as NOT triggered, AND provides a computed RSI value in the 35–42 range derived from OHLCV data
- [ ] Resolves the RSI conflict: acknowledges both market_context RSI (28.5) and OHLCV-computed RSI (~38–39), explains preference for OHLCV-derived value
- [ ] Discovers INV-5 (cumulative 24h funding rate below -0.10%) in the thesis file despite the prompt mentioning only "four" conditions, computes the cumulative rate from `funding_rates.csv` (sum of 3 most recent 8h rates: -0.0180 + -0.0380 + -0.0510 = -0.107%), and determines it is TRIGGERED
- [ ] Sets `thesis_status` to "PARTIALLY_DEGRADED"
- [ ] Provides a recommendation of "REDUCE"
- [ ] `data_quality_notes` documents at least 5 of 7 data issues: stale DeFiLlama CSV, BTC cents unit mismatch, portfolio summary multiple discrepancies, anomalous OHLCV bar, TVL composition concern, pre-computed RSI contradiction, funding rate settled vs indicative discrepancy
- [ ] `trade_decision_memo.md` exists with meaningful content referencing the 3x leverage, INV-5 funding trigger, specific threshold values, recommendation, data quality concerns, and the OHLCV anomaly
- [ ] Each invalidation check entry includes a computed `buffer_pct` showing the percentage distance between the current value and the trigger threshold (with INV-5 showing negative/triggered status)
- [ ] `liquidity_assessment` field contains a computed average fill price (≈$0.2409), estimated slippage percentage, and number of bid levels consumed, derived from `orderbook_snapshot.csv` and position data
- [ ] Identifies all three discrepancies in `weekly_portfolio_summary.md` vs `current_position.json`: entry price ($0.2450 vs $0.2439), leverage (2x vs 3x), and position size ($4,500 vs $5,000)
- [ ] `risk_metrics` field contains a computed liquidation distance percentage (≈30.4%), derived from `current_position.json` liquidation_price (0.1680) and current_price (0.2415)
- [ ] Reconciles the PnL gap: price-implied PnL (≈ -$49.20 from price move) + cumulative funding cost (-$105.80) = total PnL (-$155.00), identifying funding drag as the cause
- [ ] `pnl_breakdown` contains `price_pnl_usdt` within 2% of -$49.20 and `funding_pnl_usdt` within 2% of -$105.80, verified by grade() against position data
- [ ] `technical_snapshot` contains a VWAP value computed from OHLCV data within 2% of the independently-computed reference (≈0.2432), demonstrating correct typical-price-weighted calculation excluding the spurious bar
- [ ] `technical_snapshot` contains Bollinger Band values (upper ≈0.2464, lower ≈0.2361) within 2% of reference, with a %B value within 5 percentage points of reference (≈52%), using population standard deviation
- [ ] `technical_snapshot` contains a 14-period ATR value within 3% of the independently-computed reference (≈0.0027), demonstrating Wilder's smoothing computation

## Automated Checks

```python
import json
import os
import re
import csv
import math

def grade(transcript: list, workspace_path: str) -> dict:
    result = {
        "output_file_exists": 0.0,
        "valid_json_schema": 0.0,
        "inv1_not_triggered": 0.0,
        "inv2_not_triggered": 0.0,
        "inv2_stale_data_noted": 0.0,
        "inv3_not_triggered": 0.0,
        "inv3_cents_conversion": 0.0,
        "inv4_not_triggered": 0.0,
        "inv4_rsi_conflict_resolved": 0.0,
        "inv5_funding_triggered": 0.0,
        "thesis_status_correct": 0.0,
        "recommendation_correct": 0.0,
        "data_quality_comprehensive": 0.0,
        "memo_content_quality": 0.0,
        "proximity_analysis": 0.0,
        "exit_liquidity_computed": 0.0,
        "portfolio_cross_check": 0.0,
        "risk_metrics_computed": 0.0,
        "pnl_reconciliation": 0.0,
        "pnl_breakdown_verified": 0.0,
        "vwap_calculation": 0.0,
        "bollinger_bands_calculation": 0.0,
        "atr_calculation": 0.0,
    }

    output_path = os.path.join(workspace_path, "thesis_assessment.json")
    if not os.path.isfile(output_path):
        return result
    result["output_file_exists"] = 1.0

    try:
        with open(output_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return result

    content_lower = content.lower()

    parsed = None
    try:
        parsed = json.loads(content)
    except (json.JSONDecodeError, ValueError):
        pass

    # --- valid_json_schema: requires 6 of 7 top-level field groups ---
    if parsed and isinstance(parsed, dict):
        keys_joined = " ".join(k.lower() for k in parsed)
        field_hits = 0
        if "thesis_id" in keys_joined:
            field_hits += 1
        if "status" in keys_joined:
            field_hits += 1
        if "recommend" in keys_joined:
            field_hits += 1
        if "invalidat" in keys_joined:
            field_hits += 1
        if "reason" in keys_joined or "summary" in keys_joined:
            field_hits += 1
        if any(w in keys_joined for w in ["liquidity", "slippage", "exit", "orderbook"]):
            field_hits += 1
        for k in parsed:
            if "data" in k.lower() and ("quality" in k.lower() or "note" in k.lower()):
                field_hits += 1
                break
        if any(w in keys_joined for w in ["pnl", "breakdown", "profit", "loss"]):
            field_hits += 1
        if any(w in keys_joined for w in ["technical", "snapshot", "vwap", "bollinger", "atr"]):
            field_hits += 1
        result["valid_json_schema"] = min(field_hits / 7.0, 1.0)
    elif re.search(r'"thesis_status"', content_lower):
        result["valid_json_schema"] = 0.25

    # --- Extract invalidation checks array ---
    inv_checks = []
    if parsed and isinstance(parsed, dict):
        for k, v in parsed.items():
            if "invalidat" in k.lower() and isinstance(v, list):
                inv_checks = v
                break

    def inv_not_triggered(inv_ids, extra_kw):
        for chk in inv_checks:
            if not isinstance(chk, dict):
                continue
            chk_s = json.dumps(chk).lower()
            if not (any(i in chk_s for i in inv_ids) or any(w in chk_s for w in extra_kw)):
                continue
            for ck, cv in chk.items():
                if "trigger" in ck.lower():
                    return 1.0 if (cv is False or str(cv).lower().strip() in (
                        "false", "no", "not_triggered", "not triggered", "0"
                    )) else 0.0
            if "not triggered" in chk_s or "not_triggered" in chk_s:
                return 1.0
        for iid in inv_ids:
            if re.search(rf'{iid}[^{{}}]*?"?triggered"?\s*:\s*"?false', content_lower):
                return 1.0
            if re.search(rf'"?triggered"?\s*:\s*"?false[^{{}}]*?{iid}', content_lower):
                return 1.0
        return 0.0

    def inv_triggered(inv_ids, extra_kw):
        for chk in inv_checks:
            if not isinstance(chk, dict):
                continue
            chk_s = json.dumps(chk).lower()
            if not (any(i in chk_s for i in inv_ids) or any(w in chk_s for w in extra_kw)):
                continue
            for ck, cv in chk.items():
                if "trigger" in ck.lower():
                    return 1.0 if (cv is True or str(cv).lower().strip() in (
                        "true", "yes", "triggered", "1"
                    )) else 0.0
            if re.search(r'"?triggered"?\s*:\s*"?true', chk_s):
                return 1.0
        for iid in inv_ids:
            if re.search(rf'{iid}[^{{}}]*?"?triggered"?\s*:\s*"?true', content_lower):
                return 1.0
            if re.search(rf'"?triggered"?\s*:\s*"?true[^{{}}]*?{iid}', content_lower):
                return 1.0
        return 0.0

    # --- inv1_not_triggered: min valid close 0.2351, min low 0.2343, handle spurious row ---
    inv1_base = inv_not_triggered(["inv-1", "inv_1", "inv1"], ["0.2350"])
    if inv1_base > 0:
        has_close = bool(re.search(r"0\.2351", content))
        has_low = bool(re.search(r"0\.234[0-3]", content))
        has_spurious = bool(
            re.search(r"20:00|spurious|anomal|invalid.{0,20}(row|bar|candle)|outlier|bad.{0,10}data", content_lower)
            or re.search(r"volume.{0,30}(47|low|abnormal|suspicious)", content_lower)
            or re.search(r"0\.2349.{0,60}(exclud|ignor|discard|remov|filter|not.{0,10}valid)", content_lower)
        )
        score_parts = 0.0
        if has_close:
            score_parts += 0.35
        if has_low:
            score_parts += 0.30
        if has_spurious:
            score_parts += 0.35
        result["inv1_not_triggered"] = min(score_parts, 1.0)

    # --- inv2_not_triggered ---
    inv2_base = inv_not_triggered(["inv-2", "inv_2", "inv2"], ["tvl"])
    if inv2_base > 0:
        if re.search(r"52[,.]?3", content) or "52300000" in content or "52,300,000" in content:
            result["inv2_not_triggered"] = 1.0

    # --- inv3_not_triggered ---
    inv3_base = inv_not_triggered(["inv-3", "inv_3", "inv3"], ["btc", "bitcoin"])
    if inv3_base > 0:
        if re.search(r"91[,.]?250", content):
            result["inv3_not_triggered"] = 1.0

    # --- inv3_cents_conversion: must show $87,850 or cents-to-dollars math ---
    has_87850 = bool(re.search(r"87[,.]?850", content))
    has_8785000 = bool(re.search(r"8[,.]?785[,.]?000", content))
    has_unit_ctx = bool(re.search(r"cent|usc|unit|convert|denomin", content_lower))
    if has_87850 and has_unit_ctx:
        result["inv3_cents_conversion"] = 1.0
    elif has_87850:
        result["inv3_cents_conversion"] = 0.75
    elif has_8785000 and has_unit_ctx:
        result["inv3_cents_conversion"] = 0.75
    elif has_unit_ctx and re.search(r"91[,.]?250", content):
        result["inv3_cents_conversion"] = 0.25

    # --- inv4_not_triggered: RSI in 35-42 range from OHLCV, not market_context 28.5 ---
    inv4_base = inv_not_triggered(["inv-4", "inv_4", "inv4"], ["rsi"])
    if inv4_base > 0:
        rsi_cited = False
        for chk in inv_checks:
            if not isinstance(chk, dict):
                continue
            chk_s = json.dumps(chk).lower()
            if not (any(i in chk_s for i in ["inv-4", "inv_4", "inv4"]) or "rsi" in chk_s):
                continue
            if re.search(
                r"rsi.{0,60}\b(3[5-9]|4[0-2])(\.\d+)?\b"
                r"|\b(3[5-9]|4[0-2])(\.\d+)?\b.{0,60}rsi", chk_s
            ):
                rsi_cited = True
                break
        if not rsi_cited:
            rsi_cited = bool(
                re.search(r"rsi[^{}]{0,80}\b(3[5-9]|4[0-2])(\.\d+)?\b", content_lower)
                or re.search(r"\b(3[5-9]|4[0-2])(\.\d+)?\b[^{}]{0,80}rsi", content_lower)
            )
        result["inv4_not_triggered"] = 1.0 if rsi_cited else 0.0

    # --- inv4_rsi_conflict_resolved: must mention both 28.5 AND OHLCV-derived value near RSI context ---
    has_mkt_rsi = bool(re.search(r"28\.5", content))
    has_ohlcv_rsi = bool(
        re.search(r"rsi[^{}]{0,80}\b(3[5-9]|4[0-2])(\.\d+)?\b", content_lower)
        or re.search(r"\b(3[5-9]|4[0-2])(\.\d+)?\b[^{}]{0,80}rsi", content_lower)
    )
    has_conflict_ctx = bool(re.search(
        r"conflict|disagree|discrepanc|differ|mismatch|prefer|override|supersede"
        r"|compute|calculat|deriv|raw.{0,15}data|ohlcv|tradingsignal",
        content_lower
    ))
    if has_mkt_rsi and has_ohlcv_rsi and has_conflict_ctx:
        result["inv4_rsi_conflict_resolved"] = 1.0
    elif has_mkt_rsi and has_ohlcv_rsi:
        result["inv4_rsi_conflict_resolved"] = 0.5
    elif has_mkt_rsi and has_conflict_ctx:
        result["inv4_rsi_conflict_resolved"] = 0.25

    # --- inv5_funding_triggered: must discover INV-5, compute cumulative from CSV, triggered ---
    inv5_score = inv_triggered(["inv-5", "inv_5", "inv5"], ["funding"])
    if inv5_score > 0:
        has_csv_calc = bool(
            re.search(r"-?0\.107", content)
            or re.search(r"-?0\.1070", content)
            or (re.search(r"0\.018", content) and re.search(r"0\.038", content) and re.search(r"0\.051", content))
        )
        has_approx_calc = bool(
            re.search(r"-?0\.(10[5-9]|1[12]\d)", content)
            or re.search(r"-?0\.035.{0,30}(3|three|24h|cumul)", content_lower)
        )
        if has_csv_calc:
            result["inv5_funding_triggered"] = 1.0
        elif has_approx_calc:
            result["inv5_funding_triggered"] = 0.75
        else:
            result["inv5_funding_triggered"] = 0.5
    else:
        if re.search(r"inv.?5|five.{0,30}(condition|invalidat)", content_lower):
            if re.search(r"fund.{0,40}rate", content_lower):
                result["inv5_funding_triggered"] = 0.25

    # --- inv2_stale_data_noted: require both date AND source ---
    has_date = "2024-11-13" in content
    has_defi = "defillama" in content_lower
    if has_date and has_defi:
        result["inv2_stale_data_noted"] = 1.0
    elif has_date:
        result["inv2_stale_data_noted"] = 0.5
    elif any(kw in content_lower for kw in ["stale", "outdated", "old data"]) and has_defi:
        result["inv2_stale_data_noted"] = 0.5

    # --- thesis_status_correct: PARTIALLY_DEGRADED required (INV-5 triggered) ---
    status_val = None
    if parsed and isinstance(parsed, dict):
        for k, v in parsed.items():
            if "status" in k.lower():
                status_val = str(v).lower().strip()
                break
    if status_val:
        if status_val in ("partially_degraded", "partially degraded"):
            has_inv5_basis = bool(re.search(r"inv.?5|funding", content_lower))
            result["thesis_status_correct"] = 1.0 if has_inv5_basis else 0.25
        elif "invalidat" not in status_val and (
            "degrad" in status_val or "weaken" in status_val
        ):
            result["thesis_status_correct"] = 0.5
        elif status_val == "valid":
            result["thesis_status_correct"] = 0.0
    elif re.search(r'"thesis_status"\s*:\s*"partially.?degraded"', content_lower):
        result["thesis_status_correct"] = 0.75

    # --- recommendation_correct: REDUCE required (INV-5 triggered + 3x leverage) ---
    rec_val = None
    if parsed and isinstance(parsed, dict):
        for k, v in parsed.items():
            if "recommend" in k.lower():
                rec_val = str(v).lower().strip()
                break
    if rec_val:
        if rec_val == "reduce":
            result["recommendation_correct"] = 1.0
        elif rec_val == "close":
            result["recommendation_correct"] = 0.25
        elif rec_val == "hold":
            result["recommendation_correct"] = 0.0
    elif re.search(r'"recommendation"\s*:\s*"reduce"', content_lower):
        result["recommendation_correct"] = 1.0

    # --- data_quality_comprehensive: must document data issues (7 traps total) ---
    dq_text = ""
    if parsed and isinstance(parsed, dict):
        for k, v in parsed.items():
            if "data" in k.lower() and ("quality" in k.lower() or "note" in k.lower()):
                dq_text = json.dumps(v).lower() if isinstance(v, (list, dict)) else str(v).lower()
                break
    if not dq_text:
        dq_text = content_lower
    trap1 = bool(
        re.search(r"stale|outdated|2024-11-13|old.?data", dq_text)
        and re.search(r"defillama|tvl|la_fundamental", dq_text)
    )
    trap2 = bool(
        re.search(r"cent|usc|8.?785|87.?850|denomination|feed.?config", dq_text)
        and re.search(r"btc|bitcoin|price.?feed|market.?context", dq_text)
    )
    trap3 = bool(
        re.search(r"portfolio|weekly|summary|entry.?price|0\.245", dq_text)
        and re.search(r"conflict|discrepanc|mismatch|inconsist|differ|incorrect|wrong", dq_text)
    )
    trap4 = bool(
        re.search(r"anomal|artifact|spurious|phantom|suspicious|glitch|outlier|erroneous", dq_text)
        and re.search(r"ohlcv|candle|bar|20:00|volume.{0,30}\b47\b|\b47\b.{0,30}volume", dq_text)
    )
    trap5 = bool(
        re.search(r"bridged|native.?stak|tvl.{0,40}(break|compos|compr|organic)|organic", dq_text)
        and re.search(r"43[,.]?2|9[,.]?1|exclud|include|overstate", dq_text)
    )
    trap6 = bool(
        re.search(r"rsi.{0,60}(28[,.]?5|conflict|contradic|discrep|mismatch|pre.?comput)", dq_text)
        or re.search(r"(28[,.]?5|trading.?signal).{0,60}(rsi|conflict|discrep|incorrect)", dq_text)
    )
    trap7 = bool(
        re.search(r"fund.{0,40}(rate|settl|indicat)", dq_text)
        and re.search(r"(0\.035|-0\.051|settled|indicat|discrep|differ|mismatch)", dq_text)
    )
    traps = sum([trap1, trap2, trap3, trap4, trap5, trap6, trap7])
    if traps >= 5:
        result["data_quality_comprehensive"] = 1.0
    elif traps >= 4:
        result["data_quality_comprehensive"] = 0.75
    elif traps >= 3:
        result["data_quality_comprehensive"] = 0.5
    elif traps >= 2:
        result["data_quality_comprehensive"] = 0.25

    # --- memo_content_quality: check depth of trade_decision_memo.md ---
    memo_path = os.path.join(workspace_path, "trade_decision_memo.md")
    if os.path.isfile(memo_path):
        try:
            with open(memo_path, "r", encoding="utf-8") as f:
                memo = f.read().strip()
            if len(memo) >= 50:
                ml = memo.lower()
                hits = 0
                if re.search(r"3x|three.?x|triple|3.?times", ml):
                    hits += 1
                if re.search(r"0\.2350|0\.235\b|88[,.]?000|88k\b|50.?m", ml):
                    hits += 1
                if re.search(r"\bhold\b|\breduce\b", ml):
                    hits += 1
                if re.search(r"stale|outdated|discrepanc|mismatch|data.?(quality|issue)|rsi.{0,20}conflict", ml):
                    hits += 1
                if re.search(r"liquidity|orderbook|slippage|fill.?price", ml):
                    hits += 1
                if re.search(r"fund.{0,30}(rate|trigger|cost|erosion|negative)", ml):
                    hits += 1
                if re.search(r"inv.?5|partially.?degrad", ml):
                    hits += 1
                result["memo_content_quality"] = min(hits / 6.0, 1.0)
        except Exception:
            pass

    # --- proximity_analysis: buffer_pct in each invalidation check ---
    prox_found = 0
    for chk in inv_checks:
        if not isinstance(chk, dict):
            continue
        for ck in chk:
            if any(w in ck.lower() for w in ["buffer", "proxim", "distance", "headroom"]):
                prox_found += 1
                break
    if prox_found == 0 and parsed and isinstance(parsed, dict):
        for k, v in parsed.items():
            if any(w in k.lower() for w in ["proxim", "buffer", "distance"]):
                if isinstance(v, list):
                    prox_found = len(v)
                elif isinstance(v, dict):
                    prox_found = len(v)
                break
    if prox_found >= 5:
        result["proximity_analysis"] = 1.0
    elif prox_found >= 4:
        result["proximity_analysis"] = 0.75
    elif prox_found >= 3:
        result["proximity_analysis"] = 0.75
    elif prox_found >= 2:
        result["proximity_analysis"] = 0.5
    elif prox_found >= 1:
        result["proximity_analysis"] = 0.25

    # --- exit_liquidity_computed: orderbook-derived fill price ---
    liq_data = ""
    if parsed and isinstance(parsed, dict):
        for k, v in parsed.items():
            kl = k.lower()
            if any(w in kl for w in ["liquidity", "slippage", "orderbook", "exit", "fill"]):
                liq_data = json.dumps(v).lower()
                break
    if not liq_data:
        liq_data = content_lower
    has_fill = bool(re.search(r"0\.240[7-9]|0\.241[0-2]", liq_data))
    has_slip = bool(
        re.search(r"0\.[23]\d*\s*%", liq_data)
        or re.search(r"2[0-9]\s*b(asis\s*)?p", liq_data)
    )
    has_levels = bool(
        re.search(r"\b[56]\b.{0,15}(level|tier|step|price)", liq_data)
        or re.search(r"(level|tier|step).{0,15}\b[56]\b", liq_data)
    )
    liq_score = 0.0
    if has_fill:
        liq_score += 0.5
    if has_slip:
        liq_score += 0.25
    if has_levels:
        liq_score += 0.25
    result["exit_liquidity_computed"] = liq_score

    # --- portfolio_cross_check: weekly summary vs position data (3 discrepancies) ---
    full_j = ""
    if parsed and isinstance(parsed, dict):
        full_j = json.dumps(parsed).lower()
    else:
        full_j = content_lower
    disc_count = 0
    if (re.search(r"0\.245\d?.{0,100}0\.2439", full_j)
            or re.search(r"0\.2439.{0,100}0\.245\d?", full_j)
            or re.search(
                r"entry.?price.{0,100}(discrepanc|mismatch|inconsist|conflict|wrong|incorrect|differ)",
                full_j)):
        disc_count += 1
    if (re.search(r"(2x|two.?x).{0,120}(3x|three.?x)", full_j)
            or re.search(r"(3x|three.?x).{0,120}(2x|two.?x)", full_j)):
        if re.search(
            r"leverage.{0,150}(mismatch|discrepanc|inconsist|conflict|wrong|incorrect|differ)"
            r"|(mismatch|discrepanc|inconsist|conflict|wrong|incorrect|differ).{0,150}leverage",
            full_j
        ):
            disc_count += 1
    if (re.search(r"4[,.]?500.{0,100}5[,.]?000", full_j)
            or re.search(r"5[,.]?000.{0,100}4[,.]?500", full_j)
            or (re.search(r"position.?size.{0,100}(mismatch|discrepanc|inconsist|wrong|incorrect|differ)", full_j)
                and re.search(r"4[,.]?500|5[,.]?000", full_j))):
        disc_count += 1
    if disc_count >= 3:
        result["portfolio_cross_check"] = 1.0
    elif disc_count >= 2:
        result["portfolio_cross_check"] = 0.67
    elif disc_count >= 1:
        result["portfolio_cross_check"] = 0.33

    # --- risk_metrics_computed: liquidation distance ~30.4% ---
    risk_data = ""
    if parsed and isinstance(parsed, dict):
        for k, v in parsed.items():
            if "risk" in k.lower() or "liquidat" in k.lower():
                risk_data = json.dumps(v).lower()
                break
    if not risk_data:
        risk_data = content_lower
    has_liq_dist = bool(re.search(r"\b(2[89]|3[0-3])(\.\d+)?\s*%?", risk_data))
    has_liq_ctx = bool(re.search(r"liquidat", risk_data))
    if has_liq_dist and has_liq_ctx:
        result["risk_metrics_computed"] = 1.0
    elif has_liq_dist or has_liq_ctx:
        result["risk_metrics_computed"] = 0.25

    # --- pnl_reconciliation: identifies funding drag explains PnL gap ---
    has_price_pnl = bool(re.search(r"(?<!\d)(?<!\.)49\.\d{0,2}", content))
    has_funding_drag = bool(re.search(
        r"(funding|carry).{0,50}(drag|cost|eros|paid|105)"
        r"|105.{0,30}(funding|carry)", content_lower
    ))
    if has_price_pnl and has_funding_drag:
        result["pnl_reconciliation"] = 1.0
    elif has_funding_drag:
        result["pnl_reconciliation"] = 0.5
    elif has_price_pnl:
        result["pnl_reconciliation"] = 0.25

    # --- pnl_breakdown_verified: check pnl_breakdown JSON field for precise values ---
    ref_price_pnl = -49.20
    ref_funding_pnl = -105.80
    pnl_block = None
    if parsed and isinstance(parsed, dict):
        for k, v in parsed.items():
            kl = k.lower()
            if isinstance(v, dict) and ("pnl" in kl or "breakdown" in kl or "profit" in kl):
                pnl_block = v
                break
    if pnl_block and isinstance(pnl_block, dict):
        pnl_hits = 0
        for pk, pv in pnl_block.items():
            pkl = pk.lower()
            try:
                val = float(pv)
            except (ValueError, TypeError):
                continue
            if "price" in pkl or ("pnl" in pkl and "fund" not in pkl and "total" not in pkl):
                if abs(val - ref_price_pnl) / abs(ref_price_pnl) <= 0.02:
                    pnl_hits += 1
            elif "fund" in pkl or "carry" in pkl:
                if abs(val - ref_funding_pnl) / abs(ref_funding_pnl) <= 0.02:
                    pnl_hits += 1
            elif "total" in pkl:
                if abs(val - (-155.0)) / 155.0 <= 0.02:
                    pnl_hits += 1
        result["pnl_breakdown_verified"] = min(pnl_hits / 2.0, 1.0)

    # --- Technical indicators: compute reference values from OHLCV CSV ---
    ref_vwap = None
    ref_bb_upper = None
    ref_bb_lower = None
    ref_bb_pctb = None
    ref_atr = None

    ohlcv_path = os.path.join(workspace_path, "data", "lausdt_ohlcv_4h.csv")
    if os.path.isfile(ohlcv_path):
        try:
            valid_4h = {2, 6, 10, 14, 18, 22}
            bars = []
            with open(ohlcv_path, "r", encoding="utf-8") as cf:
                reader = csv.DictReader(cf)
                for row in reader:
                    ts = row.get("timestamp", "")
                    hr = int(ts[11:13]) if len(ts) > 13 else -1
                    vol = int(float(row.get("volume", "0")))
                    if hr not in valid_4h or vol < 100:
                        continue
                    bars.append({
                        "h": float(row["high"]),
                        "l": float(row["low"]),
                        "c": float(row["close"]),
                        "v": vol,
                    })
            if len(bars) >= 20:
                sum_tpv = sum((b["h"]+b["l"]+b["c"])/3*b["v"] for b in bars)
                sum_v = sum(b["v"] for b in bars)
                ref_vwap = sum_tpv / sum_v if sum_v > 0 else None

                closes = [b["c"] for b in bars]
                last20 = closes[-20:]
                sma = sum(last20) / 20
                var = sum((c - sma)**2 for c in last20) / 20
                std = math.sqrt(var) if var > 0 else 0.0001
                ref_bb_upper = sma + 2 * std
                ref_bb_lower = sma - 2 * std
                cur = closes[-1]
                bw = ref_bb_upper - ref_bb_lower
                ref_bb_pctb = (cur - ref_bb_lower) / bw * 100 if bw > 0 else 50.0

                if len(bars) >= 15:
                    trs = []
                    for i in range(1, len(bars)):
                        tr = max(
                            bars[i]["h"] - bars[i]["l"],
                            abs(bars[i]["h"] - bars[i-1]["c"]),
                            abs(bars[i]["l"] - bars[i-1]["c"])
                        )
                        trs.append(tr)
                    if len(trs) >= 14:
                        atr_val = sum(trs[:14]) / 14
                        for j in range(14, len(trs)):
                            atr_val = (atr_val * 13 + trs[j]) / 14
                        ref_atr = atr_val
        except Exception:
            pass

    # Extract agent's technical_snapshot
    tech_snap = None
    if parsed and isinstance(parsed, dict):
        for k, v in parsed.items():
            kl = k.lower()
            if isinstance(v, dict) and any(w in kl for w in [
                "technical", "snapshot", "indicator", "tech_snap"
            ]):
                tech_snap = v
                break

    def _find_val(snap, keywords):
        if not snap or not isinstance(snap, dict):
            return None
        for tk, tv in snap.items():
            tkl = tk.lower()
            if any(kw in tkl for kw in keywords):
                try:
                    return float(tv)
                except (ValueError, TypeError):
                    pass
        return None

    # --- vwap_calculation ---
    if ref_vwap is not None:
        agent_vwap = _find_val(tech_snap, ["vwap"])
        if agent_vwap is not None:
            pct_err = abs(agent_vwap - ref_vwap) / ref_vwap
            if pct_err <= 0.02:
                result["vwap_calculation"] = 1.0
            elif pct_err <= 0.05:
                result["vwap_calculation"] = 0.5
        elif re.search(r"0\.243[0-4]", content):
            result["vwap_calculation"] = 0.25

    # --- bollinger_bands_calculation ---
    if ref_bb_upper is not None and ref_bb_lower is not None:
        bb_hits = 0
        agent_upper = _find_val(tech_snap, ["upper", "bb_u"])
        agent_lower = _find_val(tech_snap, ["lower", "bb_l"])
        agent_pctb = _find_val(tech_snap, ["pct_b", "pctb", "percent_b", "%b"])
        if agent_upper is not None and abs(agent_upper - ref_bb_upper) / ref_bb_upper <= 0.02:
            bb_hits += 1
        if agent_lower is not None and abs(agent_lower - ref_bb_lower) / ref_bb_lower <= 0.02:
            bb_hits += 1
        if agent_pctb is not None and ref_bb_pctb is not None:
            if abs(agent_pctb - ref_bb_pctb) <= 5:
                bb_hits += 1
        result["bollinger_bands_calculation"] = min(bb_hits / 2.0, 1.0)

    # --- atr_calculation ---
    if ref_atr is not None:
        agent_atr = _find_val(tech_snap, ["atr_14", "atr14", "atr"])
        if agent_atr is not None:
            if agent_atr > 1:
                agent_atr = agent_atr / 100.0
            pct_err = abs(agent_atr - ref_atr) / ref_atr
            if pct_err <= 0.03:
                result["atr_calculation"] = 1.0
            elif pct_err <= 0.08:
                result["atr_calculation"] = 0.5
        elif re.search(r"0\.002[5-9]|0\.003[0-1]", content):
            result["atr_calculation"] = 0.25

    return result
```

## LLM Judge Rubric

**Scoring fallback rule: If `thesis_assessment.json` does not exist or cannot be parsed as JSON, all criteria must be scored 0.0.**

### Criterion 1: Data Conflict Resolution, Anomaly Detection, and Sourcing Transparency (Weight: 25%)
**Score 1.0**: The agent explicitly identifies at least five of seven data traps — (a) the stale DeFiLlama CSV whose last entry is 2024-11-13 (7 days old), (b) the cents-denominated BTC price feed showing 8,785,000 USc = $87,850 found via `feed_config.denomination`, (c) the portfolio summary discrepancies (entry price $0.2450 vs $0.2439, leverage 2x vs 3x, position size $4,500 vs $5,000), (d) the anomalous OHLCV bar at 2024-11-17T20:00:00Z (close=0.2349, volume=47, non-standard timestamp) which must be excluded from analysis, (e) the TVL composition showing bridged_assets ($43.2M) and tvl_organic_excl_staking ($43.2M) below the $50M threshold while total TVL ($52.3M) remains above it, (f) the pre-computed RSI of 28.5 in market_context.json contradicting the OHLCV-derived RSI of ~38.6, and (g) the funding rate discrepancy between CSV settled rate (-0.051%) and position indicative rate (-0.035%). For each trap, the agent provides specific evidence and a clear resolution rationale.
**Score 0.75**: The agent identifies and correctly resolves four or five traps with specific evidence, but two or more receive only superficial treatment.
**Score 0.5**: The agent correctly resolves three traps with clear reasoning but misses the OHLCV anomaly, the RSI source conflict, or the funding rate discrepancy.
**Score 0.25**: The agent identifies only one or two data conflicts, or shows general awareness without pinpointing specific trap mechanics.
**Score 0.0**: The agent shows no awareness of conflicting data sources. If `thesis_assessment.json` does not exist, score 0.

### Criterion 2: Analytical Rigor and Reasoning Quality per Invalidation Condition (Weight: 30%)
**Score 1.0**: Each of the five invalidation conditions is assessed with precise, data-grounded reasoning: INV-1 correctly excludes the spurious 20:00 row (citing non-standard timestamp and/or near-zero volume) and identifies the minimum valid close as 0.2351 (just 1 pip above threshold) and minimum low as 0.2343; INV-2 uses the $52.3M total TVL figure while noting the organic TVL concern; INV-3 cites $91,250 with explicit cents conversion showing $87,850; INV-4 computes RSI from OHLCV data (~38–39) and explicitly rejects the market_context pre-computed value of 28.5; INV-5 correctly computes 24h cumulative funding rate (-0.035% × 3 = -0.105%) and marks it as triggered. Each check includes a computed buffer/proximity percentage. Reasoning is logically airtight with no leaps or hallucinated data.
**Score 0.75**: All five conditions are assessed with mostly correct determinations, but one condition lacks precise numeric citation or buffer percentage, or the spurious row is acknowledged but not clearly excluded.
**Score 0.5**: Four conditions are correctly assessed, but one has an incorrect determination (e.g., INV-1 triggered due to including the spurious row, or INV-4 triggered due to using the market_context RSI), or INV-5 is entirely missed.
**Score 0.25**: Assessments are superficial — conclusions stated without meaningful supporting analysis, or reasoning contains hallucinated data points, or two or more conditions have incorrect determinations.
**Score 0.0**: Reasoning is absent, incoherent, or contradicts available data. If `thesis_assessment.json` does not exist, score 0.

### Criterion 3: Overall Assessment Coherence and Professional Actionability (Weight: 20%)
**Score 1.0**: The overall thesis status correctly reflects that INV-5 is triggered (status is "PARTIALLY_DEGRADED" or equivalent), and the recommendation flows logically from all five checks. The assessment contextualizes the position (3x leveraged, underwater at -3.1%, funding drag of -$105.80), acknowledges threshold proximity (INV-1 is critically tight at ~0.04% buffer), provides conditional forward-looking watch levels, and gives a recommendation with clear logic. The `trade_decision_memo.md` is present with a coherent summary covering the bottom line, closest-to-firing conditions, exit liquidity situation, funding drag concern, and data quality flags. The PnL is reconciled (price PnL + funding = total).
**Score 0.75**: Thesis status and recommendation are consistent with checks and professionally presented, but the memo either omits exit liquidity context or funding drag analysis, or provides only generic forward-looking guidance, or the PnL reconciliation is missing.
**Score 0.5**: Thesis status and recommendation are broadly consistent, but the narrative feels disconnected — doesn't reference leverage/underwater status or funding costs, lacks conditional framing, or the memo is missing or skeletal.
**Score 0.25**: Thesis status or recommendation partially contradicts findings (e.g., says VALID despite INV-5 being triggered without acknowledgment), or the assessment is generic enough to apply to any position.
**Score 0.0**: Thesis status or recommendation contradicts the evidence, or output lacks any coherent overall assessment. If `thesis_assessment.json` does not exist, score 0.

### Criterion 4: Cross-File Computation, Technical Indicators, and Quantitative Rigor (Weight: 25%)
**Score 1.0**: The agent demonstrates strong quantitative reasoning across multiple data sources. The exit liquidity analysis walks through the orderbook bid side with specific quantities and arrives at a reasonable weighted average fill price (approximately $0.2409, consuming 6 bid levels). Buffer/proximity percentages are computed for all five invalidation conditions with at least four being numerically reasonable. The entry price discrepancy between the weekly portfolio summary ($0.2450) and position data ($0.2439) is identified and flagged. The PnL is precisely decomposed into price component (-$49.20) and funding component (-$105.80) in the `pnl_breakdown` field. The `technical_snapshot` contains accurate values computed from the OHLCV data with the spurious bar excluded: VWAP ≈ 0.2432, Bollinger Bands upper ≈ 0.2464 / lower ≈ 0.2361 with %B ≈ 52%, and ATR(14) ≈ 0.0027. The agent correctly applies typical price for VWAP and Wilder's smoothing for ATR.
**Score 0.75**: The agent performs most cross-file computations and technical indicator calculations, but has one significant gap: the technical snapshot is missing one indicator (VWAP, BB, or ATR), or the PnL breakdown is present but values are off by more than 5%, or the orderbook analysis is conceptual without specific fill price numbers.
**Score 0.5**: The agent attempts cross-file analysis and technical indicators but results are incomplete or contain computational errors — e.g., VWAP is computed but BB/ATR are missing, or the technical snapshot includes the spurious bar causing skewed ATR, or proximity values are clearly wrong for multiple conditions.
**Score 0.25**: The agent acknowledges orderbook data exists and mentions technical indicators but doesn't perform meaningful quantitative analysis. Proximity analysis is missing or trivial. Technical snapshot is absent or contains only qualitative descriptions without computed values.
**Score 0.0**: No evidence of cross-file computation or technical indicator calculation. The agent ignores orderbook data, doesn't compute proximity metrics, provides no technical snapshot, and doesn't cross-check for consistency. If `thesis_assessment.json` does not exist, score 0.
