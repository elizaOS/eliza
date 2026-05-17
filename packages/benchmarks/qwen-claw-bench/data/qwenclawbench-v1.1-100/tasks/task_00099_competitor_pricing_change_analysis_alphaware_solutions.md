---
id: task_00099_competitor_pricing_change_analysis_alphaware_solutions
name: Competitor Pricing Change Analysis — AlphaWare Solutions
category: Research and Information Retrieval
grading_type: hybrid
timeout_seconds: 1800
verification_method: rubric
input_modality: text-only
external_dependency: none
grading_weights:
  automated: 0.6
  llm_judge: 0.4
workspace_files:
- source: data/website_diff_2024-06-15.json
  dest: data/website_diff_2024-06-15.json
- source: data/competitor_profile.yaml
  dest: data/competitor_profile.yaml
- source: data/our_pricing.json
  dest: data/our_pricing.json
- source: data/change_history.csv
  dest: data/change_history.csv
- source: reports/market_overview_Q2_2024.md
  dest: reports/market_overview_Q2_2024.md
- source: data/alert_config.yaml
  dest: data/alert_config.yaml
- source: data/social_mentions.json
  dest: data/social_mentions.json
- source: data/internal_memo_pricing_strategy.md
  dest: data/internal_memo_pricing_strategy.md
- source: data/competitor_financials_summary.csv
  dest: data/competitor_financials_summary.csv
subcategory: Business and Market Research
---

## Prompt

Just got a SiteWatch alert this morning, AlphaWare Solutions made some significant changes to their pricing page overnight. I need you to pull together a competitor analysis based on everything we have in the workspace. I need two things from you:

First, put together a structured JSON analysis and save it to `competitor_analysis.json`. Break down what changed on their Enterprise plan, the new pricing, seat count, any new add-ons they introduced, versus what they had before. I want to see how their new pricing compares to our Enterprise plan, including the actual dollar gap between us. Flag whether they've moved into AI features, what direction their pricing has been trending based on the historical change data, and give me your competitive read on what this means for us, the implications plus a few recommended next steps we should consider.

Second, save a concise executive briefing to `executive_briefing.md`, something I can forward to the leadership team. Should have a situation overview, a side-by-side pricing comparison table showing their old vs new pricing alongside ours, and really dig into the value story, headline prices don't tell the whole picture when seat counts are shifting this much. Include the key takeaways on our competitive position and recommended next steps. 


## Expected Behavior

The agent should systematically examine all workspace files, identify the most current and authoritative data sources, and produce both a well-structured JSON analysis and a concise executive briefing.

**Key data resolution:**

1. **Trap 1 — Outdated internal memo vs. fresh website diff:** The file `data/internal_memo_pricing_strategy.md` (dated 2024-04-12) states that AlphaWare has "no AI features on their roadmap for 2024" and that their Enterprise plan is $299/mo for 50 seats. However, `data/website_diff_2024-06-15.json` (detected 2024-06-15) clearly shows AlphaWare has introduced an "AI Assistant Add-on" at $49/mo and changed their Enterprise plan to $249/mo with 100 seats. The agent must recognize the website diff is two months newer and represents directly observed changes on the competitor's live website, overriding the memo's now-incorrect assessment. The `has_ai_features` field must be `true`.

2. **Trap 2 — Financial CSV with stale implied pricing vs. website diff:** The file `data/competitor_financials_summary.csv` shows AlphaWare's `avg_deal_size` as $35,880/yr, a figure that reflects the old $299/mo Enterprise pricing and has not been updated to reflect the June 15 changes. The agent should not use this financial data to determine current pricing. The website diff is the authoritative source: the new Enterprise price is $249/mo with 100 seats.

3. **Pre-change corroborating sources:** The agent should recognize that `data/competitor_profile.yaml` (last updated 2024-05-20) and `reports/market_overview_Q2_2024.md` (dated June 10, 2024) both reflect pre-change pricing ($299/mo, 50 seats, no AI features). These are consistent with the website diff's `old_content` and correctly represent the state before the June 15 changes. The website diff supersedes all these sources for current pricing data.

**Correct values for the JSON output:**
- `competitor_name`: "AlphaWare Solutions"
- `change_detected_date`: "2024-06-15T08:32:00Z"
- `pricing_changes`: Enterprise price $249/mo, 100 seats, new AI Assistant Add-on at $49/mo
- `previous_pricing`: Enterprise price $299/mo, 50 seats
- `our_enterprise_price`: 279 (from `data/our_pricing.json`)
- `price_difference`: -30 (their $249 minus our $279 = -30, meaning they are now $30 cheaper)
- `has_ai_features`: true
- `pricing_trend`: "decreasing" or similar — the change history shows they raised from $279 to $299 in March 2024, but now dropped to $249, with the net recent direction being a significant decrease
- `competitive_implications`: Should mention that AlphaWare has undercut our Enterprise pricing and is now offering AI features (closing what was previously a competitive advantage for us), aligning with the Q2 market trend of AI bundling and enterprise price compression noted in `reports/market_overview_Q2_2024.md`
- `recommended_actions`: Should include actionable items such as reviewing our own Enterprise pricing, highlighting our included AI features vs. their paid add-on, and monitoring for further changes

**Executive briefing expectations:**
- The briefing should open with a situation overview (AlphaWare pricing change detected June 15)
- Must include a pricing comparison table showing AlphaWare's old pricing ($299/mo, 50 seats), new pricing ($249/mo, 100 seats, AI add-on at $49/mo), and our current pricing ($279/mo, 75 seats, AI included) side by side
- Should include a per-seat cost breakdown to show the value picture: AlphaWare's new per-seat cost is $2.49/seat/mo ($249 ÷ 100), down from $5.98/seat/mo ($299 ÷ 50); our per-seat cost is $3.72/seat/mo ($279 ÷ 75). On a per-seat basis, AlphaWare has gone from most expensive to cheapest, while our plan falls in the middle — though ours includes AI at no extra cost
- Should highlight key competitive implications: AlphaWare is now $30/mo cheaper at the plan level and dramatically cheaper per-seat, and has introduced AI capabilities
- Should conclude with prioritized recommended next steps
- All pricing figures must be derived from the actual workspace data (consistent with the JSON analysis)

The agent should trace AlphaWare's full pricing trajectory ($279→$299→$249) by cross-referencing `data/change_history.csv` records CHG-3820 (March 2024 increase) and CHG-4491 (June 2024 decrease). The change history log now contains records from multiple competitors (BetaTech Solutions, GammaCloud Inc), so the agent must filter for AlphaWare-specific entries when analyzing pricing trends.

The agent should explicitly mark stale data sources with their dates — at minimum identifying the internal memo (April 2024) and the website diff (June 2024) as temporally distinct sources, and stating which is outdated and which is authoritative.

The agent should focus on the data-bearing files for the pricing analysis and recognize that `data/alert_config.yaml` (monitoring tool configuration) and `data/social_mentions.json` (social media chatter) do not contain pricing intelligence needed for the core analysis, though social sentiment may optionally provide context for the briefing.

**Quality tiers (for grading reference):**
- *Basic completion:* Both deliverable files exist with reasonable structure; JSON is parseable with most required fields; executive briefing covers the competitive situation in general terms.
- *Good completion:* All pricing values are derived from the authoritative website diff source; data traps (stale memo, stale financials) are correctly avoided; the executive briefing contains a properly formatted pricing comparison table with accurate figures.
- *High-quality completion:* Per-seat cost analysis is included to demonstrate true value comparison (AlphaWare new: $2.49/seat, AlphaWare old: $5.98/seat, ours: $3.72/seat); competitive implications reference specific market trends from the Q2 report; recommended actions are concrete and prioritized with specific tactical suggestions; all cross-file data conflicts are explicitly resolved in favor of the most recent direct observation.

## Grading Criteria

- [ ] Output file `competitor_analysis.json` exists and is valid JSON
- [ ] `competitor_name` correctly identifies "AlphaWare Solutions" with substantive competitive implications (>100 chars) demonstrating analytical depth
- [ ] `change_detected_date` contains "2024-06-15T" in ISO format with output demonstrating awareness of data source authority (website diff as authoritative)
- [ ] `pricing_changes` reflects the new Enterprise price of $249/mo with enterprise plan context and analytical implications referencing competitive dynamics
- [ ] `pricing_changes` reflects the new seat count of 100 and cross-references the previous count of 50 in `previous_pricing` with substantive competitive analysis
- [ ] `pricing_changes` includes the AI Assistant Add-on at $49/mo
- [ ] `previous_pricing` correctly shows $299/mo and 50 seats
- [ ] `our_enterprise_price` is 279 with `price_difference` correctly computed as -30, and substantive competitive analysis demonstrating cross-field reasoning
- [ ] `price_difference` correctly computes as -30 (AlphaWare is $30 cheaper)
- [ ] `has_ai_features` is true with AI implications analyzed in competitive assessment (AI + competitive gap/differentiation language) — correctly overrides the outdated internal memo
- [ ] `pricing_trend` indicates decreasing direction backed by specific price-point evidence ($249/$299/$279) in the trend field itself, not just in implications
- [ ] `competitive_implications` references all four dimensions: pricing pressure vocabulary, AI competition with context, specific values ($249/$279/$30), and broader market trends (4/4 for full score)
- [ ] `recommended_actions` contains at least 2 substantive items (>30 chars each, referencing ≥2 competitive elements per item)
- [ ] Executive briefing `executive_briefing.md` exists with meaningful content
- [ ] Executive briefing contains a side-by-side pricing comparison table with all three pricing values (249/299/279) and per-seat cost data for full score
- [ ] Executive briefing provides substantive competitive analysis in prose (excluding headers): pricing comparison vocabulary, dollar-gap ($30) calculation, AI competitive implications, and market context — requires 3+ dimensions
- [ ] Executive briefing data accuracy: key pricing figures appear in analytical prose with proper context (249+279 with comparison words, $30 gap computation, 299→249 transition, $49 AI add-on context, per-seat derived calculations) — requires 4+ checks
- [ ] Executive briefing includes per-seat cost breakdown showing value comparison
- [ ] JSON output avoids stale data from outdated sources (internal memo, financial CSV, stale AI claims) and demonstrates explicit awareness of data source authority (website diff/SiteWatch as authoritative/primary)
- [ ] Output explicitly addresses data conflict resolution — how inconsistencies between workspace files of different dates were resolved
- [ ] Analysis integrates broader market trends (Q2 enterprise price compression, AI adoption race) from the market overview report
- [ ] Analysis includes pricing trajectory showing the $279→$299→$249 historical price path from change history data
- [ ] Analysis presents the complete 3-step pricing trajectory ($279→$299→$249) with explicit temporal ordering language, showing all three price points within a coherent narrative passage — full score requires raise-then-drop sequencing; partial for only reporting the latest $299→$249 change
- [ ] Output explicitly marks at least 2 data sources with their dates (internal memo April 2024, website diff June 2024) and contrasts their timeliness — full score requires both sources dated with staleness/authority language; partial for dating sources without explicit comparison

## Automated Checks

```python
import json
import re
from pathlib import Path


def grade(transcript: list, workspace_path: str) -> dict:
    results = {
        "output_file_valid_json": 0.0,
        "correct_competitor_name": 0.0,
        "correct_change_date": 0.0,
        "correct_new_price": 0.0,
        "correct_new_seats": 0.0,
        "correct_ai_addon": 0.0,
        "correct_previous_pricing": 0.0,
        "correct_our_price": 0.0,
        "correct_price_difference": 0.0,
        "correct_has_ai_features": 0.0,
        "correct_pricing_trend": 0.0,
        "competitive_implications_quality": 0.0,
        "recommended_actions_quality": 0.0,
        "executive_briefing_exists": 0.0,
        "briefing_has_comparison_table": 0.0,
        "briefing_competitive_analysis": 0.0,
        "briefing_data_accuracy": 0.0,
        "briefing_per_seat_analysis": 0.0,
        "avoids_stale_data": 0.0,
        "conflict_resolution_explicit": 0.0,
        "market_trend_integration": 0.0,
        "price_trajectory_analysis": 0.0,
        "pricing_trend_three_step": 0.0,
        "data_staleness_marking": 0.0,
    }

    ws = Path(workspace_path)

    def get_field(data, *names, default=None):
        for n in names:
            if n in data:
                return data[n]
        # One level deep: handle wrapper keys like {"analysis": {...}, "report": {...}}
        for v in data.values():
            if isinstance(v, dict):
                for n in names:
                    if n in v:
                        return v[n]
        return default

    def to_str(val):
        return json.dumps(val) if not isinstance(val, str) else val

    # ===== Read both deliverables =====
    output_path = ws / "competitor_analysis.json"
    parsed = None
    content = ""
    if output_path.exists():
        try:
            content = output_path.read_text(encoding="utf-8")
            parsed = json.loads(content)
        except Exception:
            parsed = None

    eb_path = ws / "executive_briefing.md"
    eb_content = ""
    if eb_path.exists():
        try:
            eb_content = eb_path.read_text(encoding="utf-8")
        except Exception:
            eb_content = ""

    all_lower = (content + "\n" + eb_content).lower()

    if isinstance(parsed, dict):
        results["output_file_valid_json"] = 1.0
        content_lower = content.lower()

        # ===== Pre-compute analytical depth gates =====
        ci = str(get_field(
            parsed, "competitive_implications", "implications",
            "competitive_analysis", "analysis", "competitive_assessment",
            "strategic_implications", "implications_summary",
            "market_implications", default=""
        )).lower()
        # Fall back to the full JSON content when the dedicated field is absent or tiny
        if len(ci) < 50:
            ci = content_lower
        ci_depth = len(ci) > 100
        ci_analytical = bool(re.search(
            r"(undercut|cheaper|price.{0,15}"
            r"(gap|war|pressure|advantage)|erode|narrow|aggressive)"
            r".{0,100}"
            r"\b(ai|feature|capabilit|add.?on|advantage|differenti)",
            ci,
        ))
        source_authority = bool(re.search(
            r"(website.?diff|sitewatch|monitor).{0,50}"
            r"(authorit|primary|definitive|most.recent|reliable)",
            all_lower,
        ))

        # --- competitor_name ---
        name = str(get_field(
            parsed, "competitor_name", "company_name", "company", "name",
            "competitor", "subject", "target_company", default=""
        )).strip().lower()
        # Content fallback: "alphaware"+"solutions" is specific enough to be safe
        if not name:
            name = content_lower
        if "alphaware" in name and "solution" in name:
            results["correct_competitor_name"] = 1.0
        elif "alphaware" in name:
            results["correct_competitor_name"] = 0.5

        # --- change_detected_date ---
        date_val = str(get_field(
            parsed, "change_detected_date", "detected_date",
            "date_detected", "detection_date", "change_date",
            "event_date", "detection_timestamp", default=""
        ))
        # Content fallback: extract ISO timestamp from raw JSON text
        if not date_val:
            _dm = re.search(r"2024-06-15T\d{2}:\d{2}", content)
            date_val = _dm.group(0) if _dm else (
                "2024-06-15" if "2024-06-15" in content else ""
            )
        if "2024-06-15T" in date_val:
            results["correct_change_date"] = 1.0
        elif "2024-06-15" in date_val:
            results["correct_change_date"] = 0.5

        # --- pricing_changes: new Enterprise price $249 ---
        # Use None sentinel so we can detect when the field is truly absent
        _pc_raw = get_field(
            parsed, "pricing_changes", "pricing_change", "new_pricing",
            "changes", "pricing_update", "price_changes", "updated_pricing", default=None
        )
        pc = _pc_raw if _pc_raw is not None else {}
        pc_str = to_str(pc).lower()
        # If field truly absent, fall back to the whole JSON text for pattern matching
        if _pc_raw is None:
            pc_str = content_lower

        _pp_raw = get_field(
            parsed, "previous_pricing", "old_pricing", "prior_pricing",
            "before", "former_pricing", "historical_pricing", default=None
        )
        pp = _pp_raw if _pp_raw is not None else {}
        pp_str = to_str(pp).lower()
        if _pp_raw is None:
            pp_str = content_lower
        has_249 = bool(re.search(r"\b249\b", pc_str))
        has_ent = bool(re.search(r"enterprise", pc_str))
        if has_249 and has_ent:
            results["correct_new_price"] = 1.0
        elif has_249:
            results["correct_new_price"] = 0.5

        # --- pricing_changes: new seat count 100 with change context ---
        has_100_seats = (
            bool(re.search(r"\b100\b", pc_str))
            and bool(re.search(r"seat", pc_str))
        )
        has_prev_50 = bool(re.search(r"\b50\b", pp_str))
        has_plan_ctx = bool(re.search(r"enterprise|plan", pc_str))
        if has_100_seats and has_prev_50 and has_plan_ctx:
            results["correct_new_seats"] = 1.0
        elif has_100_seats and (has_prev_50 or has_plan_ctx):
            results["correct_new_seats"] = 0.5
        elif has_100_seats:
            results["correct_new_seats"] = 0.25

        # --- pricing_changes: AI Assistant Add-on at $49 ---
        pc_vals = ""
        if isinstance(pc, dict):
            pc_vals = " ".join(str(v) for v in pc.values()).lower()
        elif isinstance(pc, list):
            pc_vals = " ".join(str(v) for v in pc).lower()
        else:
            pc_vals = str(pc).lower()
        ai_full = (
            re.search(r"\bai\b", pc_vals)
            and re.search(r"\b49\b", pc_vals)
            and re.search(r"add[\s-]on|assistant", pc_vals)
        )
        ai_partial = (
            re.search(r"\bai\b", pc_str)
            and re.search(r"\b49\b", pc_str)
        )
        ai_in_content = (
            re.search(r"ai.{0,30}(?:add.?on|assistant)", content_lower)
            and re.search(r"\b49\b", content)
        )
        if ai_full:
            results["correct_ai_addon"] = 1.0
        elif ai_partial:
            results["correct_ai_addon"] = 0.5
        elif ai_in_content:
            results["correct_ai_addon"] = 0.25

        # --- previous_pricing: $299/50 with temporal context ---
        has_299 = bool(re.search(r"\b299\b", pp_str))
        has_50 = bool(re.search(r"\b50\b", pp_str))
        pp_val_ctx = bool(re.search(
            r"old|previous|prior|before|former|original|was\b", pp_str
        ))
        pp_field_ctx = _pp_raw is not None
        if has_299 and has_50 and (pp_val_ctx or pp_field_ctx):
            results["correct_previous_pricing"] = 1.0
        elif has_299 and has_50:
            results["correct_previous_pricing"] = 0.5
        elif has_299 or has_50:
            results["correct_previous_pricing"] = 0.25

        # --- our_enterprise_price: 279 (joint with price_difference) ---
        our_price = get_field(
            parsed, "our_enterprise_price", "our_price",
            "our_plan_price", "our_pricing", "our_current_price",
            "current_price_ours", default=None
        )
        # Content fallback: $279 is specific enough in this task context
        if our_price is None and re.search(r"\b279\b", content):
            our_price = 279

        pd_field = get_field(
            parsed, "price_difference", "pricing_gap", "price_gap",
            "difference", "gap_analysis", "price_delta", "delta",
            "competitive_gap", default=None
        )
        # Content fallback for price_difference
        if pd_field is None:
            if re.search(r"-30\b", content):
                pd_field = -30
            elif re.search(r"\b30\b.{0,30}(cheaper|less|gap|lower|below)", content_lower):
                pd_field = -30
        if our_price is not None:
            price_ok = False
            try:
                val = float(
                    str(our_price).replace("$", "").replace(",", "").strip()
                )
                price_ok = abs(val - 279) < 1
            except (ValueError, TypeError):
                price_ok = "279" in str(our_price)
            pd_correct = False
            if pd_field is not None:
                try:
                    pd_val = float(
                        str(pd_field).replace("$", "").replace(",", "")
                        .replace("/mo", "").strip()
                    )
                    pd_correct = abs(pd_val - (-30)) < 1
                except (ValueError, TypeError):
                    pd_correct = "-30" in str(pd_field)
            if price_ok and pd_correct:
                results["correct_our_price"] = 1.0
            elif price_ok and pd_field is not None:
                results["correct_our_price"] = 0.5
            elif price_ok:
                results["correct_our_price"] = 0.25

        # --- price_difference: -30 ---
        if pd_field is not None:
            try:
                cleaned = (
                    str(pd_field).replace("$", "").replace(",", "")
                    .replace("/mo", "").strip()
                )
                val = float(cleaned)
                if abs(val - (-30)) < 1:
                    results["correct_price_difference"] = 1.0
                elif abs(abs(val) - 30) < 1:
                    results["correct_price_difference"] = 0.5
            except (ValueError, TypeError):
                s = str(pd_field).lower()
                if "-30" in s or "\u221230" in s:
                    results["correct_price_difference"] = 1.0
                elif "30" in s and any(
                    w in s
                    for w in ["less", "cheaper", "lower", "minus", "below"]
                ):
                    results["correct_price_difference"] = 0.75

        # --- has_ai_features (joint: require AI analysis in implications) ---
        hai = get_field(
            parsed, "has_ai_features", "ai_features", "offers_ai",
            "has_ai", "ai_enabled", "has_artificial_intelligence", default=None
        )
        # Content fallback: parse boolean assignment from raw JSON text
        if hai is None:
            if re.search(
                r'["\']has_ai[_\s]?features?["\']?\s*:\s*true'
                r'|["\']ai[_\s]?features?["\']?\s*:\s*true'
                r'|["\']offers_ai["\']?\s*:\s*true'
                r'|["\']has_ai["\']?\s*:\s*true',
                content_lower,
            ):
                hai = True
        hai_true = (
            hai is True
            or (isinstance(hai, str)
                and hai.strip().lower() in ("true", "yes"))
        )
        ai_analyzed = bool(re.search(
            r"\bai\b.{0,60}(compet|advantage|gap|differenti"
            r"|clos|catch|bundl|threat|disrupt|erode|narrow)",
            ci,
        ))
        if hai_true and ai_analyzed:
            results["correct_has_ai_features"] = 1.0
        elif hai_true:
            results["correct_has_ai_features"] = 0.5

        # --- pricing_trend (joint: require price-point evidence) ---
        trend = str(get_field(
            parsed, "pricing_trend", "trend", "price_trend", default=""
        )).lower()
        trend_kws = [
            "decreas", "declin", "down", "lower",
            "drop", "reduc", "fell", "cut",
        ]
        trend_correct = any(kw in trend for kw in trend_kws)
        trend_evidence_in_field = bool(
            re.search(r"\b(249|299|279)\b", trend)
        )
        trend_evidence_in_ci = bool(re.search(
            r"\b249\b.{0,120}\b299\b|\b299\b.{0,120}\b249\b", ci,
        ))
        if trend_correct and (trend_evidence_in_field or trend_evidence_in_ci):
            results["correct_pricing_trend"] = 1.0
        elif trend_correct:
            results["correct_pricing_trend"] = 0.5
        elif any(kw in trend for kw in ["volatil", "fluctuat", "mixed"]):
            results["correct_pricing_trend"] = 0.25

        # --- competitive_implications: content depth ---
        ci_pricing = bool(re.search(
            r"cheaper|undercut|price.{0,15}"
            r"(gap|differ|compet|war|cut|drop|lower|decreas|reduc|under)",
            ci,
        ))
        ci_ai = bool(re.search(
            r"\bai\b.{0,50}"
            r"(feature|capabilit|add.?on|advantage|gap"
            r"|compet|clos|introduc|launch)",
            ci,
        ))
        ci_specific = bool(
            re.search(r"249|279|\$30|30.{0,10}(cheap|less|lower)", ci)
        )
        ci_market = bool(
            re.search(r"market|trend|industr|q2|compress|bundl", ci)
        )
        ci_hits = sum([ci_pricing, ci_ai, ci_specific, ci_market])
        if ci_hits >= 4:
            results["competitive_implications_quality"] = 1.0
        elif ci_hits >= 3:
            results["competitive_implications_quality"] = 0.5
        elif ci_hits >= 2:
            results["competitive_implications_quality"] = 0.25

        # --- recommended_actions (stricter: length > 30, >= 2 keywords) ---
        ra = get_field(
            parsed, "recommended_actions", "action_items",
            "recommendations", "next_steps", default=[]
        )
        if isinstance(ra, list) and len(ra) >= 1:
            action_kws = [
                "pric", "review", "monitor", "ai", "feature",
                "enterprise", "seat", "compet", "strateg",
                "bundle", "add-on", "addon", "update", "analyz",
                "evaluat", "adjust", "highlight", "differentiat",
                "position", "sales", "respond",
            ]
            substantive = 0
            for item in ra:
                text = ""
                if isinstance(item, str):
                    text = item.strip().lower()
                elif isinstance(item, dict):
                    text = " ".join(
                        str(v) for v in item.values()
                    ).lower()
                kw_hits = sum(1 for kw in action_kws if kw in text)
                if len(text) > 30 and kw_hits >= 2:
                    substantive += 1
            if substantive >= 2:
                results["recommended_actions_quality"] = 1.0
            elif substantive >= 1:
                results["recommended_actions_quality"] = 0.5

        # --- avoids_stale_data ---
        stale_signals = [
            (hai is False
             or (isinstance(hai, str)
                 and hai.strip().lower() in ("false", "no"))),
            bool(re.search(r"35[,.]?880", content + eb_content)),
            bool(
                re.search(r"\b299\b", pc_str)
                and not re.search(r"\b249\b", pc_str)
            ),
            bool(
                not hai_true
                and re.search(
                    r"no ai.{0,20}(feature|roadmap|plan)",
                    ci,
                )
            ),
        ]
        no_stale = sum(bool(s) for s in stale_signals) == 0
        recency_signals = [
            bool(re.search(
                r"(june|jun|6[\-/]15|2024-06-15).{0,80}"
                r"(latest|most.recent|authorit|primary|definitive|reliable|up.to.date)",
                all_lower,
            )),
            bool(re.search(
                r"(website.?diff|sitewatch|monitor).{0,80}"
                r"(authorit|primary|latest|definitive|reliable|most.recent|up.to.date)",
                all_lower,
            )),
            bool(re.search(
                r"(most.recent|most.current|up.to.date|latest).{0,60}"
                r"(source|data|pric|observ|evidence|change)",
                all_lower,
            )),
        ]
        recency_aware = sum(recency_signals) >= 1
        if no_stale and recency_aware:
            results["avoids_stale_data"] = 1.0
        elif recency_aware:
            results["avoids_stale_data"] = 0.5
        elif no_stale:
            results["avoids_stale_data"] = 0.25

        # --- conflict_resolution_explicit ---
        cr_signals = [
            bool(re.search(
                r"(supersed|overrid|more.recent|most.recent"
                r"|newer.{0,20}source|latest.{0,25}"
                r"(data|source|observ))",
                all_lower,
            )),
            bool(re.search(
                r"(memo|april|internal).{0,60}"
                r"(outdat|stale|old|supersed|overrid"
                r"|no longer|prior to|incorrect|unreliable)",
                all_lower,
            )),
            bool(re.search(
                r"(website.?diff|june.?15|6[\-/]15"
                r"|direct.observ).{0,50}"
                r"(authorit|primary|reliab|trust"
                r"|definitive|accurate)",
                all_lower,
            )),
            bool(re.search(
                r"(conflict|discrepanc|contradict|inconsisten)"
                r".{0,50}(resolv|reconcil|priorit|favor|address)",
                all_lower,
            )),
        ]
        cr_hits = sum(cr_signals)
        if cr_hits >= 2:
            results["conflict_resolution_explicit"] = 1.0
        elif cr_hits >= 1:
            results["conflict_resolution_explicit"] = 0.5

        # --- market_trend_integration ---
        market_patterns = [
            r"(?:q2|second.quarter).{0,20}(?:2024|market|trend)",
            r"(?:price|pricing).{0,15}(?:compress|pressure|declin|drop)"
            r".{0,20}(?:market|industry|sector|enterprise)",
            r"\bai\b.{0,20}(?:arms.race|adoption|bundl|table.stakes)",
            r"(?:industry|market|sector).{0,10}(?:wide|trend|shift)",
            r"(?:10.{0,5}15\s*%|12\s*%|average.{0,20}(?:declin|drop))",
        ]
        market_hits = sum(
            1 for pat in market_patterns
            if re.search(pat, all_lower)
        )
        if market_hits >= 3:
            results["market_trend_integration"] = 1.0
        elif market_hits >= 2:
            results["market_trend_integration"] = 0.75
        elif market_hits >= 1:
            results["market_trend_integration"] = 0.5

        # --- price_trajectory_analysis ---
        traj_points = 0
        if re.search(
            r"\b279\b.{0,120}\b299\b|\b299\b.{0,120}\b279\b",
            content,
        ):
            traj_points += 1
        if re.search(
            r"\b299\b.{0,120}\b249\b|\b249\b.{0,120}\b299\b",
            content,
        ):
            traj_points += 1
        if re.search(
            r"(?:increas|rais|hik).{0,50}(?:then|before|later|"
            r"subsequently|now|but).{0,50}(?:decreas|drop|cut|reduc)"
            r"|(?:went up|rose).{0,50}(?:then|now|but|later)"
            r".{0,50}(?:drop|fell|decreas)",
            content.lower(),
        ):
            traj_points += 1
        if re.search(
            r"(?:march|2024-03).{0,50}(?:increas|rais|hik|went up)",
            content.lower(),
        ):
            traj_points += 1
        if traj_points >= 3:
            results["price_trajectory_analysis"] = 1.0
        elif traj_points >= 2:
            results["price_trajectory_analysis"] = 0.75
        elif traj_points >= 1:
            results["price_trajectory_analysis"] = 0.5

        # --- pricing_trend_three_step ---
        combined = content + "\n" + eb_content
        found_full_traj = False
        found_three_prices = False
        for m in re.finditer(r"\b(249|279|299)\b", combined):
            start = max(0, m.start() - 200)
            end = min(len(combined), m.start() + 400)
            window = combined[start:end]
            if (re.search(r"\b279\b", window)
                    and re.search(r"\b299\b", window)
                    and re.search(r"\b249\b", window)):
                wl = window.lower()
                has_temporal = bool(re.search(
                    r"(rais|increas|hik|went.up|from|initially"
                    r"|started|original).{0,100}"
                    r"(then|now|but|later|revers|subsequen"
                    r"|drop|cut|decreas|reduc|lower|fell)",
                    wl,
                ))
                if has_temporal:
                    found_full_traj = True
                    break
                found_three_prices = True

        if found_full_traj:
            results["pricing_trend_three_step"] = 1.0
        elif found_three_prices:
            results["pricing_trend_three_step"] = 0.5
        elif re.search(
            r"\b299\b.{0,150}\b249\b|\b249\b.{0,150}\b299\b",
            combined,
        ):
            results["pricing_trend_three_step"] = 0.25

        # --- data_staleness_marking ---
        memo_dated = bool(re.search(
            r"(memo|internal).{0,80}(april|2024[\-/]04|apr\.?\s*2024)",
            all_lower,
        )) or bool(re.search(
            r"(april|2024[\-/]04|apr\.?\s*2024).{0,80}(memo|internal)",
            all_lower,
        ))
        diff_dated = bool(re.search(
            r"(website.?diff|sitewatch|monitor|direct.observ)"
            r".{0,80}(june|2024[\-/]06|jun\.?\s*2024|6[\-/]15)",
            all_lower,
        )) or bool(re.search(
            r"(june|2024[\-/]06|jun\.?\s*2024|6[\-/]15)"
            r".{0,80}(website.?diff|sitewatch|monitor|direct.observ)",
            all_lower,
        ))
        staleness_contrast = bool(re.search(
            r"(outdat|stale|supersed|overrid|no.longer"
            r"|obsolet|newer|more.recent|prior.to)"
            r".{0,100}"
            r"(april|june|2024|memo|website|diff|observ)",
            all_lower,
        )) or bool(re.search(
            r"(april|2024[\-/]04).{0,200}(june|2024[\-/]06)"
            r"|(june|2024[\-/]06).{0,200}(april|2024[\-/]04)",
            all_lower,
        ))
        if memo_dated and diff_dated and staleness_contrast:
            results["data_staleness_marking"] = 1.0
        elif memo_dated and diff_dated:
            results["data_staleness_marking"] = 0.5
        elif memo_dated or diff_dated:
            results["data_staleness_marking"] = 0.25

    # ===== Secondary deliverable: executive_briefing.md =====
    if len(eb_content.strip()) >= 50:
        results["executive_briefing_exists"] = 1.0
        eb_lower = eb_content.lower()
        non_table = "\n".join(
            l for l in eb_content.split("\n") if "|" not in l
        )
        nt_lower = non_table.lower()
        prose = "\n".join(
            l for l in eb_content.split("\n")
            if "|" not in l and not l.strip().startswith("#")
        )
        prose_lower = prose.lower()

        has_table = bool(re.search(r"\|.*\|.*\|", eb_content))
        table_text = "\n".join(
            l for l in eb_content.split("\n") if "|" in l
        )
        unique_pricing = sum([
            bool(re.search(r"\b249\b", table_text)),
            bool(re.search(r"\b299\b", table_text)),
            bool(re.search(r"\b279\b", table_text)),
        ])
        per_seat_in_table = bool(re.search(
            r"2\.49|3\.72|5\.98|per.seat", table_text, re.IGNORECASE
        ))
        if has_table and unique_pricing >= 3 and per_seat_in_table:
            results["briefing_has_comparison_table"] = 1.0
        elif has_table and unique_pricing >= 3:
            results["briefing_has_comparison_table"] = 0.5
        elif has_table and unique_pricing >= 2:
            results["briefing_has_comparison_table"] = 0.25

        # --- briefing_competitive_analysis (prose-based, 4 dimensions) ---
        comp_vocab = bool(re.search(
            r"cheaper|undercut|price.{0,10}"
            r"(gap|pressure|war|advantage)"
            r"|competitive.{0,5}(threat|position.{0,10}revers)"
            r"|eroded|narrowed|aggressive",
            prose_lower,
        ))
        dollar_gap = bool(
            re.search(
                r"[-\u2212]?\$?30.{0,20}"
                r"(cheap|less|lower|gap|differ|under|saving)",
                prose_lower,
            )
            or re.search(r"(gap|differ).{0,20}\$?30\b", prose_lower)
        )
        ai_impl = bool(re.search(
            r"\bai\b.{0,80}"
            r"(advantage|differentiat|gap|clos|catch|bundle"
            r"|compet|include|add.?on|introduc|feature)",
            prose_lower,
        ))
        mkt_ctx = bool(re.search(
            r"(q2|market|industry).{0,50}"
            r"(trend|compress|bundl|shift|price)",
            prose_lower,
        ))
        bca_hits = sum([comp_vocab, dollar_gap, ai_impl, mkt_ctx])
        if bca_hits >= 3:
            results["briefing_competitive_analysis"] = 1.0
        elif bca_hits >= 2:
            results["briefing_competitive_analysis"] = 0.5

        # --- briefing_data_accuracy (contextual co-occurrence in prose) ---
        da_checks = [
            bool(
                re.search(r"\b249\b", non_table)
                and re.search(r"\b279\b", non_table)
                and re.search(
                    r"compar|versus|vs\.?|gap|differ|cheap|under|against",
                    nt_lower,
                )
            ),
            bool(
                re.search(
                    r"[-\u2212]?\$?30.{0,20}"
                    r"(cheap|less|lower|gap|differ|under|saving)",
                    nt_lower,
                )
                or re.search(
                    r"(gap|differ|delta|margin).{0,20}\$?30\b",
                    nt_lower,
                )
            ),
            bool(re.search(
                r"\b299\b.{0,80}\b249\b|\b249\b.{0,80}\b299\b",
                non_table,
            )),
            bool(re.search(
                r"\b49\b.{0,40}(\bai\b|add.?on)"
                r"|(\bai\b|add.?on).{0,40}\b49\b",
                nt_lower,
            )),
            bool(re.search(
                r"2\.49|3\.72|5\.98|\d+(\.\d+)?%|per[- ]seat",
                eb_lower,
            )),
        ]
        da_score = sum(da_checks)
        if da_score >= 4:
            results["briefing_data_accuracy"] = 1.0
        elif da_score >= 3:
            results["briefing_data_accuracy"] = 0.5
        elif da_score >= 2:
            results["briefing_data_accuracy"] = 0.25

        # --- briefing_per_seat_analysis ---
        has_per_seat_term = bool(
            re.search(r"per.seat|per\suser|\/seat|cost.per", eb_lower)
        )
        has_aw_per_seat = bool(
            re.search(r"2\.49|2\.50", eb_content)
        )
        has_our_per_seat = bool(
            re.search(r"3\.72|3\.73", eb_content)
        )
        ps_hits = sum([
            has_per_seat_term, has_aw_per_seat, has_our_per_seat
        ])
        if ps_hits >= 2:
            results["briefing_per_seat_analysis"] = 1.0
        elif ps_hits >= 1:
            results["briefing_per_seat_analysis"] = 0.5

    return results
```

## LLM Judge Rubric

**Human Reference Baseline:** A senior competitive intelligence analyst would cross-reference all 9 data sources, explicitly flag stale data with dates and credibility assessments, compute per-seat costs for all tiers, trace the full $279→$299→$249 pricing trajectory with temporal context, predict AlphaWare's likely next move based on the pattern, assess differential impact across customer segments (Starter/Professional/Enterprise), and provide actionable recommendations tied to specific competitive gaps with implementation timelines. Responses at or above this standard score 1.0 on the analytical criteria; those covering basic analysis without per-seat breakdowns, trajectory analysis, or forward-looking assessment score 0.5.

### Criterion 1: Data Resolution and Conflict Handling (Weight: 20%)

**Score 1.0**: Correctly identifies the website diff (`data/website_diff_2024-06-15.json`) as the authoritative source for current pricing. Explicitly dates each referenced data source (at minimum: internal memo — April 2024, website diff — June 2024, competitor profile — May 2024) with credibility/staleness language. Recognizes that the internal memo's "no AI features" assessment is outdated by the June 2024 observations and explicitly states WHY it is superseded (two-month gap, direct observation vs. internal speculation). Does not rely on the financial CSV's implied pricing ($35,880/yr figure). All pricing figures in both deliverables are derived from the most recent source.
**Score 0.5**: Uses the website diff as the primary source and gets all pricing values correct, but does not explicitly date the conflicting sources or explain the reasoning behind the prioritization. Merely states "the website diff is more recent" without identifying specific dates or credibility differences for each source.
**Score 0.25**: Partially resolves conflicts — gets some values from the correct source but uses stale data for others (e.g., correct new price but wrong AI feature status, or quotes the $35,880 financial figure as current).
**Score 0.0**: Uses outdated sources as authoritative (e.g., claims no AI features based on the internal memo, or uses the financial CSV's implied pricing as current). If `competitor_analysis.json` does not exist, score 0 on all dimensions.

### Criterion 2: Analytical Depth and Competitive Insight (Weight: 20%)

**Score 1.0**: Competitive implications reference specific data points: the $30 plan-level price gap, per-seat cost shift from $5.98→$2.49 for AlphaWare vs. our $3.72, AlphaWare's new AI add-on ($49/mo) vs. our included AI suite, and alignment with Q2 market trends of AI bundling and enterprise price compression from the market overview report. Traces the full $279→$299→$249 pricing trajectory with temporal context (March increase then June reversal). Recommended actions are concrete, prioritized, and tied to specific competitive gaps (e.g., "Emphasize our included AI suite vs. their $49/mo add-on in sales materials" rather than generic "monitor competitors"). The analysis connects individual data points into a coherent competitive narrative that explains the strategic significance of the pricing move.
**Score 0.5**: Mentions the pricing difference and AI competition but lacks per-seat cost analysis or does not compute derived values. References the $299→$249 change but misses the full $279→$299→$249 trajectory. Recommended actions are reasonable but generic (e.g., "review our pricing," "keep monitoring"). Does not connect the move to broader market trends from the Q2 report.
**Score 0.25**: Surface-level analysis that states obvious facts (e.g., "they lowered their price") without quantified competitive implications or per-seat breakdown. Recommended actions are vague one-liners with no reference to specific competitive elements.
**Score 0.0**: No meaningful competitive analysis provided. If `competitor_analysis.json` does not exist, score 0 on all dimensions.

### Criterion 3: Executive Briefing Quality (Weight: 15%)

**Score 1.0**: Briefing is concise, well-structured, and leadership-ready. Includes a clear situation overview, a correctly populated side-by-side pricing comparison table (AlphaWare old vs. new vs. ours) with percentage change annotations (e.g., "−17% price drop," "2× seat increase"), a per-seat cost breakdown ($2.49 vs. $3.72 vs. $5.98), and visualization-friendly data presentation (e.g., tables with clear delta columns or formatted percentage changes). Key competitive takeaways are sharp and data-driven. Prioritized next steps with specific tactical suggestions.
**Score 0.5**: Briefing has a comparison table with accurate figures (249/299/279) and reasonable structure, but lacks per-seat analysis, percentage change annotations, or reads more like a data dump than an executive document. Recommendations exist but are not prioritized or lack specificity.
**Score 0.25**: Briefing exists but is skeletal — missing the comparison table, or contains significant data errors, or lacks any competitive analysis prose.
**Score 0.0**: Executive briefing is missing or empty. If `executive_briefing.md` does not exist, score 0 on all dimensions.

### Criterion 4: Strategic Foresight and Implicit Requirements (Weight: 30%)

This criterion assesses whether the analysis goes beyond explicit task requirements to demonstrate the kind of forward-looking, holistic thinking expected from a senior competitive intelligence analyst. The Prompt asks only about the pricing change and competitive implications; a strong response should also address these implicit dimensions:

**Score 1.0** (requires at least 4 of the following 6 sub-dimensions):
- **Predictive analysis**: Predicts or speculates on AlphaWare's likely next pricing action based on the observed pattern (e.g., "The aggressive seat doubling and price cut suggests AlphaWare may be pursuing rapid market share growth; further discounts or feature bundling are likely in Q3").
- **Tier-differentiated impact assessment**: Evaluates how AlphaWare's changes affect our competitive position across different customer segments (Starter at $49/5 seats, Professional at $149/25 seats, Enterprise at $279/75 seats) rather than only analyzing Enterprise vs. Enterprise.
- **Data source credibility annotation**: Explicitly timestamps each data source with credibility assessment (e.g., "website diff [June 15, 2024] — high confidence, direct observation; internal memo [April 12, 2024] — low confidence, superseded by direct evidence; financial CSV — stale, reflects pre-change metrics").
- **AI add-on strategic impact**: Analyzes the customer decision-making impact of AlphaWare's AI add-on pricing model — e.g., customers who don't need AI can get AlphaWare's base Enterprise plan at $249 without the AI cost, making the effective gap $79 for AI-optional buyers vs. $30 for AI-wanting buyers.
- **Response timeframe recommendation**: Provides a suggested timeline for action (e.g., "Recommend pricing committee review within 2 weeks; sales team talking points update within 48 hours").
- **Visualization-friendly presentation**: Executive briefing includes visual-friendly data elements such as tables with percentage change columns, delta annotations, or structured comparison matrices beyond a simple price list.

**Score 0.5** (2–3 sub-dimensions present): Addresses some implicit requirements — e.g., provides a timeline suggestion and mentions tier impact, but lacks predictive analysis or data source credibility annotation.
**Score 0.25** (1 sub-dimension present): Shows minimal awareness of implicit requirements — e.g., briefly mentions "we should act quickly" without specific timelines, or notes AI pricing impact in passing without structured analysis.
**Score 0.0**: No evidence of strategic foresight or implicit requirement awareness. Analysis is purely reactive, addressing only explicitly stated requirements.

### Criterion 5: Completeness and Structural Accuracy (Weight: 15%)

**Score 1.0**: All required JSON fields are present with correct types (string, number, boolean, array as appropriate). ISO date format with T separator is used for `change_detected_date`. Pricing figures are numerically correct ($249, $299, $279, −$30, $49). The JSON is cleanly formatted and parseable. Both deliverable files exist and are well-formed.
**Score 0.5**: Both files exist; all core fields present but 1–2 minor type or format issues (e.g., price as string instead of number, date without T separator, `price_difference` as positive 30 instead of −30).
**Score 0.25**: Significant structural issues — multiple missing fields, incorrect types, or one deliverable file missing entirely.
**Score 0.0**: JSON is malformed, unparseable, or missing most required fields. If `competitor_analysis.json` does not exist, score 0 on all dimensions.
