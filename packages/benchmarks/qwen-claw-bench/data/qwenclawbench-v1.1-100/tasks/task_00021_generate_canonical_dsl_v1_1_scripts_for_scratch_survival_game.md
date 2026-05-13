---
id: task_00021_generate_canonical_dsl_v1_1_scripts_for_scratch_survival_game
name: Generate Canonical DSL v1.1 Scripts for Scratch Survival Game
category: Workflow and Agent Orchestration
grading_type: hybrid
verification_method: rubric
input_modality: text-only
external_dependency: none
timeout_seconds: 1800
grading_weights:
  automated: 0.25
  llm_judge: 0.75
workspace_files:
- source: docs/canonical_dsl_v1.1_spec.md
  dest: docs/canonical_dsl_v1.1_spec.md
- source: docs/canonical_dsl_v1.0_spec.md
  dest: docs/canonical_dsl_v1.0_spec.md
- source: config/project_metadata.json
  dest: config/project_metadata.json
- source: config/game_balance.yaml
  dest: config/game_balance.yaml
- source: examples/sample_dsl_output.json
  dest: examples/sample_dsl_output.json
- source: examples/enemy_behavior_reference.json
  dest: examples/enemy_behavior_reference.json
- source: logs/previous_generation_attempt.log
  dest: logs/previous_generation_attempt.log
- source: docs/scratch_opcode_reference.md
  dest: docs/scratch_opcode_reference.md
- source: config/sprite_costumes.yaml
  dest: config/sprite_costumes.yaml
- source: docs/difficulty_scaling_notes.md
  dest: docs/difficulty_scaling_notes.md
- source: config/game_balance_playtest.json
  dest: config/game_balance_playtest.json
subcategory: Script and Terminal Automation
---
## Prompt

We tried to auto-generate the Canonical DSL scripts for our Scratch project "极限生存挑战" (Extreme Survival Challenge) but the last attempt blew up — there's an error log in the workspace if you want to see what went wrong. I need you to take over and produce a complete, valid Canonical DSL JSON file that covers the entire game.

Quick rundown of the game: three sprites — Player, Enemy, Apple. On green flag the Stage initializes all game variables and manages a countdown timer. The Player tracks the mouse position while the game is active. Enemies spawn as clones from the top of the screen at a dynamic rate that speeds up with the player's score — check the difficulty scaling docs in the workspace for the exact tiers and timing. Apples also spawn as falling clones at a fixed rate. Collisions do what you'd expect: enemies cost lives, apples give points, hitting the edge deletes the clone.

There's a bunch of reference material in the workspace — spec docs, example outputs, config files, balance data, the whole nine yards. Fair warning: some of it is outdated or even contradictory, so you'll need to figure out which sources are actually current before you start generating.

Write the final DSL JSON to `output/scratch_dsl_script.json`, and also put together a short `output/generation_report.md` documenting which config sources you relied on, any conflicts you found between workspace files, and how you resolved them.

I also need a structured validation checklist at `output/validation_checklist.json` — basically a JSON array where each entry represents a specific compliance check you ran against your output. Each entry should have at minimum: the check name, whether it passed or failed, which source file(s) you used as the reference for that check, and a brief evidence string showing the actual vs expected values. Cover at least the structural requirements, variable correctness, and difficulty parameter verification.

Oh, and one more thing — write a quick validation script at `output/validate_dsl.py` that programmatically checks your generated JSON against the spec requirements. At minimum it should verify the top-level structure, hat fields, and opcode formatting. It should also cross-reference the variable names used in the generated DSL against `config/project_metadata.json` to confirm they match the official variable definitions — flag any mismatches as warnings. Print a summary of what passed and what didn't.

## Expected Behavior

The agent must produce a valid Canonical DSL v1.1 JSON file at `output/scratch_dsl_script.json`, a conflict-resolution report at `output/generation_report.md`, a structured validation checklist at `output/validation_checklist.json`, and a validation script at `output/validate_dsl.py`. The correct approach involves:

1. Exploring the workspace files to understand the project structure and DSL specification
2. Identifying the correct DSL spec version (v1.1, not the outdated v1.0) by independently comparing the content and structure of the two spec documents — neither filename contains deprecation markers, and the v1.1 spec does not explicitly list its differences from v1.0 — the agent must read both documents and cross-reference against the example outputs to determine which format is current
3. Using `config/project_metadata.json` as the authoritative source for variable defaults and status strings, resolving conflicts with `config/game_balance.yaml` despite the yaml file carrying a significantly more recent review date and explicitly claiming to override project metadata
4. Using `docs/difficulty_scaling_notes.md` as the sole authoritative source for difficulty tier parameters (spawn intervals and score thresholds), since `config/project_metadata.json` does not contain difficulty tier data — the agent must independently determine that `config/game_balance_playtest.json` contains different (incorrect) spawn intervals and thresholds by cross-comparing values across files
5. Generating DSL scripts covering all sprite behaviors (Stage initialization with pre-game countdown and timer, Player movement, Enemy spawning and clone behavior, Apple spawning and clone behavior), including game-over state transition when the timer reaches zero
6. Outputting the DSL result to `output/scratch_dsl_script.json`
7. Writing `output/generation_report.md` documenting which sources were used, conflicts found between files, and the rationale for each resolution decision
8. Writing `output/validation_checklist.json` — a structured JSON array where each entry documents a compliance check (check name, pass/fail result, source file reference, and evidence showing actual vs expected values), covering structural requirements, variable correctness, and difficulty parameter verification
9. Writing `output/validate_dsl.py` — a validation script that programmatically checks the generated JSON against v1.1 structural requirements (top-level format, hatId presence, opcode casing), cross-references variable names against `config/project_metadata.json` to verify they match the official definitions, and prints a pass/fail summary

The correct solution requires navigating several conflicting information sources:

**Trap 1 — DSL Schema Version (v1.0 vs v1.1):**
The workspace contains two spec documents with similar names: `docs/canonical_dsl_v1.0_spec.md` and `docs/canonical_dsl_v1.1_spec.md`. Neither filename explicitly flags one as deprecated, and the v1.1 spec does not contain a "changes from v1.0" summary — the agent must independently read both documents in full and compare their structural requirements to determine which is current. The v1.0 spec describes an outdated format with top-level `{"targets":[{"scripts":[...]}]}`, no `hatId` requirement, and camelCase opcodes like `data_setVariable`. The v1.1 spec is the correct one: top-level must be `{"scripts":[...]}`, every script must include a `"hatId"` field (unique string), and opcodes must be all-lowercase (e.g., `data_setvariableto`). The examples in `examples/sample_dsl_output.json` and `examples/enemy_behavior_reference.json` confirm v1.1 structure. The error log (`logs/previous_generation_attempt.log`) shows the previous attempt failed with generic validation errors (structural failure, schema violation, opcode registry mismatch) but does not reveal which spec version was used, which fields are missing, or which opcodes are wrong — the agent must independently cross-reference the spec documents to diagnose and resolve the issues.

**Trap 2 — Game Variable Defaults (project_metadata.json vs game_balance.yaml):**
The agent should use `config/project_metadata.json` (version 2.1, last modified 2024-03-12) as the correct source for variable defaults, rather than `config/game_balance.yaml` which contains misleading values (lives = 5, English status strings). This trap is made harder by the fact that `game_balance.yaml` carries a significantly more recent review date (2024-03-25) than `project_metadata.json` (2024-03-12), has an authoritative header ("approved by game design lead"), explicitly claims to "override any defaults in project metadata and design notes", and presents itself as "FINAL approved values after comprehensive playtest round 3". The agent must look beyond the dates and authority claims: `project_metadata.json` is the structured project configuration file with versioned Chinese variable definitions that match the project's theme, while `game_balance.yaml` is a localized override for an international build. The correct defaults are: 分数=0, 生命=3, 时间=30, 状态="准备", transitioning to "进行中" and eventually "结束".

**Trap 3 — Difficulty Scaling (difficulty_scaling_notes.md vs game_balance_playtest.json):**
The agent should use the current difficulty values from `docs/difficulty_scaling_notes.md`, not the candidate values in `config/game_balance_playtest.json` (which has different base spawn interval 1.0s and different thresholds at 15 and 25). The playtest file presents itself as a "2.0-rc1" candidate with a "pending_approval" status and a recent date (2024-03-18), making it look like a legitimate newer configuration rather than an outdated one — the agent must cross-compare the actual numeric values against the design notes to identify the discrepancies. Note that `config/project_metadata.json` does not contain difficulty tier data, so the agent cannot simply rely on a single file for all parameters. The correct three-tier scaling is: base 0.5s, score > 10 → 0.4s, score > 20 AND time > 5 → 0.3s. The difficulty scaling notes do not provide implementation pseudocode — the agent must derive the correct nested condition structure from the parameter table alone.

**Correct output structure (Ground Truth):**
- Top-level: `{"scripts": [...]}`
- Each script has `"hat"` (opcode string), `"hatId"` (unique string), and `"blocks"` (array)
- All opcodes use the v1.1 lowercase format (e.g., `data_setvariableto`, `data_changevariableby`, `control_wait`, `control_forever`, `control_if`, `operator_random`, `operator_gt`, `operator_equals`, `motion_gotoxy`, `motion_setx`, `sensing_touchingobject`, `looks_show`, `looks_hide`, `control_create_clone_of`, `control_start_as_clone`, `control_delete_this_clone`, `event_whenflagclicked`)
- Variable fields use Chinese names: "分数", "生命", "时间", "状态"
- Status values use Chinese strings: "准备", "进行中", "结束"
- 生命 defaults to 3 (not 5)
- Enemy spawn intervals follow the correct difficulty tiers: 0.5s (base), 0.4s (score > 10), 0.3s (score > 20 AND time > 5)
- At least 6 scripts total: Stage init/timer, Player movement, Enemy spawn loop, Enemy clone behavior, Apple spawn loop, Apple clone behavior (some may be combined)

**Common Pitfalls — Expected Correct Handling:**
- The agent should correctly identify `canonical_dsl_v1.0_spec.md` as outdated by independently reading and comparing both spec documents' content — neither filename contains deprecation markers, and the v1.1 spec does not explicitly list changes from v1.0 — then use `canonical_dsl_v1.1_spec.md` exclusively
- The agent should resolve the conflicting variable defaults by preferring `project_metadata.json` over `game_balance.yaml` despite the yaml's significantly more recent review date (2024-03-25 vs 2024-03-12) and explicit override claims, using structural consistency and project-language alignment as the deciding factors
- The agent should use Chinese variable names and status strings consistently, matching the project's Chinese theme
- The agent should implement all three difficulty tiers with the correct spawn intervals (0.5s, 0.4s, 0.3s) and thresholds (0, 10, 20)
- The agent should include the time > 5 condition for tier 3 to prevent end-game overwhelm, as explained in the difficulty scaling notes
- The agent should produce valid JSON with UTF-8 encoding to support Chinese characters

**Human Reference Baseline (for LLM Judge anchoring):**
A competent human developer's solution for this task has the following characteristics — LLM Judge scores of 0.5 correspond roughly to this level, while 1.0 requires demonstrably exceeding it:
- **Script structure:** 6–8 cleanly separated scripts — one Stage init, one timer/game-over, one Player movement, one Enemy spawn loop, one Enemy clone behavior, one Apple spawn loop, one Apple clone behavior. Difficulty tier conditions use a clean nested if-else chain (not redundant parallel if-blocks).
- **Report quality:** Identifies all three conflict areas with a side-by-side comparison table of conflicting values (file name, version, date, specific values). Explains rationale for each resolution decision.
- **DSL efficiency:** No redundant blocks. Spawn logic cleanly separated from clone behavior. Consistent block patterns across similar clone scripts (show→position→move-loop→check-collision→delete).
- **Validation rigor:** Validation script cross-references variable names against `project_metadata.json` programmatically. Checklist has 5+ entries with quantitative evidence (actual vs expected values with source file citations).
- **Cross-artifact consistency:** The four output files are individually correct but not explicitly cross-referenced — the report mentions conflicts that don't have corresponding checklist entries, and the validation script checks different things than what the checklist documents.
- **Defensive design:** Spawn loops check game state before spawning but clone scripts do not self-terminate when the game ends. Player movement is not gated by game state.

**Multi-level completion expectations:**
- **Basic completion:** Valid JSON output with `{"scripts":[...]}` v1.1 structure, hatId on all scripts, and at least some correct game logic. Even at this level, the agent must recognize v1.1 is the correct spec.
- **High-quality completion:** All three traps correctly resolved, complete coverage of all sprite behaviors with correct game flow (init with 2-second countdown → playing → end when timer reaches zero), three-tier difficulty scaling with correct parameters, a generation report that explicitly documents the conflicts found with quantitative evidence (specific version numbers, dates, and value discrepancies), a structured validation checklist (`output/validation_checklist.json`) with per-check pass/fail results and source file references, and a validation script that not only checks v1.1 structural compliance but also cross-references variable names against project metadata to verify correctness.
- **Exceptional completion (exceeds human reference):** In addition to high-quality completion, the DSL scripts demonstrate expert-level efficiency (nested if-else for difficulty tiers, no duplicated blocks, consistent patterns). The report provides a systematic conflict matrix with version lineage analysis and explains why seemingly authoritative sources were rejected (e.g., `game_balance.yaml`'s localization context despite its override claims). The validation approach covers all three conflict areas with programmatic cross-referencing. All four output artifacts form a coherent cross-referenced package (report findings traceable to checklist entries, validation script checks align with checklist claims). DSL scripts include defensive game-state checks (spawn loops gated by 状态=="进行中", clone self-deletion on game-over, timer guard against going below 0).

## Grading Criteria

- [ ] Output file `output/scratch_dsl_script.json` exists and contains valid JSON (`output_file_valid_json`)
- [ ] Top-level structure follows v1.1 format `{"scripts": [...]}` with no v1.0 `targets` wrapper (`v11_structure_correct`)
- [ ] Every script object contains a `hatId` field with a unique non-empty string value (`hatid_present_unique`)
- [ ] All opcodes throughout the JSON use v1.1 lowercase format — no camelCase opcodes like `data_setVariable` (`opcode_casing_correct`)
- [ ] Variable fields reference correct Chinese names from project metadata: "分数", "生命", "时间", "状态" (`chinese_variable_names`)
- [ ] Variable "生命" initialized to 3 based on `project_metadata.json` — not 5 from `game_balance.yaml` (`lives_default_correct`)
- [ ] Status variable "状态" uses Chinese strings "准备", "进行中", and "结束" — not English equivalents from `game_balance.yaml` (`status_strings_chinese`)
- [ ] Enemy spawn implements three-tier difficulty scaling with correct intervals (0.5s, 0.4s, 0.3s) at correct score thresholds (0, 10, 20) including tier 3 time>5 condition, verified from parsed condition and wait blocks (`difficulty_tiers_correct`)
- [ ] Enemy clone script includes positioning at top, downward falling motion, edge deletion, Player collision with life deduction (`enemy_clone_complete`)
- [ ] Apple clone script includes Player collision that increments "分数" via `data_changevariableby`, with clone deletion (`apple_score_logic`)
- [ ] Timer countdown logic decrements "时间" using `data_changevariableby` with a negative value (`timer_countdown`)
- [ ] Scripts provide complete coverage: multiple `event_whenflagclicked` scripts for different sprites and at least two `control_start_as_clone` scripts (`sprite_coverage`)
- [ ] Report file `output/generation_report.md` documents at least two specific conflicts found between workspace files and explains resolution rationale (`report_documents_conflicts`)
- [ ] Stage initialization script includes game-over transition: when "时间" reaches 0, "状态" is set to "结束" with a conditional check (`game_end_transition`)
- [ ] Stage initialization script contains correct pre-game sequence: "状态" set to "准备", a 2-second `control_wait`, then "状态" set to "进行中" (`init_wait_sequence`)
- [ ] Validation script `output/validate_dsl.py` exists and contains meaningful v1.1 compliance checks (JSON parsing, structure verification, opcode validation) (`validation_script_functional`)
- [ ] Validation script cross-references variable names in the generated DSL against `config/project_metadata.json` definitions, loading the metadata file and comparing variable names programmatically (`validate_cross_references`)
- [ ] Report file `output/generation_report.md` contains quantitative evidence: specific version numbers (e.g., 2.1, 1.0), file modification dates, and explicit value comparisons between conflicting sources (`report_quantitative_evidence`)
- [ ] Validation checklist `output/validation_checklist.json` exists as a valid JSON array with at least 5 check entries, each containing check_name, result (pass/fail), source_file, and evidence fields documenting specific compliance verifications (`validation_checklist_complete`)

**Content gate:** Format/structural keys (`output_file_valid_json`, `v11_structure_correct`, `hatid_present_unique`, `opcode_casing_correct`, `validation_script_functional`, `validation_checklist_complete`) receive aggressive discounting, and documentary keys (`report_documents_conflicts`, `report_quantitative_evidence`, `validate_cross_references`) receive moderate discounting, when core game-logic keys (including variable names, difficulty tiers, sprite behaviors, game flow, and timer logic) average below 0.70. A secondary hard gate applies when the hardest game-logic keys (difficulty tiers, enemy clone, apple score, game-end transition) average below 0.30 — format keys receive an additional 0.5× multiplier and documentary keys receive an additional 0.7× multiplier, compounding with the primary gate. Producing a correctly formatted but content-weak JSON should not earn significant automated credit.

## Automated Checks

```python
import json
import os
import re
from pathlib import Path


def grade(transcript: list, workspace_path: str) -> dict:
    result = {
        "output_file_valid_json": 0.0,
        "v11_structure_correct": 0.0,
        "hatid_present_unique": 0.0,
        "opcode_casing_correct": 0.0,
        "chinese_variable_names": 0.0,
        "lives_default_correct": 0.0,
        "status_strings_chinese": 0.0,
        "difficulty_tiers_correct": 0.0,
        "enemy_clone_complete": 0.0,
        "apple_score_logic": 0.0,
        "timer_countdown": 0.0,
        "sprite_coverage": 0.0,
        "report_documents_conflicts": 0.0,
        "game_end_transition": 0.0,
        "init_wait_sequence": 0.0,
        "validation_script_functional": 0.0,
        "validate_cross_references": 0.0,
        "report_quantitative_evidence": 0.0,
        "validation_checklist_complete": 0.0,
    }

    output_file = Path(workspace_path) / "output" / "scratch_dsl_script.json"
    report_file = Path(workspace_path) / "output" / "generation_report.md"

    if not output_file.is_file():
        return result

    try:
        content = output_file.read_text(encoding="utf-8")
    except Exception:
        return result

    if not content.strip():
        return result

    data = None
    try:
        data = json.loads(content)
        result["output_file_valid_json"] = 1.0
    except (json.JSONDecodeError, ValueError):
        return result

    if not isinstance(data, dict):
        return result

    has_scripts = "scripts" in data and isinstance(data.get("scripts"), list)
    no_targets = "targets" not in data
    if has_scripts and no_targets:
        result["v11_structure_correct"] = 1.0
    elif has_scripts:
        result["v11_structure_correct"] = 0.5

    scripts = data.get("scripts", [])
    if not isinstance(scripts, list):
        scripts = []

    def collect_all_blocks(node):
        blocks = []
        if isinstance(node, dict):
            if "opcode" in node:
                blocks.append(node)
            for val in node.values():
                blocks.extend(collect_all_blocks(val))
        elif isinstance(node, list):
            for item in node:
                blocks.extend(collect_all_blocks(item))
        return blocks

    def collect_wait_durations(node):
        durations = []
        for block in collect_all_blocks(node):
            if block.get("opcode") == "control_wait":
                dur = block.get("inputs", {}).get("DURATION")
                if isinstance(dur, (int, float)):
                    durations.append(float(dur))
                elif isinstance(dur, str):
                    try:
                        durations.append(float(dur))
                    except ValueError:
                        pass
        return durations

    def collect_var_ops(node):
        ops = []
        for block in collect_all_blocks(node):
            opc = block.get("opcode", "")
            if opc in ("data_setvariableto", "data_changevariableby"):
                var_name = block.get("fields", {}).get("VARIABLE", "")
                val = block.get("inputs", {}).get("VALUE")
                ops.append((opc, var_name, val))
        return ops

    def collect_condition_operands(node):
        operands = []
        for block in collect_all_blocks(node):
            opc = block.get("opcode", "")
            if opc in ("operator_gt", "operator_lt", "operator_equals"):
                for key in ("OPERAND1", "OPERAND2"):
                    val = block.get("inputs", {}).get(key)
                    if isinstance(val, (int, float)):
                        operands.append(val)
                    elif isinstance(val, str):
                        try:
                            operands.append(float(val))
                        except ValueError:
                            pass
        return operands

    all_var_ops = []
    all_opcodes = []
    for script in scripts:
        if not isinstance(script, dict):
            continue
        blocks = script.get("blocks", [])
        for b in collect_all_blocks(blocks):
            all_opcodes.append(b.get("opcode", ""))
        all_var_ops.extend(collect_var_ops(blocks))

    hat_ids = []
    scripts_with_hatid = 0
    total_scripts = 0
    for script in scripts:
        if not isinstance(script, dict):
            continue
        total_scripts += 1
        hid = script.get("hatId")
        if isinstance(hid, str) and hid.strip():
            hat_ids.append(hid.strip())
            scripts_with_hatid += 1

    if total_scripts > 0:
        coverage = scripts_with_hatid / total_scripts
        uniqueness = (
            len(set(hat_ids)) / max(len(hat_ids), 1) if hat_ids else 0
        )
        if coverage == 1.0 and uniqueness == 1.0:
            result["hatid_present_unique"] = 1.0
        else:
            result["hatid_present_unique"] = round(
                coverage * 0.5 + uniqueness * 0.5, 2
            )

    camel_re = re.compile(r"[a-z][A-Z]")
    if all_opcodes:
        camel_count = sum(1 for op in all_opcodes if camel_re.search(op))
        if camel_count == 0:
            result["opcode_casing_correct"] = 1.0
        else:
            result["opcode_casing_correct"] = round(
                max(0.0, 1.0 - camel_count / len(all_opcodes)), 2
            )

    required_cn = {"\u5206\u6570", "\u751f\u547d", "\u65f6\u95f4", "\u72b6\u6001"}
    found_cn = set()
    for _, var_name, _ in all_var_ops:
        if var_name in required_cn:
            found_cn.add(var_name)
    result["chinese_variable_names"] = round(len(found_cn) / len(required_cn), 2)

    lives_set_3 = False
    lives_set_5 = False
    for opc, var_name, val in all_var_ops:
        if var_name == "\u751f\u547d" and opc == "data_setvariableto":
            v = None
            if isinstance(val, (int, float)):
                v = val
            elif isinstance(val, str):
                try:
                    v = float(val)
                except ValueError:
                    pass
            if v is not None:
                if abs(v - 3) < 0.01:
                    lives_set_3 = True
                if abs(v - 5) < 0.01:
                    lives_set_5 = True
    if lives_set_3 and not lives_set_5:
        result["lives_default_correct"] = 1.0
    elif lives_set_3:
        result["lives_default_correct"] = 0.5

    has_zhunbei = False
    has_jinxingzhong = False
    has_jieshu = False
    has_english = False
    for opc, var_name, val in all_var_ops:
        if (
            var_name == "\u72b6\u6001"
            and opc == "data_setvariableto"
            and isinstance(val, str)
        ):
            s = val.strip()
            if s == "\u51c6\u5907":
                has_zhunbei = True
            elif s == "\u8fdb\u884c\u4e2d":
                has_jinxingzhong = True
            elif s == "\u7ed3\u675f":
                has_jieshu = True
            elif s.lower() in (
                "ready", "playing", "gameover", "end", "game_over",
            ):
                has_english = True
    ss = 0.0
    if has_zhunbei:
        ss += 0.35
    if has_jinxingzhong:
        ss += 0.35
    if has_jieshu:
        ss += 0.3
    if has_english:
        ss = max(0.0, ss - 0.25)
    result["status_strings_chinese"] = round(ss, 2)

    all_durations = []
    all_operands = []
    for script in scripts:
        if not isinstance(script, dict):
            continue
        blocks = script.get("blocks", [])
        all_durations.extend(collect_wait_durations(blocks))
        all_operands.extend(collect_condition_operands(blocks))

    dur_set = {round(d, 2) for d in all_durations}
    op_set = {round(o, 1) for o in all_operands}
    ts = 0.0
    if 0.5 in dur_set:
        ts += 0.17
    if 0.4 in dur_set:
        ts += 0.17
    if 0.3 in dur_set:
        ts += 0.17
    if 10.0 in op_set:
        ts += 0.17
    if 20.0 in op_set:
        ts += 0.17
    if 5.0 in op_set:
        ts += 0.15
    result["difficulty_tiers_correct"] = round(min(1.0, ts), 2)

    best_enemy = 0.0
    for script in scripts:
        if not isinstance(script, dict):
            continue
        if script.get("hat") != "control_start_as_clone":
            continue
        blocks = script.get("blocks", [])
        ops_in = [b.get("opcode", "") for b in collect_all_blocks(blocks)]
        var_ops_in = collect_var_ops(blocks)
        has_life = any(
            vn == "\u751f\u547d" and o == "data_changevariableby"
            for o, vn, _ in var_ops_in
        )
        if not has_life:
            continue
        sc = 0.25
        if "motion_gotoxy" in ops_in or "motion_setx" in ops_in:
            sc += 0.25
        if "motion_changeyby" in ops_in:
            sc += 0.25
        if (
            "sensing_touchingobject" in ops_in
            and "control_delete_this_clone" in ops_in
        ):
            sc += 0.25
        best_enemy = max(best_enemy, sc)
    if best_enemy == 0.0:
        for script in scripts:
            if not isinstance(script, dict):
                continue
            if script.get("hat") != "control_start_as_clone":
                continue
            ops_in = [
                b.get("opcode", "")
                for b in collect_all_blocks(script.get("blocks", []))
            ]
            sc = 0.0
            if "motion_changeyby" in ops_in:
                sc += 0.15
            if "sensing_touchingobject" in ops_in:
                sc += 0.15
            if "control_delete_this_clone" in ops_in:
                sc += 0.1
            best_enemy = max(best_enemy, sc)
    result["enemy_clone_complete"] = round(min(1.0, best_enemy), 2)

    best_apple = 0.0
    for script in scripts:
        if not isinstance(script, dict):
            continue
        if script.get("hat") != "control_start_as_clone":
            continue
        blocks = script.get("blocks", [])
        var_ops_in = collect_var_ops(blocks)
        ops_in = [b.get("opcode", "") for b in collect_all_blocks(blocks)]
        has_score = any(
            vn == "\u5206\u6570" and o == "data_changevariableby"
            for o, vn, _ in var_ops_in
        )
        if has_score:
            sc = 0.5
            if "control_delete_this_clone" in ops_in:
                sc += 0.25
            if "sensing_touchingobject" in ops_in:
                sc += 0.25
            best_apple = max(best_apple, sc)
    if best_apple == 0.0:
        if any(
            vn == "\u5206\u6570" and o == "data_changevariableby"
            for o, vn, _ in all_var_ops
        ):
            best_apple = 0.25
    result["apple_score_logic"] = round(min(1.0, best_apple), 2)

    for opc, var_name, val in all_var_ops:
        if var_name == "\u65f6\u95f4" and opc == "data_changevariableby":
            v = None
            if isinstance(val, (int, float)):
                v = val
            elif isinstance(val, str):
                try:
                    v = float(val)
                except ValueError:
                    pass
            if v is not None and v < 0:
                result["timer_countdown"] = 1.0
            else:
                result["timer_countdown"] = 0.5
            break

    flag_count = sum(
        1
        for s in scripts
        if isinstance(s, dict) and s.get("hat") == "event_whenflagclicked"
    )
    clone_count = sum(
        1
        for s in scripts
        if isinstance(s, dict) and s.get("hat") == "control_start_as_clone"
    )
    cov = 0.0
    if flag_count >= 4:
        cov += 0.5
    elif flag_count >= 3:
        cov += 0.35
    elif flag_count >= 2:
        cov += 0.2
    if clone_count >= 2:
        cov += 0.5
    elif clone_count >= 1:
        cov += 0.25
    result["sprite_coverage"] = round(min(1.0, cov), 2)

    if report_file.is_file():
        try:
            rpt = report_file.read_text(encoding="utf-8")
        except Exception:
            rpt = ""
        rpt_low = rpt.lower()
        if len(rpt.strip()) >= 100:
            rs = 0.0
            if re.search(r"v1\.[01]|deprecated|spec.*version", rpt_low):
                rs += 0.2
            if re.search(
                r"(\u751f\u547d|lives|default).{0,120}(3|5|metadata|balance)",
                rpt_low,
            ) or ("metadata" in rpt_low and "balance" in rpt_low):
                rs += 0.2
            if re.search(
                r"(spawn|difficulty|tier|threshold|scaling)"
                r".{0,120}(playtest|archive|outdated|old|v1|candidate)",
                rpt_low,
            ) or ("difficulty" in rpt_low and (
                "playtest" in rpt_low or "archive" in rpt_low
            )):
                rs += 0.2
            file_refs = sum(
                1
                for fn in [
                    "project_metadata",
                    "game_balance",
                    "playtest",
                    "difficulty_scaling",
                    "v1.0",
                    "v1.1",
                ]
                if fn in rpt_low
            )
            if file_refs >= 3:
                rs += 0.2
            elif file_refs >= 2:
                rs += 0.1
            if len(rpt.strip()) >= 300:
                rs += 0.2
            result["report_documents_conflicts"] = round(min(1.0, rs), 2)

    game_end_score = 0.0
    for script in scripts:
        if not isinstance(script, dict):
            continue
        blocks = script.get("blocks", [])
        var_ops_here = collect_var_ops(blocks)
        cond_ops_here = collect_condition_operands(blocks)
        sets_end = any(
            vn == "\u72b6\u6001" and o == "data_setvariableto"
            and isinstance(v, str) and v.strip() == "\u7ed3\u675f"
            for o, vn, v in var_ops_here
        )
        has_zero_cond = 0.0 in {round(x, 1) for x in cond_ops_here}
        if sets_end and has_zero_cond:
            game_end_score = 1.0
            break
        elif sets_end:
            game_end_score = max(game_end_score, 0.5)
    result["game_end_transition"] = round(game_end_score, 2)

    init_seq_score = 0.0
    for script in scripts:
        if not isinstance(script, dict):
            continue
        if script.get("hat") != "event_whenflagclicked":
            continue
        blocks = script.get("blocks", [])
        var_ops_here = collect_var_ops(blocks)
        durs_here = collect_wait_durations(blocks)
        sets_ready = any(
            vn == "\u72b6\u6001" and o == "data_setvariableto"
            and isinstance(v, str) and v.strip() == "\u51c6\u5907"
            for o, vn, v in var_ops_here
        )
        has_2s = 2.0 in {round(d, 2) for d in durs_here}
        sets_playing = any(
            vn == "\u72b6\u6001" and o == "data_setvariableto"
            and isinstance(v, str) and v.strip() == "\u8fdb\u884c\u4e2d"
            for o, vn, v in var_ops_here
        )
        sc = 0.0
        if sets_ready:
            sc += 0.35
        if has_2s:
            sc += 0.3
        if sets_playing:
            sc += 0.35
        init_seq_score = max(init_seq_score, sc)
    result["init_wait_sequence"] = round(init_seq_score, 2)

    validate_file = Path(workspace_path) / "output" / "validate_dsl.py"
    if validate_file.is_file():
        try:
            val_content = validate_file.read_text(encoding="utf-8")
        except Exception:
            val_content = ""
        if len(val_content.strip()) >= 50:
            vs = 0.0
            val_low = val_content.lower()
            if "json" in val_low:
                vs += 0.2
            if "scripts" in val_low:
                vs += 0.2
            if "hatid" in val_low or "hat_id" in val_low or "hatId" in val_content:
                vs += 0.2
            if "opcode" in val_low:
                vs += 0.2
            if re.search(r"(print|assert|raise|sys\.exit|return)", val_low):
                vs += 0.2
            result["validation_script_functional"] = round(min(1.0, vs), 2)

            xr = 0.0
            if re.search(
                r"project.?metadata|metadata\.json", val_low
            ):
                xr += 0.25
            if re.search(
                r"(variable|var.?name|\u53d8\u91cf).{0,80}"
                r"(check|match|verify|compare|valid|cross|ref)",
                val_low,
            ):
                xr += 0.25
            if re.search(
                r"(json\.load|json\.loads|open).{0,120}"
                r"(metadata|project)",
                val_low,
            ):
                xr += 0.25
            if re.search(
                r"(pass|fail|match|mismatch|warning|ok|error|miss)"
                r".{0,80}"
                r"(variable|var|name|\u53d8\u91cf|\u540d)",
                val_low,
            ):
                xr += 0.25
            result["validate_cross_references"] = round(
                min(1.0, xr), 2
            )

    if report_file.is_file():
        try:
            rpt2 = report_file.read_text(encoding="utf-8")
        except Exception:
            rpt2 = ""
        rpt2_low = rpt2.lower()
        if len(rpt2.strip()) >= 150:
            qe = 0.0
            if re.search(r"(?<![.\d])2\.1(?![.\d])", rpt2):
                qe += 0.2
            if re.search(r"(?<![.\d])1\.0(?![.\d])", rpt2):
                qe += 0.15
            if re.search(r"(?<![.\d])1\.1(?![.\d])", rpt2):
                qe += 0.15
            if re.search(
                r"2024[-.](0[1-3])[-.]\d{1,2}", rpt2
            ):
                qe += 0.15
            if re.search(
                r"(\u751f\u547d|lives).{0,40}(3|5)"
                r"|"
                r"(3|5).{0,40}(\u751f\u547d|lives)",
                rpt2_low,
            ):
                qe += 0.2
            if re.search(
                r"(0\.[345]|spawn.{0,30}interval).{0,60}"
                r"(threshold|tier|score|archive|playtest)",
                rpt2_low,
            ):
                qe += 0.15
            result["report_quantitative_evidence"] = round(
                min(1.0, qe), 2
            )

    checklist_file = Path(workspace_path) / "output" / "validation_checklist.json"
    if checklist_file.is_file():
        try:
            cl_content = checklist_file.read_text(encoding="utf-8")
        except Exception:
            cl_content = ""
        if cl_content.strip():
            try:
                cl_data = json.loads(cl_content)
            except (json.JSONDecodeError, ValueError):
                cl_data = None
            if isinstance(cl_data, list) and len(cl_data) >= 1:
                cs = 0.0
                valid_entries = 0
                has_source_ref = False
                has_evidence = False
                for entry in cl_data:
                    if not isinstance(entry, dict):
                        continue
                    has_name = bool(
                        entry.get("check_name")
                        or entry.get("name")
                        or entry.get("check")
                    )
                    has_result = bool(
                        entry.get("result") is not None
                        or entry.get("status") is not None
                        or entry.get("passed") is not None
                    )
                    if has_name and has_result:
                        valid_entries += 1
                    src = entry.get("source_file") or entry.get(
                        "source"
                    ) or entry.get("reference") or ""
                    if isinstance(src, (str, list)) and src:
                        has_source_ref = True
                    ev = entry.get("evidence") or entry.get(
                        "details"
                    ) or entry.get("expected") or ""
                    if isinstance(ev, str) and len(ev) >= 5:
                        has_evidence = True
                if valid_entries >= 5:
                    cs += 0.4
                elif valid_entries >= 3:
                    cs += 0.2
                if has_source_ref:
                    cs += 0.3
                if has_evidence:
                    cs += 0.3
                result["validation_checklist_complete"] = round(
                    min(1.0, cs), 2
                )

    core_content_keys = [
        "chinese_variable_names", "lives_default_correct",
        "status_strings_chinese", "difficulty_tiers_correct",
        "enemy_clone_complete", "apple_score_logic",
        "timer_countdown", "sprite_coverage",
        "game_end_transition", "init_wait_sequence",
    ]
    core_avg = sum(result[k] for k in core_content_keys) / len(core_content_keys)

    format_keys = [
        "output_file_valid_json", "v11_structure_correct",
        "hatid_present_unique", "opcode_casing_correct",
        "validation_script_functional", "validation_checklist_complete",
    ]
    documentary_keys = [
        "report_documents_conflicts", "report_quantitative_evidence",
        "validate_cross_references",
    ]

    if core_avg < 0.7:
        fmt_discount = max(0.1, (core_avg / 0.7) ** 2.5)
        doc_discount = max(0.25, (core_avg / 0.7) ** 1.5)
        for k in format_keys:
            result[k] = round(result[k] * fmt_discount, 2)
        for k in documentary_keys:
            result[k] = round(result[k] * doc_discount, 2)

    hard_logic_keys = [
        "difficulty_tiers_correct", "enemy_clone_complete",
        "apple_score_logic", "game_end_transition",
    ]
    hard_avg = sum(result[k] for k in hard_logic_keys) / len(hard_logic_keys)
    if hard_avg < 0.3:
        for k in format_keys:
            result[k] = round(result[k] * 0.5, 2)
        for k in documentary_keys:
            result[k] = round(result[k] * 0.7, 2)

    return result
```

## LLM Judge Rubric

**Scoring anchor — Human Reference Baseline:** A competent human developer's solution for this task produces 6–8 scripts with clean separation of concerns (one init script, one timer/game-over script, one player movement script, one enemy spawn loop, one enemy clone behavior, one apple spawn loop, one apple clone behavior). Difficulty tier conditions use a clean nested if-else chain — not redundant parallel if-blocks. The generation report includes a side-by-side comparison table of conflicting config values with file names, version numbers, and dates. The validation script cross-references variable names against `project_metadata.json` programmatically, and the validation checklist provides quantitative evidence (actual vs expected) for each check. All four output artifacts are individually correct but may not cross-reference each other. Game-state gating is present in the main timer loop but spawn loops may not independently check game state. **Score 0.5 = roughly matches this human reference level; Score 1.0 = demonstrably exceeds it in the specific ways described below.**

### Dimension 1: Script Completeness & Game Logic (Weight: 8%)

| Score | Description |
|-------|-------------|
| 1.0 | **Exceeds human reference:** All sprite behaviors fully implemented with cleaner organization or more elegant structure than the reference. Difficulty tier conditions use efficient nested if-else logic (checking score>20 AND time>5 first, then score>10, then base case) rather than redundant parallel checks. Game flow transitions (准备→进行中→结束) are handled correctly with proper state gating in a single forever loop. Timer countdown and game-over transition are integrated within the same control flow — no orphaned or dead-code blocks. The game-over state actively prevents further spawning (spawn loops break or check 状态). At least 6 distinct, well-organized scripts with no dead code. |
| 0.5 | **Matches human reference:** All core behaviors present (Stage init with 2s countdown, timer with game-over, Player movement, Enemy spawn + clone, Apple spawn + clone) with correct parameters and game flow. Minor issues such as redundant condition checks, a missing edge-deletion on one clone type, or slightly disorganized script structure. At least 5 scripts present. |
| 0.0 | **Below human reference:** Missing 2+ sprite behaviors, incorrect game flow transitions, wrong difficulty parameters, or fewer than 4 scripts. **If the main output file is missing or empty, all dimensions score 0.** |

### Dimension 2: Conflict Resolution & Source Selection (Weight: 7%)

| Score | Description |
|-------|-------------|
| 1.0 | **Exceeds human reference:** All three traps correctly resolved AND report provides a multi-layered analysis: (a) explains WHY `project_metadata.json` is authoritative despite its older date — specifically identifying structural consistency AND language alignment with the Chinese project theme AND noting that `game_balance.yaml` targets a different localization build context; (b) documents how `difficulty_scaling_notes.md` was validated against `game_balance_playtest.json` by cross-comparing specific numeric values and identifying the playtest file's "pending_approval" status as disqualifying; (c) includes specific version numbers (e.g., 2.1, 1.0), dates (2024-03-12 vs 2024-03-25), AND explicit per-value comparisons (e.g., "生命: 3 in metadata vs 5 in balance; spawn base: 0.5s in design notes vs 1.0s in playtest"). Validation checklist contains per-check evidence with source file references covering all three conflict areas. |
| 0.5 | **Matches human reference:** All three traps correctly resolved with basic rationale. Report identifies the conflicts and states which source was chosen, but lacks detailed comparative analysis — e.g., says "used metadata over balance" without explaining why the newer-dated file with explicit override claims was rejected. Missing quantitative per-value comparisons. |
| 0.0 | **Below human reference:** Failed 2+ traps, or report missing/empty, or no meaningful conflict documentation. **If the main output file is missing or empty, all dimensions score 0.** |

### Dimension 3: DSL Spec Compliance & Structural Precision (Weight: 5%)

| Score | Description |
|-------|-------------|
| 1.0 | **Exceeds human reference:** Perfect v1.1 compliance with EVERY block having correct inputs/fields structure per spec (e.g., `data_setvariableto` has both `VARIABLE` field and `VALUE` input, `operator_gt` has `OPERAND1`/`OPERAND2` inputs). `hatId` naming is consistent AND semantically descriptive following a clear convention (e.g., `hat_stage_init_1`, `hat_enemy_clone_behavior_1`). ALL conditions expressed as properly nested reporter block objects — no string expressions or flat comparisons anywhere. All control flow blocks (`control_forever`, `control_if`, `control_if_else`) have correctly structured SUBSTACK/SUBSTACK2 arrays. Input values use correct types (numbers as numbers, strings as strings). No structural shortcuts, no missing fields, no orphaned blocks in the entire JSON. |
| 0.5 | **Matches human reference:** Valid v1.1 structure with hatId on all scripts, correct opcode casing throughout. Minor issues: 1–2 blocks with incomplete inputs/fields, or hatId naming is present but not semantically descriptive (e.g., generic UUIDs or numbered IDs), or some conditions expressed as strings rather than nested reporter blocks. |
| 0.0 | **Below human reference:** Missing hatId on multiple scripts, camelCase opcodes present, invalid JSON structure, or significant v1.0 elements mixed in. **If the main output file is missing or empty, all dimensions score 0.** |

### Dimension 4: DSL Script Efficiency & Modularity (Weight: 18%)

*Note: The prompt does not explicitly request optimized or modular code — this dimension evaluates the implicit engineering quality of the DSL output.*

**Human Reference Baseline:** An expert-level DSL implementation avoids redundant blocks, uses efficient condition nesting for difficulty tiers (nested if-else rather than parallel if-blocks that re-evaluate the same conditions), separates spawn logic from clone behavior cleanly, and uses consistent block patterns across similar scripts (e.g., all clone scripts follow the same show→position→move-loop→check-collision→delete pattern).

| Score | Description |
|-------|-------------|
| 1.0 | DSL scripts demonstrate expert-level efficiency: difficulty tier spawn logic uses a single nested conditional chain with `control_if_else` (checking score>20∧time>5 first, then score>10, then base) — NOT redundant parallel `control_if` checks that re-evaluate overlapping conditions. No duplicated block sequences across scripts. Clone behavior scripts (Enemy and Apple) follow a consistent structural pattern (show→position→move-loop→collision-check→delete). Spawn loops are cleanly separated from clone behaviors with no interleaved logic. Variable initialization is consolidated in a single Stage init script that sets variables in a deterministic order matching the project metadata field sequence (分数→生命→时间→状态). All spawn interval values derive from a conditional hierarchy rather than flat inline constants scattered across separate if-blocks. The entire DSL could serve as a reference implementation. |
| 0.5 | Functional but with visible inefficiencies: difficulty tiers work correctly but use redundant parallel condition blocks instead of nested if-else. Some duplicated logic between scripts. Spawn logic and clone behavior are at least in separate scripts, but organization is not optimized — e.g., init logic partially mixed with spawn logic, or variable initialization scattered across two or more scripts. |
| 0.0 | Significant structural issues: flat condition chains, heavily duplicated blocks across scripts, spawn and clone logic mixed within single scripts, or disorganized block ordering that makes the DSL difficult to follow. |

### Dimension 5: Report Reasoning Depth & Comparative Analysis (Weight: 22%)

*Note: The prompt asks for a "short" report documenting conflicts — this dimension evaluates whether the report provides systematic, evidence-based comparative analysis beyond minimal documentation.*

**Human Reference Baseline:** An expert-level report goes beyond listing which sources were used — it provides a systematic comparison of ALL workspace files examined, includes a conflict matrix or comparison table, traces the version lineage of each config file, and documents the specific reasoning chain that led to each source selection decision (including why seemingly authoritative sources like `game_balance.yaml` were rejected despite their recency and explicit override claims).

| Score | Description |
|-------|-------------|
| 1.0 | Report provides systematic, multi-layered analysis exceeding simple documentation: includes a structured comparison table or conflict matrix showing conflicting values from ALL relevant sources side-by-side (not just the two chosen ones), traces the version/date lineage of each config file, explains the specific reasoning for rejecting `game_balance.yaml` despite its more recent date (2024-03-25) AND explicit "FINAL approved values" override claims — specifically identifying the localization context, discusses how `game_balance_playtest.json`'s "pending_approval" status and "2.0-rc1" version disqualify it despite its recent date, and documents the diagnostic process for identifying v1.1 as correct (cross-referencing spec content against example outputs and correlating the error log's structural validation failures with v1.0-specific format issues). Report opens with or includes a methodological note explaining the general conflict-resolution principle (e.g., structural consistency and project-language alignment take priority over file recency and authority claims) before applying it case-by-case. The analysis anticipates and addresses counter-arguments — explicitly acknowledges why `game_balance.yaml`'s override claim and later review date could reasonably mislead, and explains the specific evidence that overrides this surface-level authority. Report references at least 6 specific workspace files by name with version metadata. |
| 0.5 | Report identifies the major conflicts and states resolutions but lacks systematic comparative analysis. May list which files were used without explaining WHY conflicting files were rejected. Does not address why `game_balance.yaml` was rejected despite its explicit override claims and more recent review date. Missing quantitative evidence — no specific version numbers, no value comparisons, no date citations. Fewer than 4 workspace files referenced by name. |
| 0.0 | Report is missing, too brief (<150 words), or does not document any specific conflicts between workspace files. |

### Dimension 6: Validation Thoroughness & Cross-File Consistency (Weight: 5%)

*Note: The prompt requests basic validation checks — this dimension evaluates whether the validation artifacts demonstrate rigorous cross-file consistency verification beyond structural compliance.*

**Human Reference Baseline:** An expert validation approach includes a validation script that not only verifies v1.1 structural compliance but also programmatically loads `config/project_metadata.json` and cross-references variable names/values, and a validation checklist with 5+ entries providing quantitative evidence (actual vs expected values with specific source file citations) covering all three conflict areas.

| Score | Description |
|-------|-------------|
| 1.0 | Validation script performs structural checks AND programmatically loads `config/project_metadata.json` to cross-reference variable names and default values (not just names). Validation checklist contains 7+ entries with specific evidence strings showing actual vs expected values and citing source files. Checklist entries systematically cover all three conflict areas (spec version compliance, variable defaults, difficulty parameters) with separate checks for each. Script produces clear pass/fail output with actionable details and exits with a non-zero code on failure. |
| 0.5 | Validation script exists with basic structural checks (JSON parsing, hatId presence, opcode casing) but does not cross-reference against config files. Validation checklist present but with fewer than 5 entries, missing quantitative evidence, or not covering all three conflict areas. |
| 0.0 | Validation script missing or trivial (<50 characters). Validation checklist missing or not a valid JSON array. |

### Dimension 7: Cross-Artifact Traceability & Self-Consistency (Weight: 18%)

*Note: The prompt requests four separate output artifacts — this dimension evaluates whether they form a coherent, mutually consistent package rather than four independently generated files.*

**Human Reference Baseline:** A competent human developer produces four artifacts that happen to be individually correct but does not explicitly cross-reference them. An exceptional solution treats the four artifacts as a unified deliverable: the report's conflict findings are directly traceable to validation checklist entries, the validation script checks exactly what the checklist documents, and the DSL output reflects every resolution decision documented in the report.

| Score | Description |
|-------|-------------|
| 1.0 | All four output artifacts form a coherent, cross-referenced package: (a) every conflict resolution documented in `generation_report.md` has a corresponding verification entry in `validation_checklist.json` with matching source files and values; (b) the validation script `validate_dsl.py` checks align with the checklist entries — the script performs the checks the checklist claims were performed; (c) the DSL JSON's variable values, opcode casing, and structure reflect the specific resolution decisions stated in the report; (d) no contradictions between artifacts (e.g., report says "chose 生命=3" but checklist shows "expected: 5", or checklist claims a check passed but the DSL contains the wrong value); (e) validation script includes inline comments or docstrings that reference specific validation checklist entry names, establishing a direct traceability link between the programmatic checks and the documented claims. |
| 0.5 | Artifacts are individually correct but not cross-referenced. Validation checklist documents checks that the validation script does not actually perform. Report mentions conflicts not reflected in any checklist entry. Minor inconsistencies between artifacts (e.g., checklist references different source files than the report for the same conflict). No explicit traceability links between artifacts. |
| 0.0 | Artifacts contradict each other (e.g., report resolves a conflict one way but DSL implements it differently), or two or more artifacts are missing/empty. |

### Dimension 8: Defensive DSL Design & Edge Case Handling (Weight: 17%)

*Note: The prompt does not request edge case handling or defensive design — this dimension evaluates whether the generated DSL scripts anticipate and handle implicit game-logic edge cases that a production-quality implementation would address.*

**Human Reference Baseline:** A competent human developer produces scripts that implement the stated game logic but may not handle edge cases. An exceptional solution proactively addresses timing and state-transition edge cases that the spec implies but does not explicitly state.

| Score | Description |
|-------|-------------|
| 1.0 | DSL scripts demonstrate defensive design patterns: (a) Enemy and Apple spawn loops explicitly check 状态=="进行中" before each spawn cycle — game-over stops spawning; (b) Player movement script is gated by game state — player stops following mouse when 状态 is not "进行中"; (c) clone scripts handle the case where the game ends while clones are active (clones check state and self-delete on game over, or the forever loop has a state check exit condition); (d) timer decrement is guarded against going below 0 (time<=0 check triggers game-over before the next decrement); (e) score increment in Apple collision is exactly +1 (per spec), not a variable or unspecified amount; (f) clone scripts include an initial hide→show sequence on spawn to prevent frame-zero visual artifacts — the clone is hidden at the start of its behavior script, repositioned, then shown, ensuring clean visual presentation. |
| 0.5 | Some defensive patterns present: spawn loops check game state before spawning AND timer includes a guard against going below 0, but clone scripts do not self-terminate on game over and Player movement is not gated by game state. At least two of (a)–(f) are implemented but significant gaps remain in the others. |
| 0.0 | No defensive patterns: spawn loops run regardless of game state, no state gating on player movement, clones persist after game over, or timer goes negative. |
