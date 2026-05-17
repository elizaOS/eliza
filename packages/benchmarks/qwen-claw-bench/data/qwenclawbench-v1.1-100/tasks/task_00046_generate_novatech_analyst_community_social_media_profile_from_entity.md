---
id: task_00046_generate_novatech_analyst_community_social_media_profile_from_entity
name: Generate NovaTech Analyst Community Social Media Profile from Entity Knowledge Base
category: Knowledge and Memory Management
grading_type: hybrid
timeout_seconds: 1800
workspace_files:
- source: data/entities/analysts_entity.json
  dest: data/entities/analysts_entity.json
- source: data/entities/novatech_entity.json
  dest: data/entities/novatech_entity.json
- source: data/entities/starbridge_project.json
  dest: data/entities/starbridge_project.json
- source: data/market/institutional_holdings.csv
  dest: data/market/institutional_holdings.csv
- source: data/market/analyst_ratings_detail.csv
  dest: data/market/analyst_ratings_detail.csv
- source: data/market/revenue_breakdown.csv
  dest: data/market/revenue_breakdown.csv
- source: data/context/market_share_report.json
  dest: data/context/market_share_report.json
- source: data/context/product_roadmap.yaml
  dest: data/context/product_roadmap.yaml
- source: data/context/competitor_analysis_outdated.json
  dest: data/context/competitor_analysis_outdated.json
- source: data/market/analyst_consensus_summary.json
  dest: data/market/analyst_consensus_summary.json
- source: data/social_media/profile_template.json
  dest: data/social_media/profile_template.json
- source: reports/previous_social_profiles/hedge_fund_example.json
  dest: reports/previous_social_profiles/hedge_fund_example.json
- source: reports/previous_social_profiles/retail_investor_example.json
  dest: reports/previous_social_profiles/retail_investor_example.json
- source: config/generation_rules.yaml
  dest: config/generation_rules.yaml
- source: data/market/starbridge_investment_details.csv
  dest: data/market/starbridge_investment_details.csv
grading_weights:
  automated: 0.5
  llm_judge: 0.5
subcategory: Agent and Tool Integration
---
## Prompt

We're building out a knowledge-management-driven content system for our financial research platform, and I need your help with one of the profile generation tasks.

The idea is this: we have a bunch of entity definitions, market data files, and contextual reports sitting in the workspace. From all of that, I need you to synthesize a **social media profile** for the "analysts" entity — basically, imagine a collective social media presence representing the 74 analysts who cover NovaTech. Think of it as the voice of the sell-side analyst community focused on this stock.

There's a profile template schema in `data/social_media/profile_template.json` — please follow that structure. You can also look at the example profiles under `reports/previous_social_profiles/` for tone and style guidance, and check `config/generation_rules.yaml` for any constraints on field lengths or content rules.

The profile should be grounded in the actual data across the workspace. Pull in specifics: the target price range, market share figures, the Starbridge project details, revenue trends, product roadmap highlights — whatever paints an accurate and compelling picture of what this analyst community is tracking. The bio, pinned content, key narratives, and topics should all reflect real numbers and facts from the data files, not generic filler.

One thing I'll stress: **accuracy matters more than polish**. The workspace contains several files that touch on the same metrics — take the time to read through all of them before committing to any specific figure. Not every file represents the current state of affairs, and some older analyses or informal communications may not align with the authoritative sources.

Save the final profile as JSON to `output/social_media_profile.json`.

## Expected Behavior

The agent should:

1. **Read and understand the profile template schema** from `data/social_media/profile_template.json` to know the required output structure (bio, handle, display_name, profile_type, topics, pinned_content, follower_persona, posting_style, key_narratives, and any other fields defined).

2. **Read the generation rules** from `config/generation_rules.yaml` to understand constraints like character limits and content guidelines.

3. **Examine example profiles** in `reports/previous_social_profiles/` to calibrate the tone and depth expected (professional for the hedge fund example, casual for retail — the analyst profile should lean professional/institutional).

4. **Gather data from primary entity files**:
   - `data/entities/analysts_entity.json`: 74 analysts, target price range **$140–$432.78**, Technology sector coverage.
   - `data/entities/novatech_entity.json`: NovaTech (NVTK), AI chip manufacturer, $2.8T market cap, GX200/Obsidian products, PUMA ecosystem, **declining DC revenue in Q4**.
   - `data/entities/starbridge_project.json`: **$100 billion** AI infrastructure project by FrontierAI using NovaTech GX200 chips.

5. **Gather supporting market data**:
   - `data/market/analyst_ratings_detail.csv`: 74 individual ratings skewed toward Buy/Outperform, median target ~$310.
   - `data/market/revenue_breakdown.csv`: Shows DC revenue peaking in 2024-Q2 then declining in Q3 and Q4.
   - `data/market/institutional_holdings.csv`: Top institutional holders (Vanguard, BlackStone Capital, StateStreet, etc.).
   - `data/context/market_share_report.json`: NovaTech holds **82.4%** of the AI accelerator market (dated 2024-12-01).
   - `data/context/product_roadmap.yaml`: GX200 specs, Obsidian architecture, PUMA v13.2.

6. **Target Price Range Verification**:
   - Multiple files contain target price figures for NovaTech analysts. The agent must cross-reference sources and apply the correct conflict-resolution logic from `config/generation_rules.yaml` to determine the authoritative low end of the target price range.
   - The `analyst_ratings_detail.csv` contains individual analyst targets and can serve as a corroborating check on the range bounds used.

7. **Market Share Data Currency**:
   - Two files contain NovaTech market share figures with different dates and different values. The agent must correctly identify which figure represents the current state of the market and use it in the profile, ignoring the stale data regardless of how authoritatively it is titled.

8. **Investment Scale Accuracy**:
   - The Starbridge project investment is described in different files at different levels of granularity. The agent must correctly represent the total project scale rather than a sub-unit figure. The profile should accurately state the investment scale for Starbridge.

9. **Generate the output JSON** at `output/social_media_profile.json` that:
   - Follows the template schema structure.
   - Contains a bio under 200 characters that references the 74 analysts and NovaTech coverage.
   - Includes accurate key_narratives referencing the correct target price range ($140–$432.78), market share (82.4%), Starbridge ($100B), and DC revenue trend concerns.
   - Lists relevant topics (e.g., AI chips, NovaTech, PUMA ecosystem, datacenter GPUs, Starbridge).
   - Has an appropriate handle and display name for a collective analyst community profile.
   - Includes pinned_content summarizing the current consensus view with accurate data points.

## Grading Criteria

- [ ] **output_file_exists**: Output file exists at `output/social_media_profile.json`
- [ ] **valid_json_structure**: The output is valid JSON containing a "bio" field
- [ ] **bio_field_present**: Bio field exists and contains substantive content about analysts covering NovaTech
- [ ] **correct_target_price_low**: Target price range uses the correct low of $140; using $155 (from the consensus summary) without also including $140 scores 0.0 (exclusive penalty for accepting the wrong source)
- [ ] **correct_target_price_high**: Target price range uses the correct high of $432.78
- [ ] **no_outdated_market_share**: Market share figure does NOT use the outdated 91.7% from the 2023 report; using 91.7% without also citing 82.4% scores 0.0 (exclusive penalty); using the correct 82.4% scores 1.0
- [ ] **references_puma_ecosystem**: Profile references the PUMA ecosystem
- [ ] **references_starbridge**: Profile references the Starbridge project
- [ ] **references_dc_revenue**: Profile references the declining datacenter revenue trend in Q4 2024
- [ ] **bio_length_valid**: The bio field must not exceed 200 characters as required by both the template schema and generation_rules.yaml; a bio exceeding 200 characters scores 0.0 (exclusive penalty)
- [ ] **starbridge_scale_correct**: Profile correctly states the Starbridge project total investment as $100 billion; stating a phase-level amount (e.g., $8.5B or $100M) as the total scores 0.0 (exclusive penalty for misreading the investment CSV units)
- [ ] **topics_count_valid**: The topics array contains between 3 and 10 items as required by generation_rules.yaml (topics_min_count: 3, topics_max_count: 10); below minimum scores 0.5; missing or empty scores 0.0
- [ ] **credibility_markers_present**: Profile contains a credibility_markers array with at least 2 entries as required by generation_rules.yaml (credibility_markers_min_count: 2); 1 entry scores 0.5; missing or empty scores 0.0

## Automated Checks

```python
import json
import os
import re
from pathlib import Path

def grade(transcript: list, workspace_path: str) -> dict:
    """Grade the social media profile generation task."""

    result = {
        "output_file_exists": 0.0,
        "valid_json_structure": 0.0,
        "bio_field_present": 0.0,
        "correct_target_price_low": 0.0,
        "correct_target_price_high": 0.0,
        "no_outdated_market_share": 0.0,
        "references_puma_ecosystem": 0.0,
        "references_starbridge": 0.0,
        "references_dc_revenue": 0.0,
        "bio_length_valid": 0.0,
        "starbridge_scale_correct": 0.0,
        "topics_count_valid": 0.0,
        "credibility_markers_present": 0.0,
    }

    output_file = Path(workspace_path) / "output" / "social_media_profile.json"

    # 1. output_file_exists
    if not output_file.exists():
        return result
    result["output_file_exists"] = 1.0

    try:
        content = output_file.read_text(encoding="utf-8")
    except Exception:
        return result

    if not content or content.strip() == "":
        return result

    content_lower = content.lower()

    # 2. valid_json_structure: Output is valid JSON containing "bio" field
    if re.search(r'"bio"\s*:', content):
        result["valid_json_structure"] = 1.0

    # Try to parse JSON for deeper checks
    try:
        data = json.loads(content)
    except (json.JSONDecodeError, ValueError):
        data = None

    def extract_strings(obj):
        """Recursively extract all string values from a JSON structure."""
        strings = []
        if isinstance(obj, str):
            strings.append(obj)
        elif isinstance(obj, list):
            for item in obj:
                strings.extend(extract_strings(item))
        elif isinstance(obj, dict):
            for v in obj.values():
                strings.extend(extract_strings(v))
        return strings

    # 3. bio_field_present: Bio field exists and contains substantive content about analysts
    if data and isinstance(data, dict):
        bio_value = data.get("bio", "")
        if isinstance(bio_value, str) and re.search(r'\banalyst', bio_value, re.IGNORECASE):
            result["bio_field_present"] = 1.0
    else:
        bio_match = re.search(r'"bio"\s*:\s*"([^"]*)"', content, re.IGNORECASE)
        if bio_match and re.search(r'\banalyst', bio_match.group(1), re.IGNORECASE):
            result["bio_field_present"] = 1.0

    # 4. correct_target_price_low: Uses $140 (not $155 from the contradictory consensus summary)
    # EXCLUSIVE: $155 present without $140 → 0.0 (fell for trap 1 source conflict)
    has_140 = bool(re.search(r'(?<!\d)140(?!\d)', content))
    has_155 = bool(re.search(r'(?<!\d)155(?!\d)', content))
    if has_140:
        result["correct_target_price_low"] = 1.0
    elif has_155 and not has_140:
        result["correct_target_price_low"] = 0.0  # EXCLUSIVE: accepted wrong source value
    # else remains 0.0

    # 5. correct_target_price_high: Includes $432.78
    # Partial credit: 0.75 for $432 or $433 (close approximation)
    if re.search(r'432\.78', content):
        result["correct_target_price_high"] = 1.0
    elif re.search(r'(?<!\d)43[23](?!\d)', content):
        result["correct_target_price_high"] = 0.75

    # 6. no_outdated_market_share: Does NOT use 91.7% (dated 2023 report); should use 82.4%
    # EXCLUSIVE: 91.7% present without 82.4% → 0.0 (fell for trap 2 stale file)
    has_82 = bool(re.search(r'82\.4', content))
    has_91 = bool(re.search(r'91\.7', content))
    if has_91 and not has_82:
        result["no_outdated_market_share"] = 0.0  # EXCLUSIVE: accepted outdated value
    elif has_82:
        result["no_outdated_market_share"] = 1.0
    elif not has_91 and re.search(r'market\s+share', content_lower):
        result["no_outdated_market_share"] = 0.5
    elif not has_91:
        result["no_outdated_market_share"] = 0.75

    # 7. references_puma_ecosystem: References PUMA (case-sensitive acronym)
    # Partial credit: 0.5 for mentioning ecosystem without PUMA
    if re.search(r'\bPUMA\b', content):
        result["references_puma_ecosystem"] = 1.0
    elif re.search(r'\becosystem\b', content_lower):
        result["references_puma_ecosystem"] = 0.5

    # 8. references_starbridge: References Starbridge project by name
    # Partial credit: 0.75 for $100 billion without name; 0.5 for infrastructure project
    if re.search(r'\bStarbridge\b', content, re.IGNORECASE):
        result["references_starbridge"] = 1.0
    elif re.search(r'100\s*billion', content_lower):
        result["references_starbridge"] = 0.75
    elif re.search(r'\binfrastructure\s+project\b', content_lower):
        result["references_starbridge"] = 0.5

    # 9. references_dc_revenue: "datacenter" and "declin" in the same JSON string value
    # Partial credit: 0.5 for mentioning either term without co-occurrence
    dc_revenue_found = False
    dc_mentioned = False
    decline_mentioned = False

    if data and isinstance(data, dict):
        all_strings = extract_strings(data)
        for s in all_strings:
            s_lower = s.lower()
            has_dc = bool(re.search(r'data\s*center|datacenter|dc[\s_]revenue', s_lower))
            has_decline = bool(re.search(r'declin', s_lower))
            if has_dc and has_decline:
                dc_revenue_found = True
                break
            if has_dc:
                dc_mentioned = True
            if has_decline:
                decline_mentioned = True
    else:
        string_values = re.findall(r'"((?:[^"\\]|\\.)*)"', content)
        for sv in string_values:
            sv_lower = sv.lower()
            has_dc = bool(re.search(r'data\s*center|datacenter|dc[\s_]revenue', sv_lower))
            has_decline = bool(re.search(r'declin', sv_lower))
            if has_dc and has_decline:
                dc_revenue_found = True
                break
            if has_dc:
                dc_mentioned = True
            if has_decline:
                decline_mentioned = True

    if dc_revenue_found:
        result["references_dc_revenue"] = 1.0
    elif dc_mentioned or decline_mentioned:
        result["references_dc_revenue"] = 0.5

    # 10. bio_length_valid: Bio must not exceed 200 characters (required by template + rules)
    # EXCLUSIVE: bio > 200 chars → 0.0
    if data and isinstance(data, dict):
        bio_val = data.get("bio", "")
        if isinstance(bio_val, str):
            bio_len = len(bio_val)
            if bio_len > 200:
                result["bio_length_valid"] = 0.0  # EXCLUSIVE: violated length constraint
            elif bio_len > 0:
                result["bio_length_valid"] = 1.0
    else:
        bio_match = re.search(r'"bio"\s*:\s*"((?:[^"\\]|\\.)*)"', content)
        if bio_match:
            bio_text = bio_match.group(1)
            if len(bio_text) > 200:
                result["bio_length_valid"] = 0.0  # EXCLUSIVE
            elif len(bio_text) > 0:
                result["bio_length_valid"] = 1.0

    # 11. starbridge_scale_correct: Starbridge total investment must be $100 billion, NOT a
    # phase-level amount (e.g., ~$8.5B or "$100M") from the investment CSV.
    # EXCLUSIVE: profile states "$100 million" or a per-phase amount as total → 0.0
    wrong_scale = bool(re.search(
        r'(starbridge[^.]{0,60}100\s*million|100\s*million[^.]{0,60}starbridge|'
        r'\$\s*100\s*m\b[^a-z][^.]{0,40}starbridge|starbridge[^.]{0,40}\$\s*100\s*m\b[^a-z])',
        content_lower
    ))
    correct_scale = bool(re.search(
        r'(100\s*billion|100\s*b\b|100,000\s*million|\$100b\b|100bn\b)',
        content_lower
    ))
    if wrong_scale and not correct_scale:
        result["starbridge_scale_correct"] = 0.0  # EXCLUSIVE: misread phase amount as total
    elif correct_scale:
        result["starbridge_scale_correct"] = 1.0
    elif re.search(r'\bstarbridge\b', content_lower):
        result["starbridge_scale_correct"] = 0.5  # Starbridge mentioned, scale unclear

    # 12. topics_count_valid: topics array must have 3–10 items (generation_rules.yaml)
    # Below minimum (1-2): 0.5; missing/empty: 0.0
    if data and isinstance(data, dict):
        topics = data.get("topics", [])
        if isinstance(topics, list):
            n = len(topics)
            if 3 <= n <= 10:
                result["topics_count_valid"] = 1.0
            elif 1 <= n <= 2:
                result["topics_count_valid"] = 0.5
            # 0 or > 10: stays 0.0
    else:
        topics_match = re.search(r'"topics"\s*:\s*\[(.*?)\]', content, re.DOTALL)
        if topics_match:
            topic_items = re.findall(r'"[^"]*"', topics_match.group(1))
            n = len(topic_items)
            if 3 <= n <= 10:
                result["topics_count_valid"] = 1.0
            elif 1 <= n <= 2:
                result["topics_count_valid"] = 0.5

    # 13. credibility_markers_present: credibility_markers array with ≥2 entries (rules require ≥2)
    # 1 entry: 0.5; missing/empty: 0.0
    if data and isinstance(data, dict):
        cm = data.get("credibility_markers", [])
        if isinstance(cm, list):
            n = len(cm)
            if n >= 2:
                result["credibility_markers_present"] = 1.0
            elif n == 1:
                result["credibility_markers_present"] = 0.5
    else:
        cm_match = re.search(r'"credibility_markers"\s*:\s*\[(.*?)\]', content, re.DOTALL)
        if cm_match:
            items = re.findall(r'"[^"]*"', cm_match.group(1))
            if len(items) >= 2:
                result["credibility_markers_present"] = 1.0
            elif len(items) == 1:
                result["credibility_markers_present"] = 0.5

    return result
```

## LLM Judge Rubric

### Criterion 1: Trap Detection and Data Conflict Resolution Reasoning (Weight: 40%)
**Score 1.0**: The agent explicitly identified all three traps (contradictory target price low of $155 vs $140, outdated 91.7% market share vs current 82.4%, and the unit mismatch in Starbridge project phases summing to $100B not $100M) and articulated clear reasoning for why it chose the primary entity definitions or correct data over the misleading alternatives. The reasoning is documented or evident in the agent's process.
**Score 0.75**: The agent correctly resolved at least two of the three traps with clear reasoning, and showed awareness of data conflicts even if one trap was not explicitly called out. Resolution logic is sound but may lack full articulation for one conflict.
**Score 0.5**: The agent resolved at least one trap correctly with reasoning, but either missed the other conflicts entirely or resolved them without explaining the rationale. Some evidence of data cross-referencing exists but is inconsistent.
**Score 0.25**: The agent showed minimal awareness of data conflicts. It may have stumbled into a correct answer on one trap by chance but did not demonstrate deliberate cross-referencing or conflict resolution logic.
**Score 0.0**: The agent showed no awareness of any data conflicts, did not cross-reference sources, and either used trap values or made no effort to reconcile contradictory information.

### Criterion 2: Data Synthesis Depth and Factual Grounding (Weight: 35%)
**Score 1.0**: The profile is richly grounded in specific, accurate data points drawn from multiple workspace files — including revenue trend specifics (e.g., Q4 DC decline), product details (GX200, Obsidian architecture), market share figures, institutional holder context, median target price, rating distribution skew, and Starbridge project scale. Content reads as if written by someone with deep familiarity with the underlying data, with no hallucinated facts or generic filler.
**Score 0.75**: The profile incorporates most key data points from across the workspace with accuracy. A few areas rely on slightly vague language rather than precise figures, but overall the content is clearly data-driven and specific. No significant hallucinations.
**Score 0.5**: The profile includes some real data points but misses several important details (e.g., omits revenue trend specifics, lacks product roadmap details, or provides only surface-level market data). Some content feels generic or could apply to any analyst community rather than being NovaTech-specific.
**Score 0.25**: The profile contains only a handful of real data points, with much of the content being generic, vague, or loosely connected to the actual workspace data. Key narratives or topics lack specificity.
**Score 0.0**: The profile is largely generic filler with minimal or no connection to the actual data files in the workspace. Key facts are missing, hallucinated, or fabricated.

### Criterion 3: Professional Tone, Coherence, and Template Adherence Quality (Weight: 25%)
**Score 1.0**: The profile reads as a cohesive, professional social media presence that convincingly represents a sell-side analyst community. The tone is appropriately institutional (calibrated from the example profiles), all fields work together narratively (bio, pinned content, key narratives, and topics tell a consistent story), and the output demonstrates thoughtful adaptation of the template schema beyond mere field-filling — e.g., the posting style, follower persona, and linked entities feel intentional and internally consistent.
**Score 0.75**: The profile is professional and coherent with good tone calibration. Most fields complement each other well, though one or two fields may feel slightly disconnected or formulaic. Overall impression is of a competent, well-structured profile.
**Score 0.5**: The profile is adequate but reads more like a mechanical template fill-in than a cohesive social media presence. Tone may be inconsistent (e.g., mixing casual and institutional voices), or some fields feel disconnected from the overall narrative. Functional but not compelling.
**Score 0.25**: The profile has noticeable coherence issues — fields contradict each other, tone is inappropriate for an institutional analyst community, or the output feels rushed and disjointed. Multiple fields feel like generic placeholders.
**Score 0.0**: The profile lacks coherence, uses an inappropriate tone throughout, or fails to present a believable social media presence. Fields are disconnected, contradictory, or largely empty/meaningless.