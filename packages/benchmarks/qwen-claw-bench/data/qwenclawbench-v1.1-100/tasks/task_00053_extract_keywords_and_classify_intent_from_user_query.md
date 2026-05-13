---
id: task_00053_extract_keywords_and_classify_intent_from_user_query
name: Extract Keywords and Classify Intent from User Query
category: Knowledge and Memory Management
grading_type: hybrid
timeout_seconds: 1800
grading_weights:
  automated: 0.55
  llm_judge: 0.45
workspace_files:
- source: data/conversation_history.json
  dest: data/conversation_history.json
- source: data/memory_index.json
  dest: data/memory_index.json
- source: data/file_registry.json
  dest: data/file_registry.json
- source: config/extraction_rules.yaml
  dest: config/extraction_rules.yaml
- source: config/intent_mapping.json
  dest: config/intent_mapping.json
- source: data/user_profile.json
  dest: data/user_profile.json
- source: data/old_extraction_log.json
  dest: data/old_extraction_log.json
- source: data/similar_queries_reference.json
  dest: data/similar_queries_reference.json
- source: docs/keyword_extraction_guide.md
  dest: docs/keyword_extraction_guide.md
- source: docs/api_changelog.md
  dest: docs/api_changelog.md
subcategory: Memory and Context Management
---
## Prompt

We're building out the context-awareness layer for our assistant and I need your help with a concrete extraction task. A user just sent us this query (in Chinese):

**"我想继续分析先前对话中讨论过的视频项目，特别是 project_v3.prproj 的关键帧动画技能方案迭代优化部分"**

Translation for context: "I want to continue analyzing the video project discussed in previous conversations, especially the keyframe animation skill scheme iteration optimization part of project_v3.prproj"

What I need you to do: process this query through our extraction pipeline. Look at the configuration files under `config/` for the canonical extraction rules and intent mapping definitions. There's also supporting data in `data/` — conversation history, memory index, file registry, user profile — that provides context about this user's session. Some reference files and logs are floating around too; use your judgment about what's authoritative.

Produce a JSON file at `output/extracted_keywords.json` with this structure:

```json
{
  "query": "<the original Chinese query>",
  "intent": "<classified intent from the defined categories>",
  "keywords": ["<extracted keyword 1>", "<keyword 2>", ...],
  "matched_memory_ids": ["<memory IDs from memory_index that match>"],
  "matched_files": ["<filenames from file_registry that match>"],
  "confidence": <float between 0 and 1>
}
```

The keywords should follow the extraction settings (max count, stop word filtering, preserving proper nouns and technical terms). The intent should be classified according to our official intent mapping configuration. Match against the memory index and file registry to find relevant prior context.

Thanks — this is going to be the test case for our pipeline validation, so accuracy matters here.

## Expected Behavior

The agent must correctly process the Chinese user query through the extraction pipeline defined by the configuration files. Here is the complete correct approach:

1. **Intent Classification**: The query contains the phrases "先前对话" (previous conversation), "继续分析" (continue analyzing), and "讨论过" (discussed before). According to `config/intent_mapping.json`, the triggers for `search_memory` include "之前", "上次", "记得", "历史", "对话", and "讨论过". The query matches "对话" and "讨论过", so the intent must be classified as `search_memory`. The query also mentions "project_v3.prproj" (a file reference), which could trigger `search_file`, but the dominant intent based on the overall query structure (wanting to continue a previous discussion) should be `search_memory`.

   - **Trap 1 (outdated data)**: `data/old_extraction_log.json` uses deprecated intent names like `memory_lookup` and `file_search` and is deceptively marked as `"deprecated": false`. The agent must use the canonical intent values from `config/intent_mapping.json`, which defines `search_memory`, `search_file`, and `general` as the valid categories. The correct intent value is `search_memory`, NOT `memory_lookup`.

   - **Trap 2 (contradictory reference)**: `data/similar_queries_reference.json` contains authoritative-looking examples with confidence scores that incorrectly classify conversation-continuation queries (like this one) as `general` intent. The agent must follow the official rules in `config/intent_mapping.json` rather than these misleading reference examples. The correct intent is `search_memory`.

   - **Trap 3 (priority system conflict)**: Both `config/extraction_rules.yaml` and `docs/keyword_extraction_guide.md` describe a `priority` field where a higher numeric value takes precedence — under this rule, `search_file` (priority 2) would override `search_memory` (priority 1) when both trigger in the same query. The reference file `data/similar_queries_reference.json` (ref_007) even contains a near-identical query explicitly classified as `search_file` using this priority argument. However, the authoritative intent definition source is `config/intent_mapping.json`, which uses a `priority_weight` system where `search_memory` (weight 1.0) outranks `search_file` (weight 0.9). Furthermore, the overall communicative purpose of the query — to continue a previous conversation ("先前对话中讨论过", "继续分析") — aligns with `search_memory` semantically. The agent must correctly identify `config/intent_mapping.json` as the canonical authority for intent classification and output `search_memory`, NOT `search_file`.

2. **Keyword Extraction**: Per `config/extraction_rules.yaml`, the agent should:
   - Remove stop words (Chinese particles/pronouns like 我/的/中/过)
   - Preserve proper nouns (`project_v3.prproj`) and technical terms (`关键帧动画`, `迭代优化`)
   - Extract at most 6 keywords (max_keywords: 6)
   - Keep keywords to max 4 words each
   
   Expected keywords should include terms like: "视频项目" (video project), "project_v3.prproj", "关键帧动画" (keyframe animation), "技能方案" (skill scheme), "迭代优化" (iteration optimization), and potentially "先前对话" (previous conversation) or similar contextual terms. The total must not exceed 6.

3. **Memory Matching**: The agent should scan `data/memory_index.json` and find entries whose keywords overlap with the extracted keywords. Entries related to video project analysis, keyframe animation, skill optimization, and project_v3.prproj should be matched. The agent should return the IDs of matching memory entries.

4. **File Matching**: The agent should scan `data/file_registry.json` and match files referenced in or relevant to the query. At minimum, `project_v3.prproj` should be matched since it's explicitly named. Other relevant files like `skill_scheme_v3.xlsx` could also be matched based on keyword overlap.

5. **Confidence Score**: Should be a reasonable float between 0 and 1, reflecting high confidence given the clear trigger word matches.

The output must be valid JSON written to `output/extracted_keywords.json`.

## Grading Criteria

- [ ] Output file exists at `output/extracted_keywords.json` and contains valid JSON
- [ ] The `intent` field is set to `search_memory` (not `memory_lookup`, `file_search`, `general`, or any other value)
- [ ] The `keywords` array contains no more than 6 entries (respecting max_keywords from extraction_rules.yaml)
- [ ] The `keywords` array includes `project_v3.prproj` as a preserved proper noun/technical term
- [ ] The `keywords` array includes at least one Chinese technical term related to keyframe animation or skill scheme optimization (e.g., containing "关键帧", "技能方案", or "迭代优化")
- [ ] The `matched_files` array includes `project_v3.prproj`
- [ ] The `matched_memory_ids` array is non-empty and contains valid IDs from `data/memory_index.json`
- [ ] The `confidence` field is a number between 0 and 1 (inclusive)
- [ ] The `query` field contains the original Chinese query text
- [ ] Keywords do not contain stop words defined in `config/extraction_rules.yaml` (e.g., 我, 的, 了, 吧, 啊)
- [ ] The `intent` field is NOT set to `search_file` — the agent must not fall for the extraction_rules.yaml priority-number trap and must use `intent_mapping.json` as the authoritative classification source

## Automated Checks

```python
import os
import re
import json
from pathlib import Path

def grade(transcript: list, workspace_path: str) -> dict:
    """Grade the output of the keyword extraction task."""
    
    result = {
        "output_file_exists": 0.0,
        "valid_json_structure": 0.0,
        "valid_intent_field": 0.0,
        "correct_intent_value": 0.0,
        "no_deprecated_intent": 0.0,
        "no_deprecated_file_intent": 0.0,
        "no_wrong_search_file": 0.0,
        "keyword_count_within_limit": 0.0,
        "contains_video_keyword": 0.0,
        "contains_analysis_keyword": 0.0,
        "no_stop_words_in_keywords": 0.0,
        "proper_json_format": 0.0,
        "project_v3_in_keywords": 0.0,
        "matched_files_has_project": 0.0,
        "matched_memory_ids_nonempty": 0.0,
    }
    
    output_path = Path(workspace_path) / "output" / "extracted_keywords.json"
    
    if not output_path.is_file():
        return result
    result["output_file_exists"] = 1.0
    
    try:
        content = output_path.read_text(encoding="utf-8")
    except Exception:
        return result
    
    # 2. valid_json_structure: contains "keywords" as a JSON key
    if re.search(r'"keywords"', content):
        result["valid_json_structure"] = 1.0
    
    # 3. valid_intent_field: contains "intent" as a JSON key
    if re.search(r'"intent"', content):
        result["valid_intent_field"] = 1.0
    
    # 4. correct_intent_value: intent must be "search_memory"
    # Tightened to require the exact JSON field assignment rather than bare word presence.
    if re.search(r'"intent"\s*:\s*"search_memory"', content):
        result["correct_intent_value"] = 1.0
    elif re.search(r'search_memory', content):
        result["correct_intent_value"] = 0.5
    
    # 5. no_deprecated_intent: must NOT contain "memory_lookup" (deprecated name from old log)
    if "memory_lookup" not in content.lower():
        result["no_deprecated_intent"] = 1.0
    
    # 6. no_deprecated_file_intent: must NOT contain "file_search" (deprecated name from old log)
    if "file_search" not in content.lower():
        result["no_deprecated_file_intent"] = 1.0
    
    # 7. no_wrong_search_file: Trap 3 — agent must NOT set intent to "search_file".
    # extraction_rules.yaml's priority comment and keyword_extraction_guide.md both misleadingly
    # claim that search_file (priority 2) overrides search_memory (priority 1). The correct
    # authority is intent_mapping.json's priority_weight where search_memory (1.0) > search_file
    # (0.9). Correct intent is search_memory, NOT search_file.
    if not re.search(r'"intent"\s*:\s*"search_file"', content):
        result["no_wrong_search_file"] = 1.0
    
    # 8. keyword_count_within_limit: keywords array has at most 6 items (max_keywords: 6)
    content_single_line = re.sub(r'\s+', ' ', content)
    if re.search(r'"keywords"\s*:\s*\[(?:[^\],]*,){0,5}[^\],]*\]', content_single_line):
        result["keyword_count_within_limit"] = 1.0
    
    # 9. contains_video_keyword: keywords contain video/视频/项目
    if re.search(r'(?i)(video|视频|项目)', content):
        result["contains_video_keyword"] = 1.0
    
    # 10. contains_analysis_keyword: keywords contain analysis/分析/优化/迭代/skill/技能
    if re.search(r'(?i)(analy|分析|优化|迭代|skill|技能)', content):
        result["contains_analysis_keyword"] = 1.0
    
    # 11. no_stop_words_in_keywords: must NOT contain common stop words as quoted keyword values.
    # Original: only checked "吧". Broadened to the most common stop words from extraction_rules.yaml
    # that would appear if stop word filtering is skipped.
    stop_words_to_check = ['"吧"', '"啊"', '"的"', '"了"', '"我"', '"你"', '"是"', '"在"',
                           '"和"', '"也"', '"都"', '"就"', '"还"', '"这"', '"那"', '"呢"',
                           '"吗"', '"呀"', '"嘛"']
    if not any(sw in content for sw in stop_words_to_check):
        result["no_stop_words_in_keywords"] = 1.0
    elif sum(1 for sw in stop_words_to_check if sw in content) <= 1:
        result["no_stop_words_in_keywords"] = 0.5
    
    # 12. proper_json_format: output is a valid JSON object (braces present)
    if re.search(r'^\s*\{[\s\S]*\}\s*$', content):
        result["proper_json_format"] = 1.0

    # 13. project_v3_in_keywords: project_v3.prproj must be preserved as a proper noun keyword.
    if re.search(r'"keywords"\s*:\s*\[[\s\S]*?"project_v3\.prproj"[\s\S]*?\]', content):
        result["project_v3_in_keywords"] = 1.0
    elif "project_v3" in content.lower():
        result["project_v3_in_keywords"] = 0.5

    # 14. matched_files_has_project: matched_files must include project_v3.prproj.
    if re.search(r'"matched_files"\s*:\s*\[[\s\S]*?"project_v3\.prproj"[\s\S]*?\]', content):
        result["matched_files_has_project"] = 1.0
    elif re.search(r'"matched_files"\s*:\s*\[[\s\S]*?project_v3[\s\S]*?\]', content):
        result["matched_files_has_project"] = 0.5

    # 15. matched_memory_ids_nonempty: matched_memory_ids must be non-empty.
    if re.search(r'"matched_memory_ids"\s*:\s*\[\s*"[^"]+', content):
        result["matched_memory_ids_nonempty"] = 1.0
    elif re.search(r'"matched_memory_ids"\s*:\s*\[', content) and \
         not re.search(r'"matched_memory_ids"\s*:\s*\[\s*\]', content):
        result["matched_memory_ids_nonempty"] = 0.5

    # 16. query_field_contains_original: the "query" field must contain the original Chinese text.
    result["query_field_contains_original"] = 0.0
    if re.search(r'"query"\s*:\s*"[^"]*(?:视频项目|project_v3|关键帧|先前对话)[^"]*"', content):
        result["query_field_contains_original"] = 1.0
    elif re.search(r'"query"\s*:\s*"[^"]{10,}"', content):
        result["query_field_contains_original"] = 0.5

    # 17. confidence_valid_range: confidence must be a number in [0, 1].
    result["confidence_valid_range"] = 0.0
    conf_match = re.search(r'"confidence"\s*:\s*([\d.]+)', content)
    if conf_match:
        try:
            conf_val = float(conf_match.group(1))
            if 0.0 <= conf_val <= 1.0:
                result["confidence_valid_range"] = 1.0
        except ValueError:
            pass

    return result
```

## LLM Judge Rubric

### Criterion 1: Intent Classification Correctness and Reasoning Quality (Weight: 45%)
**Score 1.0**: `intent` is set to `search_memory`. The output (or implicit reasoning reflected in the confidence and keyword choices) demonstrates that the agent correctly identified "先前对话" and "讨论过" as the dominant trigger for `search_memory`, and did not fall for any of the three intent traps: (1) did not use deprecated name `memory_lookup` from `old_extraction_log.json`; (2) did not follow the misleading `similar_queries_reference.json` examples that classify continuation queries as `general`; (3) correctly applied `intent_mapping.json`'s `priority_weight` system (`search_memory` weight 1.0 > `search_file` weight 0.9) rather than the numeric `priority` field in `extraction_rules.yaml` or `keyword_extraction_guide.md`. The intent choice is the most semantically appropriate given the query's overall communicative purpose.
**Score 0.75**: `intent` is `search_memory` and the output avoids all deprecated names. One of the three traps was not explicitly navigated (e.g., the priority-weight vs. priority-number distinction is not reflected in the output), but the final intent is correct.
**Score 0.5**: `intent` is `search_memory` but the reasoning shows partial confusion — e.g., the agent initially leaned toward `search_file` due to the file reference and only settled on `search_memory` without fully explaining the priority weight resolution.
**Score 0.25**: `intent` is `search_file` (fell for Trap 3's numeric-priority argument) or `general` (fell for Trap 2's misleading reference examples), but keyword extraction and file/memory matching are otherwise reasonable.
**Score 0.0**: `intent` uses a deprecated label (`memory_lookup`, `file_search`) or is entirely absent. The output does not reflect any meaningful engagement with the intent classification rules.

### Criterion 2: Keyword Extraction Quality (Weight: 30%)
**Score 1.0**: Keywords list contains ≤6 entries, preserves `project_v3.prproj` as a proper noun, includes at least one meaningful Chinese technical term (e.g., "关键帧动画", "技能方案", "迭代优化"), and contains no stop words from `config/extraction_rules.yaml`. Keywords reflect the core semantic content of the query — video project, continuation context, keyframe animation, optimization — without padding or redundancy.
**Score 0.75**: Keywords satisfy the count limit, include `project_v3.prproj`, and have at least one technical Chinese term. One minor issue: a borderline term is included (e.g., "先前对话" which is contextual rather than a topic keyword) or a more specific term is missing.
**Score 0.5**: Keywords satisfy the count limit and include `project_v3.prproj`, but the Chinese technical terms are too generic (e.g., only "视频" without "关键帧" or "迭代优化"), or 1–2 stop words appear in the list.
**Score 0.25**: Keywords are present but exceed the 6-item limit, or do not preserve `project_v3.prproj` as a complete proper noun, or are mostly Chinese stop words and common verbs.
**Score 0.0**: No keywords, empty list, or keywords bear no relationship to the query content.

### Criterion 3: Memory and File Matching Accuracy (Weight: 25%)
**Score 1.0**: `matched_files` includes `project_v3.prproj` and potentially other relevant files (e.g., `skill_scheme_v3.xlsx`) from `data/file_registry.json`. `matched_memory_ids` is non-empty and contains IDs from `data/memory_index.json` that are semantically relevant to video project, keyframe animation, or skill optimization — not random IDs. Confidence is a reasonable float (e.g., 0.7–0.95) reflecting high confidence given clear trigger matches.
**Score 0.75**: `matched_files` includes `project_v3.prproj`. `matched_memory_ids` is non-empty and mostly relevant. Confidence is in a plausible range.
**Score 0.5**: `matched_files` includes `project_v3.prproj` but no other relevant files. `matched_memory_ids` is non-empty but IDs appear to be guessed or generic rather than matching actual index entries.
**Score 0.25**: `matched_files` or `matched_memory_ids` is present but empty, or `project_v3.prproj` is missing from matched_files despite being explicitly named in the query.
**Score 0.0**: Both `matched_files` and `matched_memory_ids` are empty or absent from the output.