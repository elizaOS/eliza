---
id: task_00052_generate_openai_social_media_profile_from_workspace_data
name: Generate OpenAI Social Media Profile from Workspace Data
category: Knowledge and Memory Management
grading_type: hybrid
timeout_seconds: 1800
grading_weights:
  automated: 0.45
  llm_judge: 0.55
workspace_files:
- source: data/entity_registry.json
  dest: data/entity_registry.json
- source: data/social_media_guidelines.yaml
  dest: data/social_media_guidelines.yaml
- source: data/openai_context_notes.md
  dest: data/openai_context_notes.md
- source: data/competitor_profiles.json
  dest: data/competitor_profiles.json
- source: data/entity_updates_2024.json
  dest: data/entity_updates_2024.json
- source: config/output_schema.json
  dest: config/output_schema.json
- source: data/social_tone_matrix.csv
  dest: data/social_tone_matrix.csv
- source: data/field_guidelines_v2.yaml
  dest: data/field_guidelines_v2.yaml
- source: logs/previous_generations.log
  dest: logs/previous_generations.log
subcategory: Memory and Context Management
---
## Prompt

We're spinning up institutional social media accounts for the AI companies in our entity registry, and OpenAI is next on the list. I've gathered all the relevant reference materials in the workspace — the entity registry, our social media setup guidelines, context notes on OpenAI's public communications, the output schema, field guidelines, the tone matrix, and a few other files from previous work.

I need you to synthesize everything and produce a well-crafted social media profile JSON for OpenAI. Save it to `output/openai_social_profile.json`. The profile needs to conform to the output schema in `config/output_schema.json` and follow the guidelines in `data/social_media_guidelines.yaml`.

All text string fields must be written in Chinese (zh-CN) — the `gender` field is the only exception and must remain the English string `"other"`. The persona should be a single dense paragraph with no line breaks, covering the organization's background, account positioning, speaking style, content characteristics, stances on key topics, and any special notes worth remembering. Be sure to include OpenAI's most recent product launches (e.g., GPT-4 Turbo, Sora) in the persona content — the workspace has up-to-date product information.

There are multiple files covering overlapping topics, and some contain conflicting information. Use your judgment to determine which source is authoritative for each data point. The output must validate cleanly against the schema — no nulls, correct types, all required fields present. The output schema and the final-version guidelines take precedence for field format rules.

## Expected Behavior

The agent must produce a valid JSON file at `output/openai_social_profile.json` containing all required fields from the output schema.

**Correct resolution of factual data conflicts (Trap 1 — Multi-Source Misinformation):**
- `data/entity_registry.json` lists OpenAI's founding year as **2015** and headquarters as **San Francisco**. This is the canonical, verified source (registry_version 1.0.3, last_verified 2023-11-15).
- `data/entity_updates_2024.json` lists the founding year as **2018** and headquarters as **Seattle, Washington**, and claims this corrects "erroneous 2015 entry per SEC filings." These values are factually incorrect — OpenAI was founded in December 2015 as a nonprofit; the capped-profit entity launched in 2019, not 2018.
- `data/openai_context_notes.md` (Section 5) now ALSO incorrectly claims "operative founding date of the commercial entity is 2018" and "headquarters currently in Seattle." This file has been corrupted with the same misinformation.
- The agent must detect that TWO sources claim 2018/Seattle but the VERIFIED primary registry (with explicit `last_verified` timestamp and `source: Internal Research & Verification Team`) states 2015/San Francisco. The agent should override the two-source consensus using the verified registry + domain knowledge. The correct founding year (**2015**) and headquarters (**San Francisco**) must appear in the output.

**Correct resolution of guideline conflicts (Trap 2 — Contradictory Field Guidelines):**
- `data/social_media_guidelines.yaml` (Version 1.0 Final, dated 2024-01-15) specifies: gender = `"other"` (English), age = `30`, persona must be a single paragraph with no newlines.
- `data/field_guidelines_v2.yaml` (labeled v2, dated 2023-06-20) incorrectly states: gender = `"其他"` (Chinese), age = `25`, newlines allowed in persona. Despite the "v2" filename, its actual date (2023-06) is older than the final guidelines (2024-01).
- The agent should trust `data/social_media_guidelines.yaml` (marked "Final", later effective date) and `config/output_schema.json` (the definitive schema), which corroborate: age=30, gender="other", no newlines.

**Correct resolution of bio length conflicts (Trap 3 — Field Length Discrepancy):**
- `data/social_media_guidelines.yaml` and `config/output_schema.json` both specify bio: minLength=150, maxLength=250.
- `data/field_guidelines_v2.yaml` (v2, 2023-06-20) incorrectly specifies bio: min_length=80, max_length=180.
- The agent must use the authoritative schema (output_schema.json) and final guidelines (social_media_guidelines.yaml): bio must be **150-250 characters**. A bio of 80-180 chars satisfying only the v2 constraint would violate the schema.

**Output file requirements:**
- `bio`: 150-250 characters, written in Chinese, summarizing OpenAI's identity and mission
- `persona`: 1500-2500 characters, single paragraph (no `\n`), written in Chinese, covering organization basics (founded **2015**, **San Francisco**), account positioning, speaking style (professional yet approachable, innovative, safety-focused), content characteristics, stances on AI safety/alignment/democratization, organizational memory — must mention recent products (GPT-4 Turbo, Sora) from entity_updates_2024.json
- `age`: integer `30`
- `gender`: string `"other"` (English, not Chinese)
- `mbti`: `"INTJ"` (from social_tone_matrix.csv for TechCompany entities)
- `country`: `"美国"` (Chinese, from entity registry)
- `profession`: A string describing OpenAI's role in Chinese, e.g., `"AI研究实验室"`
- `interested_topics`: Array of at least 3 Chinese topic strings covering AI-related areas
- No null values, no additional properties, valid JSON

**Selective source usage (key insight):**
- For founding year and headquarters: use `entity_registry.json` (verified) — reject the 2018/Seattle data from entity_updates_2024.json AND openai_context_notes.md
- For recent products: use `entity_updates_2024.json` — it correctly lists GPT-4 Turbo, Sora, and GPT Store, which are legitimately newer information
- The agent must distinguish between data that is NEWLY CORRECT (recent products) vs. data that is NEWLY WRONG (founding year/HQ) within the same update file

**Files to use with caution:**
- `data/competitor_profiles.json`: profiles for other companies — must not be used as templates
- `logs/previous_generations.log`: workspace log — informational only, not authoritative

## Grading Criteria

- [ ] Output file exists at `output/openai_social_profile.json` and is valid JSON
- [ ] All required fields are present: bio, persona, age, gender, mbti, country, profession, interested_topics
- [ ] The `age` field is the integer `30` (not 25 from field_guidelines_v2.yaml)
- [ ] The `gender` field is the English string `"other"` (not the Chinese string `"其他"` from field_guidelines_v2.yaml)
- [ ] The `mbti` field is a valid 4-letter MBTI type (preferably `"INTJ"` based on social_tone_matrix.csv for TechCompany)
- [ ] The `bio` field is 150-250 characters (conforming to output_schema.json and social_media_guidelines.yaml, NOT the shorter 80-180 limit from field_guidelines_v2.yaml)
- [ ] The `persona` field is 1500-2500 characters, written in Chinese, and contains no newline characters (single continuous paragraph)
- [ ] The persona correctly references OpenAI's founding year as **2015** — overrides the erroneous 2018 claim appearing in entity_updates_2024.json AND openai_context_notes.md (two-source trap)
- [ ] The persona correctly references OpenAI's headquarters as **San Francisco** (旧金山) — overrides the erroneous Seattle claim
- [ ] The persona mentions at least one recent product launch (GPT-4 Turbo, Sora, or GPT Store) from entity_updates_2024.json — demonstrates selective use of the update file for correct new data
- [ ] The persona covers required aspects: organization basics, speaking style, content characteristics, stances on key topics (AI safety, responsible AI), and organizational memory
- [ ] The `interested_topics` field is an array with at least 3 topic strings
- [ ] The output contains no null values and no additional properties beyond the schema
- [ ] The `country` field is written in Chinese (e.g., `"美国"`), conforming to the Chinese language requirement for all text fields except gender

## Automated Checks

```python
import os
import re
import json

def grade(transcript: list, workspace_path: str) -> dict:
    """Grade the openai_social_profile.json output file."""

    result = {
        "output_file_exists": 0.0,
        "valid_json_structure": 0.0,
        "age_is_30": 0.0,
        "gender_is_other_english": 0.0,
        "gender_not_chinese": 0.0,
        "has_interested_topics_array": 0.0,
        "country_in_chinese": 0.0,
        "no_null_values": 0.0,
        "has_mbti_field": 0.0,
        "persona_no_newlines": 0.0,
        "bio_length_correct": 0.0,
        "has_profession_field": 0.0,
        "founding_year_correct": 0.0,
        "headquarters_correct": 0.0,
        "recent_product_mentioned": 0.0,
        "schema_required_fields_present": 0.0,
    }

    output_path = os.path.join(workspace_path, "output", "openai_social_profile.json")

    if not os.path.isfile(output_path):
        return result

    result["output_file_exists"] = 1.0

    try:
        with open(output_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return result

    # --- valid_json_structure ---
    # Parse JSON and check that all required fields are present strings/values.
    # Original: only checked for bio field via regex — did not verify actual JSON validity
    # or presence of other required fields. Fixed: use json.loads for structural validation.
    parsed = None
    try:
        parsed = json.loads(content)
        required = {"bio", "persona", "age", "gender", "mbti", "country", "profession", "interested_topics"}
        if isinstance(parsed, dict) and required.issubset(parsed.keys()):
            result["valid_json_structure"] = 1.0
    except (json.JSONDecodeError, Exception):
        if re.search(r'"bio"\s*:\s*"[^"]+"', content):
            result["valid_json_structure"] = 0.5

    # --- age_is_30 ---
    if re.search(r'"age"\s*:\s*30[^0-9]', content):
        result["age_is_30"] = 1.0

    # --- gender_is_other_english ---
    if re.search(r'"gender"\s*:\s*"other"', content):
        result["gender_is_other_english"] = 1.0

    # --- gender_not_chinese ---
    # Check that gender field value is not "其他" — but allow "其他" in persona/bio text.
    if not re.search(r'"gender"\s*:\s*"其他"', content):
        result["gender_not_chinese"] = 1.0

    # --- has_interested_topics_array ---
    if parsed is not None and isinstance(parsed, dict):
        topics = parsed.get("interested_topics")
        if isinstance(topics, list) and len(topics) >= 3 and all(isinstance(x, str) for x in topics):
            result["has_interested_topics_array"] = 1.0
        elif isinstance(topics, list) and len(topics) >= 1:
            result["has_interested_topics_array"] = 0.5
    elif re.search(r'"interested_topics"\s*:\s*\[', content):
        result["has_interested_topics_array"] = 0.5

    # --- country_in_chinese ---
    # Prompt explicitly states all text fields must be in Chinese except gender.
    if re.search(r'"country"\s*:\s*"[\u4e00-\u9fff]+', content):
        result["country_in_chinese"] = 1.0

    # --- no_null_values ---
    if not re.search(r':\s*null\b', content):
        result["no_null_values"] = 1.0

    # --- has_mbti_field ---
    if re.search(r'"mbti"\s*:\s*"[EI][SN][TF][JP]"', content):
        result["has_mbti_field"] = 1.0

    # --- persona_no_newlines ---
    # Use parsed JSON if available; verify no newlines AND length in schema range (1500-2500).
    if parsed is not None:
        persona_val = parsed.get("persona", "") if isinstance(parsed, dict) else ""
        if isinstance(persona_val, str) and "\n" not in persona_val and "\r" not in persona_val:
            plen = len(persona_val)
            if 1500 <= plen <= 2500:
                result["persona_no_newlines"] = 1.0
            elif 1000 <= plen < 1500:
                result["persona_no_newlines"] = 0.5
    else:
        # Fallback regex check when JSON parsing failed
        m = re.search(r'"persona"\s*:\s*"([^"]{1000,})"', content)
        if m and r'\n' not in m.group(1):
            result["persona_no_newlines"] = 0.5

    # --- bio_length_correct ---
    # Schema and social_media_guidelines.yaml: bio must be 150-250 chars.
    # field_guidelines_v2.yaml (outdated) incorrectly specifies 80-180 chars.
    # Original bug: used `dir()` to detect if `parsed` was defined — unreliable across
    # Python environments. Fixed: use `parsed` directly (already defined above) or regex.
    bio_len = 0
    if parsed is not None:
        bio_val = parsed.get("bio", "") if isinstance(parsed, dict) else ""
        if isinstance(bio_val, str):
            bio_len = len(bio_val)
    else:
        m_bio = re.search(r'"bio"\s*:\s*"([^"]*)"', content)
        if m_bio:
            bio_len = len(m_bio.group(1))
    if 150 <= bio_len <= 250:
        result["bio_length_correct"] = 1.0
    elif 80 <= bio_len < 150:
        # 80-149 chars: satisfies only the outdated v2 guidelines, not the authoritative schema
        result["bio_length_correct"] = 0.5

    # --- has_profession_field ---
    if re.search(r'"profession"\s*:\s*"[^"]+"', content):
        result["has_profession_field"] = 1.0

    # --- founding_year_correct ---
    # Two trap sources (entity_updates_2024.json and openai_context_notes.md) claim 2018.
    # Only entity_registry.json (the verified primary source) has the correct year 2015.
    # Full credit if 2015 appears without 2018; partial if both appear (conflict acknowledged);
    # zero if only 2018 appears (trap activated).
    target_text = ""
    if parsed is not None and isinstance(parsed, dict):
        target_text = f'{parsed.get("bio", "")} {parsed.get("persona", "")}'
    else:
        target_text = content
    has_2015 = bool(re.search(r'\b2015\b', target_text))
    has_2018 = bool(re.search(r'\b2018\b', target_text))
    if has_2015 and not has_2018:
        result["founding_year_correct"] = 1.0
    elif has_2015 and has_2018:
        result["founding_year_correct"] = 0.75
    # else: 0.0 (trap activated or year not mentioned)

    # --- headquarters_correct ---
    # Two trap sources claim Seattle; entity_registry.json (verified) says San Francisco.
    has_sf = bool(re.search(r'(?i)(san francisco|旧金山)', target_text))
    has_seattle = bool(re.search(r'(?i)(seattle|西雅图)', target_text))
    if has_sf and not has_seattle:
        result["headquarters_correct"] = 1.0
    elif has_sf and has_seattle:
        result["headquarters_correct"] = 0.75
    # else: 0.0

    # --- recent_product_mentioned ---
    # Prompt explicitly asks agent to mention recent product launches from entity_updates_2024.json.
    # Agent must selectively use entity_updates for product info (correct) while rejecting its
    # founding year / HQ data (incorrect). Checks for GPT-4 Turbo, Sora, or GPT Store.
    if re.search(r'(?i)(gpt.?4.?turbo|sora|gpt.?store|custom.?gpts)', content):
        result["recent_product_mentioned"] = 1.0
    elif re.search(r'(?i)(gpt.?4|dall.?e.?3)', content):
        result["recent_product_mentioned"] = 0.5

    # Attempt to validate against output schema if available
    schema_path = os.path.join(workspace_path, "config", "output_schema.json")
    if os.path.isfile(schema_path) and os.path.isfile(output_path):
        try:
            with open(schema_path, "r", encoding="utf-8") as _sf:
                schema_data = json.loads(_sf.read())
            output_data = parsed if parsed is not None else json.loads(content)
            if isinstance(output_data, dict):
                # Basic required field check from schema
                required_fields = schema_data.get("required", [])
                if required_fields:
                    missing = [f for f in required_fields if f not in output_data]
                    result["schema_required_fields_present"] = 1.0 if not missing else max(0.0, 1.0 - len(missing) / len(required_fields))
                else:
                    result["schema_required_fields_present"] = 0.5  # schema exists but no required fields defined
            else:
                result["schema_required_fields_present"] = 0.0
        except Exception:
            result["schema_required_fields_present"] = 0.0
    else:
        result["schema_required_fields_present"] = 0.0

    return result
```

## LLM Judge Rubric

### Criterion 1: Multi-Source Trap Detection and Resolution (Weight: 40%)
**Score 1.0**: The agent correctly resolves all three traps with explicit reasoning: (a) Trap 1 — founding year/HQ: TWO sources (entity_updates_2024.json AND openai_context_notes.md) claim 2018/Seattle, but the agent correctly identifies `entity_registry.json` as the authoritative verified source and uses 2015/San Francisco; the reasoning cites the registry's verification metadata, "last_verified" timestamp, or well-known public knowledge about OpenAI. (b) Trap 2 — field guidelines: recognizes that `field_guidelines_v2.yaml` (dated 2023-06, status "active") is superseded by `social_media_guidelines.yaml` (dated 2024-01, status "final"), and that the output_schema.json is the definitive authority; uses age=30, gender="other", no newlines. (c) Trap 3 — bio length: ignores the field_guidelines_v2.yaml constraint of 80-180 chars and uses the correct 150-250 range from the authoritative schema and final guidelines.
**Score 0.75**: The agent correctly resolves at least two traps with sound reasoning and partially handles the third — e.g., uses correct 2015/SF while noting the conflict, uses correct field values (age=30, gender="other"), but doesn't explicitly address the bio length discrepancy between the two guideline files.
**Score 0.5**: The agent falls for the founding year trap (uses 2018) despite two sources confirming it — demonstrating that when two files agree, the agent accepts them without checking the primary verified source. OR it correctly handles the factual data but falls for both guideline traps (age=25, gender="其他"). No more than one trap fully resolved.
**Score 0.25**: The agent shows partial awareness of conflicts in one area but resolves them incorrectly for at least two of the three traps. For example, it picks 2018 because "two sources say so" without consulting the verified registry, and also uses age=25 from the v2 guidelines without checking the effective dates.
**Score 0.0**: The agent uses 2018/Seattle as the founding facts (both trap sources agree, agent follows the majority), uses age=25 or gender="其他" from the v2 guidelines, and makes no attempt to evaluate source reliability or cross-reference the authoritative files.

### Criterion 2: Selective Source Synthesis and Content Quality (Weight: 35%)
**Score 1.0**: The persona demonstrates sophisticated selective source usage: it correctly uses entity_registry.json for founding facts (2015, San Francisco) while ALSO drawing recent product information (GPT-4 Turbo, Sora, GPT Store) from entity_updates_2024.json — showing the agent can extract correct data from the same file that contains incorrect data, rather than wholesale accepting or rejecting it. The persona is a rich, dense single paragraph in Chinese covering all required dimensions: organizational background, account positioning, speaking style, stances on AI safety/democratization/responsible deployment, and organizational memory. The bio is well-crafted in the correct 150-250 char range.
**Score 0.75**: The persona is well-written, covers most required dimensions, and includes recent products from entity_updates_2024.json. However, it either misses one required dimension (e.g., no explicit speaking style description), or doesn't clearly demonstrate the selective sourcing strategy (uses only entity_registry.json for all data, missing the most recent products like Sora).
**Score 0.5**: The persona is in Chinese with accurate founding facts (2015, SF), but lacks recent product launches from entity_updates_2024.json (only mentions older products like ChatGPT, GPT-4), OR the content is accurate but feels generic — not drawing on the specific communication style analysis in openai_context_notes.md.
**Score 0.25**: The persona has significant quality issues: either uses incorrect facts (2018, Seattle), lacks required dimensions, is too brief even with correct structure, or primarily reflects information from the wrong sources (competitor_profiles.json as template, or content not grounded in workspace files).
**Score 0.0**: The persona and/or bio are missing, not in Chinese, contain predominantly incorrect factual information, or show no meaningful synthesis of the workspace materials.

### Criterion 3: Schema Validation and Professional Output (Weight: 25%)
**Score 1.0**: The output JSON is valid, schema-compliant, and ready for platform deployment. All 8 required fields are present with correct types (age is integer 30, gender is string "other", interested_topics is an array of 3+ strings). No null values, no additional properties. Country is in Chinese ("美国"). MBTI is "INTJ" (correct for TechCompany per tone matrix). The bio is in the correct 150-250 char range (not the shorter 80-180 from the v2 guidelines trap). The persona is 1500-2500 chars with no newline characters. The document is professional and ready to hand to the platform team.
**Score 0.75**: The output is valid JSON with all required fields in mostly correct formats, but has one schema violation — e.g., bio is 90-148 chars (satisfying only the outdated v2 constraint, not the schema minimum of 150), or interested_topics has only 2 items instead of 3, or MBTI is a valid type but not "INTJ" (the recommended value for TechCompany).
**Score 0.5**: The JSON is valid but has 2-3 schema issues — e.g., age is 25 (from the v2 guidelines trap), or bio is too short, or persona contains newline characters (following the v2 "allow_newlines=true" guidance). These indicate the agent followed the wrong guideline source.
**Score 0.25**: The JSON has structural issues — e.g., some required fields are missing, several values are null or empty strings, the persona is under 1000 chars, or the output has additional properties beyond the schema.
**Score 0.0**: The output file doesn't exist, is invalid JSON, is missing most required fields, or fails basic schema validation entirely.