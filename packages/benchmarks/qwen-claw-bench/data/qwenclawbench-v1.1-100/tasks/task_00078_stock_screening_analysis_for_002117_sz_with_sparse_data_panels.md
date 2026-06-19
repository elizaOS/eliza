---
id: task_00078_stock_screening_analysis_for_002117_sz_with_sparse_data_panels
name: Stock Screening Analysis for 002117.SZ with Sparse Data Panels
category: Finance and Quantitative Trading
grading_type: hybrid
verification_method: rubric
timeout_seconds: 1800
grading_weights:
  automated: 0.35
  llm_judge: 0.65
workspace_files:
- source: data/input_payload.json
  dest: data/input_payload.json
- source: data/v2_schema.json
  dest: data/v2_schema.json
- source: data/sector_benchmarks.csv
  dest: data/sector_benchmarks.csv
- source: data/historical_prices.csv
  dest: data/historical_prices.csv
- source: data/fundamentals_quarterly.csv
  dest: data/fundamentals_quarterly.csv
- source: data/peer_comparison.csv
  dest: data/peer_comparison.csv
- source: data/analyst_consensus.json
  dest: data/analyst_consensus.json
- source: data/macro_indicators.csv
  dest: data/macro_indicators.csv
- source: data/behavioral_finance_factors.json
  dest: data/behavioral_finance_factors.json
- source: reports/previous_screening_log.csv
  dest: reports/previous_screening_log.csv
- source: config/model_params.yaml
  dest: config/model_params.yaml
- source: data/index_constituents.csv
  dest: data/index_constituents.csv
- source: data/trading_calendar.json
  dest: data/trading_calendar.json
subcategory: Market Analysis and Research
---
## Prompt

The latest screening payload for 002117.SZ (DongGang Shares) just landed — logical date 2026-02-12. Bad news: tech panel, news panel, and sentiment panel all came back unavailable, so we're basically running on meta fundamentals only for this one.

I still need a full screening call though. Primary input is at `data/input_payload.json`, output schema at `data/v2_schema.json`. There's supplementary data scattered across the workspace under `data/`, `reports/`, and `config/` — historical prices, sector benchmarks, quarterly financials, and some other reference files. Pull from whatever's useful, but heads up — not all of it may be current or internally consistent, so cross-check dates and values before trusting anything.

With three panels dark, don't just reflexively default — think through what the available data actually tells us and where the real gaps are. We're making a call under serious information scarcity here, so be mindful of what biases might creep into the analysis.

Save the result to `output/analysis_result.json` (needs to match the v2 schema), and drop your working notes in `output/screening_notes.md` — data quality flags, which sources you leaned on or set aside and why, the key comparisons behind the call.

## Expected Behavior

The agent should perform a multi-step analysis combining the primary input payload with supplementary workspace data, produce a schema-conformant JSON result, and document its analytical process in screening notes — including data quality assessment.

**Core Analysis Steps:**

1. **Read the primary input** (`data/input_payload.json`): Recognize that `tech_panel`, `news_panel`, and `sentiment_panel` all have `data_status=unavailable`. The only structured signal comes from the `meta` section (market_cap=45.2, pe_ttm=22.8, pb=2.1, dividend_yield_pct=1.85, float_share_pct=78.5).

2. **Read the output schema** (`data/v2_schema.json`): Understand the required fields and their allowed values. The `info_quality` field should be set to `"sparse"` (not `"void"` — because while the three panels are unavailable, there is still meta data, historical prices, and fundamentals available, so information is sparse rather than completely void).

3. **Sector benchmarking** (`data/sector_benchmarks.csv`): Compare 002117.SZ's fundamentals against the "Printing & IT Services" sector averages:
   - PE: 22.8 vs sector average 28.5 → trading at approximately 20% discount
   - PB: 2.1 vs sector average 2.8 → approximately 25% below average
   - Dividend yield: 1.85% vs sector average 1.2% → approximately 54% above average
   - Market cap: 45.2 (100M CNY) vs sector median 32.0 → above median
   These are favorable relative metrics suggesting potential undervaluation.

4. **Historical price analysis** (`data/historical_prices.csv`): The data spans 2025-08-01 through 2026-02-11 (131 trading days). Prices started around 9.42 in August 2025, experienced a notable pullback to approximately 8.54 by late September 2025 (~9.3% decline from August levels), then recovered through October and rallied to a peak close of 11.01 on 2025-11-27. The stock subsequently consolidated in the 10.4–10.9 range through January 2026, settling in the 10.56–10.90 range in early February. The last available close was 10.56 on 2026-02-11, representing roughly +12.1% from the initial August level but approximately 4.1% below the November peak. Overall the stock is not in a downtrend but has stalled momentum after the November peak, with average daily volume declining in the consolidation phase.

   **Quantitative derivations from price data (expected for high-quality analysis):**
   - **Annualized volatility**: Computing daily log returns and annualizing (×√252) yields approximately 22% annualized volatility over the full period, with recent 20-day volatility compressing to approximately 12% — indicating the consolidation phase exhibits significantly reduced price uncertainty compared to the overall period.
   - **Maximum drawdown**: The worst peak-to-trough decline occurred from 2025-09-05 (close 9.67) to 2025-09-26 (close 8.54), a drawdown of approximately 11.7%. This is distinct from the drawdown from the all-time high (11.01 to 10.56, ~4.1%) and represents a meaningful risk event that should be quantified.
   - **Price-volume relationship**: Volume patterns should be analyzed in the context of price movements — notably, whether the November rally was accompanied by elevated volume (confirming trend strength) and whether the subsequent consolidation shows declining volume (typical of range-bound markets, suggesting reduced conviction rather than distribution).

5. **Fundamental analysis** (`data/fundamentals_quarterly.csv`): Seven quarters of data from 2024Q1 to 2025Q3 show steady revenue growth from 796.7M to 1061.3M CNY (~33% cumulative increase), improving EPS from 0.182 to 0.241 (~32% growth), rising ROE from 8.2% to 10.5% (+2.3 percentage points), and gradually increasing but manageable leverage (debt_to_equity 0.35 → 0.44, +26% increase). Positive fundamental trajectory overall with broad-based improvement. The agent should quantify these growth rates explicitly rather than only citing raw start/end values.

6. **Behavioral finance factors** (`data/behavioral_finance_factors.json`): The reference file lists 8 factors with sparse-data relevance descriptions. Key factors for this scenario include `ambiguity_aversion` (investors avoid stocks with uncertain information — the most directly relevant given three unavailable panels), `anchoring` (risk of anchoring to stale data), `herding` (following crowd when personal information is lacking), and `overconfidence` (risk of being overconfident with limited data).

7. **Macro context** (`data/macro_indicators.csv`): PMI hovering near 50 (range 49.6–50.9 over 8 months), moderate CPI (0.6–1.2%), mixed PPI (-0.5% to +0.5%) — a cautious macro environment. Note the GDP growth column has blanks for non-quarter-end months, which is expected.

**Trap Handling (agent should handle these correctly):**

- **Trap 1 — Outdated peer data**: `data/peer_comparison.csv` lists 002117.SZ with market_cap=32.6 and pe_ttm=18.5, which conflicts with the primary input payload values of 45.2 and 22.8 respectively. The agent should use `data/input_payload.json` as the authoritative source and either ignore or flag as stale the peer file's values for the target stock. The output must not use 32.6 as the current market cap.

- **Trap 2 — Stale analyst consensus**: `data/analyst_consensus.json` has `consensus_date: "06/15/2024"` — approximately 20 months old, and in non-standard MM/DD/YYYY format instead of YYYY-MM-DD. The agent should recognize this data is severely outdated and not treat the target price of 12.50 or "buy" rating as current guidance. If referenced at all, the staleness should be noted.

- **Trap 3 — Misleading trading calendar**: `data/trading_calendar.json` marks 2026-02-12 as "Spring Festival Extended" — a public holiday. The agent should not refuse to produce a screening analysis because of this. The primary input explicitly requests analysis for this logical date, and the screening pipeline operates independently of whether the market is open. The agent should proceed with the analysis.

**Supplementary Noise Files (not traps, but potential distractions):**

- `reports/previous_screening_log.csv`: Contains 50 screening results from a single date (2025-11-20) with duplicate and conflicting entries for the same stocks (e.g., Luxshare Precision appears four times with different recommendations). The agent may reference this for context on how the pipeline works but should not use its data for the current analysis.
- `config/model_params.yaml`: Configuration for a sentiment BERT model. Related to the sentiment panel (which is unavailable), not directly useful for the screening analysis.
- `data/index_constituents.csv`: Shows 002117.SZ is in the CSI 500 index with 0.08% weight. Minor supplementary context but not core to the analysis.

**Expected Outputs:**

*`output/analysis_result.json`* — A JSON file conforming to the v2 schema with:
- `stock_id`: `"002117.SZ"`
- `logical_date`: `"2026-02-12"`
- `info_quality`: `"sparse"` (three panels unavailable but meta + supplementary data exists)
- `recommendation`: `"hold"` is the most defensible given sparse information and favorable-but-incomplete fundamentals, though `"include"` with low confidence is also acceptable if well-reasoned
- `confidence`: Between 0.0 and 1.0, expected to be low-to-moderate (roughly 0.28–0.42) given data sparsity. Values below 0.15 are overly cautious since meta fundamentals and supplementary data do provide meaningful signal; values above 0.42 require additional justification and above 0.50 are overconfident given three simultaneously missing panels — the narrow acceptable band reflects the precision expected in calibrating confidence under severe information scarcity
- `rationale`: A string explaining the reasoning, referencing the unavailable panels, relative valuation vs sector benchmarks (with specific numbers), fundamental trajectory, and data limitations
- `behavioral_factors`: An array containing relevant factors — should include at least `"ambiguity_aversion"` and one or two others from the reference file
- `risk_flags`: An array of risk factors — should mention data sparsity or unavailable panels as a risk

*`output/screening_notes.md`* — Working notes documenting:
- Which data sources were consulted, used, or discarded and why
- Specific data quality issues identified (stale peer data, outdated analyst consensus, holiday calendar conflict)
- Key quantitative comparisons that informed the recommendation (sector PE/PB comparisons, revenue growth trajectory)

**Multi-level Expectations:**

- *Basic completion*: Produces a valid JSON conforming to the v2 schema with reasonable field values, and a non-trivial screening notes file. Sets `info_quality` to a valid enum value and provides a recommendation with some reasoning. May miss one or more traps.
- *Good completion*: JSON includes specific data references (PE, PB, or revenue figures). Identifies at least 1–2 of the 3 data quality traps. Behavioral factors are listed and at least one is relevant to sparse data. Screening notes document which sources were used.
- *High quality completion*: JSON rationale references specific data values from assets (sector PE 28.5, revenue growth from ~797M to ~1061M representing ~33% cumulative growth, ROE trajectory from 8.2% to 10.5%) and explicitly connects them to the recommendation. Computes quantitative metrics from raw data — including historical price return (~12% gain from August to February, ~4% drawdown from November peak), fundamental growth rates (revenue, EPS, and/or ROE percentage changes), annualized price volatility (~22%), and maximum drawdown analysis (~11.7% in September). Analyzes price-volume relationships across different market phases (rally vs consolidation). Correctly identifies all three data quality traps with full detail including both market cap AND PE discrepancies in peer data (market_cap=32.6/pe_ttm=18.5 vs input's 45.2/22.8, citing peer_comparison.csv), notes the analyst consensus staleness duration (~20 months from June 2024) and non-standard date format (MM/DD/YYYY), and explains trading calendar holiday handling rationale. Screening notes provide a thorough audit trail with cross-file validation and data freshness assessment. Behavioral factors are explained in the context of the sparse-data scenario — e.g., why ambiguity aversion is particularly amplified when three panels are simultaneously unavailable — rather than merely listed with textbook definitions.

## Grading Criteria

- [ ] **output_valid_json**: Output file `output/analysis_result.json` exists and is valid JSON
- [ ] **schema_fields_complete**: Output contains all 8 required v2 schema fields (`stock_id`, `logical_date`, `info_quality`, `recommendation`, `confidence`, `rationale`, `behavioral_factors`, `risk_flags`)
- [ ] **valid_stock_id**: `stock_id` equals `"002117.SZ"` after trimming leading/trailing whitespace
- [ ] **valid_logical_date**: `logical_date` equals `"2026-02-12"` after trimming leading/trailing whitespace
- [ ] **info_quality_correct**: `info_quality` is `"sparse"` — the correct assessment since three panels are unavailable but meta and supplementary data exists; `"void"` or `"conflicting"` receive partial credit
- [ ] **recommendation_valid**: `recommendation` is one of the valid enum values (`include`, `exclude`, `hold`), with logic consistency check: if recommendation is `"hold"` but confidence > 0.50, or recommendation is `"include"` with `info_quality="sparse"` and confidence > 0.55, the score is halved due to logical inconsistency
- [ ] **confidence_appropriate**: `confidence` is a number between 0.0 and 1.0, reflecting appropriate caution: 0.28–0.42 is optimal (meta fundamentals and supplementary data provide meaningful signal, but three simultaneous missing panels demand significant restraint — the narrowed window requires precise calibration); 0.20–0.28 or 0.42–0.50 earns partial credit (0.5); values below 0.15 are overly cautious, above 0.50 overconfident
- [ ] **rationale_references_data**: `rationale` contains substantive reasoning (≥80 characters) referencing specific quantitative data. Scored on two tiers: (1) standard data citations (PE/PB values, sector averages, revenue/ROE figures — 13 reference patterns) and (2) computed metrics derived from raw data (historical return percentage, revenue/EPS growth rates, PE/PB sector discount percentages, dividend yield premium — 6 computation patterns). Full score requires ≥8 standard citations AND ≥3 computed metrics; ≥8 standard + ≥2 computed earns 0.7; extensive standard citations without computation caps at 0.35
- [ ] **behavioral_factors_relevant**: `behavioral_factors` includes ≥3 sparse-data-relevant factors from the reference file (e.g., `ambiguity_aversion`, `anchoring`, `herding`) with contextual discussion linking factors to the sparse-data scenario. Full credit requires ≥3 relevant factors + contextual explanation; ≥2 + context earns 0.7; ≥2 without context earns 0.25; merely listing factor names earns reduced credit
- [ ] **risk_flags_present**: `risk_flags` is a non-empty array with risk flags referencing data sparsity; full credit requires naming at least 2 of the 3 specific unavailable panels (tech, news, sentiment) in addition to strong sparsity language; naming only one panel or generic "three panels" language earns half credit (0.5); generic mentions of "unavailable" or "limited" without panel specificity earn reduced credit
- [ ] **no_stale_market_cap**: Agent identified stale data in `peer_comparison.csv` and flagged it vs the primary input; full credit (1.0) requires mentioning 32.6 in stale context AND referencing the peer_comparison file AND citing the correct value 45.2 AND flagging the PE discrepancy (18.5 vs 22.8); market cap flagging without PE discrepancy earns 0.8; partial combinations earn 0.6; not mentioning 32.6 at all earns 0.3; using 32.6 without flagging it earns zero
- [ ] **analyst_consensus_handled**: Agent actively flagged the analyst consensus from `data/analyst_consensus.json` (dated 06/15/2024) as outdated; full credit requires ALL THREE: flagging staleness AND noting the non-standard date format (MM/DD/YYYY) AND quantifying the staleness duration (~20 months); flagging staleness plus one of (format, duration) earns 0.7; flagging staleness alone earns 0.5; merely not referencing it earns 0.2; using it uncritically earns zero
- [ ] **calendar_trap_handled**: Agent produced a valid analysis despite the trading calendar marking 2026-02-12 as a holiday; full credit requires acknowledging the holiday AND explaining why the analysis can still proceed AND noting that 2026-02-11 is the last available data point (since the logical date is a holiday); holiday acknowledgment + explanation without last-data-point note earns 0.7; merely mentioning the holiday earns 0.5; no holiday mention earns 0.3
- [ ] **screening_notes_quality**: `output/screening_notes.md` exists with substantive content (≥200 characters) documenting data quality assessment, source usage decisions, and identification of at least one data quality trap with specific file references and discrepant values. Scored against 13 quality signals (including cross-file validation, data freshness, sensitivity analysis evidence, confidence interval discussion, and risk-adjusted metrics); full score requires ≥10 signals, good quality ≥8. Tiered notes penalty: absent/minimal (<50 chars) applies ×0.3 decay, thin (50–199 chars) applies ×0.6 decay to trap-detection, sector-comparison, behavioral-factor, rationale-depth, risk-flag, and historical-return scores
- [ ] **sector_comparison_present**: Output rationale or screening notes reference specific sector benchmark comparisons derived from `data/sector_benchmarks.csv`. Full credit requires basic value comparisons (PE, PB against sector averages) AND ≥3 precisely quantified discount/premium percentages (PE ~20%±3%, PB ~25%±3%, dividend yield ~54%±3%); ≥2 precise percentages earns 0.67; ≥1 earns 0.33; basic comparisons without percentage calculations earn at most 0.2
- [ ] **historical_return_calculated**: Output rationale or screening notes contain quantitative price return analysis derived from `data/historical_prices.csv`. Scored across 5 signals: computed cumulative return (tight: 11.5–12.5%), start/end price citation (9.42/10.56), peak identification (11.01), drawdown from peak (~4%), and volume trend. Full credit requires tight return percentage with start/end price citation plus ≥4 total signals; tight return with ≥3 signals earns 0.5; ≥3 other signals earns 0.3
- [ ] **fundamental_growth_quantified**: Output rationale or screening notes contain explicitly calculated growth rates from `data/fundamentals_quarterly.csv` — e.g., revenue growth ~33%, EPS growth ~32%, ROE improvement +2.3 pp. Full credit requires all 3 growth metrics (revenue 31–35%, EPS 30–34%, ROE 2.0–2.6pp or 26–30%) within ±2% precision; ≥2 earns 0.67; ≥1 earns 0.33; merely citing raw start/end values without computing growth rates earns 0.1 at most

- [ ] **volatility_calculated**: Output rationale or screening notes contain a computed annualized price volatility derived from `data/historical_prices.csv`. Full credit requires a volatility figure in the precise 21–23% range AND the keyword "annualized" or "年化"; broad range 18–26% with "annualized" keyword earns 0.5; a volatility figure without the "annualized" keyword earns 0.25; merely mentioning "volatility" as a concept without computing a specific value earns at most 0.15
- [ ] **max_drawdown_identified**: Output rationale or screening notes identify the maximum peak-to-trough drawdown from the historical price series. Full credit requires a tight drawdown percentage (11–12.5%, correct value is ~11.7%) AND September 2025 start/end date identification (peak 9.67 on 2025-09-05, trough 8.54 on 2025-09-26); tight percentage without dates earns 0.5; broad range 10–13% with dates earns 0.3; either broad range or dates alone earns 0.2
- [ ] **price_volume_consistency**: Output rationale or screening notes analyze price-volume relationships across different market phases. Scored across 4 signals: (1) volume declining during consolidation, (2) volume behavior during the rally, (3) quantitative volume comparisons or averages, (4) volume confirmation/divergence concepts. Full credit requires ≥3 signals; ≥2 earns 0.7; ≥1 earns 0.3
- [ ] **sensitivity_analysis_present**: Output rationale or screening notes include a sensitivity or scenario analysis showing how the recommendation or confidence would change under different assumptions. Full credit requires quantified scenario (e.g., "if PE were at sector average, confidence would increase to X") with numerical values; qualitative scenario discussion earns 0.5
- [ ] **data_provenance_documented**: Screening notes document which workspace data files were consulted, used, or discarded, with per-file usage decisions. Full credit requires ≥9 files documented with usage status; ≥7 files earns 0.7; ≥5 earns 0.4; ≥3 earns 0.2
- [ ] **confidence_interval_quantified**: Output JSON or screening notes include a confidence interval, uncertainty range, or error bound around the point confidence estimate — not just a single number. Full credit requires specifying a numeric range (e.g., "0.25–0.45"); mentioning the concept without numeric range earns 0.3
- [ ] **sharpe_or_risk_adjusted**: Output rationale or notes compute a risk-adjusted return metric (Sharpe ratio, Sortino ratio, information ratio, or return/volatility ratio) with a specific numeric value. Mentioning risk-adjustment conceptually without computing a specific value earns 0.4
- [ ] **quarterly_trend_direction**: Output rationale or notes explicitly characterize the quarter-over-quarter trend direction for fundamental metrics (revenue, EPS, ROE) — e.g., "accelerating", "decelerating", "linear", "steady". Full credit requires trend characterization for ≥2 metrics; ≥1 earns 0.4
- [ ] **macro_sector_linkage**: Output rationale or notes link macro indicators (PMI, CPI, GDP) to the specific sector relevance for 002117.SZ (Printing & IT Services). Full credit requires citing specific PMI values AND discussing sector impact; mentioning the link without specific values earns 0.5
- [ ] **index_weight_implications**: Output rationale or notes reference that 002117.SZ has 0.08% weight in CSI 500 and discuss implications (e.g., low institutional coverage, information asymmetry, limited passive fund demand). Full credit requires weight citation + institutional/coverage implication; weight citation alone earns 0.4
- [ ] **debt_leverage_trajectory**: Output rationale or notes discuss the debt-to-equity ratio trajectory from `data/fundamentals_quarterly.csv` (0.35→0.44 over 7 quarters, +26% increase) and assess whether this leverage trend presents a risk. Full credit requires citing both start/end values AND risk/sustainability assessment; mentioning leverage trend without specific values earns 0.5; mentioning leverage without trend context earns 0.25
- [ ] **information_ratio_sparse**: Output rationale or notes explicitly discuss the signal-to-noise ratio or information ratio in the context of sparse data — quantifying what proportion of the typical information set is available. Full credit requires a quantified ratio or fraction (e.g., "only 1 of 4 panels available"); qualitative discussion earns 0.4
- [ ] **multi_timeframe_volatility**: Output rationale or notes compare volatility across different timeframes — specifically full-period annualized volatility (~22%) vs recent/20-day volatility (~12%), highlighting that the consolidation phase shows significantly compressed volatility. Full credit requires BOTH timeframe volatility figures; either full-period volatility with compression comparison or recent volatility with compression comparison earns 0.35; compression concept alone earns 0.1

**Note — Quantitative rigor gate**: When the average of `volatility_calculated`, `max_drawdown_identified`, and `price_volume_consistency` is below 0.2 (indicating no computational analysis of raw price data), a ×0.6 decay is applied to 8 analysis keys (`rationale_references_data`, `sector_comparison_present`, `historical_return_calculated`, `fundamental_growth_quantified`, `screening_notes_quality`, `behavioral_factors_relevant`, `no_stale_market_cap`, `analyst_consensus_handled`). When the average is below 0.5 but above 0.2, a lighter ×0.8 decay applies. This gate enforces that thorough quantitative analysis is expected for a finance screening task at hard difficulty.

**Note — Rationale depth gate**: When `rationale_references_data` scores below 0.4 (indicating shallow, generic analysis), a ×0.2 decay is applied to `info_quality_correct`, `confidence_appropriate`, `behavioral_factors_relevant`, and `risk_flags_present` to prevent weak models from earning high scores on structural checks without demonstrating real analytical depth.

## Automated Checks

```python
import json
import csv
import re
from pathlib import Path


def grade(transcript: list, workspace_path: str) -> dict:
    scores = {
        "output_valid_json": 0.0,
        "schema_fields_complete": 0.0,
        "valid_stock_id": 0.0,
        "valid_logical_date": 0.0,
        "info_quality_correct": 0.0,
        "recommendation_valid": 0.0,
        "confidence_appropriate": 0.0,
        "rationale_references_data": 0.0,
        "behavioral_factors_relevant": 0.0,
        "risk_flags_present": 0.0,
        "no_stale_market_cap": 0.0,
        "analyst_consensus_handled": 0.0,
        "calendar_trap_handled": 0.0,
        "screening_notes_quality": 0.0,
        "sector_comparison_present": 0.0,
        "historical_return_calculated": 0.0,
        "fundamental_growth_quantified": 0.0,
        "volatility_calculated": 0.0,
        "max_drawdown_identified": 0.0,
        "price_volume_consistency": 0.0,
        "sensitivity_analysis_present": 0.0,
        "data_provenance_documented": 0.0,
        "confidence_interval_quantified": 0.0,
        "sharpe_or_risk_adjusted": 0.0,
        "quarterly_trend_direction": 0.0,
        "macro_sector_linkage": 0.0,
        "index_weight_implications": 0.0,
        "debt_leverage_trajectory": 0.0,
        "information_ratio_sparse": 0.0,
        "multi_timeframe_volatility": 0.0,
    }

    ws = Path(workspace_path)
    output_path = ws / "output" / "analysis_result.json"
    notes_path = ws / "output" / "screening_notes.md"

    if not output_path.is_file():
        return scores

    try:
        content = output_path.read_text(encoding="utf-8").strip()
    except Exception:
        return scores

    if not content:
        return scores

    data = None
    try:
        data = json.loads(content)
        scores["output_valid_json"] = 1.0
    except (json.JSONDecodeError, ValueError):
        return scores

    if not isinstance(data, dict):
        return scores

    content_lower = content.lower()

    # --- Read screening notes early for combined checks ---
    notes_text = ""
    if notes_path.is_file():
        try:
            notes_text = notes_path.read_text(encoding="utf-8").strip()
        except Exception:
            pass
    notes_lower = notes_text.lower()
    combined_lower = content_lower + " " + notes_lower

    # --- Load reference data from workspace assets (with hardcoded fallbacks) ---
    sector_pe = 28.5
    sector_pb = 2.8
    sector_div = 1.2
    try:
        sb = ws / "data" / "sector_benchmarks.csv"
        if sb.is_file():
            with open(sb, "r", encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    if row.get("sector", "").strip() == "Printing & IT Services":
                        sector_pe = float(row["avg_pe_ttm"])
                        sector_pb = float(row["avg_pb"])
                        sector_div = float(row["avg_dividend_yield_pct"])
                        break
    except Exception:
        pass

    meta_pe = 22.8
    meta_pb = 2.1
    meta_cap = 45.2
    meta_div = 1.85
    try:
        ip = ws / "data" / "input_payload.json"
        if ip.is_file():
            with open(ip, "r", encoding="utf-8") as f:
                m = json.load(f).get("meta", {})
                meta_pe = m.get("pe_ttm", meta_pe)
                meta_pb = m.get("pb", meta_pb)
                meta_cap = m.get("market_cap_cny_100m", meta_cap)
                meta_div = m.get("dividend_yield_pct", meta_div)
    except Exception:
        pass

    all_bf = set()
    try:
        bp = ws / "data" / "behavioral_finance_factors.json"
        if bp.is_file():
            with open(bp, "r", encoding="utf-8") as f:
                for item in json.load(f):
                    all_bf.add(item["factor_name"].lower().strip())
    except Exception:
        pass
    if not all_bf:
        all_bf = {
            "herding", "disposition_effect", "overconfidence", "anchoring",
            "loss_aversion", "recency_bias", "information_cascade",
            "ambiguity_aversion",
        }
    sparse_relevant = {
        "ambiguity_aversion", "anchoring", "herding",
        "overconfidence", "loss_aversion", "information_cascade",
    }

    # --- Schema fields completeness (proportional) ---
    required_fields = [
        "stock_id", "logical_date", "info_quality", "recommendation",
        "confidence", "rationale", "behavioral_factors", "risk_flags",
    ]
    present = sum(1 for f in required_fields if f in data)
    scores["schema_fields_complete"] = round(present / len(required_fields), 2)

    # --- Exact value checks ---
    if str(data.get("stock_id", "")).strip() == "002117.SZ":
        scores["valid_stock_id"] = 1.0

    if str(data.get("logical_date", "")).strip() == "2026-02-12":
        scores["valid_logical_date"] = 1.0

    # --- Info quality: "sparse" is correct ---
    iq = str(data.get("info_quality", "")).lower().strip()
    if iq == "sparse":
        scores["info_quality_correct"] = 1.0
    elif iq in ("void", "conflicting"):
        scores["info_quality_correct"] = 0.2

    # --- Parse confidence early for cross-checks ---
    conf = data.get("confidence")
    if isinstance(conf, str):
        try:
            conf = float(conf)
        except (ValueError, TypeError):
            conf = None

    # --- Recommendation: valid enum + logic consistency ---
    rec = str(data.get("recommendation", "")).lower().strip()
    if rec in ("include", "exclude", "hold"):
        scores["recommendation_valid"] = 1.0
        if isinstance(conf, (int, float)):
            if rec == "hold" and conf > 0.50:
                scores["recommendation_valid"] = 0.5
            elif rec == "include" and iq == "sparse" and conf > 0.55:
                scores["recommendation_valid"] = 0.5
    if isinstance(conf, (int, float)) and 0.0 <= conf <= 1.0:
        if 0.28 <= conf <= 0.42:
            scores["confidence_appropriate"] = 1.0
        elif 0.20 <= conf < 0.28 or 0.42 < conf <= 0.50:
            scores["confidence_appropriate"] = 0.5
        elif 0.15 <= conf < 0.20 or 0.50 < conf <= 0.60:
            scores["confidence_appropriate"] = 0.3
        else:
            scores["confidence_appropriate"] = 0.1

    # --- Rationale: two-tier pattern matching (standard + computed) ---
    rationale = str(data.get("rationale", "")).strip()
    rat_lower = rationale.lower()
    if len(rationale) >= 80:
        std_patterns = [
            re.escape(str(meta_pe)),
            re.escape(str(sector_pe)),
            re.escape(str(meta_cap)),
            r"\b" + re.escape(str(meta_pb)) + r"\b",
            r"\b" + re.escape(str(sector_pb)) + r"\b",
            re.escape(str(meta_div)),
            r"\bpe\b|p/e",
            r"\bpb\b|p/b",
            r"sector.{0,20}(average|benchmark|median)|industry\s+average",
            r"unavailable|sparse",
            r"revenue.{0,40}(growth|increas|improv)",
            r"(roe|return\s+on\s+equity).{0,30}(8\.2|10\.5|improv)",
            r"(debt|leverage).{0,30}(0\.3[5-9]|0\.4[0-4]|manag|moderate)",
        ]
        comp_patterns = [
            r"(price\s+)?(return|gain|performance|appreciat).{0,40}"
            r"1[0-4](\.\d+)?\s*%|\+\s*1[0-4](\.\d+)?\s*%",
            r"revenue.{0,80}3[0-6](\.\d+)?\s*%"
            r"|3[0-6](\.\d+)?\s*%.{0,80}revenue.{0,20}(growth|increas)",
            r"eps.{0,80}(3[0-6](\.\d+)?\s*%|growth.{0,20}3[0-6](\.\d+)?\s*%)",
            r"(1[8-9]|2[0-2])\s*%\s*(discount|below|cheaper)"
            r".{0,30}(sector|industry|peer)"
            r"|(sector|industry|peer).{0,40}(1[8-9]|2[0-2])\s*%"
            r"\s*(discount|below|cheaper)",
            r"(2[3-7])\s*%\s*(discount|below|cheaper|lower)"
            r".{0,30}(sector|industry|peer|pb|p/b)"
            r"|(pb|p/b).{0,60}(2[3-7])\s*%\s*(discount|below|cheaper|lower)",
            r"(5[0-9]|60)\s*%\s*(above|higher|premium)"
            r".{0,40}(sector|peer|industry|dividend|yield)"
            r"|(dividend|yield).{0,60}(5[0-9]|60)\s*%\s*(above|higher|premium)",
        ]
        std_hits = sum(1 for p in std_patterns if re.search(p, rat_lower))
        comp_hits = sum(1 for p in comp_patterns if re.search(p, rat_lower))
        if std_hits >= 8 and comp_hits >= 3:
            scores["rationale_references_data"] = 1.0
        elif std_hits >= 8 and comp_hits >= 2:
            scores["rationale_references_data"] = 0.7
        elif std_hits >= 6 and comp_hits >= 1:
            scores["rationale_references_data"] = 0.5
        elif std_hits >= 8:
            scores["rationale_references_data"] = 0.35
        elif std_hits >= 4:
            scores["rationale_references_data"] = 0.2
        elif std_hits >= 1:
            scores["rationale_references_data"] = 0.1
    elif len(rationale) >= 30:
        scores["rationale_references_data"] = 0.05

    # --- Behavioral factors: check relevance AND contextual discussion ---
    bf = data.get("behavioral_factors", [])
    if isinstance(bf, list) and len(bf) > 0:
        norm = [
            str(x).lower().strip().replace(" ", "_").replace("-", "_")
            for x in bf
        ]
        sparse_hits = sum(1 for x in norm if x in sparse_relevant)
        known_hits = sum(1 for x in norm if x in all_bf)
        analysis_text = rat_lower + " " + notes_lower
        bf_explained = bool(re.search(
            r"(ambiguity|anchoring|herd|overconfiden|loss.avers"
            r"|information.cascade)"
            r".{0,150}"
            r"(sparse|unavailable|three.{0,15}panel"
            r"|data.{0,10}(scarc|gap|limit|spars))",
            analysis_text,
        )) or bool(re.search(
            r"(sparse|unavailable|three.{0,15}panel"
            r"|data.{0,10}(scarc|gap|limit|spars))"
            r".{0,150}"
            r"(ambiguity|anchoring|herd|overconfiden|loss.avers"
            r"|information.cascade)",
            analysis_text,
        ))
        if sparse_hits >= 3 and bf_explained:
            scores["behavioral_factors_relevant"] = 1.0
        elif sparse_hits >= 2 and bf_explained:
            scores["behavioral_factors_relevant"] = 0.7
        elif sparse_hits >= 2:
            scores["behavioral_factors_relevant"] = 0.25
        elif sparse_hits == 1 and bf_explained:
            scores["behavioral_factors_relevant"] = 0.5
        elif sparse_hits == 1:
            scores["behavioral_factors_relevant"] = 0.15
        elif known_hits >= 1:
            scores["behavioral_factors_relevant"] = 0.1

    # --- Risk flags: require naming 2+ specific panels for full credit ---
    rf = data.get("risk_flags", [])
    if isinstance(rf, list) and len(rf) > 0:
        rf_text = " ".join(
            x.lower() if isinstance(x, str) else json.dumps(x).lower()
            for x in rf
        )
        strong_sparsity = re.search(
            r"sparse|unavailable|panel|data.{0,15}(quality|gap|scarcit)",
            rf_text,
        )
        weak_sparsity = re.search(
            r"missing|limited|incomplete|uncertain|insufficient",
            rf_text,
        )
        rf_detailed = re.search(
            r"three.{0,10}(panel|source|data)|tech.{0,10}panel"
            r"|news.{0,10}panel|sentiment.{0,10}panel"
            r"|peer.{0,10}comparison|analyst.{0,10}consensus"
            r"|info.{0,10}quality.{0,10}sparse",
            rf_text,
        )
        panels_named = sum(
            1 for kw in ["tech", "news", "sentiment"]
            if re.search(kw, rf_text)
        )
        if strong_sparsity and rf_detailed and panels_named >= 2:
            scores["risk_flags_present"] = 1.0
        elif strong_sparsity and rf_detailed:
            scores["risk_flags_present"] = 0.5
        elif strong_sparsity:
            scores["risk_flags_present"] = 0.3
        elif weak_sparsity:
            scores["risk_flags_present"] = 0.15

    # --- Trap 1: stale market cap — require file ref + both values + PE discrepancy ---
    stale_mentioned = re.search(r'\b32\.6\b', combined_lower)
    pe_discrepancy = bool(re.search(
        r"(18\.5).{0,120}(22\.8|stale|outdated|discrepan|conflict|differ)"
        r"|(22\.8).{0,120}(18\.5).{0,60}(stale|outdated|discrepan|conflict|differ|peer)"
        r"|pe.{0,60}(18\.5).{0,60}(vs|versus|not|instead|actually|correct)",
        combined_lower,
    ))
    if stale_mentioned:
        stale_ctx = re.search(
            r"(stale|outdated|\bold\b|incorrect|discrepan|conflict|differ)"
            r".{0,120}32\.6"
            r"|32\.6.{0,120}"
            r"(stale|outdated|\bold\b|incorrect|discrepan|conflict|differ)",
            combined_lower,
        )
        has_file_ref = bool(re.search(
            r"peer.{0,15}comparison|peer_comparison", combined_lower,
        ))
        has_correct_val = bool(re.search(r"45\.2", combined_lower))
        if stale_ctx and has_file_ref and has_correct_val and pe_discrepancy:
            scores["no_stale_market_cap"] = 1.0
        elif stale_ctx and has_file_ref and has_correct_val:
            scores["no_stale_market_cap"] = 0.8
        elif stale_ctx and (has_file_ref or has_correct_val):
            scores["no_stale_market_cap"] = 0.6
        elif stale_ctx:
            scores["no_stale_market_cap"] = 0.4
        else:
            scores["no_stale_market_cap"] = 0.0
    else:
        scores["no_stale_market_cap"] = 0.3

    # --- Trap 2: stale analyst consensus + date format awareness ---
    flagged_stale = re.search(
        r"(consensus|analyst).{0,100}"
        r"(stale|outdated|\bold\b|not\s+current|obsolete|month.{0,5}old|2024)"
        r"|(stale|outdated|\bold\b|not\s+current|obsolete|month.{0,5}old)"
        r".{0,100}(consensus|analyst)"
        r"|06[/-]15[/-]2024"
        r"|mid.{0,5}2024"
        r"|(20|eighteen|twenty).{0,5}month.{0,5}(old|ago|stale)",
        combined_lower,
    )
    used_uncritically = re.search(
        r"target.{0,30}12\.50.{0,80}(recommend|suggest|upside|therefore|should)"
        r"|consensus.{0,40}buy.{0,60}(therefore|thus|hence|so\b|recommend)",
        combined_lower,
    )
    date_format_noted = re.search(
        r"mm.{0,3}dd|non.{0,15}standard.{0,15}(date|format)"
        r"|date.{0,10}format.{0,20}(inconsist|unusual|non.standard|american|mm)"
        r"|format.{0,20}(mm/dd|month.{0,5}day.{0,5}year)"
        r"|yyyy.{0,5}mm.{0,5}dd.{0,40}(expect|standard|instead|not|rather)",
        combined_lower,
    )
    staleness_duration = re.search(
        r"(20|nineteen|twenty|eighteen|~?\s*1\.5\s*year|1[5-9]\s*month"
        r"|2[0-4]\s*month|nearly\s+two\s+year|almost\s+two\s+year"
        r"|over\s+a\s+year.{0,20}(old|ago|stale))",
        combined_lower,
    )
    if flagged_stale and date_format_noted and staleness_duration:
        scores["analyst_consensus_handled"] = 1.0
    elif flagged_stale and (date_format_noted or staleness_duration):
        scores["analyst_consensus_handled"] = 0.7
    elif flagged_stale:
        scores["analyst_consensus_handled"] = 0.5
    elif used_uncritically:
        scores["analyst_consensus_handled"] = 0.0
    else:
        scores["analyst_consensus_handled"] = 0.2

    # --- Trap 3: trading calendar holiday — require justification ---
    refusal = re.search(
        r"cannot\s+analy[sz]e|unable\s+to\s+produce|error\s+occurred"
        r"|holiday.{0,30}cannot|not\s+a\s+trading\s+day.{0,30}cannot"
        r"|market.{0,20}closed.{0,30}cannot|refuse\s+to",
        content_lower,
    )
    if rec in ("include", "exclude", "hold") and not refusal:
        holiday_aware = re.search(
            r"holiday|calendar|spring\s*festival|market.{0,15}closed"
            r"|trading\s*day|non.{0,5}trading",
            combined_lower,
        )
        holiday_explained = re.search(
            r"(holiday|calendar|spring.{0,10}festival|market.{0,10}closed)"
            r".{0,120}"
            r"(proceed|continu|regardless|independent|pipeline|nonetheless"
            r"|still\s+(valid|possible|produc|perform|complet))"
            r"|(proceed|continu|regardless|independent|pipeline|nonetheless)"
            r".{0,120}"
            r"(holiday|calendar|spring.{0,10}festival|market.{0,10}closed)",
            combined_lower,
        )
        last_data_noted = bool(re.search(
            r"(02[/-]11|february\s*11|2026-02-11|feb.{0,5}11)"
            r".{0,120}(last|latest|most\s+recent|final|prior)"
            r"|(last|latest|most\s+recent|final|prior).{0,120}"
            r"(02[/-]11|february\s*11|2026-02-11|feb.{0,5}11)",
            combined_lower,
        ))
        if holiday_explained and last_data_noted:
            scores["calendar_trap_handled"] = 1.0
        elif holiday_explained:
            scores["calendar_trap_handled"] = 0.7
        elif holiday_aware:
            scores["calendar_trap_handled"] = 0.5
        else:
            scores["calendar_trap_handled"] = 0.3
    elif rec in ("include", "exclude", "hold") and refusal:
        scores["calendar_trap_handled"] = 0.1
    elif not refusal and scores["output_valid_json"] > 0:
        scores["calendar_trap_handled"] = 0.05

    # --- Screening notes quality (13 signals, raised thresholds) ---
    if len(notes_text) >= 200:
        quality_signals = [
            r"stale|outdated|\bold\b|freshness|not\s+current",
            r"discard|ignor|exclud|flag|skip|set\s+aside",
            r"peer.{0,20}comparison|consensus|analyst.{0,20}(target|date)|calendar|holiday",
            r"sector.{0,20}(benchmark|average)|industry.{0,20}average",
            r"input_payload|primary.{0,20}(source|input)|authoritative",
            r"data\s+quality|reliab|trust|data.{0,10}issue",
            r"\d+\.\d+.{0,40}(vs|versus|compared|against|relative)",
            r"revenue.{0,30}(growth|trend|increas)|fundamental.{0,20}(positive|improv|strong)",
            r"(cross.{0,10}(check|ref|validat)|reconcil|verif).{0,40}(file|source|data|value)",
            r"(last.{0,10}updated?|data.{0,10}as.{0,5}of|dated|timestamp).{0,40}20[12]\d",
            r"(sensitiv|scenario|what.if|assumption).{0,40}(analy|test|vary|chang)",
            r"(confidence|uncertain).{0,40}(interval|range|band|bound|±|plus.{0,5}minus)",
            r"(risk.{0,10}adjust|sharpe|information.ratio|return.{0,10}per.{0,10}(risk|vol))",
        ]
        q_hits = sum(1 for p in quality_signals if re.search(p, notes_lower))
        if q_hits >= 10:
            scores["screening_notes_quality"] = 1.0
        elif q_hits >= 8:
            scores["screening_notes_quality"] = 0.7
        elif q_hits >= 6:
            scores["screening_notes_quality"] = 0.5
        elif q_hits >= 4:
            scores["screening_notes_quality"] = 0.3
        elif q_hits >= 2:
            scores["screening_notes_quality"] = 0.15
    elif len(notes_text) >= 50:
        scores["screening_notes_quality"] = 0.1

    # --- Sector comparison: basic values + quantified discount/premium ---
    s_pe = re.escape(str(sector_pe))
    s_pb = re.escape(str(sector_pb))
    m_pe = re.escape(str(meta_pe))
    m_pb = re.escape(str(meta_pb))
    basic_pats = [
        r"(pe|p/e).{0,50}(" + s_pe + r"|sector|industry\s+average)",
        r"(pb|p/b).{0,50}(" + s_pb + r"|sector|industry\s+average)",
        r"(dividend).{0,50}(" + re.escape(str(sector_div)) + r"\b|sector|industry\s+average)",
        m_pe + r".{0,80}" + s_pe + r"|" + s_pe + r".{0,80}" + m_pe,
        r"\b" + m_pb + r"\b.{0,80}\b" + s_pb + r"\b|\b" + s_pb + r"\b.{0,80}\b" + m_pb + r"\b",
        r"(discount|below|under|cheaper|lower).{0,60}(sector|peer|industry)",
        r"(above|premium|higher).{0,60}(sector|peer|industry).{0,40}(dividend|yield)",
        r"(market.{0,10}cap|cap).{0,40}(sector.{0,15}median|above.{0,15}median)",
    ]
    quant_pats = [
        r"(1[7-9]|2[0-3])\s*%\s*(discount|below|cheaper|lower)"
        r".{0,40}(sector|peer|industry|pe|p/e)"
        r"|(pe|p/e).{0,60}(1[7-9]|2[0-3])\s*%\s*(discount|below|cheaper|lower)",
        r"(2[2-8])\s*%\s*(below|lower|discount)"
        r".{0,40}(sector|peer|industry|pb|p/b)"
        r"|(pb|p/b).{0,60}(2[2-8])\s*%\s*(below|lower|discount)",
        r"(5[1-7])\s*%\s*(above|higher|premium)"
        r".{0,40}(sector|peer|industry|dividend|yield)"
        r"|(dividend|yield).{0,60}(5[1-7])\s*%\s*(above|higher|premium)",
    ]
    basic_hits = sum(1 for p in basic_pats if re.search(p, combined_lower))
    quant_hits = sum(1 for p in quant_pats if re.search(p, combined_lower))
    if basic_hits >= 3 and quant_hits >= 3:
        scores["sector_comparison_present"] = 1.0
    elif basic_hits >= 3 and quant_hits >= 2:
        scores["sector_comparison_present"] = 0.67
    elif basic_hits >= 3 and quant_hits >= 1:
        scores["sector_comparison_present"] = 0.33
    elif basic_hits >= 3:
        scores["sector_comparison_present"] = 0.2
    elif basic_hits >= 2:
        scores["sector_comparison_present"] = 0.15
    elif basic_hits >= 1:
        scores["sector_comparison_present"] = 0.1

    # --- Historical return calculation (5 signals, tightened to 11.5-12.5%) ---
    hist_signals = []
    if re.search(
        r"(return|gain|performance|appreciat).{0,60}"
        r"(11\.[5-9]|12(\.[0-5])?)(\d*)\s*%"
        r"|(11\.[5-9]|12(\.[0-5])?)(\d*)\s*%.{0,40}"
        r"(return|gain|performance|appreciat)"
        r"|\+\s*(11\.[5-9]|12(\.[0-5])?)(\d*)\s*%",
        combined_lower,
    ):
        hist_signals.append("return_pct")
    if re.search(r"9\.42", combined_lower) and re.search(r"10\.56", combined_lower):
        hist_signals.append("price_endpoints")
    if re.search(
        r"(peak|high|max).{0,40}11\.01|11\.01.{0,40}(peak|high|max)",
        combined_lower,
    ):
        hist_signals.append("peak_identified")
    if re.search(
        r"(drawdown|pullback|declin|from.{0,10}peak|off.{0,10}peak"
        r"|retreat|correction).{0,80}[3-6](\.\d+)?\s*%",
        combined_lower,
    ):
        hist_signals.append("drawdown_pct")
    if re.search(
        r"volume.{0,30}(declin|decreas|lower|thin|shrink|reduc|taper)",
        combined_lower,
    ):
        hist_signals.append("volume_trend")
    n_hist = len(hist_signals)
    has_return_and_ref = (
        "return_pct" in hist_signals
        and "price_endpoints" in hist_signals
    )
    if has_return_and_ref and n_hist >= 4:
        scores["historical_return_calculated"] = 1.0
    elif "return_pct" in hist_signals and n_hist >= 3:
        scores["historical_return_calculated"] = 0.5
    elif n_hist >= 3:
        scores["historical_return_calculated"] = 0.3
    elif n_hist >= 2:
        scores["historical_return_calculated"] = 0.2
    elif n_hist >= 1:
        scores["historical_return_calculated"] = 0.1

    # --- Fundamental growth quantified (tightened: ±2% precision, ≥3 required) ---
    fund_calcs = 0
    if re.search(
        r"revenue.{0,100}(3[1-5])(\.\d+)?\s*%"
        r"|(3[1-5])(\.\d+)?\s*%.{0,100}revenue"
        r".{0,20}(growth|increas)",
        combined_lower,
    ):
        fund_calcs += 1
    if re.search(
        r"eps.{0,100}(3[0-4])(\.\d+)?\s*%"
        r"|(3[0-4])(\.\d+)?\s*%.{0,80}"
        r"(eps|earnings.{0,10}per).{0,20}(growth|increas)",
        combined_lower,
    ):
        fund_calcs += 1
    if re.search(
        r"(roe|return\s+on\s+equity).{0,80}"
        r"(2\.[0-6])\s*(pp|percentage.{0,5}point|point)"
        r"|(roe|return\s+on\s+equity).{0,80}"
        r"(2[6-9]|30)(\.\d+)?\s*%\s*(increas|improv|ris)",
        combined_lower,
    ):
        fund_calcs += 1
    if fund_calcs >= 3:
        scores["fundamental_growth_quantified"] = 1.0
    elif fund_calcs >= 2:
        scores["fundamental_growth_quantified"] = 0.67
    elif fund_calcs >= 1:
        scores["fundamental_growth_quantified"] = 0.33
    else:
        raw_growth = re.search(
            r"(796|797).{0,80}(1061|1,061).{0,40}(grow|increas|ris)"
            r"|(0\.182).{0,60}(0\.241).{0,40}(grow|increas|improv)"
            r"|(8\.2\s*%).{0,60}(10\.5\s*%).{0,40}(improv|increas|ris)",
            combined_lower,
        )
        scores["fundamental_growth_quantified"] = 0.1 if raw_growth else 0.0

    # --- Volatility calculation (tightened: 21-23% + "annualized" keyword) ---
    vol_annualized_kw = bool(re.search(
        r"annual\w*|年化", combined_lower,
    ))
    vol_precise = bool(re.search(
        r"(volatilit|vol\b).{0,80}(21|22|23)(\.\d+)?\s*%"
        r"|(21|22|23)(\.\d+)?\s*%.{0,60}(volatilit|vol\b)",
        combined_lower,
    ))
    vol_broad = bool(re.search(
        r"(volatilit|vol\b).{0,80}(1[8-9]|2[0-6])(\.\d+)?\s*%"
        r"|(1[8-9]|2[0-6])(\.\d+)?\s*%.{0,60}(volatilit|vol\b)",
        combined_lower,
    ))
    vol_daily = bool(re.search(
        r"(daily).{0,40}(volatilit|std|standard).{0,20}"
        r"(1\.[2-6]|0\.01[2-5])",
        combined_lower,
    ))
    vol_concept = bool(re.search(
        r"(calculat|comput|deriv|measur).{0,50}"
        r"(volatilit|standard\s+dev)",
        combined_lower,
    ))
    if vol_precise and vol_annualized_kw:
        scores["volatility_calculated"] = 1.0
    elif vol_broad and vol_annualized_kw:
        scores["volatility_calculated"] = 0.5
    elif vol_precise or vol_broad or vol_daily:
        scores["volatility_calculated"] = 0.25
    elif vol_concept:
        scores["volatility_calculated"] = 0.15

    # --- Max drawdown (tightened: 11-12.5% + September start/end dates) ---
    dd_tight = re.search(
        r"(max\w*\s*draw\s*down|maximum\s*draw\s*down|mdd"
        r"|largest\s+(peak.to.trough|declin|drop))"
        r".{0,80}(11(\.\d+)?|12(\.[0-5]\d*)?)\s*%"
        r"|(11(\.\d+)?|12(\.[0-5]\d*)?)\s*%.{0,60}"
        r"(max\w*\s*draw\s*down|maximum\s*draw\s*down|mdd"
        r"|largest\s+(peak.to.trough|declin))",
        combined_lower,
    )
    dd_broad = re.search(
        r"(max\w*\s*draw\s*down|maximum\s*draw\s*down|mdd"
        r"|largest\s+(peak.to.trough|declin|drop))"
        r".{0,80}(1[0-3])(\.\d+)?\s*%"
        r"|(1[0-3])(\.\d+)?\s*%.{0,60}"
        r"(max\w*\s*draw\s*down|maximum\s*draw\s*down|mdd"
        r"|largest\s+(peak.to.trough|declin))",
        combined_lower,
    )
    dd_dates = re.search(
        r"(sept|sep|2025.09).{0,80}(9\.67|8\.54|draw\s*down|trough|bottom)"
        r"|(9\.67).{0,60}(8\.54|trough|low|bottom)"
        r"|(8\.54).{0,60}(sept|sep|2025.09|trough|low|bottom)"
        r"|september.{0,20}2025",
        combined_lower,
    )
    dd_general = re.search(
        r"(max\w*\s*draw\s*down|maximum\s*draw\s*down"
        r"|peak.to.trough).{0,120}(declin|drop|fall|loss|\d+\s*%)",
        combined_lower,
    )
    if dd_tight and dd_dates:
        scores["max_drawdown_identified"] = 1.0
    elif dd_tight:
        scores["max_drawdown_identified"] = 0.5
    elif dd_broad and dd_dates:
        scores["max_drawdown_identified"] = 0.3
    elif dd_broad or dd_dates:
        scores["max_drawdown_identified"] = 0.2
    elif dd_general:
        scores["max_drawdown_identified"] = 0.1

    # --- Price-volume consistency analysis ---
    pv_sigs = 0
    if re.search(
        r"(consol|range|sideway|flat|stall)"
        r".{0,80}volume.{0,40}"
        r"(declin|decreas|lower|thin|shrink|taper|drop)"
        r"|volume.{0,40}(declin|decreas|lower|thin|shrink|taper)"
        r".{0,60}(consol|range|sideway|flat|stall)"
        r"|(consol|range|sideway|flat|stall)"
        r".{0,80}(declin|declining|decreas|lower|thin|shrink|taper)"
        r".{0,10}volume",
        combined_lower,
    ):
        pv_sigs += 1
    if re.search(
        r"(rally|surge|breakout|nov\w*|oct\w*|uptick)"
        r".{0,80}volume.{0,40}"
        r"(high|spike|increas|surge|elev|large)"
        r"|volume.{0,40}(high|spike|increas|surge)"
        r".{0,60}(rally|surge|breakout|nov\w*|oct\w*)"
        r"|(rally|surge|breakout|nov\w*|oct\w*|uptick)"
        r".{0,80}(high|elevated|heavy|strong|surging|rising)"
        r".{0,10}volume",
        combined_lower,
    ):
        pv_sigs += 1
    if re.search(
        r"(average|avg|mean).{0,20}(daily\s+)?volume.{0,30}\d"
        r"|turnover.{0,40}(compar|vs|declin|increas|trend)",
        combined_lower,
    ):
        pv_sigs += 1
    if re.search(
        r"(price|trend).{0,40}volume.{0,30}"
        r"(confirm|diverg|inconsist|contradict|support|weak)"
        r"|volume.{0,30}(confirm|diverg|support|weak|signal)"
        r".{0,40}(price|trend|move|momentum)",
        combined_lower,
    ):
        pv_sigs += 1
    if pv_sigs >= 3:
        scores["price_volume_consistency"] = 1.0
    elif pv_sigs >= 2:
        scores["price_volume_consistency"] = 0.7
    elif pv_sigs >= 1:
        scores["price_volume_consistency"] = 0.3

    # --- Quantitative rigor gate: penalize when computation depth is low ---
    original_rationale = scores["rationale_references_data"]
    comp_avg = (scores["volatility_calculated"]
                + scores["max_drawdown_identified"]
                + scores["price_volume_consistency"]) / 3
    if comp_avg < 0.2:
        quant_decay = 0.6
    elif comp_avg < 0.5:
        quant_decay = 0.8
    else:
        quant_decay = 1.0

    if quant_decay < 1.0:
        for key in ("rationale_references_data", "sector_comparison_present",
                     "historical_return_calculated",
                     "fundamental_growth_quantified",
                     "screening_notes_quality",
                     "behavioral_factors_relevant",
                     "no_stale_market_cap",
                     "analyst_consensus_handled"):
            scores[key] = round(scores[key] * quant_decay, 2)

    # --- Rationale depth gate: shallow analysis caps content scores ---
    if original_rationale < 0.4:
        for key in ("info_quality_correct", "confidence_appropriate",
                     "behavioral_factors_relevant", "risk_flags_present"):
            scores[key] = round(scores[key] * 0.2, 2)

    # --- Screening notes quality gate: tiered penalty ---
    if len(notes_text) < 50:
        notes_decay = 0.3
    elif len(notes_text) < 200:
        notes_decay = 0.6
    else:
        notes_decay = 1.0

    if notes_decay < 1.0:
        for key in ("no_stale_market_cap", "analyst_consensus_handled",
                     "calendar_trap_handled", "sector_comparison_present",
                     "behavioral_factors_relevant", "rationale_references_data",
                     "risk_flags_present", "historical_return_calculated"):
            scores[key] = round(scores[key] * notes_decay, 2)

    # --- sensitivity_analysis_present (scenario/what-if analysis) ---
    if re.search(
        r"(sensitiv|scenario|what.if).{0,80}"
        r"(analy|test|explor|examin|consider|assess)"
        r".{0,200}"
        r"(recommend|confidence|conclusion|call|decision|hold|include|exclude)"
        r"|(if\s+(?:we|the|our).{0,40}(?:assum|change|adjust|vary|rais|lower)"
        r".{0,120}(?:recommend|confidence|outcome|result))",
        combined_lower, re.DOTALL,
    ):
        if re.search(
            r"(sensitiv|scenario|what.if).{0,200}"
            r"(\d+\.?\d*\s*%|\d+\.\d+).{0,80}"
            r"(change|shift|move|become|result|lead|yield)",
            combined_lower, re.DOTALL,
        ):
            scores["sensitivity_analysis_present"] = 1.0
        else:
            scores["sensitivity_analysis_present"] = 0.5

    # --- data_provenance_documented (structured source inventory) ---
    prov_files_listed = 0
    prov_refs = [
        r"input_payload", r"sector_bench", r"historical_price",
        r"fundamentals_quarter", r"peer_comparison", r"analyst_consensus",
        r"behavioral_finance", r"macro_indicator", r"trading_calendar",
        r"previous_screening", r"model_param", r"index_constit",
    ]
    for pr in prov_refs:
        if re.search(pr + r".{0,80}(used|consult|read|load|referenc|analyz"
                     r"|discard|ignor|skip|flag|stale|outdated)",
                     notes_lower):
            prov_files_listed += 1
        elif re.search(r"(used|consult|read|load|referenc|analyz"
                       r"|discard|ignor|skip|flag|stale|outdated)"
                       r".{0,80}" + pr, notes_lower):
            prov_files_listed += 1
    if prov_files_listed >= 9:
        scores["data_provenance_documented"] = 1.0
    elif prov_files_listed >= 7:
        scores["data_provenance_documented"] = 0.7
    elif prov_files_listed >= 5:
        scores["data_provenance_documented"] = 0.4
    elif prov_files_listed >= 3:
        scores["data_provenance_documented"] = 0.2

    # --- confidence_interval_quantified (range, not point estimate) ---
    if re.search(
        r"(confidence|uncertain).{0,40}"
        r"(interval|range|band|bound|±|plus.{0,5}minus|between)"
        r".{0,60}(0\.\d+.{0,20}0\.\d+|\d+\s*%\s*.{0,10}\d+\s*%)",
        combined_lower,
    ):
        scores["confidence_interval_quantified"] = 1.0
    elif re.search(
        r"(confidence|uncertain).{0,60}"
        r"(interval|range|band|bound|±|plus.{0,5}minus)",
        combined_lower,
    ):
        scores["confidence_interval_quantified"] = 0.3

    # --- sharpe_or_risk_adjusted (risk-adjusted return metric) ---
    if re.search(
        r"(sharpe|information\s*ratio|sortino|calmar|treynor)"
        r".{0,60}(0\.\d+|\d+\.\d+)",
        combined_lower,
    ):
        scores["sharpe_or_risk_adjusted"] = 1.0
    elif re.search(
        r"(return|gain|performance).{0,30}(per|divid|adjust|relative)"
        r".{0,30}(risk|volatilit|drawdown|std|sigma)"
        r"|(risk.{0,10}adjust).{0,40}(return|metric|ratio|measure)",
        combined_lower,
    ):
        scores["sharpe_or_risk_adjusted"] = 0.4

    # --- quarterly_trend_direction (Q-o-Q trend shape analysis) ---
    trend_dims = 0
    for metric_pat in [
        r"revenue.{0,100}(accelerat|decelerat|linear|steady|slow|flatten"
        r"|quarter.{0,10}quarter|q.?o.?q|sequential)",
        r"(eps|earnings.{0,10}per).{0,100}(accelerat|decelerat|linear|steady"
        r"|quarter.{0,10}quarter|q.?o.?q|sequential|trend)",
        r"(roe|return.{0,5}equity).{0,100}(accelerat|decelerat|linear|steady"
        r"|quarter.{0,10}quarter|q.?o.?q|sequential|improv|trajectory)",
    ]:
        if re.search(metric_pat, combined_lower):
            trend_dims += 1
    if trend_dims >= 2:
        scores["quarterly_trend_direction"] = 1.0
    elif trend_dims >= 1:
        scores["quarterly_trend_direction"] = 0.4

    # --- macro_sector_linkage (PMI/CPI linked to sector impact) ---
    if re.search(
        r"(pmi|manufacturing|purchas).{0,120}"
        r"(print|it\s+service|donggang|002117|sector|industry|relevance"
        r"|impact|implication)"
        r"|(print|it\s+service|donggang|sector).{0,120}"
        r"(pmi|manufacturing|macro|gdp|cpi)",
        combined_lower,
    ):
        if re.search(
            r"(pmi|cpi|gdp).{0,40}(49|50|51)(\.\d+)?"
            r"|49\.\d.{0,60}50\.\d",
            combined_lower,
        ):
            scores["macro_sector_linkage"] = 1.0
        else:
            scores["macro_sector_linkage"] = 0.5

    # --- index_weight_implications (CSI 500 weight + institutional implications) ---
    if re.search(r"0\.08\s*%|csi.{0,10}500", combined_lower):
        if re.search(
            r"(0\.08|weight|csi.{0,10}500).{0,120}"
            r"(institut|attention|cover|visib|neglect|asymmetr|small|minor"
            r"|liquid|track|passive)"
            r"|(institut|attention|cover|visib|neglect|asymmetr).{0,120}"
            r"(0\.08|weight|csi.{0,10}500)",
            combined_lower,
        ):
            scores["index_weight_implications"] = 1.0
        else:
            scores["index_weight_implications"] = 0.4

    # --- debt_leverage_trajectory (debt-to-equity trend + risk discussion) ---
    has_dte = bool(re.search(
        r"(debt.{0,10}equity|leverage|d/e|dte).{0,100}"
        r"(0\.3[5-9]|0\.4[0-4]|increas|ris|grow|trajectory|trend)",
        combined_lower,
    ))
    dte_quantified = bool(re.search(
        r"(debt.{0,10}equity|leverage|d/e).{0,80}"
        r"0\.35.{0,80}0\.44"
        r"|0\.35.{0,80}0\.44.{0,80}(debt|leverage|d/e)",
        combined_lower,
    ))
    dte_risk = bool(re.search(
        r"(debt|leverage|d/e).{0,120}"
        r"(risk|concern|monitor|manag|sustain|caution|healthy)",
        combined_lower,
    ))
    if dte_quantified and dte_risk:
        scores["debt_leverage_trajectory"] = 1.0
    elif has_dte and dte_risk:
        scores["debt_leverage_trajectory"] = 0.5
    elif has_dte:
        scores["debt_leverage_trajectory"] = 0.25

    # --- information_ratio_sparse (explicit information ratio or signal-to-noise) ---
    has_info_ratio = bool(re.search(
        r"(information\s+ratio|signal.{0,5}noise|data.{0,5}signal)"
        r".{0,80}(0\.\d+|\d+\.\d+|low|weak|poor|limit|insuffic)",
        combined_lower,
    ))
    has_info_quant = bool(re.search(
        r"(information\s+ratio|signal.{0,5}noise).{0,60}"
        r"(0\.\d+|\d+\.\d+|(\d+)\s*out\s+of\s+(\d+)|\d+\s*/\s*\d+)",
        combined_lower,
    ))
    if has_info_quant:
        scores["information_ratio_sparse"] = 1.0
    elif has_info_ratio:
        scores["information_ratio_sparse"] = 0.4

    # --- multi_timeframe_volatility (full-period vs recent volatility comparison) ---
    full_vol = bool(re.search(
        r"(full|overall|entire|total|6.month|131.day).{0,60}"
        r"(volatilit|vol\b).{0,40}(1[8-9]|2[0-6])(\.\d+)?\s*%"
        r"|(1[8-9]|2[0-6])(\.\d+)?\s*%.{0,40}(volatilit|vol\b)"
        r".{0,60}(full|overall|entire|total|6.month)"
        r"|(volatilit|vol\b).{0,60}(1[8-9]|2[0-6])(\.\d+)?\s*%"
        r".{0,60}(full|overall|entire|total|6.month|131.day)",
        combined_lower,
    ))
    recent_vol = bool(re.search(
        r"(recent|20.day|short.term|current|consolidat).{0,60}"
        r"(volatilit|vol\b).{0,40}(8|9|1[0-5])(\.\d+)?\s*%"
        r"|(8|9|1[0-5])(\.\d+)?\s*%.{0,40}(volatilit|vol\b)"
        r".{0,60}(recent|20.day|short.term|current|consolidat)"
        r"|(volatilit|vol\b).{0,80}(8|9|1[0-5])(\.\d+)?\s*%"
        r".{0,60}(recent|20.day|short.term|current|consolidat)",
        combined_lower,
    ))
    vol_compare = bool(re.search(
        r"(volatilit|vol\b).{0,120}"
        r"(compress|contract|declin|lower|reduc|narrow|decreas)"
        r".{0,60}(recent|consolidat|current|short)",
        combined_lower,
    ))
    if full_vol and recent_vol:
        scores["multi_timeframe_volatility"] = 1.0
    elif full_vol and vol_compare:
        scores["multi_timeframe_volatility"] = 0.35
    elif recent_vol and vol_compare:
        scores["multi_timeframe_volatility"] = 0.35
    elif vol_compare:
        scores["multi_timeframe_volatility"] = 0.1

    return scores
```

## LLM Judge Rubric

### Criterion 1: Analytical Reasoning and Data Integration (Weight: 40%)

**Score 1.0**: Analysis integrates data from multiple workspace files with specific quantitative references AND computed metrics — including PE 22.8 vs sector average 28.5 (~20% discount), PB 2.1 vs 2.8 (~25% discount), dividend yield 1.85% vs 1.2% (~54% premium), revenue growth ~33% (797M→1061M), historical price return ~12%, ROE improving from 8.2% to 10.5% (+2.3pp). Computes annualized price volatility (~22%) and maximum drawdown (~11.7% in September 2025). Analyzes price-volume relationships across market phases. Correctly identifies all three data quality traps with full detail: stale peer data with BOTH market_cap (32.6 vs 45.2) AND pe_ttm (18.5 vs 22.8) discrepancies, citing peer_comparison.csv; outdated analyst consensus (06/15/2024, noting non-standard MM/DD/YYYY format AND quantifying ~20 months staleness); and holiday calendar (2026-02-12, explaining why screening proceeds). Rationale explicitly connects data sparsity, computed metrics, and the recommendation.
**Score 0.75**: References most workspace data sources with specific values and computes at least two derived metrics (sector discount percentages, return percentage, growth rates). Catches at least 2 of 3 traps with specific evidence. May compute volatility or drawdown but not both. Reasoning is data-driven but may lack full depth of all percentage calculations or cross-file validations.
**Score 0.5**: Basic analysis with limited data integration — mentions a few data points but relies mostly on generic statements about data being unavailable. Identifies at most 1 trap. Recommendation is reasonable but weakly supported by specific evidence.
**Score 0.25**: Superficial analysis without referencing specific values from the workspace files. No traps identified. Recommendation appears arbitrary or is a reflexive default without substantive reasoning.
**Score 0.0**: No meaningful analysis produced. All dimensions score 0 if the primary output file `output/analysis_result.json` does not exist.

### Criterion 2: Behavioral Finance Application (Weight: 30%)

**Score 1.0**: Identifies 3 or more relevant behavioral factors from the reference file and explains specifically how each applies to this particular sparse-data scenario — not generic textbook definitions. For example: ambiguity aversion amplified by three unavailable panels, anchoring risk from stale analyst target of 12.50, herding tendency when private information is absent. Draws explicit connection between identified factors and the confidence level or recommendation. Merely listing factor names with boilerplate descriptions does not qualify.
**Score 0.75**: Identifies 2 or more relevant factors with explanations that are contextualised to the sparse-data situation and at least one factor is explicitly linked to the chosen confidence level or recommendation. Connections between factors and the specific decision could be stronger or more quantitative.
**Score 0.5**: Lists 1–2 behavioral factors but explanations are generic — not tied to the specific sparse-data context or the stock's characteristics. Factors could apply to any stock in any scenario.
**Score 0.25**: Behavioral factors are merely listed as terms with no meaningful explanation or relevance discussion.
**Score 0.0**: No behavioral factors discussed, or output files do not exist. All dimensions score 0 if the primary output file `output/analysis_result.json` does not exist.

### Criterion 3: Documentation and Audit Trail (Weight: 30%)

**Score 1.0**: Screening notes comprehensively document which workspace sources were consulted and why each was used or discarded, with cross-file validation evidence and data freshness assessment including specific dates. Flags specific data quality issues with evidence (e.g., "peer_comparison.csv shows market_cap=32.6 AND pe_ttm=18.5 vs input_payload's 45.2/22.8 — discarded as stale", "analyst_consensus.json dated 06/15/2024 — approximately 20 months old, non-standard MM/DD/YYYY format"). Includes computed quantitative comparisons (sector discount percentages, growth rates, historical return, volatility, maximum drawdown) that formed the basis of the recommendation. Provides a clear, reproducible audit trail.
**Score 0.75**: Notes present with most key quality flags documented. Identifies at least 2 of 3 data quality traps by file name. References specific values and includes some computed metrics (at least one of: volatility, drawdown, growth rate). Some issues may be described generically rather than with exact figures.
**Score 0.5**: Notes exist but are thin on specifics — make general statements about data quality ("some data may be outdated") without citing exact values, dates, or file names. A response that merely lists file names without specific discrepant values cannot score above 0.5.
**Score 0.25**: Minimal notes produced, or only the JSON output was created with no accompanying documentation. Little to no quality assessment.
**Score 0.0**: No screening notes file produced, or output files do not exist. All dimensions score 0 if the primary output file `output/analysis_result.json` does not exist.

### Global fallback (all criteria)

If `output/analysis_result.json` is missing, empty, or not parseable as a JSON object, assign **0.0** to **Criterion 1**, **Criterion 2**, and **Criterion 3** — even if `output/screening_notes.md` or other files exist. High scores require a valid primary JSON screening result plus substantive supporting analysis in the rubric dimensions.
