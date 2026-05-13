---
id: task_00056_seo_long_tail_keyword_research_report_for_retirement_calculator
name: SEO Long-Tail Keyword Research Report for Retirement Calculator
category: Research and Information Retrieval
grading_type: hybrid
external_dependency: none
verification_method: rubric
input_modality: text-only
timeout_seconds: 1800
grading_weights:
  automated: 0.35
  llm_judge: 0.65
workspace_files:
- source: data/seed_keywords.json
  dest: data/seed_keywords.json
- source: data/keyword_research_export.csv
  dest: data/keyword_research_export.csv
- source: data/competitor_keywords.csv
  dest: data/competitor_keywords.csv
- source: data/search_intent_guide.json
  dest: data/search_intent_guide.json
- source: data/volume_thresholds.yaml
  dest: data/volume_thresholds.yaml
- source: data/competition_mapping.json
  dest: data/competition_mapping.json
- source: reports/previous_seo_audit.md
  dest: reports/previous_seo_audit.md
- source: config/output_template.md
  dest: config/output_template.md
- source: logs/research_tool_log.txt
  dest: logs/research_tool_log.txt
subcategory: Business and Market Research
---
## Prompt

We're about to launch a retirement withdrawal calculator on our finance site and I need you to put together an SEO keyword research report for the content team. I've already pulled all the raw data — there's a seed keyword config in `data/seed_keywords.json`, the full keyword research export in `data/keyword_research_export.csv`, competitor ranking data in `data/competitor_keywords.csv`, and a search intent guide in `data/search_intent_guide.json`. There are some other files in the workspace too, not sure how useful they all are.

Here's what I need: pick the **top 3 long-tail keywords** (4+ words each) from the data that are the best opportunities for us. For each one, classify its search intent, assess search volume and competition level, and come up with a suggested SEO page title (keep it under 60 characters). There's an output template at `config/output_template.md` — use that to structure your report.

One thing — please ground the volume and competition assessments in the actual numbers from the research export. There's a bunch of other config and reference files in the workspace; some of it might be useful context but I'm not 100% sure everything in there is still current, so use your judgment. Save the final report to `deliverables/seo_keywords_report.md`, and also dump the keyword picks with their raw numbers into `deliverables/keyword_analysis.json` — the dev team wants a machine-readable version they can feed into our CMS.

## Expected Behavior

The agent should perform the following steps to produce a correct solution:

1. **Read the seed keyword configuration** from `data/seed_keywords.json` to understand the target keyword ("retirement withdrawal calculator"), industry ("Finance & Retirement"), and output requirements (keywords must be 4+ words, max 3 keywords, with fields: keyword, searchIntent, searchVolume, competition, suggestedTitle).

2. **Analyze `data/keyword_research_export.csv`** to identify long-tail keyword candidates. The agent should filter for keywords with 4 or more words and evaluate them based on search volume (`avg_monthly_searches`), competition index (`competition_index`), CPC, and trend data. Short-tail or irrelevant keywords (e.g., "withdrawal calculator" with only 2 words) must be excluded. **Critical filter:** The CSV also contains high-ratio short-tail decoy keywords — "retirement withdrawal tool" (3 words, vol=5200, comp=15, ratio=346.7) and "early retirement calculator" (3 words, vol=4800, comp=12, ratio=400.0). Despite having the highest volume-to-competition ratios in the dataset, these are NOT long-tail keywords (only 3 words each) and must be excluded per the prompt's "4+ words each" requirement. The agent should prioritize keywords with the best volume-to-competition ratio among genuine long-tail candidates (4+ words), as these represent the most valuable content opportunities.

3. **Cross-reference with `data/competitor_keywords.csv`** to identify keyword opportunities where competitors rank but not strongly (in standard SEO, position 1–10 is page 1, 11–20 page 2, etc. — positions above ~10 indicate weaker rankings, and positions above ~30 suggest minimal organic visibility). For example, "simple retirement withdrawal calculator for beginners" has only one competitor at position 49 with 8 estimated traffic — a clear opportunity. In contrast, "fire movement retirement withdrawal calculator tool" has a competitor at position 7 with 222 traffic, indicating stronger existing competition on page 1.

4. **Classify search intent** using `data/search_intent_guide.json`, matching keyword patterns (e.g., "best" → commercial, "how much" → informational) to the appropriate intent category. Per the guide's `classificationNotes`, when a keyword matches multiple intent patterns, the most specific match takes priority — long-tail keywords with "calculator" default to transactional unless preceded by "how to" (→ informational) or "best" (→ commercial).

5. **Handle Trap 1 — Outdated volume thresholds in `data/volume_thresholds.yaml`:** This YAML file defines thresholds from 2019 (high: >5000, medium: 1000-5000, low: <1000) which are wildly inappropriate for long-tail niche keywords where volumes typically range 50-2000. The agent should recognize this file is outdated (it says `last_updated: 2019-03-15`) and instead derive volume classifications from the actual data distribution in the CSV. Appropriate thresholds for this niche would be roughly: high (>1000), medium (200-1000), low (<200). A keyword with 370 monthly searches should be classified as "medium," not "low."

6. **Handle Trap 2 — Contradictory competition data in `data/competition_mapping.json`:** This JSON file contains manual assessments from Q1 2022 that directly contradict the quantitative `competition_index` values in the CSV. For example, "401k retirement withdrawal calculator with taxes" has a competition_index of 72 in the CSV (high) but is labeled "low" in the JSON. Conversely, "best retirement withdrawal calculator for early retirement" has a competition_index of 25 in the CSV (low) but is labeled "high" in the JSON. The agent must use the CSV's quantitative data as the authoritative source, since it represents data-driven measurements rather than subjective manual assessments from years ago.

7. **Ignore noise files:** `reports/previous_seo_audit.md` is about insurance calculators (entirely different product line) and `logs/research_tool_log.txt` contains only operational API logs. Neither contains actionable data for this task.

8. **Produce the Markdown report** in `deliverables/seo_keywords_report.md` following the template in `config/output_template.md`, with a properly formatted Markdown table containing exactly 3 long-tail keywords, each with: keyword (4+ words), search intent, search volume assessment (including actual numeric values from the CSV, e.g., "880 monthly searches — Medium"), competition level (including the numeric competition_index value), and a suggested title under 60 characters.

9. **Produce the structured JSON output** in `deliverables/keyword_analysis.json` containing the same 3 keyword picks with their raw numeric data from the CSV (avg_monthly_searches, competition_index), classified volume/competition levels, search intent, trend data, and suggested titles. The JSON should have a top-level `keywords` array with 3 entries, each containing at minimum: `keyword`, `search_intent` (or `searchIntent`), `avg_monthly_searches` (or `searchVolume`), `competition_index` (or `competition`), `suggested_title` (or `suggestedTitle`), and `trend` (or `trend_3m`/`trendData`) reflecting the 3-month trend from the CSV. Numeric fields (`avg_monthly_searches`, `competition_index`) must contain actual integer values from the CSV, not string labels like "medium" or "low".

### Ground Truth — Keyword Data Verification

The following data points from the CSV have been manually verified and serve as ground truth for evaluating the agent's analysis:

**Volume thresholds (niche-appropriate, derived from data distribution):**
- Long-tail keywords (4+ words, retirement/withdrawal related) in this CSV range from 130 to 1,450 avg monthly searches
- Recommended classification: High (>1,000), Medium (200–1,000), Low (<200)
- The outdated `volume_thresholds.yaml` (2019) defines High as >5,000 — applying it would classify nearly all long-tail keywords as "low," which is incorrect for this niche

**Competition index trap verification:**
- "401k retirement withdrawal calculator with taxes": CSV competition_index = 72 (high), `competition_mapping.json` says "low" — CSV is authoritative
- "best retirement withdrawal calculator for early retirement": CSV competition_index = 25 (low), `competition_mapping.json` says "high" — CSV is authoritative

**Short-tail decoy keywords (must be excluded):**
- "retirement withdrawal tool": 3 words, vol=5200, comp=15, ratio=346.7 — NOT a long-tail keyword despite highest ratio
- "early retirement calculator": 3 words, vol=4800, comp=12, ratio=400.0 — NOT a long-tail keyword despite highest ratio
- These keywords deliberately test whether the agent enforces the 4+ word filter before optimizing for ratio

**Top keyword candidates (ranked by volume-to-competition ratio, 4+ words only):**

| Keyword | Vol | Comp | Trend | Ratio | Expected Intent |
|---------|-----|------|-------|-------|-----------------|
| best retirement withdrawal calculator for early retirement | 880 | 25 | +12% | 35.2 | commercial |
| fire movement retirement withdrawal calculator tool | 670 | 20 | +25% | 33.5 | transactional |
| how much can i withdraw from retirement calculator | 1450 | 45 | +15% | 32.2 | informational |
| early retirement withdrawal penalty calculator free | 540 | 18 | +22% | 30.0 | transactional |
| retirement withdrawal rate calculator by age | 1120 | 38 | +10% | 29.5 | transactional |
| simple retirement withdrawal calculator for beginners | 310 | 12 | +18% | 25.8 | transactional |
| best free retirement withdrawal planning calculator online | 760 | 32 | +19% | 23.8 | commercial |
| safe withdrawal rate retirement calculator online | 720 | 41 | +14% | 17.6 | transactional |

Any selection of 3 keywords from these top candidates (or other defensible picks from the data) is acceptable, provided the agent's reasoning is grounded in quantitative data from the CSV rather than the contradictory/outdated config files.

### Multi-Level Expectations

**Basic completion** (minimum viable): The agent produces `deliverables/seo_keywords_report.md` with a Markdown table containing 3 long-tail keywords, each with intent, volume, competition, and title fields filled in. The keywords are relevant to retirement withdrawal calculators and sourced from the data files.

**High-quality completion**: In addition to basic completion, the agent (a) explicitly identifies both data traps and articulates why the CSV is the authoritative source, (b) derives volume/competition classifications from the actual data distribution rather than config files, (c) cites specific quantitative values from the CSV to justify keyword selections, (d) cross-references competitor ranking data with specific position numbers and traffic estimates to identify content gaps, (e) produces a valid `keyword_analysis.json` with numeric integer values that exactly match the CSV source data (within 5% volume / ±2 competition tolerance) and keywords consistent with the report table, (f) classifies search intent correctly per the patterns in `search_intent_guide.json` AND explicitly cites the triggering pattern for each keyword's classification in the report body (e.g., "'best' indicates commercial intent per the guide"), (g) demonstrates analytical methodology such as volume-to-competition ratio ranking with explicit numeric ratio values, CPC analysis, AND inter-keyword comparative analysis (e.g., "keyword A has higher volume but lower trend than keyword B"), (h) grounds keyword selection reasoning with volume AND competition index AND at least 2 additional data factors (CPC, trend, ratio) per keyword in the report body text, (i) explicitly explains why outdated or contradictory config files were rejected, (j) derives and states niche-appropriate volume thresholds from the actual data distribution (citing the observed range of ~130–1,450 monthly searches for long-tail keywords and specific threshold boundaries), (k) factors actual CPC dollar values from the CSV for each selected keyword into the opportunity assessment (not just mentioning "CPC" generically), (l) correctly handles both data traps at the data level — all keyword volume labels reflect niche-appropriate thresholds (not YAML 2019) and all competition labels match CSV competition_index values (not contradictory JSON mapping), (m) includes a methodology or analytical framework section with quantitative evidence including specific ratio values and threshold derivation, (n) correctly excludes short-tail decoy keywords from the CSV (e.g., "retirement withdrawal tool" and "early retirement calculator" with only 3 words) despite their high volume-to-competition ratios, only selecting genuine 4+ word long-tail keywords, AND explicitly explains in the report body why these specific short-tail decoys were excluded despite their high ratios, (o) provides multi-factor justification for each selected keyword in the report body citing at least 4 of 5 factors (volume, competition index, CPC, trend, ratio), (p) each selected keyword's per-keyword rationale requires volume AND competition index as mandatory plus ALL 3 additional factors (CPC, trend, and ratio) for full credit, (q) suggested SEO titles contain at least 2 substantive words from their corresponding keyword phrase, (r) cites at least 30 distinct CSV-derived numeric values in the report body to demonstrate comprehensive data engagement across multiple keywords, (s) the `keyword_analysis.json` trend values exactly match the CSV trend data strings (e.g., "+12%") for cross-deliverable data integrity, (t) the `keyword_analysis.json` includes CPC values for each keyword that match the CSV source data, and (u) the report explicitly identifies noise/irrelevant workspace files — recognizing that `reports/previous_seo_audit.md` covers insurance calculators (a different product line) and `logs/research_tool_log.txt` contains only operational API logs, explaining why these files were disregarded.

## Grading Criteria

- [ ] The report file exists with sufficient content (≥200 chars), contains a properly formatted Markdown table with separator, references the seed keyword "retirement withdrawal calculator", includes industry context ("Finance & Retirement"), has a seed keyword section, contains exactly 3 long-tail keywords in the table, and all suggested titles are ≤60 characters AND contain at least 2 substantive words from their corresponding keyword — merged structural + quality check (`report_basic_format`)
- [ ] All 3 recommended keywords are actual entries from `data/keyword_research_export.csv` with 4+ words each (not fabricated or hallucinated keywords)
- [ ] The selected keywords are among the top keyword opportunities from the CSV by volume-to-competition ratio (top 3 full credit, top 5 partial, top 8 minimal)
- [ ] Search intent classifications are correct per `data/search_intent_guide.json` patterns AND the report body explicitly cites the triggering classification pattern for each keyword (e.g., "'best' indicates commercial intent") — label accuracy 30% + explicit reasoning 70% (`intent_classified_with_reasoning`)
- [ ] Volume labels (High/Medium/Low) reflect niche-appropriate thresholds derived from CSV data distribution (High >1000, Medium 200–1000, Low <200), not the outdated 2019 thresholds from `data/volume_thresholds.yaml`
- [ ] The report's volume column includes actual numeric values (avg_monthly_searches) from the CSV alongside qualitative labels
- [ ] Competition labels align with the quantitative `competition_index` from the CSV (≥55 = High, 30–54 = Medium, <30 = Low), not the contradictory manual assessments in `data/competition_mapping.json`
- [ ] The report's competition column includes actual competition_index values (±1 tolerance) from the CSV alongside qualitative levels
- [ ] The report handles noise files correctly: (30%) keyword column does not incorporate irrelevant insurance calculator terms from `reports/previous_seo_audit.md`, AND (70%) the report body explicitly identifies noise/irrelevant workspace files — mentions `previous_seo_audit.md` as covering a different product (insurance) and/or `research_tool_log.txt` as containing only operational logs — demonstrating deliberate file triage (`noise_file_handling`)
- [ ] All 3 recommended keywords are genuine long-tail keywords (4+ words each) AND the report body explicitly justifies the exclusion of short-tail decoys — (40%) all table keywords are 4+ words, (60%) the report mentions specific decoy keywords like "retirement withdrawal tool" or "early retirement calculator" in the context of exclusion, or explains why 3-word high-ratio keywords were filtered out (`short_tail_exclusion_justified`)
- [ ] The report references competitor ranking data (positions, traffic estimates) from `data/competitor_keywords.csv` to justify keyword opportunities or identify content gaps
- [ ] The report explicitly identifies at least 4 of 5 data quality signals — outdated/2019 mention, contradiction mention, `volume_thresholds.yaml` reference, `competition_mapping.json` reference, CSV-as-authoritative statement — demonstrating trap awareness (`trap_identification_signals`, denominator 4)
- [ ] The report demonstrates analytical depth through 6 signals: volume-to-competition ratio, niche/long-tail terminology, trend data, data distribution/quantitative terms, CPC reference, AND inter-keyword comparative analysis — requires 6/6 for full credit (`analytical_depth`)
- [ ] Keyword selection reasoning in the report body cites volume AND competition index AND at least 2 additional factors (CPC, trend, ratio) per keyword to ground the selection rationale (`selection_rationale_grounded`)
- [ ] The `deliverables/keyword_analysis.json` is valid JSON with 3 keyword entries, required fields, numeric integer types for volume and competition, AND trend data for each entry — merged completeness check (`json_completeness`)
- [ ] Numeric values in `keyword_analysis.json` (avg_monthly_searches, competition_index) match the actual values in `data/keyword_research_export.csv` within 5% tolerance for volume and ±2 for competition index; partial credit reduced for single-field match (`json_values_match_csv`)
- [ ] The report includes explicit volume-to-competition ratio analysis with numeric ratio values (e.g., "ratio of 35.2") for the selected keywords
- [ ] The report references CPC data with term mention AND dollar amounts AND actual CSV CPC values matched for ≥2 selected keywords — 3-signal check (`cpc_data_referenced`)
- [ ] The report explicitly derives niche-appropriate volume thresholds from the actual data distribution, citing the observed search volume range (approximately 130–1,450 for long-tail keywords) and stating specific threshold boundaries (e.g., 200 and 1,000)
- [ ] The report cites specific competitor position numbers and traffic estimates from `data/competitor_keywords.csv` (e.g., "position 49 with 8 estimated traffic") rather than generic competitor references
- [ ] The keywords in `deliverables/keyword_analysis.json` match the 3 keywords in the report's Markdown table, with numeric type fields present, trend values exactly matching CSV trend data, AND CPC values matching CSV CPC data (within 10% tolerance) — cross-deliverable consistency with data integrity check including CPC verification (`json_keywords_match_report`)
- [ ] Both data traps are correctly handled at the data level — no keyword with volume ≥200 is labeled "low" (avoiding the YAML 2019 trap) and no keyword with competition_index <30 is labeled "high" (avoiding the contradictory JSON mapping trap)
- [ ] The report body text (outside the Markdown table) cites at least 30 distinct CSV-derived numeric values (volumes, competition indices, CPC values, ratio values) demonstrating deep data engagement across both selected and non-selected candidate keywords (`report_body_data_density`)
- [ ] Each selected keyword has multi-factor justification in the report body text, citing all 5 factors: volume value, competition index, CPC, trend data, and volume-to-competition ratio — requires 5/5 for full credit (`keyword_opportunity_multi_factor`)
- [ ] Each selected keyword has multi-factor justification with volume AND competition index as mandatory, plus ALL 3 additional factors (CPC, trend, AND ratio) for full credit — 2 additional factors scores 0.67, 1 additional factor scores 0.33 (`selection_rationale_quality`)
- [ ] The report includes a methodology section (or equivalent analytical framework) with quantitative evidence — specific ratio values, threshold derivation numbers, or data distribution observations
- [ ] ALL 3 keywords have both correct niche-appropriate volume labels (High >1000, Medium 200–1000, Low <200) AND correct CSV-based competition labels (≥55 = High, 30–54 = Medium, <30 = Low) — all-or-nothing check with no partial credit

## Automated Checks

```python
import os
import re
import csv
import json

def grade(transcript: list, workspace_path: str) -> dict:
    """Grade the SEO keyword research report and structured JSON output."""

    report_path = os.path.join(workspace_path, "deliverables", "seo_keywords_report.md")
    json_path = os.path.join(workspace_path, "deliverables", "keyword_analysis.json")
    csv_path = os.path.join(workspace_path, "data", "keyword_research_export.csv")

    scores = {
        "report_basic_format": 0.0,
        "keywords_exist_in_csv": 0.0,
        "keywords_are_top_candidates": 0.0,
        "intent_classified_with_reasoning": 0.0,
        "volume_uses_niche_thresholds": 0.0,
        "volume_numeric_cited": 0.0,
        "competition_uses_csv_index": 0.0,
        "competition_numeric_cited": 0.0,
        "noise_file_handling": 0.0,
        "short_tail_exclusion_justified": 0.0,
        "competitor_data_utilized": 0.0,
        "trap_identification_signals": 0.0,
        "analytical_depth": 0.0,
        "selection_rationale_grounded": 0.0,
        "json_completeness": 0.0,
        "json_values_match_csv": 0.0,
        "ratio_analysis_in_report": 0.0,
        "cpc_data_referenced": 0.0,
        "threshold_derivation_explicit": 0.0,
        "competitor_position_specifics": 0.0,
        "json_keywords_match_report": 0.0,
        "trap_handling_verified": 0.0,
        "report_body_data_density": 0.0,
        "keyword_opportunity_multi_factor": 0.0,
        "selection_rationale_quality": 0.0,
        "report_quantitative_methodology": 0.0,
        "volume_competition_labels_all_correct": 0.0,
    }

    if not os.path.isfile(report_path):
        return scores

    try:
        with open(report_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return scores

    content_lower = content.lower()

    # --- report_basic_format (merged: structure + seed + industry + keyword count + title quality) ---
    bf_score = 0.0
    if len(content) >= 200:
        bf_score += 0.15
    if re.search(r"\|.*\|.*\|", content) and re.search(r"(?m)^\|[\s\-:]+\|", content):
        bf_score += 0.1
    elif re.search(r"\|.*\|.*\|", content):
        bf_score += 0.05
    if re.search(r"(?i)\bretirement\s+withdrawal\s+calculator\b", content):
        bf_score += 0.15
    if re.search(r"(?i)finance\s*(?:&|and)\s*retirement", content):
        bf_score += 0.1
    if re.search(r"(?i)seed\s*keyword", content):
        bf_score += 0.1

    csv_keywords = {}
    try:
        with open(csv_path, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                kw = row["keyword"].strip().lower()
                csv_keywords[kw] = {
                    "vol": int(row["avg_monthly_searches"].strip()),
                    "comp": int(row["competition_index"].strip()),
                    "trend": row["trend_3m"].strip(),
                    "cpc": float(row["cpc_usd"].strip()),
                }
    except Exception:
        pass

    table_lines = re.findall(r'(?m)^\|(.+)\|$', content)
    data_rows = []
    for line in table_lines:
        stripped = line.strip().strip("|").strip()
        if re.match(r'^[\s\-:|]+$', stripped):
            continue
        cells = [c.strip() for c in line.split("|")]
        cells = [c for c in cells if c.strip()]
        if len(cells) >= 2:
            first = re.sub(r'[*_`\[\]]', '', cells[0]).strip().lower()
            if re.search(r'^\s*keyword\s*$', first):
                continue
            if ("retirement" in first or "withdrawal" in first) and len(first.split()) >= 4:
                data_rows.append([re.sub(r'[*_`\[\]]', '', c).strip() for c in cells])

    n_kw = len(data_rows)

    # Compute non-table text early (needed by multiple keys)
    non_table_lines_list = []
    for line in content.split("\n"):
        if not re.match(r'^\s*\|', line):
            non_table_lines_list.append(line)
    non_table_text = "\n".join(non_table_lines_list)

    # Complete report_basic_format: merged keyword count + title quality checks
    stop_words = {"for", "with", "the", "a", "and", "to", "of", "in", "by", "from", "i", "can", "my", "is"}
    if n_kw == 3:
        bf_score += 0.15
    elif n_kw == 2:
        bf_score += 0.1
    elif n_kw > 3:
        bf_score += 0.07
    if data_rows:
        title_sub = 0.0
        title_count = 0
        for row_cells in data_rows:
            if len(row_cells) >= 5:
                title = row_cells[4].strip()
                if title and len(title) > 3:
                    title_count += 1
                    kw_words = set(row_cells[0].strip().lower().split()) - stop_words
                    title_words = set(title.lower().split()) - stop_words
                    overlap = len(kw_words & title_words)
                    if len(title) <= 60 and overlap >= 2:
                        title_sub += 1.0
                    elif len(title) <= 60:
                        title_sub += 0.5
        if title_count > 0:
            bf_score += 0.25 * (title_sub / title_count)
    scores["report_basic_format"] = min(bf_score, 1.0)

    # --- short_tail_exclusion_justified (4+ words check + explicit decoy exclusion reasoning) ---
    all_table_keywords = []
    for line in table_lines:
        stripped = line.strip().strip("|").strip()
        if re.match(r'^[\s\-:|]+$', stripped):
            continue
        cells = [c.strip() for c in line.split("|")]
        cells = [c for c in cells if c.strip()]
        if len(cells) >= 2:
            first = re.sub(r'[*_`\[\]]', '', cells[0]).strip().lower()
            if re.search(r'^\s*keyword\s*$', first):
                continue
            if any(term in first for term in ["retirement", "withdrawal", "pension",
                                               "calculator", "payout", "401k"]):
                all_table_keywords.append(first)

    if all_table_keywords:
        check_kws = all_table_keywords[:3]
        longtail_count = sum(1 for kw in check_kws if len(kw.split()) >= 4)
        st_base = 0.0
        if longtail_count >= 3:
            st_base = 1.0
        elif longtail_count == 2:
            st_base = 0.5
        elif longtail_count == 1:
            st_base = 0.25

        st_justified = 0.0
        decoy_names = ["retirement withdrawal tool", "early retirement calculator"]
        for decoy in decoy_names:
            decoy_esc = re.escape(decoy)
            if re.search(rf'(?is){decoy_esc}.{{0,300}}'
                         rf'(exclud|filter|reject|not\s+(?:select|chosen|long.?tail)|'
                         rf'3.?word|short.?tail|only\s+\d\s+word)', non_table_text):
                st_justified = 1.0
                break
            if re.search(rf'(?is)(exclud|filter|reject|not\s+(?:select|chosen|long.?tail)|'
                         rf'3.?word|short.?tail|only\s+\d\s+word).{{0,300}}{decoy_esc}',
                         non_table_text):
                st_justified = 1.0
                break
        if st_justified < 1.0:
            if re.search(r'(?i)(short.?tail|3.?word|three.?word|fewer\s+than\s+4|less\s+than\s+4)'
                         r'.{0,200}(exclud|filter|reject|not\s+(?:select|qualify|include))',
                         non_table_text):
                st_justified = 0.5
            elif re.search(r'(?i)(exclud|filter|reject|not\s+(?:select|qualify|include))'
                           r'.{0,200}(short.?tail|3.?word|three.?word|fewer\s+than\s+4)',
                           non_table_text):
                st_justified = 0.5
        scores["short_tail_exclusion_justified"] = round(
            st_base * 0.4 + st_justified * 0.6, 2)

    longtail_csv = {kw for kw in csv_keywords if len(kw.split()) >= 4}

    def match_csv_keyword(kw_text):
        if kw_text in csv_keywords:
            return kw_text
        for csv_kw in longtail_csv:
            if csv_kw in kw_text or kw_text in csv_kw:
                return csv_kw
        return None

    # --- keywords_exist_in_csv ---
    if csv_keywords and data_rows:
        matched = 0
        for row_cells in data_rows:
            kw_text = row_cells[0].strip().lower()
            if match_csv_keyword(kw_text):
                matched += 1
        total = min(n_kw, 3)
        if total > 0:
            scores["keywords_exist_in_csv"] = round(matched / total, 2)

    # --- keywords_are_top_candidates (tightened: top-3 full, top-5 partial, top-8 minimal) ---
    longtail_ratios = {}
    if csv_keywords:
        for kw, data in csv_keywords.items():
            if (len(kw.split()) >= 4 and data["comp"] > 0
                    and ("retirement" in kw or "withdrawal" in kw)):
                longtail_ratios[kw] = data["vol"] / data["comp"]
    if longtail_ratios and data_rows:
        sorted_ratios = sorted(longtail_ratios.values(), reverse=True)
        top3_threshold = sorted_ratios[min(2, len(sorted_ratios) - 1)]
        top5_threshold = sorted_ratios[min(4, len(sorted_ratios) - 1)]
        top8_threshold = sorted_ratios[min(7, len(sorted_ratios) - 1)]
        ratio_score = 0
        checked = 0
        for row_cells in data_rows:
            kw_text = row_cells[0].strip().lower()
            kw_match = match_csv_keyword(kw_text)
            if kw_match and kw_match in longtail_ratios:
                checked += 1
                kw_ratio = longtail_ratios[kw_match]
                if kw_ratio >= top3_threshold:
                    ratio_score += 1.0
                elif kw_ratio >= top5_threshold:
                    ratio_score += 0.67
                elif kw_ratio >= top8_threshold:
                    ratio_score += 0.33
        if checked > 0:
            scores["keywords_are_top_candidates"] = round(ratio_score / checked, 2)

    # --- intent_classified_with_reasoning (tightened: label correctness + explicit guide-based reasoning) ---
    if data_rows:
        label_score = 0
        reasoning_score = 0
        checked = 0
        for row_cells in data_rows:
            if len(row_cells) >= 2:
                kw_text = row_cells[0].strip().lower()
                intent_cell = row_cells[1].strip().lower()
                trigger = None
                if any(p in kw_text for p in ["how to", "how much", "how does", "what is"]):
                    expected = "informational"
                    trigger = next(p for p in ["how to", "how much", "how does", "what is"] if p in kw_text)
                elif any(p in kw_text for p in ["best", "top", "compare", "vs", "review"]):
                    expected = "commercial"
                    trigger = next(p for p in ["best", "top", "compare", "vs", "review"] if p in kw_text)
                elif any(p in kw_text for p in ["calculator", "free", "tool", "online"]):
                    expected = "transactional"
                    trigger = next(p for p in ["calculator", "free", "tool", "online"] if p in kw_text)
                else:
                    expected = "informational"
                if expected in intent_cell:
                    label_score += 1
                checked += 1
                if trigger:
                    kw_frag = re.escape(" ".join(kw_text.split()[:3]))
                    trigger_esc = re.escape(trigger)
                    pats = [
                        rf'(?is){kw_frag}.{{0,400}}(?:{trigger_esc}).{{0,200}}(?:intent|classif|categor|{re.escape(expected)})',
                        rf'(?is)(?:intent|classif|categor|{re.escape(expected)}).{{0,200}}(?:{trigger_esc}).{{0,400}}{kw_frag}',
                        rf'(?is)(?:{trigger_esc}).{{0,300}}(?:{re.escape(expected)}).{{0,300}}{kw_frag}',
                    ]
                    for p in pats:
                        if re.search(p, non_table_text):
                            reasoning_score += 1
                            break
        if checked > 0:
            scores["intent_classified_with_reasoning"] = round(
                0.3 * (label_score / checked) + 0.7 * (reasoning_score / checked), 2)

    # --- volume_uses_niche_thresholds (label accuracy) ---
    if data_rows and csv_keywords:
        label_correct = 0
        checked = 0
        for row_cells in data_rows:
            if len(row_cells) >= 3:
                kw = row_cells[0].strip().lower()
                vol_text = row_cells[2].strip().lower()
                kw_match = match_csv_keyword(kw)
                if kw_match:
                    csv_vol = csv_keywords[kw_match]["vol"]
                    checked += 1
                    if csv_vol > 1000:
                        expected_label = "high"
                    elif csv_vol >= 200:
                        expected_label = "medium"
                    else:
                        expected_label = "low"
                    if expected_label in vol_text:
                        label_correct += 1
                    elif expected_label == "high" and "medium" in vol_text:
                        label_correct += 0.5
                    elif expected_label == "low" and "medium" in vol_text:
                        label_correct += 0.5
        if checked > 0:
            scores["volume_uses_niche_thresholds"] = round(label_correct / checked, 2)

    # --- volume_numeric_cited ---
    if csv_keywords and data_rows:
        cited = 0
        checked = 0
        for row_cells in data_rows:
            kw_text = row_cells[0].strip().lower()
            kw_match = match_csv_keyword(kw_text)
            if kw_match:
                checked += 1
                csv_vol = csv_keywords[kw_match]["vol"]
                found = False
                if len(row_cells) >= 3:
                    nums = re.findall(r"\d+", row_cells[2].replace(",", ""))
                    if any(abs(int(n) - csv_vol) <= csv_vol * 0.15 for n in nums):
                        found = True
                if found:
                    cited += 1
        if checked > 0:
            scores["volume_numeric_cited"] = round(cited / checked, 2)

    # --- competition_uses_csv_index (label accuracy) ---
    if data_rows and csv_keywords:
        label_correct = 0
        checked = 0
        for row_cells in data_rows:
            if len(row_cells) >= 4:
                kw = row_cells[0].strip().lower()
                comp_text = row_cells[3].strip().lower()
                kw_match = match_csv_keyword(kw)
                if kw_match:
                    csv_comp = csv_keywords[kw_match]["comp"]
                    checked += 1
                    gross_error = False
                    if csv_comp >= 55 and "low" in comp_text and "medium" not in comp_text:
                        gross_error = True
                    if csv_comp < 30 and "high" in comp_text and "medium" not in comp_text:
                        gross_error = True
                    if gross_error:
                        label_correct += 0.0
                    else:
                        if csv_comp >= 55:
                            expected = "high"
                        elif csv_comp >= 30:
                            expected = "medium"
                        else:
                            expected = "low"
                        if expected in comp_text:
                            label_correct += 1.0
                        else:
                            moderate_err = False
                            if csv_comp >= 55 and "medium" in comp_text:
                                moderate_err = True
                            if csv_comp < 20 and "medium" in comp_text:
                                moderate_err = True
                            label_correct += 0.25 if moderate_err else 0.5
        if checked > 0:
            scores["competition_uses_csv_index"] = round(label_correct / checked, 2)

    # --- competition_numeric_cited ---
    if csv_keywords and data_rows:
        cited = 0
        checked = 0
        for row_cells in data_rows:
            kw_text = row_cells[0].strip().lower()
            kw_match = match_csv_keyword(kw_text)
            if kw_match and len(row_cells) >= 4:
                checked += 1
                csv_comp = csv_keywords[kw_match]["comp"]
                nums = re.findall(r"\d+", row_cells[3])
                if any(abs(int(n) - csv_comp) <= 1 for n in nums):
                    cited += 1
        if checked > 0:
            scores["competition_numeric_cited"] = round(cited / checked, 2)

    # --- noise_file_handling (no insurance contamination + noise file awareness) ---
    insurance_terms = ["insurance premium calculator", "insurance estimator",
                       "insurance comparison tool", "term life insurance",
                       "insurance calculator", "health insurance comparison",
                       "insurecalc", "disability insurance", "universal life insurance",
                       "auto insurance quote"]
    kw_column_texts = []
    for line in table_lines:
        stripped = line.strip().strip("|").strip()
        if re.match(r'^[\s\-:|]+$', stripped):
            continue
        cells = [c.strip() for c in line.split("|")]
        cells = [c for c in cells if c.strip()]
        if len(cells) >= 2:
            first = re.sub(r'[*_`\[\]]', '', cells[0]).strip().lower()
            if not re.search(r'^\s*keyword\s*$', first):
                kw_column_texts.append(first)
    kw_column_joined = " ".join(kw_column_texts)
    nfh_score = 0.0
    if not any(t in kw_column_joined for t in insurance_terms):
        nfh_score += 0.3
    noise_awareness = 0
    if re.search(r'(?is)(previous.seo.audit|seo.audit|insurance\s*(?:calculator|estimator|comparison))'
                 r'.{0,300}(irrelevant|different\s*product|unrelated|not\s*(?:relevant|applicable|useful)|'
                 r'wrong\s*product|other\s*product|ignor|discard|disregard)', non_table_text):
        noise_awareness += 1
    elif re.search(r'(?is)(irrelevant|different\s*product|unrelated|not\s*(?:relevant|applicable|useful)|'
                   r'ignor|discard).{0,300}(previous.seo.audit|insurance)', non_table_text):
        noise_awareness += 1
    if re.search(r'(?is)(research.tool.log|tool.log|api.log)'
                 r'.{0,300}(operational|not\s*(?:useful|relevant|actionable)|log\s*(?:data|file)|'
                 r'ignor|discard|disregard|no\s*actionable)', non_table_text):
        noise_awareness += 1
    elif re.search(r'(?is)(operational|log\s*(?:data|file)|not\s*(?:useful|relevant|actionable))'
                   r'.{0,300}(research.tool.log|tool.log)', non_table_text):
        noise_awareness += 1
    nfh_score += 0.7 * min(noise_awareness / 2, 1.0)
    scores["noise_file_handling"] = round(nfh_score, 2)

    # --- competitor_data_utilized ---
    comp_signals = 0
    if re.search(r"(?i)position\s*\d+|rank(?:ed|ing)?\s*(?:at\s*)?\d+|page\s*[2-9]", content):
        comp_signals += 1
    if re.search(r"(?i)competitor", content) and re.search(r"(?i)(rank|position|traffic|page\s*\d)", content):
        comp_signals += 1
    if re.search(r"(?i)(content\s*gap|keyword\s*gap|opportunity|weak(?:ly)?\s*rank|low\s*(?:organic\s*)?visibility)", content):
        comp_signals += 1
    if re.search(r"(?i)(?:estimated\s*)?traffic\s*(?:of\s*)?\d+|\d+\s*(?:estimated\s*)?traffic", content):
        comp_signals += 1
    scores["competitor_data_utilized"] = min(round(comp_signals / 4, 2), 1.0)

    # --- trap_identification_signals ---
    trap_signals = 0
    if re.search(r"(?i)(outdated|out[\s-]of[\s-]date|2019|old\s*threshold|stale)", content):
        trap_signals += 1
    if re.search(r"(?i)(contradict|conflict|inconsistent|mismatch|discrepan)", content):
        trap_signals += 1
    if re.search(r"(?i)volume.thresholds\.yaml|volume.thresholds", content):
        trap_signals += 1
    if re.search(r"(?i)competition.mapping\.json|competition.mapping", content):
        trap_signals += 1
    if re.search(r"(?i)(csv\s*(?:is|as)\s*(?:authorit|primary|reliable)|prefer\s*(?:the\s*)?csv|trust\s*(?:the\s*)?csv|use\s*(?:the\s*)?csv)", content):
        trap_signals += 1
    scores["trap_identification_signals"] = min(round(trap_signals / 4, 2), 1.0)

    # --- analytical_depth (tightened: 6 signals, denominator 5 — requires near-full coverage) ---
    depth_signals = 0
    if re.search(r"(?i)volume[\s-]to[\s-]competition\s*ratio|vol\s*/\s*comp|search.volume\s*/\s*competition", content):
        depth_signals += 1
    if re.search(r"(?i)(niche|long[\s-]tail)\s*(appropriate|specific|market|keyword|distribution)", content):
        depth_signals += 1
    if re.search(r"(?i)\+\d+%|trend|growing|increasing|upward|momentum", content):
        depth_signals += 1
    if re.search(r"(?i)(data\s*distribution|actual\s*data|quantitative|data[\s-]driven|raw\s*data)", content):
        depth_signals += 1
    if re.search(r"(?i)\bcpc\b|cost[\s-]per[\s-]click", content):
        depth_signals += 1
    if re.search(r"(?i)(higher|lower|stronger|weaker|more\s+competi|less\s+competi|compared\s+to|versus|"
                 r"while|whereas|in\s+contrast|relative\s+to|outperform|underperform)"
                 r".{0,200}(keyword|volume|competition|ratio|trend|opportunity)", non_table_text):
        depth_signals += 1
    scores["analytical_depth"] = min(round(depth_signals / 6, 2), 1.0)

    # --- selection_rationale_grounded (tightened: vol + comp + extra factor per keyword) ---
    grounding_score = 0
    grounding_checked = 0
    for row_cells in data_rows:
        kw_text = row_cells[0].strip().lower()
        kw_match = match_csv_keyword(kw_text)
        if kw_match and kw_match in csv_keywords:
            grounding_checked += 1
            csv_d = csv_keywords[kw_match]
            non_table_clean = non_table_text.replace(",", "")
            vol_found = str(csv_d["vol"]) in non_table_clean
            comp_found = str(csv_d["comp"]) in non_table_text
            extra = 0
            for fmt in (f"${csv_d['cpc']:.2f}", f"{csv_d['cpc']:.2f}", f"${csv_d['cpc']:.1f}"):
                if fmt in non_table_text:
                    extra += 1
                    break
            if csv_d["trend"] in non_table_text:
                extra += 1
            if csv_d["comp"] > 0:
                ratio_str = f"{csv_d['vol'] / csv_d['comp']:.1f}"
                if ratio_str in non_table_clean:
                    extra += 1
            if vol_found and comp_found and extra >= 2:
                grounding_score += 1.0
            elif vol_found and comp_found and extra >= 1:
                grounding_score += 0.67
            elif vol_found and comp_found:
                grounding_score += 0.33
            elif vol_found or comp_found:
                grounding_score += 0.17
    if grounding_checked > 0:
        scores["selection_rationale_grounded"] = round(grounding_score / grounding_checked, 2)

    # --- json_completeness (merged: JSON structure + numeric types + trend data) ---
    if os.path.isfile(json_path):
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                jdata = json.load(f)
            has_kw_list = isinstance(jdata.get("keywords"), list)
            if has_kw_list and len(jdata["keywords"]) == 3:
                required_a = {"keyword", "search_intent", "avg_monthly_searches",
                              "competition_index", "suggested_title"}
                required_b = {"keyword", "searchIntent", "searchVolume",
                              "competition", "suggestedTitle"}
                all_valid = True
                has_numeric_vol = False
                has_numeric_comp = False
                trend_count = 0
                for entry in jdata["keywords"]:
                    if not isinstance(entry, dict):
                        all_valid = False
                        break
                    keys = set(entry.keys())
                    if not (len(required_a & keys) >= 4 or len(required_b & keys) >= 4):
                        all_valid = False
                    for vk in ("avg_monthly_searches", "searchVolume", "search_volume"):
                        if vk in entry and isinstance(entry[vk], (int, float)):
                            has_numeric_vol = True
                    for ck in ("competition_index", "competition", "competitionIndex"):
                        if ck in entry and isinstance(entry[ck], (int, float)):
                            has_numeric_comp = True
                    for tk in ("trend", "trend_3m", "trend_data", "trendData", "trend3m"):
                        if tk in entry and entry[tk]:
                            trend_count += 1
                            break
                has_both_numeric = has_numeric_vol and has_numeric_comp
                jc_score = 0.0
                if all_valid and has_both_numeric:
                    jc_score += 0.5
                elif all_valid:
                    jc_score += 0.15
                elif has_both_numeric:
                    jc_score += 0.1
                if trend_count == 3:
                    jc_score += 0.5
                elif trend_count >= 1:
                    jc_score += round(trend_count / 6, 2)
                scores["json_completeness"] = min(jc_score, 1.0)
            elif has_kw_list and len(jdata["keywords"]) > 0:
                scores["json_completeness"] = 0.05
        except (json.JSONDecodeError, Exception):
            pass

    # --- json_values_match_csv ---
    if os.path.isfile(json_path) and csv_keywords:
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                jdata = json.load(f)
            if isinstance(jdata.get("keywords"), list):
                matched = 0
                checked = 0
                for entry in jdata["keywords"]:
                    if not isinstance(entry, dict):
                        continue
                    kw_name = str(entry.get("keyword", "")).strip().lower()
                    if kw_name not in csv_keywords:
                        continue
                    csv_d = csv_keywords[kw_name]
                    checked += 1
                    vol_val = next((entry[k] for k in ("avg_monthly_searches", "searchVolume", "search_volume") if k in entry and entry[k] is not None), None)
                    comp_val = next((entry[k] for k in ("competition_index", "competition", "competitionIndex") if k in entry and entry[k] is not None), None)
                    vol_ok = False
                    comp_ok = False
                    if vol_val is not None:
                        try:
                            v = int(str(vol_val).replace(",", "").strip())
                            vol_ok = abs(v - csv_d["vol"]) <= csv_d["vol"] * 0.05
                        except (ValueError, TypeError):
                            pass
                    if comp_val is not None:
                        try:
                            c = int(str(comp_val).replace(",", "").strip())
                            comp_ok = abs(c - csv_d["comp"]) <= 2
                        except (ValueError, TypeError):
                            pass
                    if vol_ok and comp_ok:
                        matched += 1
                    elif vol_ok or comp_ok:
                        matched += 0.25
                if checked > 0:
                    scores["json_values_match_csv"] = round(matched / checked, 2)
        except Exception:
            pass

    # --- ratio_analysis_in_report (requires explicit ratio calculation) ---
    ratio_signals = 0
    has_ratio_text = bool(re.search(
        r'(?i)volume[\s-]to[\s-]competition\s*ratio|vol\s*/\s*comp|'
        r'search.volume\s*/\s*competition', content))
    has_ratio_number = bool(re.search(r'\b\d{2,3}\.\d\b', content))
    if has_ratio_text and has_ratio_number:
        ratio_signals += 1.0
    elif has_ratio_text:
        ratio_signals += 0.5
    if longtail_ratios:
        sorted_kws = sorted(longtail_ratios.items(), key=lambda x: x[1], reverse=True)
        cited_ratios = 0
        for kw, ratio in sorted_kws[:8]:
            ratio_1d = f"{ratio:.1f}"
            content_clean = content.replace(",", "")
            if ratio_1d in content_clean:
                cited_ratios += 1
        if cited_ratios >= 2:
            ratio_signals += 1.0
        elif cited_ratios >= 1:
            ratio_signals += 0.5
    scores["ratio_analysis_in_report"] = min(round(ratio_signals / 2, 2), 1.0)

    # --- cpc_data_referenced (tightened: /3 denominator, requires actual CPC value matches) ---
    cpc_signals = 0
    if re.search(r'(?i)\bcpc\b|cost[\s-]per[\s-]click', content):
        cpc_signals += 1
    if re.search(r'\$\s*\d+\.?\d*', content):
        cpc_signals += 1
    cpc_match_count = 0
    if csv_keywords and data_rows:
        for row_cells in data_rows:
            kw_text = row_cells[0].strip().lower()
            kw_match = match_csv_keyword(kw_text)
            if kw_match and "cpc" in csv_keywords[kw_match]:
                csv_cpc = csv_keywords[kw_match]["cpc"]
                for fmt in (f"{csv_cpc:.2f}", f"{csv_cpc:.1f}", f"{csv_cpc}"):
                    if fmt in content:
                        cpc_match_count += 1
                        break
    if cpc_match_count >= 2:
        cpc_signals += 1
    elif cpc_match_count >= 1:
        cpc_signals += 0.5
    scores["cpc_data_referenced"] = min(round(cpc_signals / 3, 2), 1.0)

    # --- threshold_derivation_explicit (requires data-range threshold derivation) ---
    deriv_signals = 0
    has_low_bound = bool(re.search(r'\b13\d\b|\b130\b', content))
    has_high_bound = bool(re.search(r'\b1[,.]?4[0-5]\d\b|\b1450\b', content))
    if has_low_bound and has_high_bound:
        deriv_signals += 1.0
    elif has_low_bound or has_high_bound:
        deriv_signals += 0.5
    if re.search(r'(?i)(deriv|establish|set|defin)\w*\s+(?:the\s+)?'
                 r'(threshold|classif|categor|bracket|tier)', content):
        deriv_signals += 1
    elif re.search(r'(?i)(appropriate|suitable|niche)[\s-]+(threshold|classif|categor)', content):
        deriv_signals += 0.5
    thresh_count = 0
    if re.search(r'\b200\b', content) and re.search(r'(?i)(low|medium|threshold|bound)', content):
        thresh_count += 1
    if re.search(r'\b1[,.]?000\b', content) and re.search(r'(?i)(high|medium|threshold|bound)', content):
        thresh_count += 1
    if thresh_count >= 2:
        deriv_signals += 1.0
    elif thresh_count >= 1:
        deriv_signals += 0.5
    scores["threshold_derivation_explicit"] = min(round(deriv_signals / 2.5, 2), 1.0)

    # --- competitor_position_specifics (requires specific position/traffic from CSV) ---
    pos_matches = re.findall(r'(?i)position\s*(\d+)', content)
    traf_matches = re.findall(
        r'(?i)(?:estimated\s*)?traffic\s*(?:of\s*)?(\d+)|(\d+)\s*(?:estimated\s*)?traffic',
        content)
    known_positions = {49, 8, 7, 47, 24, 11, 14, 31, 46, 50, 13, 12, 19, 20, 25, 26, 28, 32, 39, 42, 44}
    known_traffic = {222, 103, 56, 42, 36, 28, 26, 24, 16, 15, 13, 12, 11, 10, 8, 7, 5, 4, 3, 2, 1}
    pos_hits = sum(1 for p in pos_matches if int(p) in known_positions)
    traf_vals = [t[0] or t[1] for t in traf_matches]
    traf_hits = sum(1 for t in traf_vals if t and int(t) in known_traffic)
    if pos_hits >= 2 and traf_hits >= 1:
        scores["competitor_position_specifics"] = 1.0
    elif pos_hits >= 1 and traf_hits >= 1:
        scores["competitor_position_specifics"] = 0.67
    elif pos_hits >= 1 or traf_hits >= 1:
        scores["competitor_position_specifics"] = 0.33

    # --- json_keywords_match_report (cross-verify + numeric fields + trend values) ---
    if os.path.isfile(json_path) and data_rows:
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                jdata = json.load(f)
            if isinstance(jdata.get("keywords"), list):
                json_kws = set()
                all_have_numeric = True
                trend_matches = 0
                for entry in jdata["keywords"]:
                    if isinstance(entry, dict):
                        kw = str(entry.get("keyword", "")).strip().lower()
                        if kw:
                            json_kws.add(kw)
                        has_nv = any(isinstance(entry.get(k), (int, float))
                                     for k in ("avg_monthly_searches", "searchVolume", "search_volume"))
                        has_nc = any(isinstance(entry.get(k), (int, float))
                                     for k in ("competition_index", "competition", "competitionIndex"))
                        if not (has_nv and has_nc):
                            all_have_numeric = False
                        if kw in csv_keywords:
                            csv_trend = csv_keywords[kw]["trend"]
                            for tk in ("trend", "trend_3m", "trend_data", "trendData", "trend3m"):
                                if tk in entry and str(entry[tk]).strip() == csv_trend:
                                    trend_matches += 1
                                    break
                report_kws = set()
                for row_cells in data_rows:
                    report_kws.add(row_cells[0].strip().lower())
                matched = 0
                for jk in json_kws:
                    for rk in report_kws:
                        if jk == rk or jk in rk or rk in jk:
                            matched += 1
                            break
                kw_score = min(matched, 3) / 3
                if not all_have_numeric:
                    kw_score *= 0.5
                if trend_matches < 3:
                    kw_score *= 0.67
                cpc_matches = 0
                for entry in jdata["keywords"]:
                    if isinstance(entry, dict):
                        ekw = str(entry.get("keyword", "")).strip().lower()
                        if ekw in csv_keywords:
                            csv_cpc = csv_keywords[ekw]["cpc"]
                            for ck in ("cpc", "cpc_usd", "cpcUsd", "cost_per_click"):
                                if ck in entry:
                                    try:
                                        ecpc = float(entry[ck])
                                        if abs(ecpc - csv_cpc) <= csv_cpc * 0.1:
                                            cpc_matches += 1
                                    except (ValueError, TypeError):
                                        pass
                                    break
                if cpc_matches == 0:
                    kw_score *= 0.5
                elif cpc_matches < 3:
                    kw_score *= 0.75
                scores["json_keywords_match_report"] = round(kw_score, 2)
        except Exception:
            pass

    # --- trap_handling_verified (data-level trap avoidance, not just mentions) ---
    if data_rows and csv_keywords:
        vol_trap_ok = True
        comp_trap_ok = True
        checked_v = 0
        checked_c = 0
        for row_cells in data_rows:
            kw_text = row_cells[0].strip().lower()
            kw_match = match_csv_keyword(kw_text)
            if kw_match:
                csv_vol = csv_keywords[kw_match]["vol"]
                csv_comp = csv_keywords[kw_match]["comp"]
                if len(row_cells) >= 3:
                    vol_text = row_cells[2].strip().lower()
                    checked_v += 1
                    if csv_vol >= 200 and "low" in vol_text and "medium" not in vol_text and "high" not in vol_text:
                        vol_trap_ok = False
                if len(row_cells) >= 4:
                    comp_text = row_cells[3].strip().lower()
                    checked_c += 1
                    if csv_comp < 30 and "high" in comp_text and "medium" not in comp_text:
                        comp_trap_ok = False
                    if csv_comp >= 55 and "low" in comp_text and "medium" not in comp_text:
                        comp_trap_ok = False
        if checked_v > 0 and checked_c > 0:
            if vol_trap_ok and comp_trap_ok:
                scores["trap_handling_verified"] = 1.0
            elif vol_trap_ok or comp_trap_ok:
                scores["trap_handling_verified"] = 0.5

    # --- report_body_data_density (CSV numeric values in non-table analytical text) ---
    if csv_keywords:
        body_data_refs = set()
        non_table_clean = non_table_text.replace(",", "")
        for kw, data in csv_keywords.items():
            if len(kw.split()) >= 4 and ("retirement" in kw or "withdrawal" in kw):
                if str(data["vol"]) in non_table_clean:
                    body_data_refs.add(f"vol_{data['vol']}")
                if str(data["comp"]) in non_table_text:
                    body_data_refs.add(f"comp_{data['comp']}")
                cpc_str = f"{data['cpc']:.2f}"
                if cpc_str in non_table_text or f"${cpc_str}" in non_table_text:
                    body_data_refs.add(f"cpc_{cpc_str}")
                if data["comp"] > 0:
                    ratio_str = f"{data['vol'] / data['comp']:.1f}"
                    if ratio_str in non_table_clean:
                        body_data_refs.add(f"ratio_{ratio_str}")
        scores["report_body_data_density"] = min(round(len(body_data_refs) / 30, 2), 1.0)

    # --- keyword_opportunity_multi_factor (per-keyword multi-dimensional justification) ---
    if data_rows and csv_keywords:
        factor_scores = []
        non_table_clean = non_table_text.replace(",", "")
        for row_cells in data_rows:
            kw_text = row_cells[0].strip().lower()
            kw_match = match_csv_keyword(kw_text)
            if kw_match:
                csv_d = csv_keywords[kw_match]
                factors = 0
                if str(csv_d["vol"]) in non_table_clean:
                    factors += 1
                if str(csv_d["comp"]) in non_table_text:
                    factors += 1
                for fmt in (f"${csv_d['cpc']:.2f}", f"{csv_d['cpc']:.2f}", f"${csv_d['cpc']:.1f}"):
                    if fmt in non_table_text:
                        factors += 1
                        break
                if csv_d["trend"] in non_table_text:
                    factors += 1
                if csv_d["comp"] > 0:
                    ratio_str = f"{csv_d['vol'] / csv_d['comp']:.1f}"
                    if ratio_str in non_table_clean:
                        factors += 1
                factor_scores.append(min(factors / 5, 1.0))
        if factor_scores:
            scores["keyword_opportunity_multi_factor"] = round(
                sum(factor_scores) / len(factor_scores), 2)

    # --- selection_rationale_quality (volume + competition + extra factor per keyword) ---
    if data_rows and csv_keywords:
        qual_scores = []
        for row_cells in data_rows:
            kw_text = row_cells[0].strip().lower()
            kw_match = match_csv_keyword(kw_text)
            if kw_match and kw_match in csv_keywords:
                csv_d = csv_keywords[kw_match]
                non_table_clean = non_table_text.replace(",", "")
                has_vol = str(csv_d["vol"]) in non_table_clean
                has_comp = str(csv_d["comp"]) in non_table_text
                extra_factors = 0
                for fmt in (f"${csv_d['cpc']:.2f}", f"{csv_d['cpc']:.2f}",
                            f"${csv_d['cpc']:.1f}"):
                    if fmt in non_table_text:
                        extra_factors += 1
                        break
                if csv_d["trend"] in non_table_text:
                    extra_factors += 1
                if csv_d["comp"] > 0:
                    ratio_str = f"{csv_d['vol'] / csv_d['comp']:.1f}"
                    if ratio_str in non_table_clean:
                        extra_factors += 1
                if has_vol and has_comp and extra_factors >= 3:
                    qual_scores.append(1.0)
                elif has_vol and has_comp and extra_factors >= 2:
                    qual_scores.append(0.67)
                elif has_vol and has_comp and extra_factors >= 1:
                    qual_scores.append(0.33)
                elif has_vol and has_comp:
                    qual_scores.append(0.17)
                elif has_vol or has_comp:
                    qual_scores.append(0.08)
                else:
                    qual_scores.append(0.0)
        if qual_scores:
            scores["selection_rationale_quality"] = round(
                sum(qual_scores) / len(qual_scores), 2)

    # --- report_quantitative_methodology (methodology section with quantitative evidence) ---
    has_meth_heading = bool(re.search(
        r'(?i)##?\s*(methodology|approach|selection\s*(criteria|process|method)|'
        r'data\s*quality|analytical\s*framework)', content))
    meth_quant = 0
    if re.search(r'\b\d{2,3}\.\d\b', non_table_text):
        meth_quant += 1
    if re.search(r'(?i)\b200\b.*(threshold|low|medium)', non_table_text) or \
       re.search(r'(?i)(threshold|low|medium).*\b200\b', non_table_text):
        meth_quant += 1
    if re.search(r'(?i)(13\d|130)\b.*\b(14[0-5]\d|1[,.]?450)\b', non_table_text):
        meth_quant += 1
    if has_meth_heading and meth_quant >= 2:
        scores["report_quantitative_methodology"] = 1.0
    elif has_meth_heading and meth_quant >= 1:
        scores["report_quantitative_methodology"] = 0.67
    elif has_meth_heading:
        scores["report_quantitative_methodology"] = 0.33
    elif meth_quant >= 2:
        scores["report_quantitative_methodology"] = 0.33

    # --- volume_competition_labels_all_correct (all-or-nothing label check) ---
    if data_rows and csv_keywords:
        all_correct = True
        vc_checked = 0
        for row_cells in data_rows:
            kw_text = row_cells[0].strip().lower()
            kw_match = match_csv_keyword(kw_text)
            if kw_match:
                vc_checked += 1
                csv_vol = csv_keywords[kw_match]["vol"]
                csv_comp = csv_keywords[kw_match]["comp"]
                if len(row_cells) >= 3:
                    vol_text = row_cells[2].strip().lower()
                    if csv_vol > 1000 and "high" not in vol_text:
                        all_correct = False
                    elif 200 <= csv_vol <= 1000 and "medium" not in vol_text:
                        all_correct = False
                    elif csv_vol < 200 and "low" not in vol_text:
                        all_correct = False
                if len(row_cells) >= 4:
                    comp_text = row_cells[3].strip().lower()
                    if csv_comp >= 55 and "high" not in comp_text:
                        all_correct = False
                    elif 30 <= csv_comp < 55 and "medium" not in comp_text:
                        all_correct = False
                    elif csv_comp < 30 and "low" not in comp_text:
                        all_correct = False
        if vc_checked >= 3 and all_correct:
            scores["volume_competition_labels_all_correct"] = 1.0

    return scores
```

## LLM Judge Rubric

**Fallback Rule:** If `deliverables/seo_keywords_report.md` does not exist or is empty, all criteria below score 0.0. If `deliverables/keyword_analysis.json` does not exist, Criteria 3 and 5 cannot score above 0.5.

### Criterion 1: Trap Detection and Data Source Prioritization (Weight: 25%)

**Human Reference Baseline:** A skilled human SEO analyst would immediately flag `volume_thresholds.yaml` as outdated upon seeing `last_updated: 2019-03-15` and data ranges mismatching the niche. They would cross-check `competition_mapping.json` against the CSV and reject it due to systematic contradictions (e.g., index=72 labeled "low," index=25 labeled "high"). They would derive thresholds from the actual data distribution (130–1,450 range for 4+ word keywords), explicitly documenting their reasoning and citing specific threshold boundaries. Responses matching or exceeding this standard score 1.0.

**Score 1.0**: The agent explicitly identifies both traps — recognizes `volume_thresholds.yaml` as outdated (2019 thresholds where High >5000 are inappropriate for long-tail niche keywords ranging 130–1450) and `competition_mapping.json` as contradictory (e.g., it labels a keyword with CSV competition_index=72 as "low" and one with index=25 as "high"). The agent articulates why the CSV data is authoritative, derives niche-appropriate volume classifications with explicit threshold boundaries (e.g., High >1000, Medium 200–1000, Low <200), and explains the data distribution reasoning (citing the 130–1,450 observed range). A generic report that merely uses reasonable volume labels without referencing the conflicting files does not qualify.
**Score 0.75**: The agent detects at least one trap explicitly with specific file references and handles the other implicitly (correct labels but no explanation). Volume and competition classifications are niche-appropriate but reasoning is incomplete — e.g., identifies the YAML as outdated but does not cite the 2019 date or the >5000 threshold, or mentions contradictions without specifying which keywords are affected.
**Score 0.5**: The agent avoids the worst outcomes (doesn't classify everything as "low" volume) and shows partial awareness — e.g., mentions that config files may be unreliable or notes data freshness concerns — but does not identify specific traps by file name. Classifications are roughly reasonable but arrived at by general knowledge rather than deliberate data analysis. A shallow mention of "using CSV data" without explaining why other sources were rejected scores here.
**Score 0.25**: The agent falls for one trap clearly — either applies 2019 volume thresholds (classifying most keywords as "low") or uses the contradictory competition mapping over the CSV data — but handles the other correctly or partially.
**Score 0.0**: The agent falls for both traps, blindly applying outdated volume thresholds and contradictory competition data. Classifications are clearly misaligned with the CSV. If the report file does not exist, score 0.0.

### Criterion 2: Keyword Selection Quality and Multi-Factor Analysis (Weight: 20%)

**Human Reference Baseline:** A human SEO analyst would rank all 4+ word candidates by volume-to-competition ratio, cross-reference each against competitor positions and traffic in `competitor_keywords.csv`, factor in CPC dollar values and 3-month trends, and produce a multi-dimensional opportunity assessment with explicit numeric comparisons between candidates. They would cite at least 4 data factors per keyword and compare keywords against each other (e.g., "Keyword A has higher volume but stronger competition than Keyword B"). They would also explicitly exclude short-tail decoy keywords despite their high ratios, documenting the filtering rationale. Responses matching or exceeding this standard score 1.0.

**Score 1.0**: The three selected keywords are justified with references to specific CSV values (e.g., "880 avg monthly searches with competition index of 25" or "volume-to-competition ratio of 35.2"). The agent explains the selection logic by balancing at least 4 of 5 factors per keyword (volume, competition index, CPC, trend, ratio). Cross-referencing with `competitor_keywords.csv` is evident — the agent identifies content gaps where competitors rank weakly, citing specific position numbers and traffic estimates. Inter-keyword comparative analysis is present (e.g., "Keyword A has better trend momentum than Keyword B despite lower volume"). Short-tail decoy keywords are explicitly excluded with documented reasoning. A report that names plausible keywords without citing any numeric values from the data files does not qualify.
**Score 0.75**: Keywords are well-chosen among the top candidates and the agent references at least 2–3 quantitative factors per keyword (e.g., cites volume and competition numbers), but analysis lacks full multi-factor depth — omits CPC or trend from per-keyword rationale, or competitor gap analysis is generic (mentions "low competition" without citing specific positions/traffic). Short-tail decoys are avoided but exclusion reasoning may be implicit.
**Score 0.5**: Keywords are reasonable selections from the data but justification is thin or partially generic. Some data points may be cited but no systematic multi-dimensional evaluation is demonstrated. Only 1 factor is cited per keyword, or the same boilerplate reasoning applies to all keywords. Competitor data is referenced superficially or not at all.
**Score 0.25**: Keywords seem arbitrarily chosen or reasoning is largely generic/hallucinated rather than grounded in actual data files. No CSV-derived numeric values are cited in the selection rationale.
**Score 0.0**: Keywords appear fabricated or selected without reference to actual data. No meaningful analytical reasoning provided. If the report file does not exist, score 0.0.

### Criterion 3: Professional Deliverable Quality and Structured Output (Weight: 15%)

**Human Reference Baseline:** A professional SEO deliverable would follow the template precisely, include a methodology section explaining the analytical framework with quantitative evidence, produce SEO titles that are both keyword-rich and compelling (not mere keyword stuffing), classify all intents correctly with explicit reasoning citing the guide's patterns, and generate a JSON file with complete, accurate numeric data — including trend strings matching the CSV exactly and CPC values — ready for CMS ingestion. Responses matching or exceeding this standard score 1.0.

**Score 1.0**: The Markdown report is polished, follows the template structure, and is immediately actionable — including a methodology section with quantitative evidence (ratio values, threshold derivation). Suggested titles are genuinely SEO-optimized (compelling, include keywords naturally, verifiably under 60 characters). Intent classifications match `search_intent_guide.json` patterns and the report explicitly cites the triggering pattern for each (e.g., "'best' indicates commercial intent per the guide"). The `keyword_analysis.json` file exists with correct structure, numeric values matching the CSV source data, trend data matching CSV strings exactly, and CPC values present. A report that merely fills in the template placeholders with generic content does not qualify.
**Score 0.75**: The report is professional and mostly actionable. Titles are reasonable, intents are correct, and a methodology section exists but lacks quantitative depth. JSON file exists with correct structure but may have one missing field (e.g., trend or CPC) or minor data discrepancies.
**Score 0.5**: The report is functional but formulaic — lacks a methodology section or analytical framework. Titles may be generic or awkwardly constructed (keyword-stuffed). One intent misclassification may be present. JSON file may be missing one required field or have significant structural issues. A report that simply fills in a table without explanatory prose scores here.
**Score 0.25**: Notable quality issues — unclear structure, multiple intent misclassifications, titles exceeding 60 characters, or missing JSON deliverable entirely.
**Score 0.0**: The report is unprofessional or incoherent. Titles are not SEO-optimized, intent classifications are wrong, and no JSON output is provided. If the report file does not exist, score 0.0.

### Criterion 4: Competitive Intelligence Depth and Strategic Insight (Weight: 20%)

**Human Reference Baseline:** A human SEO strategist would not only identify competitor rankings but analyze competitor *weaknesses* — noting where competitors have thin content at low positions (e.g., position 49 with traffic of 8 signals a wide-open opportunity), where multiple competitors cluster on page 2+ leaving page 1 open, and where trend momentum (e.g., +25%) suggests growing demand that competitors haven't captured. They would recommend exploiting these specific gaps with content timing aligned to trend data and discuss how the 3 selected keywords form a coordinated content strategy across different funnel stages. Responses matching or exceeding this standard score 1.0.

**Score 1.0**: The report includes an explicit competitor weakness exploitation strategy — identifies specific keywords where competitors rank weakly (citing position numbers >20 and low traffic estimates from `competitor_keywords.csv`) and frames these as actionable content opportunities. The report suggests content prioritization or publishing timing based on trend data (e.g., "prioritize the +25% trending keyword for immediate content creation to capture growing demand"). Keywords are analyzed as a coordinated portfolio rather than in isolation — the report discusses how the 3 selected keywords complement each other across intent types or funnel stages (e.g., informational for awareness, transactional for conversion).
**Score 0.75**: The report references competitor data with some strategic framing (identifies content gaps with position numbers) but lacks explicit exploitation strategy or timing recommendations. Trend data is mentioned but not connected to content prioritization. Keywords are discussed individually without portfolio-level coordination.
**Score 0.5**: The report mentions competitors but only at a surface level (e.g., "competition is low for this keyword"). No strategic recommendations for exploiting competitor weaknesses or timing content. Trend data is present in the table but not used strategically. Keywords are treated as isolated items with no portfolio perspective.
**Score 0.25**: Competitor analysis is limited to generic statements (e.g., "we checked competitor data"). No trend-based content strategy. No keyword portfolio coordination.
**Score 0.0**: No competitor intelligence is present beyond basic competition labels, or the report only repeats what the prompt asked without adding analytical depth. If the report file does not exist, score 0.0.

### Criterion 5: Implicit Requirements and Beyond-Prompt Value (Weight: 20%)

**Human Reference Baseline:** An experienced SEO analyst would proactively add value beyond the explicit request: flagging risk factors for selected keywords (e.g., "despite strong metrics, this keyword's CPC of $X suggests lower commercial intent than expected"), suggesting keyword grouping strategies for content silos, structuring JSON output with CMS-actionable enrichment fields like `priority_ranking`, `confidence_score`, or `content_type_suggestion`, and explicitly documenting workspace file triage (which files were used, which were noise and why). Responses matching or exceeding this standard score 1.0.

**Score 1.0**: The report goes beyond explicit requirements in at least 3 of the following ways: (a) provides risk assessment for selected keywords — noting trend volatility, seasonal patterns, CPC trajectory as risk signals, or declining competition as potential indicators of keyword saturation; (b) suggests a keyword combination or clustering strategy rather than analyzing each keyword in isolation (e.g., "these keywords form a content silo around retirement withdrawal planning," or recommends internal linking between the content pieces); (c) the JSON deliverable includes enrichment fields beyond the minimum spec — such as `priority_ranking`, `confidence_score`, `content_type`, or `target_audience` — that are directly usable by a CMS without further transformation; (d) recommends content types or formats for each keyword (e.g., "informational intent → comprehensive guide/FAQ page, transactional intent → calculator landing page with comparison features"); (e) explicitly identifies and explains workspace noise file triage — why `previous_seo_audit.md` (covers insurance calculators, a different product line) and `research_tool_log.txt` (contains only operational API logs) were excluded from the analysis.
**Score 0.75**: The report provides 2 of the above beyond-prompt value signals. Analysis shows awareness of implicit quality dimensions but doesn't fully develop all of them.
**Score 0.5**: The report provides 1 beyond-prompt value signal — e.g., mentions noise files or suggests a content type for one keyword. The agent addresses the explicit requirements competently but adds minimal proactive value. JSON has only the required fields with no enrichment.
**Score 0.25**: The report sticks strictly to the explicit requirements with no proactive additions. No risk assessment, no keyword clustering, no JSON enrichment, and no explicit noise file discussion.
**Score 0.0**: The report fails to meet even the explicit requirements or is so minimal that implicit quality signals cannot be assessed. If the report file does not exist, score 0.0.