---
id: task_00038_plan_project_folder_structure_for_new_blue_ocean_project
name: Plan Project Folder Structure for New Blue Ocean Project
category: System Operations and Administration
grading_type: hybrid
external_dependency: none
verification_method: rubric
input_modality: text-only
timeout_seconds: 1800
workspace_files:
- source: config/company_projects_registry.json
  dest: config/company_projects_registry.json
- source: config/folder_naming_convention.yaml
  dest: config/folder_naming_convention.yaml
- source: data/existing_folder_audit.csv
  dest: data/existing_folder_audit.csv
- source: data/project_brief_05TK25002D.txt
  dest: data/project_brief_05TK25002D.txt
- source: config/old_naming_convention_v1.yaml
  dest: config/old_naming_convention_v1.yaml
- source: data/project_list_summary.csv
  dest: data/project_list_summary.csv
- source: logs/folder_creation_log.log
  dest: logs/folder_creation_log.log
- source: docs/IT_security_policy_excerpt.md
  dest: docs/IT_security_policy_excerpt.md
- source: templates/subfolder_checklist.md
  dest: templates/subfolder_checklist.md
grading_weights:
  automated: 0.55
  llm_judge: 0.45
subcategory: Storage and Data Management
---
## Prompt

We just kicked off the Blue Ocean Advanced Materials project and need the folder structure defined before next week's team meeting. Supporting files are under `config/`, `data/`, `docs/`, `logs/`, and `templates/`.

Deliver three files IT can run with (minimize back-and-forth):

1. **`project_folder_structure_plan.md`** — Current-standard folder layout for this project; audit findings; which naming-convention file governs and why; post-creation checks using the checklist template; ongoing documentation expectations. Use quantitative audit figures where they help.

2. **`folder_structure.json`** — Machine-readable tree: project metadata, every path to create, and other same-year registry projects that may need parallel setup.

3. **`migration_recommendations.csv`** — One row per non-compliant audited folder: current path, recommended v2.3 path, compliance score (0–1), migration priority (1 = highest), short issue description. Cross-check the audit and project summary when resolving project codes.

If sources disagree, reconcile them and state **which source is authoritative and why** (name the files). Detailed rubric checks are enforced programmatically in **Automated Checks** below.

## Expected Behavior

The agent must produce three deliverables: a comprehensive folder structure plan at `project_folder_structure_plan.md`, a structured JSON directory hierarchy at `folder_structure.json`, and a migration recommendations spreadsheet at `migration_recommendations.csv`. All three must demonstrate correct cross-referencing of multiple workspace data sources and resolution of two embedded data traps.

**Correct project code resolution (Trap 1):**
- `config/company_projects_registry.json` and `data/project_brief_05TK25002D.txt` agree on `05TK25002D`
- `data/project_list_summary.csv` disagrees (wrong final letter in the code for this project)
- The agent must use `05TK25002D` everywhere in deliverables and **explain the conflict by naming sources** (registry and/or brief vs. `project_list_summary.csv`). **Quoting the wrong spreadsheet code is optional** — attribution matters more than repeating the erroneous value
- **Basic completion**: uses `05TK25002D` without explanation; **High-quality completion**: names the conflicting sources and explains why the registry and brief outweigh the summary table

**Correct naming convention resolution (Trap 2):**
- `config/folder_naming_convention.yaml` (version 2.3, effective 2023-09-01, status: current) specifies: project folder pattern `{project_code}-{project_name}`, root at `D:\My Projects`, year folder pattern `{year} Projects`
- `config/old_naming_convention_v1.yaml` (version 1.0, dated 2021-03-15, status: superseded) uses a different pattern: `{project_name}_{project_code}` under `D:\Project Files`
- The agent must follow the current v2.3 convention and explicitly note that v1.0 is superseded
- **Basic completion**: uses v2.3 pattern without mentioning v1.0; **High-quality completion**: cites both versions with their version numbers, effective dates, and superseded status

**Correct folder structure (derived from v2.3 convention + project data):**
- Year folder: `D:\My Projects\2026 Projects` (does not exist yet per the audit CSV — no 2026 entries present)
- Project folder: `D:\My Projects\2026 Projects\05TK25002D-Blue Ocean Advanced Materials Co., Ltd. High-End Polyolefin New Materials Project`
- All 10 mandatory subfolders (01_Project_Management through 10_Archive) listed with full paths
- The project year (2026) is derived from the registry JSON entry for 05TK25002D

**Existing folder audit observations:**
- The agent should review `data/existing_folder_audit.csv` and identify specific naming inconsistencies, including:
  - `Huayang Ammonia Plant Debottleneck` — completely missing the project code prefix (should be `08TK23007A-...` per v2.3 convention, cross-referenced from `data/project_list_summary.csv`)
  - `Donghai Sulfur Recovery Upgrade_07TK24005D` — uses an underscore separator and places the project name before the code, following the superseded v1.0 pattern
  - `D:\Project Files\2022\Westport Refinery Turnaround_01TK22003B` — stored under the old root directory `D:\Project Files` with v1.0 naming conventions and old year folder format
  - `temp_new_project` — a non-standard temporary folder with no project code or proper naming
- The agent should note that no 2026 year folder currently exists
- **Basic completion**: identifies at least 1 inconsistency; **High-quality completion**: identifies 3+ inconsistencies with specific details and remediation recommendations

**JSON deliverable expected structure:**
- The `folder_structure.json` should contain at minimum:
  - Project metadata: code (`05TK25002D`), name, phase (`Basic Design`), naming convention version (`2.3`)
  - Full path for the project folder following v2.3 convention
  - List of all subfolder names or paths to be created (all 10 mandatory subfolders)
- **Basic completion**: valid JSON with project code and some paths; **High-quality completion**: complete schema with all metadata fields, correct project folder path, and all 10 subfolder names following v2.3 convention

**Migration recommendations CSV (derived from audit + convention cross-reference):**
- The agent must produce `migration_recommendations.csv` identifying all non-compliant folders from the existing folder audit
- Expected columns: `current_path`, `recommended_path`, `compliance_score` (0–1), `migration_priority` (1 = highest), `issue_description`
- Should include entries for all 4 non-compliant folders identified in the audit:
  - Huayang Ammonia Plant Debottleneck (missing code prefix → should be `08TK23007A-Huayang Ammonia Plant Debottleneck Study`, cross-referenced from project_list_summary.csv)
  - Donghai Sulfur Recovery Upgrade (v1.0 underscore pattern → should be `07TK24005D-Donghai Sulfur Recovery Unit Upgrade`)
  - Westport Refinery Turnaround (wrong root + v1.0 pattern → should be under `D:\My Projects\2022 Projects\01TK22003B-Westport Refinery Turnaround Support`)
  - temp_new_project (completely non-standard → requires investigation/removal)
- Compliance scores should reflect severity: temp_new_project ≈ 0.0, Westport ≈ 0.2, Huayang ≈ 0.3, Donghai ≈ 0.4
- Priority should reflect remediation urgency and data volume (larger folders = higher priority)
- **Basic completion**: CSV exists with some entries; **High-quality completion**: all 4 folders mapped with correct paths, sensible scores, and data-informed priority ordering

**Quantitative audit data citation:**
- When discussing audit findings in the plan, the agent should cite specific quantitative data from `existing_folder_audit.csv` to characterize the migration scope
- Key data points: Huayang folder contains 623 files / 1455.9 MB, Donghai contains 445 files / 1102.3 MB, Westport contains 1567 files / 3890.1 MB, temp_new_project contains 2 files / 0.1 MB
- Total migration volume across all 4 non-compliant folders: 2,637 files / 6,448.4 MB — computing and stating this aggregate is important for IT budget and scheduling
- These figures are critical for IT to estimate migration effort and downtime
- **Basic completion**: mentions generic size observations; **High-quality completion**: cites at least 4 specific file counts or sizes from the CSV data AND computes the total migration volume

**Registry cross-validation:**
- The plan and/or JSON should cross-reference the project registry (`config/company_projects_registry.json`) beyond just the project code
- The registered date `2025-11-30` should appear in the JSON metadata (the prompt explicitly requests it for IT ticketing)
- The agent should note that another 2026 project exists in the registry: `06TK26003B` (Sunrise Chemical Ethylene Oxide Derivatives Plant, phase: Preliminary Design, registered 2025-12-15), flagging it as potentially needing a folder setup at the same time
- **Basic completion**: includes project code from registry; **High-quality completion**: includes registered date, identifies other 2026 projects with their phase and registration date

**Cross-project code verification:**
- When identifying non-compliant folders, the agent should cross-reference the audit data with `data/project_list_summary.csv` to determine the correct project codes: `08TK23007A` for Huayang, `07TK24005D` for Donghai, `01TK22003B` for Westport
- These codes are needed to construct the correct v2.3-compliant folder names in the migration recommendations

**v1.0 vs v2.3 structural comparison:**
- Beyond just noting that v1.0 is superseded, a thorough analysis should identify specific structural differences: v1.0 has 8 mandatory subfolders vs v2.3's 10, v1.0 root is `D:\Project Files` vs v2.3's `D:\My Projects`, v1.0 isolation policy is "recommended" vs v2.3's "strict", v1.0 naming pattern places project name before code with underscore
- **High-quality completion** also cites the specific v1.0 subfolder abbreviations (e.g., `01_PM`, `02_Design`, `03_Calc`, `04_Dwg`, `06_Corr`) to illustrate how v2.3 expanded and renamed them

**Operational context from logs:**
- The folder creation log shows that D: drive is at 72% capacity (1.84 TB used of 2.56 TB) — this should be flagged as an IT consideration, especially given the new project will add more data
- The log records a backup failure and a later successful retry — citing **only the failure**, **only the recovery/retry success**, or the **full failure-then-recovery arc** is acceptable for the backup verification checklist item

**Ongoing documentation requirements:**
- Based on Section D of the subfolder checklist template, the plan should address: milestone tracking in `01_Project_Management`, deliverable compilation requirements in `09_Deliverables`, and periodic progress summaries

**Checklist section:**
- Based on `templates/subfolder_checklist.md`, include verification items for mandatory subfolders, project code confirmation, year folder existence, isolation policy acknowledgment, and README.md placement

**ACL/Permission warning from operational log:**
- The folder creation log (`logs/folder_creation_log.log`) records a permission inheritance warning: "2 subfolders have non-standard ACLs. Review recommended."
- A thorough analysis should flag this as a pre-creation check item for the new project — IT should verify ACL inheritance before initializing the new folder structure
- **Basic completion**: does not mention the ACL warning; **High-quality completion**: explicitly flags the non-standard ACL issue and recommends IT review before creating the new project's subfolders

**Project brief specifications citation:**
- The project brief (`data/project_brief_05TK25002D.txt`) contains specific numerical parameters that characterize the project scope: estimated plant capacity of 300,000 tonnes per annum, estimated duration of 18 months, project start date 2026-01-15, and target completion date 2027-07-15
- A comprehensive folder structure plan that serves as a project kickoff reference should include these key specifications for IT context
- **Basic completion**: identifies the phase as "Basic Design" without citing numerical specs; **High-quality completion**: cites at least 2 specific numerical parameters (capacity, duration, or dates) from the brief

**Handling of supplementary workspace files:**
- The IT security policy (`docs/IT_security_policy_excerpt.md`) may be referenced to confirm that the D: drive is the approved location for project file storage (per Section 2: Approved Storage Locations); citing the document ID `IT-SEC-POL-2024-008` demonstrates thorough cross-referencing
- The folder creation log (`logs/folder_creation_log.log`) provides context on how previous projects were initialized
- These files serve as realistic workspace context; the agent should extract only relevant information

## Grading Criteria

- [ ] The output file `project_folder_structure_plan.md` exists and is a well-structured Markdown document with clear section headings
- [ ] `folder_structure.json` exists, contains valid JSON, and includes required fields (project_code, project_name, subfolders as a list)
- [ ] The correct project code `05TK25002D` is used consistently as the authoritative code and is not overshadowed by the wrong value in the project list summary
- [ ] The discrepancy between authoritative sources (registry/brief: `05TK25002D`) and the project list summary data is explicitly identified and discussed with **source attribution** (file/table names); repeating the wrong spreadsheet code is not required
- [ ] The current naming convention v2.3 pattern `{project_code}-{project_name}` is correctly applied, with explicit v2.3 version reference and effective date citation
- [ ] The complete project folder path is correctly specified as a single contiguous string: `D:\My Projects\2026 Projects\05TK25002D-Blue Ocean Advanced Materials Co., Ltd. High-End Polyolefin New Materials Project`
- [ ] The year folder `D:\My Projects\2026 Projects` is specified, noted as not yet existing, with reference to the audit data showing no 2026 entries
- [ ] All 10 mandatory subfolders (01_Project_Management through 10_Archive) are listed
- [ ] The old/superseded naming convention v1.0 is explicitly discussed with its version and superseded status noted
- [ ] The existing folder audit is analyzed with at least 2 specific naming inconsistencies identified by project name, including remediation recommendations
- [ ] A subfolder completeness checklist section is included based on the template with verification items, section references (Section A–E), and template version 2.1 citation
- [ ] The strict project isolation policy is addressed with reference to its source document (naming convention or IT security policy), with full marks requiring citation of IT-SEC-POL-2024-008
- [ ] Ongoing documentation and deliverable tracking requirements are covered (per checklist template Section D), with at least 4–5 specific tracking mechanisms cited (milestone tracking, deliverable compilation, progress summaries, transmittal register, revision status)
- [ ] The project phase "Basic Design" is correctly identified from the project brief
- [ ] The JSON file contains the correct project folder path using v2.3 convention, lists all 10 mandatory subfolder names, and includes convention version and phase metadata
- [ ] `migration_recommendations.csv` exists with columns for current path, recommended path, compliance score, and migration priority, covering at least 3 non-compliant folders
- [ ] The audit analysis in the plan cites specific quantitative data (file counts and/or sizes) from the existing folder audit CSV, with full marks requiring a computed total migration volume (2,637 files / 6,448.4 MB)
- [ ] The JSON metadata includes the registered date from the project registry and/or the plan identifies other 2026 projects (06TK26003B Sunrise Chemical, Preliminary Design phase) in the registry
- [ ] Non-compliant folders' original project codes are correctly identified via cross-referencing (e.g., `08TK23007A` for Huayang, `07TK24005D` for Donghai, `01TK22003B` for Westport)
- [ ] Specific structural differences between v1.0 and v2.3 are noted (e.g., 8 vs 10 subfolders, different root directories, different isolation policies), with full marks requiring citation of v1.0 subfolder abbreviations (01_PM, 02_Design, etc.)
- [ ] The D: drive capacity warning (72% used) from the folder creation log is flagged as an IT consideration
- [ ] The backup incident from the folder creation log is noted (initial failure and/or failure with subsequent successful retry), linked to the backup verification checklist item
- [ ] All three deliverables are organized and detailed enough to be handed off to IT for execution (full marks require ≥8 sections and ≥2000 characters in the MD plan)
- [ ] The ACL/permission inheritance warning from the folder creation log is noted, flagging the non-standard ACLs on 2 subfolders as a pre-creation check item
- [ ] Key project specifications from the project brief are cited in the plan (plant capacity 300,000 tonnes/annum, estimated duration 18 months, start date 2026-01-15, target completion 2027-07-15)

## Automated Checks

```python
import os
import re
import json
import csv
from io import StringIO

def grade(transcript: list, workspace_path: str) -> dict:
    results = {
        "output_file_exists": 0.0,
        "json_deliverable_valid": 0.0,
        "correct_project_code": 0.0,
        "code_discrepancy_identified": 0.0,
        "naming_convention_applied": 0.0,
        "full_project_path_correct": 0.0,
        "year_folder_specified": 0.0,
        "all_subfolders_listed": 0.0,
        "old_convention_discussed": 0.0,
        "audit_findings_specific": 0.0,
        "checklist_section_present": 0.0,
        "isolation_policy_addressed": 0.0,
        "ongoing_docs_requirements": 0.0,
        "basic_design_phase": 0.0,
        "json_paths_correct": 0.0,
        "it_handoff_quality": 0.0,
        "audit_quantitative_cite": 0.0,
        "registry_cross_validation": 0.0,
        "migration_csv_produced": 0.0,
        "cross_project_codes_verified": 0.0,
        "v1_v2_structural_diff": 0.0,
        "disk_capacity_flagged": 0.0,
        "backup_failure_noted": 0.0,
        "acl_warning_noted": 0.0,
        "project_brief_specs_cited": 0.0,
    }

    def _find_val(d, keys, max_depth=4):
        """Search for any of the given keys in a nested dict/list structure."""
        if not isinstance(d, dict):
            return None
        for k in keys:
            if k in d:
                return d[k]
        if max_depth > 0:
            for v in d.values():
                if isinstance(v, dict):
                    r = _find_val(v, keys, max_depth - 1)
                    if r is not None:
                        return r
                elif isinstance(v, list):
                    for item in v:
                        if isinstance(item, dict):
                            r = _find_val(item, keys, max_depth - 1)
                            if r is not None:
                                return r
        return None

    md_path = os.path.join(workspace_path, "project_folder_structure_plan.md")
    json_path = os.path.join(workspace_path, "folder_structure.json")
    migration_path = os.path.join(workspace_path, "migration_recommendations.csv")

    if not os.path.isfile(md_path):
        return results

    try:
        with open(md_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return results

    if not content.strip():
        return results

    content_lower = content.lower()

    section_count = len(re.findall(r'^#{1,3}\s+\S', content, re.MULTILINE))
    doc_len = len(content.strip())
    if section_count >= 4 and doc_len >= 800:
        results["output_file_exists"] = 1.0
    elif section_count >= 2 and doc_len >= 400:
        results["output_file_exists"] = 0.5
    elif doc_len >= 400:
        # 区分「空/近空」与「有实质正文但缺标题结构」的占位输出，避免与空白交付同分
        results["output_file_exists"] = 0.25

    # --- JSON parsing with nested-structure support ---
    json_data = None
    if os.path.isfile(json_path):
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                json_data = json.load(f)
        except Exception:
            pass

    if json_data is not None:
        if isinstance(json_data, dict):
            code_val = _find_val(json_data, ["project_code", "code"])
            name_val = _find_val(json_data, ["project_name", "name"])
            sub_field = None
            for k in ["subfolders", "sub_folders", "folders", "directories",
                       "children", "mandatory_subfolders"]:
                found = _find_val(json_data, [k])
                if found is not None and isinstance(found, list):
                    sub_field = found
                    break
            has_code = code_val is not None and str(code_val).strip() != ""
            has_name = name_val is not None and str(name_val).strip() != ""
            has_subs = sub_field is not None and len(sub_field) > 0
            if has_code and has_name and has_subs:
                results["json_deliverable_valid"] = 1.0
            elif has_code and (has_name or has_subs):
                results["json_deliverable_valid"] = 0.5
        elif isinstance(json_data, list) and len(json_data) > 0:
            results["json_deliverable_valid"] = 0.25

    summary_wrong_code_present = False
    summary_path = os.path.join(workspace_path, "data", "project_list_summary.csv")
    if os.path.isfile(summary_path):
        try:
            with open(summary_path, "r", encoding="utf-8") as sf:
                summary_wrong_code_present = "05TK25002B" in sf.read()
        except Exception:
            pass

    correct_count = len(re.findall(r'05TK25002D', content))
    wrong_count = len(re.findall(r'05TK25002B', content, re.IGNORECASE))
    if correct_count > 0 and correct_count >= wrong_count * 2:
        results["correct_project_code"] = 1.0
    elif correct_count > wrong_count:
        results["correct_project_code"] = 0.5

    context_terms = ['discrepan', 'incorrect', 'error', 'mismatch',
                     'inconsisten', 'wrong', 'differ', 'conflict', 'erroneous', 'typo',
                     'disagree', 'contradict', 'authoritative']
    source_terms = ['summary', 'csv', 'registry', 'brief', 'spreadsheet',
                    'project_list', 'project list']
    has_ctx = any(t in content_lower for t in context_terms)
    has_src = any(t in content_lower for t in source_terms)
    cites_registry = bool(re.search(
        r'company[_\s-]?projects[_\s-]?registry|registry\.json', content_lower))
    cites_summary_table = bool(re.search(
        r'project[\s_-]*list[\s_-]*summary|project\s+list\s+summary', content_lower))
    cites_brief = bool(re.search(r'project[_\s-]?brief|brief_05TK', content_lower))
    auth_ref = cites_registry or cites_brief

    if correct_count > 0:
        # Prefer source attribution over repeating the wrong CSV literal in the plan.
        if auth_ref and cites_summary_table and has_ctx:
            if not os.path.isfile(summary_path):
                results["code_discrepancy_identified"] = 0.75
            elif summary_wrong_code_present:
                results["code_discrepancy_identified"] = 1.0
            else:
                results["code_discrepancy_identified"] = 0.5
        elif wrong_count > 0 and has_ctx and has_src:
            results["code_discrepancy_identified"] = 1.0
        elif auth_ref and cites_summary_table:
            results["code_discrepancy_identified"] = 0.75
        elif has_ctx and has_src:
            results["code_discrepancy_identified"] = 0.5
        elif has_ctx or has_src:
            results["code_discrepancy_identified"] = 0.25

    has_pattern = bool(re.search(
        r'05TK25002D\s*[-\u2013\u2014]\s*.*[Bb]lue\s*[Oo]cean', content))
    has_v23 = bool(re.search(r'v2\.3|version\s+2\.3', content_lower))
    has_effective = bool(re.search(r'2023[\-/]09[\-/]01', content))
    has_template = bool(re.search(
        r'project.code.*-.*project.name|\{project_code\}.*\{project_name\}',
        content_lower))
    nc_signals = sum([has_pattern, has_v23, has_effective, has_template])
    if nc_signals >= 4:
        results["naming_convention_applied"] = 1.0
    elif nc_signals >= 3:
        results["naming_convention_applied"] = 0.75
    elif nc_signals >= 2:
        results["naming_convention_applied"] = 0.5
    elif has_pattern:
        results["naming_convention_applied"] = 0.25

    full_path_re = (
        r'D\s*[:\\/\\\\]+\s*My\s+Projects\s*[/\\\\]+\s*2026\s+Projects\s*[/\\\\]+\s*'
        r'05TK25002D\s*[-\u2013\u2014]\s*Blue\s+Ocean\s+Advanced\s+Materials\s+'
        r'Co\.?,?\s+Ltd\.?\s+High[\-\s]End\s+Polyolefin'
    )
    if re.search(full_path_re, content, re.IGNORECASE):
        results["full_project_path_correct"] = 1.0
    else:
        has_d_drive = bool(re.search(r'D\s*[:\\\\]', content))
        has_my_projects = bool(re.search(r'My\s+Projects', content))
        has_2026_projects = bool(re.search(r'2026\s+Projects', content))
        has_full_name = bool(re.search(
            r'05TK25002D\s*[-\u2013\u2014]\s*Blue\s+Ocean\s+Advanced\s+Materials',
            content, re.IGNORECASE))
        path_frags = sum([has_d_drive, has_my_projects, has_2026_projects, has_full_name])
        if path_frags == 4:
            results["full_project_path_correct"] = 0.5
        elif path_frags >= 3:
            results["full_project_path_correct"] = 0.25

    has_2026_projects = bool(re.search(r'2026\s+Projects', content))
    if has_2026_projects:
        creation_terms = ['creat', 'establish', 'set up', 'new', 'missing',
                          'does not exist', 'not present', 'not yet', 'need']
        has_creation = any(t in content_lower for t in creation_terms)
        audit_ref = bool(re.search(
            r'audit.*no.*2026|no.*2026.*audit|2026.*not.*exist.*audit|'
            r'audit.*missing.*2026|existing.*folder.*no.*2026|'
            r'currently.*no.*2026',
            content_lower))
        existing_year_ref = bool(re.search(r'202[345]\s+projects', content_lower))
        if has_creation and audit_ref and existing_year_ref:
            results["year_folder_specified"] = 1.0
        elif has_creation and audit_ref:
            results["year_folder_specified"] = 0.75
        elif has_creation:
            results["year_folder_specified"] = 0.5
        else:
            results["year_folder_specified"] = 0.25

    mandatory = [
        '01_project_management', '02_design_documents', '03_calculations',
        '04_drawings', '05_procurement', '06_correspondence',
        '07_meeting_minutes', '08_quality_control', '09_deliverables', '10_archive'
    ]
    found_subs = sum(1 for s in mandatory if s in content_lower)
    if found_subs >= 10:
        results["all_subfolders_listed"] = 1.0
    elif found_subs >= 8:
        results["all_subfolders_listed"] = 0.75
    elif found_subs >= 5:
        results["all_subfolders_listed"] = 0.5

    old_pats = [r'v1\.0', r'version\s+1', r'superseded', r'\bold\b.*convention',
                r'legacy', r'previous.*convention', r'replaced', r'project\s+files']
    old_found = sum(1 for p in old_pats if re.search(p, content_lower))
    has_v1_date = bool(re.search(r'2021[\-/]03[\-/]15', content))
    if old_found >= 3 and has_v1_date:
        results["old_convention_discussed"] = 1.0
    elif old_found >= 3:
        results["old_convention_discussed"] = 0.75
    elif old_found >= 2:
        results["old_convention_discussed"] = 0.5
    elif old_found >= 1:
        results["old_convention_discussed"] = 0.25

    audit_names = ['huayang', 'donghai', 'westport', 'temp_new_project']
    found_names = sum(1 for n in audit_names if n in content_lower)
    analysis_terms = [
        'inconsisten', 'non.compliant', 'missing.*code', 'missing.*prefix',
        'wrong.*pattern', 'old.*root', 'non.standard', 'incorrect',
        'violat', 'deviat', 'does not follow', 'does not match', 'not comply'
    ]
    remed_terms = [r'remedia', r'correct.*path', r'migrat', r'rename.*to',
                   r'should\s+be', r'recommend.*renam', r'proposed.*path']
    has_analysis = any(re.search(t, content_lower) for t in analysis_terms)
    has_remediation = any(re.search(t, content_lower) for t in remed_terms)
    if found_names >= 3 and has_analysis and has_remediation:
        results["audit_findings_specific"] = 1.0
    elif found_names >= 3 and has_analysis:
        results["audit_findings_specific"] = 0.75
    elif found_names >= 2 and has_analysis:
        results["audit_findings_specific"] = 0.5
    elif found_names >= 1 and has_analysis:
        results["audit_findings_specific"] = 0.25

    # checklist — full marks require citing template version 2.1
    has_checkbox = bool(re.search(r'\-\s*\[[ x]\]', content))
    has_checklist_word = 'checklist' in content_lower
    has_verify = bool(re.search(r'verif', content_lower))
    has_section_ref = bool(re.search(
        r'section\s+[a-e]|section\s+[1-5]\b.*checklist', content_lower))
    has_signoff = bool(re.search(
        r'section\s+e|sign[\-\s]off|document\s+controller', content_lower))
    has_template_ver = bool(re.search(
        r'template.*version\s*2\.1|version\s*2\.1.*template|'
        r'checklist.*v?2\.1|v?2\.1.*checklist|template\s+v?2\.1',
        content_lower))
    cl_signals = sum([has_checkbox, has_checklist_word, has_verify])
    if cl_signals >= 2 and has_section_ref and has_signoff and has_template_ver:
        results["checklist_section_present"] = 1.0
    elif cl_signals >= 2 and has_section_ref and has_signoff:
        results["checklist_section_present"] = 0.75
    elif cl_signals >= 2 and has_section_ref:
        results["checklist_section_present"] = 0.5
    elif cl_signals >= 1:
        results["checklist_section_present"] = 0.25

    # isolation — full marks require citing IT-SEC-POL-2024-008
    has_isolat = bool(re.search(r'isolat', content_lower))
    has_project = bool(re.search(r'project', content_lower))
    enforce_terms = ['prohibit', 'forbid', 'restrict', 'not allow', 'strict',
                     'self.contain', 'no cross', 'must not', 'shall not']
    has_enforce = any(re.search(t, content_lower) for t in enforce_terms)
    doc_ref = bool(re.search(
        r'it.sec.pol|it\s+security\s+policy|naming_convention\.yaml|'
        r'folder_naming_convention\.yaml|it.sec.pol.2024|'
        r'section\s+[12].*approved|approved\s+storage',
        content_lower))
    has_policy_id = bool(re.search(
        r'IT[\-\s]?SEC[\-\s]?POL[\-\s]?2024[\-\s]?008', content, re.IGNORECASE))
    if has_isolat and has_project and has_enforce and doc_ref and has_policy_id:
        results["isolation_policy_addressed"] = 1.0
    elif has_isolat and has_project and has_enforce and doc_ref:
        results["isolation_policy_addressed"] = 0.75
    elif has_isolat and has_project and has_enforce:
        results["isolation_policy_addressed"] = 0.5
    elif has_isolat and has_project:
        results["isolation_policy_addressed"] = 0.25

    # ongoing docs — raised thresholds
    ongoing_pats = [
        r'milestone.*track', r'deliverable.*compil', r'progress.*summar',
        r'documentation.*track', r'ongoing.*document', r'periodic.*report',
        r'bi.?weekly.*summar', r'transmittal.*register',
        r'revision.*status', r'superseded.*version'
    ]
    ongoing_hits = sum(1 for p in ongoing_pats if re.search(p, content_lower))
    has_section_d = bool(re.search(
        r'section\s+d|ongoing\s+documentation\s+requirements', content_lower))
    if ongoing_hits >= 5 and has_section_d:
        results["ongoing_docs_requirements"] = 1.0
    elif ongoing_hits >= 4 and has_section_d:
        results["ongoing_docs_requirements"] = 0.75
    elif ongoing_hits >= 3:
        results["ongoing_docs_requirements"] = 0.5
    elif ongoing_hits >= 2:
        results["ongoing_docs_requirements"] = 0.25

    if re.search(r'\bbasic\s+design\b', content_lower):
        has_brief_ref = bool(re.search(r'project.brief|brief.*05TK', content_lower))
        if has_brief_ref:
            results["basic_design_phase"] = 1.0
        else:
            results["basic_design_phase"] = 0.75

    # json_paths_correct — nested-aware + 8-dimension check
    if json_data and isinstance(json_data, dict):
        jp_checks = 0

        code_val = _find_val(json_data, ["project_code", "code"])
        if code_val is not None and str(code_val).strip() == "05TK25002D":
            jp_checks += 1

        subs = None
        for k in ["subfolders", "sub_folders", "folders", "directories",
                   "children", "mandatory_subfolders"]:
            found = _find_val(json_data, [k])
            if found is not None and isinstance(found, list):
                subs = found
                break
        if subs is not None:
            sub_joined = " ".join(str(s).lower() for s in subs)
            matched = sum(1 for m in mandatory if m in sub_joined)
            if matched >= 10:
                jp_checks += 1
        else:
            json_str_lower = json.dumps(json_data).lower()
            matched = sum(1 for m in mandatory if m in json_str_lower)
            if matched >= 10:
                jp_checks += 1

        path_keys = ["project_folder", "project_path", "path",
                     "root_path", "full_path", "folder_path"]
        folder_val = _find_val(json_data, path_keys)
        if folder_val is not None:
            fv = str(folder_val).lower()
            if "05tk25002d" in fv and "my projects" in fv and "2026" in fv:
                jp_checks += 1

        conv_keys = ["convention_version", "naming_convention_version",
                     "naming_convention", "convention"]
        conv_ver = _find_val(json_data, conv_keys)
        if conv_ver is not None and str(conv_ver).strip() in ("2.3", "v2.3"):
            jp_checks += 1

        phase_keys = ["phase", "project_phase"]
        phase_val = _find_val(json_data, phase_keys)
        if phase_val is not None and str(phase_val).strip().lower() == "basic design":
            jp_checks += 1

        reg_keys = ["registered_date", "registration_date", "reg_date"]
        reg_val = _find_val(json_data, reg_keys)
        if reg_val is not None and str(reg_val).strip() == "2025-11-30":
            jp_checks += 1

        year_keys = ["year", "project_year"]
        year_val = _find_val(json_data, year_keys)
        if year_val is not None and str(year_val).strip() in ("2026",):
            jp_checks += 1

        json_str = json.dumps(json_data).lower()
        has_other_proj = "06tk26003b" in json_str
        if has_other_proj:
            jp_checks += 1

        if jp_checks >= 8:
            results["json_paths_correct"] = 1.0
        elif jp_checks >= 7:
            results["json_paths_correct"] = 0.75
        elif jp_checks >= 5:
            results["json_paths_correct"] = 0.5
        elif jp_checks >= 3:
            results["json_paths_correct"] = 0.25

    # it_handoff — raised quality bar
    md_quality = section_count >= 8 and doc_len >= 2000
    md_good = section_count >= 6 and doc_len >= 1500
    json_present = json_data is not None
    migration_present = os.path.isfile(migration_path)
    if md_quality and json_present and migration_present:
        results["it_handoff_quality"] = 1.0
    elif md_good and json_present and migration_present:
        results["it_handoff_quality"] = 0.75
    elif md_good and json_present:
        results["it_handoff_quality"] = 0.5
    elif section_count >= 4 and doc_len >= 800:
        results["it_handoff_quality"] = 0.25

    # audit cite — full marks require computed migration total
    problematic_numbers = ['623', '1567', '445', '1455.9', '3890.1', '1102.3']
    compliant_numbers = ['1847', '4523.6', '1203', '3210.8', '387', '892.5']
    prob_cited = sum(1 for n in problematic_numbers if n in content)
    comp_cited = sum(1 for n in compliant_numbers if n in content)
    total_cited = prob_cited + comp_cited
    has_migration_total = bool(re.search(
        r'2[,.]?637|6[,.]?448|6[,.]?4\s*GB|6\.3\s*GB|6\.4\s*GB|6\.5\s*GB',
        content, re.IGNORECASE))
    if has_migration_total and prob_cited >= 4 and total_cited >= 6:
        results["audit_quantitative_cite"] = 1.0
    elif has_migration_total and prob_cited >= 2:
        results["audit_quantitative_cite"] = 0.75
    elif prob_cited >= 4 and total_cited >= 6:
        results["audit_quantitative_cite"] = 0.75
    elif prob_cited >= 3:
        results["audit_quantitative_cite"] = 0.5
    elif prob_cited >= 2:
        results["audit_quantitative_cite"] = 0.25

    # registry — added Sunrise phase signal (6 total)
    rcv_signals = 0
    if re.search(r'2025[-/]11[-/]30|november\s+30[,\s]+2025|registered.*2025[-/]11',
                 content_lower):
        rcv_signals += 1
    if re.search(r'06TK26003B', content, re.IGNORECASE):
        rcv_signals += 1
    if re.search(r'sunrise\s+chemical', content_lower):
        rcv_signals += 1
    if re.search(r'08TK23007A', content, re.IGNORECASE):
        rcv_signals += 1
    if re.search(r'2025[-/]12[-/]15', content):
        rcv_signals += 1
    if re.search(r'preliminary\s+design', content_lower):
        rcv_signals += 1
    if rcv_signals >= 6:
        results["registry_cross_validation"] = 1.0
    elif rcv_signals >= 5:
        results["registry_cross_validation"] = 0.75
    elif rcv_signals >= 3:
        results["registry_cross_validation"] = 0.5
    elif rcv_signals >= 1:
        results["registry_cross_validation"] = 0.25

    # migration CSV — raised schema bar
    if os.path.isfile(migration_path):
        try:
            with open(migration_path, "r", encoding="utf-8") as f:
                mig_content = f.read()
            if not mig_content.strip():
                results["migration_csv_produced"] = 0.25
            else:
                mig_lower = mig_content.lower()
                reader = csv.reader(StringIO(mig_content))
                rows = list(reader)
                if len(rows) >= 2:
                    header = [h.lower().strip() for h in rows[0]]
                    has_old = any('current' in h or 'old' in h or 'existing' in h
                                  for h in header)
                    has_new = any('new' in h or 'recommend' in h or 'correct' in h
                                  for h in header)
                    has_score = any('score' in h or 'compliance' in h for h in header)
                    has_prio = any('priority' in h or 'urgency' in h for h in header)
                    audit_refs = sum(1 for name in ['huayang', 'donghai', 'westport', 'temp']
                                     if name in mig_lower)
                    data_rows = len(rows) - 1
                    has_quant = any(
                        k in header for k in
                        ['file_count', 'files', 'size', 'size_mb', 'volume',
                         'estimated_effort', 'effort', 'impact'])
                    schema_count = sum([has_old, has_new, has_score, has_prio])
                    if schema_count >= 4 and data_rows >= 4 and audit_refs >= 3 and has_quant:
                        results["migration_csv_produced"] = 1.0
                    elif schema_count >= 3 and data_rows >= 3 and audit_refs >= 3 and has_quant:
                        results["migration_csv_produced"] = 0.75
                    elif schema_count >= 3 and data_rows >= 3 and audit_refs >= 3:
                        results["migration_csv_produced"] = 0.5
                    elif schema_count >= 2 and data_rows >= 2 and audit_refs >= 2:
                        results["migration_csv_produced"] = 0.25
                    else:
                        results["migration_csv_produced"] = 0.25
                else:
                    results["migration_csv_produced"] = 0.25
        except Exception:
            results["migration_csv_produced"] = 0.25

    cross_codes = ['08tk23007a', '07tk24005d', '01tk22003b']
    cc_found = sum(1 for c in cross_codes if c in content_lower)
    if cc_found >= 3:
        results["cross_project_codes_verified"] = 1.0
    elif cc_found >= 2:
        results["cross_project_codes_verified"] = 0.5
    elif cc_found >= 1:
        results["cross_project_codes_verified"] = 0.25

    # v1/v2 diff — added v1.0 subfolder abbreviation check (5 signals)
    v1_has_8_subs = bool(re.search(
        r'(v1|version\s*1|old|legacy|superseded).*\b(8|eight)\b.*sub|'
        r'\b(8|eight)\b.*sub.*(v1|version\s*1|old|legacy)',
        content_lower))
    v1_root_diff = bool(re.search(r'project\s+files', content_lower) and
                        re.search(r'my\s+projects', content_lower))
    v1_isolation_diff = bool(re.search(
        r'(recommend|optional).*(v1|old)|strict.*(v2|current|2\.3)',
        content_lower) and re.search(r'isolat', content_lower))
    v1_pattern_diff = bool(re.search(
        r'(name.*_.*code|name.*before.*code).*(v1|old|superseded)|'
        r'(v1|old|superseded).*(name.*_.*code|name.*before.*code)',
        content_lower))
    v1_subfolder_names = bool(re.search(
        r'\b01_pm\b|\b02_design\b|\b03_calc\b|\b04_dwg\b|\b06_corr\b',
        content_lower))
    sd_count = sum([v1_has_8_subs, v1_root_diff, v1_isolation_diff,
                    v1_pattern_diff, v1_subfolder_names])
    if sd_count >= 4:
        results["v1_v2_structural_diff"] = 1.0
    elif sd_count >= 3:
        results["v1_v2_structural_diff"] = 0.75
    elif sd_count >= 2:
        results["v1_v2_structural_diff"] = 0.5
    elif sd_count >= 1:
        results["v1_v2_structural_diff"] = 0.25

    backup_fail_line = bool(re.search(
        r'backup.*(fail|unreachable|error)|\\\\backup[\-\\.]srv', content_lower))
    backup_fail_then_recover = bool(re.search(
        r'backup.{0,220}(fail|unreachable|error).{0,220}(retry|retried|success|successful|recover|recovered|synchroniz)',
        content_lower))
    backup_recover_context = bool(re.search(
        r'(initial|first).{0,120}backup.{0,160}(fail|unreachable|error).{0,160}'
        r'(retry|success|successful|recover|recovered|synchroniz)',
        content_lower))
    backup_retry_success_only = bool(re.search(
        r'backup.{0,140}(retry|retried).{0,100}(success|successful|synchroniz|synchronized)|'
        r'(retry|retried).{0,100}backup.{0,100}(success|successful|synchroniz|synchronized)',
        content_lower))
    if (backup_fail_line or backup_fail_then_recover or backup_recover_context
            or backup_retry_success_only):
        results["backup_failure_noted"] = 1.0
    elif re.search(r'backup.*(risk|concern|issue|warning)', content_lower):
        results["backup_failure_noted"] = 0.5

    if re.search(r'72\s*%', content):
        if re.search(r'(disk|drive|storage|capacity|space)', content_lower):
            results["disk_capacity_flagged"] = 1.0
        else:
            results["disk_capacity_flagged"] = 0.5
    elif re.search(r'(capacity|running.out|nearly.full|storage.warning)', content_lower):
        results["disk_capacity_flagged"] = 0.25

    # ACL / permission inheritance warning from log
    if re.search(r'acl|access\s+control\s+list', content_lower):
        if re.search(r'non[\-\s]standard|permission.*inherit|2\s+subfolder',
                     content_lower):
            results["acl_warning_noted"] = 1.0
        else:
            results["acl_warning_noted"] = 0.5
    elif re.search(r'permission.*(inherit|warning|review|anomal|non[\-\s]standard)',
                   content_lower):
        results["acl_warning_noted"] = 0.5

    # project brief numerical specs
    spec_signals = 0
    if re.search(r'300[,.]?000\s*(tonn|t/?a|tpa|metric)', content_lower):
        spec_signals += 1
    if re.search(r'\b18\s*months?\b', content_lower):
        spec_signals += 1
    if re.search(r'2027[\-/]07[\-/]15', content):
        spec_signals += 1
    if re.search(r'2026[\-/]01[\-/]15', content):
        spec_signals += 1
    if spec_signals >= 4:
        results["project_brief_specs_cited"] = 1.0
    elif spec_signals >= 3:
        results["project_brief_specs_cited"] = 0.75
    elif spec_signals >= 2:
        results["project_brief_specs_cited"] = 0.5
    elif spec_signals >= 1:
        results["project_brief_specs_cited"] = 0.25

    hard_keys = [
        "json_deliverable_valid", "json_paths_correct",
        "migration_csv_produced", "audit_quantitative_cite",
        "disk_capacity_flagged", "backup_failure_noted",
        "acl_warning_noted", "project_brief_specs_cited",
        "cross_project_codes_verified",
    ]
    hard_passed = sum(1 for hk in hard_keys if results.get(hk, 0) >= 0.75)

    doc_keys = [
        "naming_convention_applied", "full_project_path_correct",
        "all_subfolders_listed", "old_convention_discussed",
        "checklist_section_present", "isolation_policy_addressed",
        "ongoing_docs_requirements", "it_handoff_quality",
        "v1_v2_structural_diff", "registry_cross_validation",
    ]
    if hard_passed >= 8:
        cap = 1.0
    elif hard_passed >= 6:
        cap = 0.75
    elif hard_passed >= 4:
        cap = 0.5
    else:
        cap = 0.25
    for k in doc_keys:
        results[k] = min(results[k], cap)

    return results
```

## LLM Judge Rubric

### Criterion 1: Trap Detection and Cross-Reference Reasoning (Weight: 35%)
**Score 1.0**: Both traps are explicitly identified with thorough reasoning. For the project code discrepancy, the agent names the conflicting sources (registry/brief vs. `project_list_summary.csv` / project list summary), explains why the registry and brief are authoritative, and treats the spreadsheet row as suspect data quality — **without** requiring the erroneous code literal to be copied into the deliverables. For the naming convention conflict, the agent references both convention files by name, cites version numbers (v2.3 vs v1.0), effective dates, and superseded status, and explains why v2.3 was chosen. A generic response that merely uses the correct values without citing specific file names and version numbers cannot score 1.0.
**Score 0.75**: Both traps are identified and correct choices are made, but one explanation is shallow — e.g., mentions the discrepancy without fully attributing sources, or notes v1.0 is old without citing its version number or superseded status.
**Score 0.5**: Only one trap is explicitly discussed with reasoning while the other is silently resolved (correct choice but no explanation), OR both are mentioned with only vague justification.
**Score 0.25**: Neither trap is explicitly discussed, though correct values may have been used. No evidence of cross-referencing reasoning.
**Score 0.0**: No awareness of either data conflict, or actively uses incorrect values (e.g., uses `05TK25002B` or the v1.0 naming pattern `{project_name}_{project_code}`). If the output file `project_folder_structure_plan.md` does not exist, score 0 on all dimensions.

### Criterion 2: Existing Folder Audit Analysis Quality and Quantitative Rigor (Weight: 30%)
**Score 1.0**: The document provides a detailed analysis of the existing folder audit data, identifying at least 3 specific naming inconsistencies by project name from `existing_folder_audit.csv` (e.g., Huayang missing code prefix, Donghai using v1.0 underscore pattern, Westport under old `D:\Project Files` root, `temp_new_project` as non-standard). Notes the absence of a 2026 year folder. Cites specific quantitative data from the audit CSV — file counts and/or folder sizes for all 4 non-compliant folders (e.g., "Westport: 1567 files, 3890.1 MB", "Huayang: 623 files, 1455.9 MB") — AND computes the total migration volume (approximately 2,637 files / 6,448 MB). Offers actionable remediation recommendations with corrected paths. Notes the v1.0 subfolder abbreviations (01_PM, 02_Design, etc.) when comparing convention structures. All observations are grounded in actual audit data — not hallucinated. A response that cites individual folder numbers without computing the aggregate total cannot score 1.0. A generic statement like "some folders may not follow conventions" without citing specific project names and data from the CSV cannot score above 0.5.
**Score 0.75**: Identifies at least 2 inconsistencies with specific project names from the audit data. Notes missing 2026 folder. Cites quantitative data for at least 2–3 folders but does not compute the total migration volume. Recommendations are present but may lack corrected paths for all folders.
**Score 0.5**: Mentions the audit and notes the missing 2026 folder, but inconsistency analysis is vague without citing specific project names or quantitative data from the CSV. Or identifies only 1 inconsistency with a specific example.
**Score 0.25**: Audit section exists but contains only superficial statements with no data-driven observations, or observations appear hallucinated rather than drawn from the actual CSV.
**Score 0.0**: No audit analysis present, or entirely fabricated. If the output file does not exist, score 0 on all dimensions.

### Criterion 3: Deliverable Completeness and IT-Handoff Readiness (Weight: 35%)
**Score 1.0**: All three deliverables (`project_folder_structure_plan.md`, `folder_structure.json`, and `migration_recommendations.csv`) are present with high quality. The MD plan is well-organized (≥8 sections, ≥2000 characters) with clear sections covering: full project folder paths, all 10 mandatory subfolders, a completed checklist with verification items referencing checklist template sections and template version 2.1, ongoing documentation requirements (milestone tracking, deliverable compilation, progress summaries, transmittal register, revision status per Section D), project isolation policy with IT-SEC-POL-2024-008 citation, registry cross-validation (registered date, other 2026 projects with phase), project brief specs (capacity, timeline), and ACL/permission warnings from the log. The JSON file is valid, contains project metadata (code, name, phase, convention version, registered date, year), the correct project folder path, all 10 mandatory subfolder names, and references to other 2026 projects. The migration CSV maps all 4 non-compliant folders with corrected paths, compliance scores, priority ranking, and quantitative columns (file count/size). All three could be handed to IT for direct execution. A response missing the JSON deliverable or migration CSV entirely cannot score above 0.5.
**Score 0.75**: All three deliverables present. MD covers all major sections with minor gaps (e.g., missing template version, or ACL warning not flagged, or no computed migration total). JSON is valid but may be missing a metadata field (e.g., no registered date or year). Migration CSV has correct structure but may lack quantitative columns or be missing one non-compliant folder.
**Score 0.5**: Only two of three deliverables present (e.g., no migration CSV) but the MD plan and JSON are comprehensive. Or all three files exist but the MD is missing a significant component (no checklist, or no subfolder list) or the JSON/CSV is malformed/incomplete.
**Score 0.25**: Only one deliverable produced, and it is disorganized or missing multiple requested components. Would require significant rework.
**Score 0.0**: No meaningful deliverables, or output is incoherent. If the output file does not exist, score 0 on all dimensions.