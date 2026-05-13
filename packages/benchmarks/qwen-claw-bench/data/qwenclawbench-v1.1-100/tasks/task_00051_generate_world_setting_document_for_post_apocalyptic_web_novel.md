---
id: task_00051_generate_world_setting_document_for_post_apocalyptic_web_novel
name: Generate World-Setting Document for Post-Apocalyptic Web Novel
category: Workflow and Agent Orchestration
grading_type: hybrid
timeout_seconds: 1800
workspace_files:
- source: specs/project_brief.md
  dest: specs/project_brief.md
- source: specs/chapter_structure_guide.md
  dest: specs/chapter_structure_guide.md
- source: specs/character_template.md
  dest: specs/character_template.md
- source: specs/writing_standards_reference.md
  dest: specs/writing_standards_reference.md
- source: reference/climate_disaster_research.md
  dest: reference/climate_disaster_research.md
- source: reference/survival_mechanics.json
  dest: reference/survival_mechanics.json
- source: reference/similar_novels_analysis.md
  dest: reference/similar_novels_analysis.md
- source: config/project_config.yaml
  dest: config/project_config.yaml
- source: config/outdated_project_config.yaml
  dest: config/outdated_project_config.yaml
- source: reference/power_system_draft.md
  dest: reference/power_system_draft.md
- source: reference/timeline_draft.md
  dest: reference/timeline_draft.md
- source: reference/faction_notes.md
  dest: reference/faction_notes.md
- source: specs/review_checklist_template.md
  dest: specs/review_checklist_template.md
- source: data/name_database.csv
  dest: data/name_database.csv
- source: specs/volume_breakdown_v2.md
  dest: specs/volume_breakdown_v2.md
- source: reference/worldbuilding_contradictions.md
  dest: reference/worldbuilding_contradictions.md
- source: logs/previous_generation_log.txt
  dest: logs/previous_generation_log.txt
- source: data/location_database.json
  dest: data/location_database.json
- source: specs/dialogue_style_guide.md
  dest: specs/dialogue_style_guide.md
- source: config/file_structure.json
  dest: config/file_structure.json
grading_weights:
  automated: 0.65
  llm_judge: 0.35
subcategory: Scenario-Based Automation Applications
---
## Prompt

We're kicking off the pre-production pipeline for our post-apocalyptic web novel project. I've dumped all the planning materials into this workspace — project briefs, config files, research notes, character templates, structure guides, the works. There are a lot of files from different stages of planning, so some might be outdated or inconsistent with each other. You'll need to figure out which sources are authoritative.

Your job right now is to produce all the foundational project files into `project_output/`. The primary deliverable is **设定文件.md** (master world-setting document), along with the following companion files as specified in `specs/project_brief.md`:

- `project_output/设定文件.md` — complete world-setting document (primary deliverable)
- `project_output/人物设定.md` — character profiles
- `project_output/设立设定.md` — faction and location settings
- `project_output/写作规范.md` — writing standards and style guide
- `project_output/正文核对检查标准.md` — per-chapter review checklist
- `project_output/正文/` — directory for chapter files (create the folder, contents TBD)
- `project_output/设定决策摘要.json` — machine-readable summary of the final authoritative decisions

Focus the bulk of your effort on **设定文件.md**, as it is the canonical reference the other files will build upon.

The document should be written in Chinese and must synthesize information from across the workspace to cover at minimum:

- **Project overview**: title, genre, protagonist name, the nature of the protagonist's cheat/advantage, overall tone
- **Apocalypse cause and mechanism**: what triggered the apocalypse, how it manifests, the progression/phases of the disaster
- **World timeline**: key events from Day 0 through the main story period
- **Power/ability system**: how powers work, tiers, limitations, connection to the apocalypse cause
- **Survival mechanics**: resource categories, threat levels, skill systems, base-building progression
- **Major factions**: key groups, their philosophies, territories, and relationships
- **Key locations**: important settings with descriptions
- **Scale parameters**: total target word count, characters per chapter, chapters per volume, total volumes, total chapters

There are conflicting details across files — some are outdated, some have internal inconsistencies, and at least one file explicitly claims to override others but contains errors. You'll need to figure out which sources are authoritative through careful cross-validation: check version numbers, dates, internal consistency, and whether the math adds up. Don't simply trust a file's self-declared authority or recency.

Make it comprehensive, well-organized with clear section headers, and suitable as a canonical reference document that the rest of the production pipeline will build upon.

Also write `project_output/设定决策摘要.json` for downstream tooling. Use these top-level keys: `protagonist_name`, `apocalypse_cause`, `cheat_type`, `tone`, `scale_parameters`, `awakening_timeline`, `authoritative_sources`, and `rejected_sources`. The markdown files and the JSON summary must agree.

## Expected Behavior

The agent must produce a comprehensive Chinese-language world-setting document at `project_output/设定文件.md`, meaningful companion files, and a matching structured summary at `project_output/设定决策摘要.json` by carefully synthesizing information from multiple workspace files while correctly resolving several conflicting data sources.

**Trap 1 — Protagonist Name (contradictory data):**
- `config/project_config.yaml` (version 2.0, dated 2024-03-15) correctly specifies the protagonist as **王艾卷** (Wang Aijuan).
- `config/outdated_project_config.yaml` (dated 2024-01-15) incorrectly lists **王爱娟** — a very similar-sounding name with different Chinese characters.
- The agent should use **王艾卷** from the authoritative `project_config.yaml` and `specs/project_brief.md`. The outdated config's date comment ("Updated 2024-01-15") makes it look plausibly current, but it is older than the v2.0 config.

**Trap 2 — Apocalypse Cause (contradictory data):**
- `specs/project_brief.md` clearly specifies the apocalypse cause as **natural disaster/climate anomaly** (自然灾害/气候异变).
- `reference/worldbuilding_contradictions.md` authoritatively claims the cause is a **meteor impact** (陨石撞击). While a meteor impact is technically a natural disaster, it contradicts the specific "climate anomaly" requirement.
- The outdated config also incorrectly says "zombie_virus."
- The agent must use **climate anomaly/natural disaster** as specified in the primary brief, NOT meteor impact or zombie virus.

**Trap 3 — Volume/Chapter Structure (outdated data):**
- `specs/chapter_structure_guide.md` correctly specifies: ~2000 chars/chapter, 50-60 chapters/volume, ~500 total chapters, ~9-10 volumes, ~1,000,000 total characters.
- `specs/volume_breakdown_v2.md` appears to be a "newer" version (v2) but contains **two separate internal contradictions**: (1) its header claims "每卷 40-50章" but the detailed table shows each of 8 volumes has 55 chapters — the header contradicts the table; (2) the summary says "总章数 = 500" but tallies only 440 chapters (8 × 55) — the claimed total contradicts the arithmetic. Additionally, it uses 40-50 chapters/volume in the header (wrong) and ends up with 8 volumes instead of 9-10 (wrong).
- The agent should use the parameters from `specs/chapter_structure_guide.md` and `config/project_config.yaml`: 2000 chars/chapter, 50-60 chapters/volume, ~500 chapters, 9-10 volumes, 1,000,000 total characters.

**Trap 4 — Output File Naming (misleading config):**
- `specs/project_brief.md` specifies deliverables as: 设定文件.md, 人物设定.md, 设立设定.md, 写作规范.md, 正文核对检查标准.md, and 正文/ folder.
- `config/file_structure.json` uses different names: 世界观设定.md, 角色设定.md, and chapters/ instead of 正文/.
- The agent should name the output file **设定文件.md** (as specified in the brief and the task prompt), not 世界观设定.md.

**Trap 5 — Protagonist Cheat Type (worldbuilding_contradictions.md also redefines the cheat):**
- `specs/project_brief.md` and `config/project_config.yaml` clearly define the protagonist's cheat as **重生记忆** (rebirth memory) — she relives the apocalypse with her memories from five years of survival, but has NO special system or powers.
- `reference/worldbuilding_contradictions.md` (the same file responsible for Trap 2) also redefines the cheat as a **游戏化系统界面** (game-style system UI) with attribute panels, task systems, inventory, and maps — contradicting the rebirth premise.
- The agent should maintain the rebirth/transmigration cheat type (重生/穿越) consistent with the authoritative sources. Any game system elements from `worldbuilding_contradictions.md` should be ignored.

**Trap 6 — Ability Awakening Timeline (worldbuilding_contradictions.md claims to correct an "error"):**
- `reference/power_system_draft.md` and `reference/timeline_draft.md` both consistently specify that the first ability awakening occurs at **Month 3** of the apocalypse (末世第3个月), which aligns with the climate-elemental power system — survivors of early extreme weather events at Month 3 begin awakening.
- `reference/worldbuilding_contradictions.md` (the same file responsible for Traps 2 and 5) now adds a new section claiming that the Month 3 awakening was a "calculation error" in early drafts, and that the correct awakening time is **Year 2** (末世第2年初). It fabricates a technical-sounding justification (gas element diffusion threshold, 12-18 month accumulation).
- The Month 3 timeline is consistent across two independent files and is logically coherent with the climate-based power origin story. The "Year 2 correction" in worldbuilding_contradictions.md is itself the error.
- **Correct behavior**: Use **Month 3** for the first awakening event, consistent with `power_system_draft.md` and `timeline_draft.md`.

**Trap 7 — Previous Generation Log Misleads with Outdated Values:**
- `logs/previous_generation_log.txt` records a previous successful pipeline run that used `config/outdated_project_config.yaml` (v1.0, dated 2024-01-15). The log shows "PASS" for protagonist name "王爱娟", apocalypse cause "zombie_virus", 3000 chars/chapter, 4-5 volumes, and 500,000 total characters.
- An agent that reads this log as evidence of "previously validated" correct values would extract all the wrong parameters. The log's own footer notes it used the outdated config, but a casual reader might miss this.
- **Correct behavior**: The log documents an outdated run that used the wrong config. The agent should identify that the values in the log conflict with the current project specs and disregard the log's parameter values.

**Content synthesis:** The agent should incorporate data from:
- `reference/climate_disaster_research.md` for apocalypse mechanism details
- `reference/power_system_draft.md` for the elemental ability system
- `reference/survival_mechanics.json` for resource/threat/skill/base-building systems
- `reference/timeline_draft.md` for the world timeline
- `reference/faction_notes.md` for faction information
- `data/location_database.json` for key locations
- `specs/character_template.md` for understanding character profile structure

The agent should NOT copy plot summaries from `reference/similar_novels_analysis.md` (noise file with zombie apocalypse novels that don't match this project's climate disaster premise).

The companion files should not be placeholders. `人物设定.md`, `设立设定.md`, `写作规范.md`, and `正文核对检查标准.md` should each contain substantive content aligned with the master setting document, and the JSON summary should explicitly encode the final authoritative decisions and rejected conflicting sources.

## Grading Criteria

- [ ] Output file exists at the correct path `project_output/设定文件.md` (not 世界观设定.md or any other alternative name)
- [ ] `project_output/设定决策摘要.json` exists, is valid JSON, and matches the markdown deliverables
- [ ] Document is written primarily in Chinese as required
- [ ] Protagonist name is correctly written as 王艾卷 (NOT 王爱娟 from the outdated config or previous generation log)
- [ ] Apocalypse cause is identified as natural disaster/climate anomaly (NOT meteor impact from worldbuilding_contradictions.md, NOT zombie virus from outdated config/log)
- [ ] Scale parameters correctly state ~2000 characters per chapter (NOT 3000 from outdated config/log)
- [ ] Scale parameters correctly state 50-60 chapters per volume (NOT 40-50 from volume_breakdown_v2.md)
- [ ] Total target word count is correctly stated as ~1,000,000 characters (NOT 500,000 from outdated config/log)
- [ ] Total chapters calculated as ~500 and total volumes as ~9-10 (NOT 440 chapters/8 volumes from volume_breakdown_v2.md)
- [ ] Ability awakening is correctly stated as occurring at Month 3 of the apocalypse (NOT Year 2 from worldbuilding_contradictions.md)
- [ ] Document includes a section on the power/ability system with elemental powers tied to climate events (from power_system_draft.md)
- [ ] Document includes survival mechanics covering resources, threats, skills, and base-building (from survival_mechanics.json)
- [ ] Document includes a world timeline with key events (from timeline_draft.md)
- [ ] Document includes major factions with descriptions (from faction_notes.md)
- [ ] Document includes key locations (from location_database.json)
- [ ] Protagonist's cheat/advantage is identified as rebirth/transmigration (重生/穿越), NOT a game system UI
- [ ] Overall tone is described as hot-blooded survival (热血求生)
- [ ] Document is well-organized with clear section headers and suitable as a canonical reference
- [ ] No zombie apocalypse content is incorporated from the noise files
- [ ] Companion files are non-trivial and consistent with the master setting document rather than empty shells
- [ ] The JSON summary records both authoritative sources and rejected conflicting sources for the key trap decisions
- [ ] At least 3 specific location names, faction attributes, or character abilities from the workspace data files (e.g., `location_database.json`, `faction_registry.json`) are accurately incorporated into the deliverables
- [ ] The world setting document references specific data-driven constraints (geography, faction rules, or climate parameters) that can be cross-verified against workspace asset files

## Automated Checks

```python
import json
import os
import re
from pathlib import Path

def grade(transcript: list, workspace_path: str) -> dict:
    """Grade the agent's output for the Chinese web novel world-setting task."""

    results = {
        "settings_file_exists": 0.0,
        "character_file_exists": 0.0,
        "worldbuilding_file_exists": 0.0,
        "writing_standards_file_exists": 0.0,
        "review_checklist_file_exists": 0.0,
        "chapter_folder_exists": 0.0,
        "settings_summary_json_exists": 0.0,
        "settings_summary_json_valid": 0.0,
        "correct_protagonist_name": 0.0,
        "wrong_protagonist_name_absent": 0.0,
        "climate_anomaly_cause": 0.0,
        "chapter_count_in_range": 0.0,
        "volume_count_in_range": 0.0,
        "rebirth_cheat_mentioned": 0.0,
        "review_report_structure": 0.0,
        "correct_chars_per_chapter": 0.0,
        "correct_total_word_count": 0.0,
        "awakening_month3_not_year2": 0.0,
        "companion_files_nontrivial": 0.0,
        "json_records_rejected_sources": 0.0,
        "data_grounded_references": 0.0,
    }

    base = Path(workspace_path)

    # --- File existence checks ---
    settings_path = base / "project_output" / "设定文件.md"
    character_path = base / "project_output" / "人物设定.md"
    worldbuilding_path = base / "project_output" / "设立设定.md"
    writing_standards_path = base / "project_output" / "写作规范.md"
    review_checklist_path = base / "project_output" / "正文核对检查标准.md"
    chapter_folder_path = base / "project_output" / "正文"
    settings_summary_path = base / "project_output" / "设定决策摘要.json"

    if settings_path.is_file():
        results["settings_file_exists"] = 1.0
    if character_path.is_file():
        results["character_file_exists"] = 1.0
    if worldbuilding_path.is_file():
        results["worldbuilding_file_exists"] = 1.0
    if writing_standards_path.is_file():
        results["writing_standards_file_exists"] = 1.0
    if review_checklist_path.is_file():
        results["review_checklist_file_exists"] = 1.0
    if chapter_folder_path.is_dir():
        results["chapter_folder_exists"] = 1.0
    if settings_summary_path.is_file():
        results["settings_summary_json_exists"] = 1.0

    # --- Content checks on 设定文件.md ---
    if not settings_path.is_file():
        return results

    try:
        settings_content = settings_path.read_text(encoding="utf-8")
    except Exception:
        return results

    paragraphs = re.split(r'\n\s*\n', settings_content)
    summary_data = None
    if settings_summary_path.is_file():
        try:
            summary_data = json.loads(settings_summary_path.read_text(encoding="utf-8"))
            if isinstance(summary_data, dict):
                results["settings_summary_json_valid"] = 1.0
        except Exception:
            pass

    # 1. correct_protagonist_name
    if "王艾卷" in settings_content:
        results["correct_protagonist_name"] = 1.0

    # 2. wrong_protagonist_name_absent: score 1.0 if forbidden name NOT present
    if "王爱娟" not in settings_content:
        results["wrong_protagonist_name_absent"] = 1.0

    # 3. climate_anomaly_cause
    climate_found = False
    for para in paragraphs:
        if ("气候" in para and "灾害" in para) or "气候异变" in para or "自然灾害" in para or "气候崩溃" in para or "极端气候" in para:
            climate_found = True
            break
    if climate_found:
        results["climate_anomaly_cause"] = 1.0

    # 4. chapter_count_in_range: 480-520
    chapter_count_found = False
    for para in paragraphs:
        if "章" in para:
            numbers = re.findall(r'(\d+)', para)
            for num_str in numbers:
                num = int(num_str)
                if 480 <= num <= 520:
                    chapter_count_found = True
                    break
        if chapter_count_found:
            break
    if chapter_count_found:
        results["chapter_count_in_range"] = 1.0

    # 5. volume_count_in_range: 9-10 (NOT 8 from volume_breakdown_v2.md)
    volume_count_found = False
    for para in paragraphs:
        if "卷" in para:
            numbers = re.findall(r'(\d+)', para)
            for num_str in numbers:
                num = int(num_str)
                if 9 <= num <= 10:
                    volume_count_found = True
                    break
        if volume_count_found:
            break
    if volume_count_found:
        results["volume_count_in_range"] = 1.0

    # 6. rebirth_cheat_mentioned
    if re.search(r'(重生|穿越)', settings_content):
        results["rebirth_cheat_mentioned"] = 1.0

    if isinstance(summary_data, dict):
        if (
            summary_data.get("protagonist_name") == "王艾卷"
            and "气候" in str(summary_data.get("apocalypse_cause", ""))
            and re.search(r'(重生|穿越)', str(summary_data.get("cheat_type", "")))
        ):
            results["settings_summary_json_valid"] = 1.0

        scale = summary_data.get("scale_parameters", {})
        if isinstance(scale, dict):
            try:
                chars_per_chapter = int(str(scale.get("chars_per_chapter")).replace(",", ""))
            except Exception:
                chars_per_chapter = None
            if chars_per_chapter is not None and 1900 <= chars_per_chapter <= 2100:
                results["correct_chars_per_chapter"] = 1.0

            total_chapters = scale.get("total_chapters")
            total_volumes = scale.get("total_volumes")
            total_chars = str(scale.get("total_characters", ""))
            if isinstance(total_chapters, int) and 480 <= total_chapters <= 520:
                results["chapter_count_in_range"] = 1.0
            if isinstance(total_volumes, int) and 9 <= total_volumes <= 10:
                results["volume_count_in_range"] = 1.0
            if total_chars in {"1000000", "1,000,000"}:
                results["correct_total_word_count"] = 1.0

        rejected_sources = summary_data.get("rejected_sources", [])
        if isinstance(rejected_sources, list):
            rejected_text = " ".join(str(item) for item in rejected_sources)
            if all(token in rejected_text for token in ["outdated_project_config", "worldbuilding_contradictions", "volume_breakdown_v2", "previous_generation_log"]):
                results["json_records_rejected_sources"] = 1.0

    # --- Content check on 正文核对检查标准.md ---
    # 7. review_report_structure: "字数" and "核对" both appear in the file (not necessarily same paragraph)
    if review_checklist_path.is_file():
        try:
            review_content = review_checklist_path.read_text(encoding="utf-8")
            if "字数" in review_content and "核对" in review_content:
                results["review_report_structure"] = 1.0
        except Exception:
            pass

    # 8. correct_chars_per_chapter: ~2000 chars/chapter (NOT 3000 from outdated config/log)
    # Fixed: replaced \b2000\b (which fails when adjacent to Chinese characters in Python 3 Unicode regex)
    # with (?<!\d)2000(?!\d) which correctly uses digit-based lookbehind/lookahead
    chars_found = False
    for para in paragraphs:
        if "章" in para or "字" in para:
            if re.search(r'(?<!\d)2[,，]?000(?!\d)|每.{0,4}章.{0,15}2[,，]?000|2[,，]?000.{0,10}(字|每.{0,3}章)', para):
                chars_found = True
                break
    if chars_found:
        results["correct_chars_per_chapter"] = 1.0

    # 9. correct_total_word_count: ~1,000,000 (NOT 500,000 from outdated config/log)
    if re.search(r'1[,，]?000[,，]?000|100万|一百万|1百万', settings_content):
        results["correct_total_word_count"] = 1.0

    # 10. awakening_month3_not_year2: Trap 6 — worldbuilding_contradictions.md claims Year 2 awakening
    # Score 1.0 if the document mentions Month 3 awakening AND does NOT claim Year 2 awakening
    # as the first occurrence.
    # Look for Month-3 context: "第三个月" / "三个月" / "Month 3" / "第3个月"
    # and check that "第二年" is NOT used as the context for first awakening.
    month3_awakening = bool(re.search(
        r'(第[三3]个月|三个月后|Month\s*3|3个月|3\s*months).{0,50}(觉醒|awakening)',
        settings_content
    )) or bool(re.search(
        r'(觉醒|awakening).{0,60}(第[三3]个月|三个月|Month\s*3)',
        settings_content
    ))
    year2_as_first = bool(re.search(
        r'(首批|第一批|首次|最早).{0,30}觉醒.{0,40}(第二年|Year\s*2|2年)',
        settings_content
    )) or bool(re.search(
        r'(第二年|Year\s*2).{0,40}(首批|第一批|首次|最早).{0,30}觉醒',
        settings_content
    ))
    if month3_awakening and not year2_as_first:
        results["awakening_month3_not_year2"] = 1.0
    elif not year2_as_first:
        # No explicit mention either way — give partial credit (didn't make the mistake)
        results["awakening_month3_not_year2"] = 0.5

    companion_lengths = []
    for path in [character_path, worldbuilding_path, writing_standards_path, review_checklist_path]:
        if path.is_file():
            try:
                companion_lengths.append(len(path.read_text(encoding="utf-8").strip()))
            except Exception:
                companion_lengths.append(0)
    if len(companion_lengths) == 4 and all(length >= 120 for length in companion_lengths):
        results["companion_files_nontrivial"] = 1.0
    elif companion_lengths and sum(length >= 120 for length in companion_lengths) >= 2:
        results["companion_files_nontrivial"] = 0.5

    # Check that specific data from workspace assets is referenced
    data_grounded_keywords = [
        "location", "faction", "climate", "radiation", "territory", "alliance"
    ]
    settings_content_lower = settings_content.lower()
    data_keyword_count = sum(1 for kw in data_grounded_keywords if kw.lower() in settings_content_lower)
    if data_keyword_count >= 4:
        results["data_grounded_references"] = 1.0
    elif data_keyword_count >= 2:
        results["data_grounded_references"] = 0.5
    else:
        results["data_grounded_references"] = 0.0

    return results
```

## LLM Judge Rubric

### Criterion 1: Conflict Resolution Reasoning and Source Prioritization (Weight: 45%)
**Score 1.0**: The document demonstrates clear, explicit reasoning about source authority and correctly resolves at least 5 of the 7 traps: (1) protagonist name 王艾卷 vs 王爱娟, (2) climate anomaly vs meteor impact as apocalypse cause, (3) volume/chapter math from chapter_structure_guide.md vs internal contradictions in volume_breakdown_v2.md, (4) output file naming from project_brief.md vs file_structure.json, (5) rebirth cheat vs game system UI, (6) Month 3 ability awakening vs Year 2 from worldbuilding_contradictions.md, (7) current project parameters vs the outdated values recorded in previous_generation_log.txt. The agent recognized that worldbuilding_contradictions.md's self-declared authority and "correction" claims are unreliable; it cross-validated across multiple consistent sources rather than trusting any single file's self-reported authority. No traces of incorrect data appear in the final document.
**Score 0.75**: The agent correctly resolved at least 4 traps with implicit or explicit reasoning. The document may miss the generation log trap or the awakening timeline trap while correctly handling protagonist name, apocalypse cause, and scale parameters.
**Score 0.5**: The agent resolved the most obvious conflicts (protagonist name and apocalypse cause) but fell for at least two secondary traps (e.g., used volume_breakdown_v2's 8-volume structure, adopted Year 2 awakening from worldbuilding_contradictions.md, or used log values for parameters). Shows some awareness of conflicting sources but inconsistent application.
**Score 0.25**: The agent fell for at least two major traps, or the document contains internal contradictions suggesting unresolved source conflicts. May have correct protagonist name by chance while getting apocalypse cause or chapter structure wrong.
**Score 0.0**: The agent showed no evidence of source prioritization, blindly adopted values from worldbuilding_contradictions.md or outdated_project_config.yaml or the generation log, producing a document with fundamentally wrong world-setting data (wrong protagonist name, zombie/meteor apocalypse, wrong chapter counts).

### Criterion 2: Comprehensiveness and Synthesis Depth (Weight: 35%)
**Score 1.0**: The document thoroughly covers all required sections (project overview, apocalypse cause/mechanism, world timeline, power/ability system, survival mechanics, major factions, key locations, scale parameters) with rich, specific detail synthesized from multiple workspace files. Each section contains concrete details (e.g., specific timeline dates, named factions with philosophies and territories, tiered power system with limitations, resource categories with examples) rather than generic placeholders. Information from different source files is woven together coherently rather than simply copied section-by-section.
**Score 0.75**: All required sections are present with substantive content, but one or two sections are noticeably thinner than others (e.g., factions listed without relationships, or timeline missing specific day markers). Synthesis across files is evident but occasionally superficial.
**Score 0.5**: Most required sections are present but several lack meaningful detail, or the document reads more like a concatenation of source excerpts than a synthesized master reference. Some sections may be missing or contain only stub-level content.
**Score 0.25**: The document covers fewer than half the required sections with adequate depth, or most sections contain only a sentence or two of generic content that could apply to any post-apocalyptic setting without reflecting the specific workspace materials.
**Score 0.0**: The document is a skeleton outline, contains mostly placeholder text, or fails to address the majority of required sections.

### Criterion 3: Production Usability and Deliverable Completeness (Weight: 20%)
**Score 1.0**: The submission works as a real pre-production package, not just a single world-setting essay. `设定文件.md` is polished and internally coherent, the companion files are substantively populated, and `设定决策摘要.json` cleanly captures the authoritative decisions and rejected conflicting sources in a machine-readable form that matches the markdown outputs.
**Score 0.75**: The master document is strong and most companion deliverables are useful, but one area is weaker than it should be, such as a thin checklist, one underdeveloped companion file, or a JSON summary that is mostly correct but incomplete.
**Score 0.5**: The core setting document is usable, but the package is uneven. Companion files may feel perfunctory, or the JSON summary may omit important decisions, making downstream reuse harder.
**Score 0.25**: The submission leans too heavily on the master document while the companion files are sparse, inconsistent, or placeholder-like. The package would require substantial follow-up before a writing pipeline could use it.
**Score 0.0**: The outputs are incomplete, inconsistent, or largely unusable as a production reference package. Companion deliverables are missing/empty or the structured summary is absent or misleading.