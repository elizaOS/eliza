---
id: task_00095_prompt_injection_defense_framework_with_skill_creation
name: Prompt Injection Defense Framework with Skill Creation
category: Security and Vulnerability Management
subcategory: Security Detection and Hardening
grading_type: hybrid
grading_weights:
  automated: 0.4
  llm_judge: 0.6
verification_method: rubric
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: data/defense_architecture.yaml
  dest: data/defense_architecture.yaml
- source: data/attack_patterns.json
  dest: data/attack_patterns.json
- source: data/recent_incidents.csv
  dest: data/recent_incidents.csv
---

## Prompt

I need help building a prompt injection defense framework for our LLM-based assistant system. We've been seeing a lot of social engineering attacks in production lately, role-play manipulation, emotional pressure, authority impersonation, on top of the usual direct injection stuff.

I've put some reference material in the workspace. First, create an OpenClaw skill for prompt injection defense analysis, put it in the skills directory like any other skill.

Then build the main framework doc at `docs/defense-framework.md`. I need:
- Layered defense architecture based on our YAML draft cover all five layers with implementation guidance
- Attack examples with interception strategies, map the red team patterns to defense layers, especially the social engineering ones
- An attack-to-defense mapping matrix showing which layers catch which patterns
- Structured test case checklist, at least 10 cases a QA team can actually run, with IDs, attack vectors, expected outcomes, and layer references
- Analysis of the incident log, what's working, where are the gaps, what are the false positive rates

Also need a `config/security-policy.yaml` with sample policy config, thresholds, permission tiers, sanitization rules. Base the thresholds on what the incident data tells us, not arbitrary numbers. This feeds into our security review next week so it needs to be thorough and grounded in the actual data.

## Expected Behavior

The agent should:

1. **Review all three reference files** in the workspace:
   - `data/defense_architecture.yaml` contains a layered security model with 5 defense layers (instruction hierarchy with 5 priority levels 0-4, input sanitization with 4 stages, tool permissions with 4 tiers, content provenance with 5 source tags, and audit logging with 4 alerting rules). Each layer includes detailed sub-components, thresholds, and enforcement mechanisms.
   - `data/attack_patterns.json` contains 10 categorized attack patterns (PI-001 through PI-010) covering: direct injection (PI-001, PI-002), indirect injection (PI-003), social engineering (PI-004 authority impersonation, PI-005 emotional manipulation, PI-006 gradual escalation, PI-009 role-playing trap, PI-010 payload splitting), encoding obfuscation (PI-007), and tool abuse (PI-008). Each pattern includes severity, example payloads, detection signals, and mitigation references.
   - `data/recent_incidents.csv` contains 15 security incidents. The agent should derive key statistics: 8 incidents blocked (53.3% overall), 3 false positives (INC-2025-003 and INC-2025-010 for encoding obfuscation, INC-2025-014 for social engineering). Among 12 true attacks, 8 were blocked (66.7% true positive block rate). Critical finding: social engineering has the worst detection — 6 incidents total (5 true attacks, 1 false positive), only 1 blocked (20% true attack block rate). Direct injection, indirect injection, and tool abuse all show 100% block rates.

2. **Create a skill file** at `skills/<skill-name>/SKILL.md` (following OpenClaw skill directory convention at `~/.openclaw/workspace/skills/*/SKILL.md`) with proper YAML frontmatter containing `name:` and `description:` fields, and actionable markdown instruction sections that guide an agent through prompt injection defense analysis and hardening as a numbered step-by-step workflow. The skill should be genuinely reusable, not just a summary of the framework document.

3. **Create `docs/defense-framework.md`** containing:
   - A threat model overview explaining prompt injection and social engineering attack vectors in the context of LLM agent systems
   - A layered defense architecture section covering all five layers from the reference YAML (instruction priority isolation, input sanitization/detection, tool permission and confirmation, content source tagging, audit logging with alerting), expanded with implementation guidance and rationale
   - An attack examples section that integrates the 10 patterns from `attack_patterns.json`, mapping each to its relevant defense layer with concrete interception strategies. Social engineering vectors (PI-004, PI-005, PI-006, PI-009, PI-010) should receive in-depth treatment with specific detection heuristics and countermeasures.
   - An attack-to-defense mapping matrix (table format) showing which defense layers catch which attack patterns
   - A test case checklist with at least 10 structured test cases, each having an ID, description, attack vector or payload, expected blocking behavior, and defense layer reference
   - A gap analysis section that analyzes `data/recent_incidents.csv` to identify detection effectiveness by category, false positive patterns, the social engineering detection gap, and recommended threshold adjustments

4. **Create `config/security-policy.yaml`** with structured security policy configuration including:
   - Alert thresholds with specific risk score values informed by the incident data and reference architecture (which uses 0.3 / 0.6 / 0.85 for low / medium / high risk)
   - Permission tiers matching the 4-tier tool permission model from the reference architecture (read_only, limited_write, sensitive_action, critical_action)
   - Rate limiting rules
   - Sanitization pipeline configuration

### Ground Truth Anchors

- The incident log contains exactly 15 incidents: 8 blocked, 7 not blocked, 3 false positives
- True attack block rate: 8 out of 12 true attacks = 66.7%
- Social engineering: 6 incidents (5 true attacks + 1 false positive), only 1 blocked → 20% true attack block rate → this is the critical gap
- Direct injection: 3 incidents, 3 blocked → 100% block rate
- Encoding obfuscation: 2 incidents, both false positives → 0 true attacks detected, 100% false positive rate for this category
- Indirect injection: 2 incidents, 2 blocked → 100% block rate
- Tool abuse: 2 incidents, 2 blocked → 100% block rate
- The defense architecture YAML defines 5 priority levels (0-4), 4 sanitization stages, 4 permission tiers, 5 source tags, and 4 alerting rules
- The attack patterns JSON contains 10 patterns: PI-001 through PI-010, with bypass difficulty ranging from low to high

### Common Pitfalls — Expected Handling

- **The agent should synthesize across all three reference files**: Rather than treating each deliverable independently, the framework should show clear connections — attack patterns mapped to defense layers, incident data informing policy thresholds, gap analysis referencing specific pattern IDs.
- **The agent should derive specific statistics from the incident log**: Not just mention incidents generically, but compute blocking rates, false positive rates, and identify the social engineering gap with concrete numbers.
- **The agent should produce well-structured test cases**: Each test case should follow a consistent format with all required fields (ID, description, attack vector, expected behavior, defense layer), not just a numbered list of vague descriptions.
- **The agent should create a genuinely reusable SKILL.md**: The skill file should function as a standalone, step-by-step workflow guide for prompt injection defense work, not just a summary of the framework document.
- **The agent should calibrate policy thresholds using evidence**: The security-policy.yaml thresholds should relate to the risk scores and detection patterns observed in the incident data and reference architecture, not be arbitrary round numbers.

## Grading Criteria

- [ ] SKILL.md exists with proper YAML frontmatter (name and description fields) and actionable workflow steps
- [ ] docs/defense-framework.md exists with substantial content (>500 characters of meaningful framework documentation)
- [ ] docs/defense-framework.md covers all five required defense layers with technical implementation guidance
- [ ] docs/defense-framework.md contains attack examples with interception strategies for at least 5 distinct attack types
- [ ] Social engineering attack vectors are addressed in depth (role-play, emotional manipulation, authority impersonation, gradual escalation)
- [ ] docs/defense-framework.md contains a test case checklist with at least 10 structured test cases
- [ ] Test cases include IDs, attack vectors, expected blocking behaviors, and defense layer references
- [ ] config/security-policy.yaml exists with structured security policy content (alert thresholds, permissions, sanitization rules)
- [ ] Framework includes an attack-to-defense layer mapping matrix showing coverage relationships
- [ ] Framework includes analysis of incident log data with detection gap identification and false positive assessment
- [ ] Framework references specific attack pattern IDs from attack_patterns.json (e.g., PI-001, PI-004)
- [ ] Security policy contains concrete, calibrated thresholds (risk scores, rate limits, permission tiers)

## Automated Checks

```python
import os
import re

def grade(transcript: list, workspace_path: str) -> dict:
    scores = {
        "skill_md_exists_and_structured": 0.0,
        "defense_framework_exists": 0.0,
        "defense_framework_layers": 0.0,
        "defense_framework_attacks": 0.0,
        "social_engineering_coverage": 0.0,
        "defense_framework_test_cases": 0.0,
        "test_case_structure": 0.0,
        "security_policy_yaml_exists": 0.0,
        "attack_defense_mapping": 0.0,
        "incident_data_analysis": 0.0,
        "references_attack_pattern_ids": 0.0,
        "policy_thresholds_calibrated": 0.0,
    }

    # ── SKILL.md ──
    # Search skills/*/SKILL.md first (OpenClaw convention), then workspace root
    skill_path = None
    skills_dir = os.path.join(workspace_path, "skills")
    if os.path.isdir(skills_dir):
        for entry in os.listdir(skills_dir):
            entry_path = os.path.join(skills_dir, entry)
            if os.path.isdir(entry_path):
                candidate = os.path.join(entry_path, "SKILL.md")
                if os.path.isfile(candidate):
                    skill_path = candidate
                    break
    if skill_path is None:
        root_skill = os.path.join(workspace_path, "SKILL.md")
        if os.path.isfile(root_skill):
            skill_path = root_skill

    if skill_path:
        try:
            with open(skill_path, "r", encoding="utf-8") as f:
                skill_content = f.read()
            has_frontmatter = skill_content.strip().startswith("---")
            has_name = bool(re.search(r"(?i)name\s*:", skill_content[:500]))
            has_description = bool(
                re.search(r"(?i)description\s*:", skill_content[:500])
            )
            has_sections = (
                len(re.findall(r"^#{1,3}\s+", skill_content, re.MULTILINE)) >= 2
            )
            has_steps = bool(
                re.search(
                    r"(?i)(step\s*\d|workflow|procedure|\d+\.\s+\S)",
                    skill_content,
                )
            )
            if (
                has_frontmatter
                and has_name
                and has_description
                and has_sections
                and has_steps
            ):
                scores["skill_md_exists_and_structured"] = 1.0
            elif has_frontmatter and has_name and has_description and has_sections:
                scores["skill_md_exists_and_structured"] = 0.7
            elif has_frontmatter and (has_name or has_description):
                scores["skill_md_exists_and_structured"] = 0.4
            elif has_frontmatter:
                scores["skill_md_exists_and_structured"] = 0.2
        except Exception:
            pass

    # ── Defense Framework ──
    fw_path = os.path.join(workspace_path, "docs", "defense-framework.md")
    if not os.path.isfile(fw_path):
        for alt in [
            "docs/defense_framework.md",
            "docs/Defense-Framework.md",
            "docs/DEFENSE-FRAMEWORK.md",
            "defense-framework.md",
        ]:
            alt_path = os.path.join(workspace_path, alt)
            if os.path.isfile(alt_path):
                fw_path = alt_path
                break

    fw_content = ""
    if os.path.isfile(fw_path):
        try:
            with open(fw_path, "r", encoding="utf-8") as f:
                fw_content = f.read()
        except Exception:
            pass

    if fw_content:
        fw_lower = fw_content.lower()

        if len(fw_content.strip()) > 500:
            scores["defense_framework_exists"] = 1.0
        elif len(fw_content.strip()) > 100:
            scores["defense_framework_exists"] = 0.5

        # Layer coverage
        layer_keywords = [
            [
                "instruction priority",
                "instruction isolation",
                "priority isolation",
                "instruction hierarchy",
            ],
            [
                "input saniti",
                "input detect",
                "sanitiz",
                "input filter",
                "input validation",
            ],
            [
                "tool permission",
                "tool confirm",
                "permission gate",
                "tool access",
                "least privilege",
            ],
            ["content source", "source tag", "provenance", "content tagging"],
            ["audit log", "audit trail", "logging", "alert"],
        ]
        layers_found = sum(
            1
            for kws in layer_keywords
            if any(kw in fw_lower for kw in kws)
        )
        scores["defense_framework_layers"] = min(1.0, layers_found / 5.0)

        # Attack type coverage
        attack_keywords = [
            ["direct injection", "direct prompt"],
            ["indirect injection", "indirect prompt"],
            ["jailbreak", "jail break"],
            [r"role.?play", "social engineer", "persona", "impersonat"],
            ["emotion", "emotional manipul", "sympathy", "urgency"],
            ["encoding", "obfuscat", "token smuggl", "homoglyph"],
            ["tool abuse", "privilege escalat"],
        ]
        attacks_found = sum(
            1
            for kws in attack_keywords
            if any(re.search(kw, fw_lower) for kw in kws)
        )
        scores["defense_framework_attacks"] = min(1.0, attacks_found / 5.0)

        # Social engineering depth
        se_keywords = [
            [r"role.?play", r"roleplay", r"fiction.*boundar"],
            [r"emotional\s+manipul", r"emotional\s+pressure"],
            [r"authority.*impersonat", r"impersonat.*author", r"pose\s+as"],
            [r"gradual.*escalat", r"multi.?turn", r"conversation\s+drift"],
            [r"payload\s+split", r"split.*payload", r"cross.?turn"],
            [r"logic\s+trap"],
        ]
        se_found = sum(
            1
            for kws in se_keywords
            if any(re.search(kw, fw_lower) for kw in kws)
        )
        scores["social_engineering_coverage"] = min(1.0, se_found / 3.0)

        # Test case count
        tc_patterns = re.findall(
            r"(?i)(tc[-_]?\d{1,3}|test[\s_-]?case[\s_-]?\d{1,3})",
            fw_content,
        )
        test_section_match = re.search(
            r"(?i)(test\s*case|test\s*checklist|test\s*suite"
            r"|security\s*test|verification)"
            r"(.*?)(?=\n#{1,2}\s|\Z)",
            fw_content,
            re.DOTALL,
        )
        tc_count = 0
        if test_section_match:
            test_section = test_section_match.group(0)
            numbered_items = re.findall(
                r"(?i)(?:^\s*\d+[\.\)]\s|\|\s*TC)",
                test_section,
                re.MULTILINE,
            )
            tc_count = max(len(tc_patterns), len(numbered_items))
        else:
            tc_count = len(tc_patterns)

        if tc_count >= 10:
            scores["defense_framework_test_cases"] = 1.0
        elif tc_count >= 7:
            scores["defense_framework_test_cases"] = 0.7
        elif tc_count >= 4:
            scores["defense_framework_test_cases"] = 0.5
        elif tc_count >= 1:
            scores["defense_framework_test_cases"] = 0.25

        # Test case structure quality
        # When tc_count >= 4, tc_patterns already found TC entries in fw_content,
        # so use fw_content directly. The section regex uses non-greedy matching and
        # may latch onto a short mention of "test case" far from the actual checklist,
        # yielding struct_count=0 even when the document has a full structured table.
        _struct_scope = (
            fw_content if tc_count >= 4
            else (test_section_match.group(0) if test_section_match else "")
        )
        if _struct_scope:
            _scope_lower = _struct_scope.lower()
            has_table = bool(re.search(r"\|.*\|", _struct_scope))
            has_ids = bool(re.search(r"(?i)tc[-_]?\d", _struct_scope))
            has_expected = (
                "expected" in _scope_lower
                or "blocking" in _scope_lower
                or "outcome" in _scope_lower
            )
            has_layer_ref = "layer" in _scope_lower or "defense" in _scope_lower
            has_attack_vec = (
                "attack" in _scope_lower
                or "vector" in _scope_lower
                or "payload" in _scope_lower
            )
            struct_count = sum(
                [
                    has_table or has_ids,
                    has_expected,
                    has_layer_ref,
                    has_attack_vec,
                ]
            )
            scores["test_case_structure"] = min(1.0, struct_count / 3.0)
        elif tc_count > 0:
            scores["test_case_structure"] = 0.25

        # Attack-to-defense mapping matrix
        mapping_indicators = [
            r"(?i)(mapping|matrix|cross.?reference)",
            r"(?i)(attack.*layer|layer.*attack|pattern.*defense|defense.*pattern)",
            r"\|.*(?i:pi[-_]?\d|attack).*\|.*(?i:layer|defense).*\|",
        ]
        mapping_signals = sum(
            1 for p in mapping_indicators if re.search(p, fw_content)
        )
        if mapping_signals >= 2:
            scores["attack_defense_mapping"] = 1.0
        elif mapping_signals >= 1:
            scores["attack_defense_mapping"] = 0.5

        # References specific attack pattern IDs from assets
        pi_id_matches = re.findall(
            r"(?i)PI[-_\s]?0*(\d{1,3})", fw_content
        )
        referenced_ids = set()
        for num_str in pi_id_matches:
            num = int(num_str)
            if 1 <= num <= 10:
                referenced_ids.add(num)
        id_count = len(referenced_ids)
        if id_count >= 7:
            scores["references_attack_pattern_ids"] = 1.0
        elif id_count >= 4:
            scores["references_attack_pattern_ids"] = 0.6
        elif id_count >= 2:
            scores["references_attack_pattern_ids"] = 0.3

        # Incident data analysis
        incident_signals = [
            [r"(?i)incident", r"(?i)inc[-_]"],
            [r"(?i)false.?positive", r"(?i)false.?negative"],
            [
                r"(?i)block.*rate|detection.*rate|bypass.*rate",
                r"(?i)\d+\.?\d*\s*%",
            ],
            [r"(?i)gap.*analy|weak.*point|improvement|recommend"],
        ]
        inc_found = sum(
            1
            for kws in incident_signals
            if any(re.search(kw, fw_content) for kw in kws)
        )
        if inc_found >= 3:
            scores["incident_data_analysis"] = 1.0
        elif inc_found >= 2:
            scores["incident_data_analysis"] = 0.6
        elif inc_found >= 1:
            scores["incident_data_analysis"] = 0.3

    # ── Security Policy YAML ──
    yaml_path = os.path.join(workspace_path, "config", "security-policy.yaml")
    if not os.path.isfile(yaml_path):
        for alt in [
            "config/security-policy.yml",
            "config/security_policy.yaml",
            "config/security_policy.yml",
        ]:
            alt_path = os.path.join(workspace_path, alt)
            if os.path.isfile(alt_path):
                yaml_path = alt_path
                break

    yaml_content = ""
    if os.path.isfile(yaml_path):
        try:
            with open(yaml_path, "r", encoding="utf-8") as f:
                yaml_content = f.read()
        except Exception:
            pass

    if yaml_content:
        yaml_lower = yaml_content.lower()
        has_alert = "alert" in yaml_lower or "threshold" in yaml_lower
        has_permission = "permission" in yaml_lower or "access" in yaml_lower
        has_sanitiz = (
            "saniti" in yaml_lower
            or "filter" in yaml_lower
            or "rule" in yaml_lower
        )
        section_count = sum([has_alert, has_permission, has_sanitiz])
        if section_count >= 3 and len(yaml_content.strip()) > 100:
            scores["security_policy_yaml_exists"] = 1.0
        elif section_count >= 2:
            scores["security_policy_yaml_exists"] = 0.7
        elif section_count >= 1:
            scores["security_policy_yaml_exists"] = 0.4

        # Policy thresholds calibrated
        has_risk_scores = bool(
            re.search(r"(?i)(risk.?score|0\.\d{1,2}|threshold)", yaml_content)
        )
        has_tiers = bool(
            re.search(
                r"(?i)(tier|read.?only|sensitive.?action|critical.?action|limited.?write)",
                yaml_content,
            )
        )
        has_rate_limits = bool(
            re.search(
                r"(?i)(rate.?limit|\d+\s*/\s*minute|\d+\s*per)", yaml_content
            )
        )
        has_specific_values = bool(re.search(r"0\.\d{1,2}", yaml_content))
        cal_count = sum(
            [has_risk_scores, has_tiers, has_rate_limits, has_specific_values]
        )
        if cal_count >= 3:
            scores["policy_thresholds_calibrated"] = 1.0
        elif cal_count >= 2:
            scores["policy_thresholds_calibrated"] = 0.6
        elif cal_count >= 1:
            scores["policy_thresholds_calibrated"] = 0.3

    return scores
```

## LLM Judge Rubric

**Global Rule**: If the main output files (`SKILL.md`, `docs/defense-framework.md`, `config/security-policy.yaml`) do not exist, all dimensions should receive a score of 0.0.

### Defense Architecture Depth and Completeness (Weight: 25%)
Evaluate how thoroughly the defense framework covers the five required layers (instruction priority isolation, input sanitization/detection, tool permission and confirmation, content source tagging, audit logging with alerting) and whether each layer is explained with technical depth that builds on `data/defense_architecture.yaml`.

- 1.0: All five layers are covered in detail with implementation guidance that extends the reference architecture. Architecture is cohesive with clear inter-layer relationships and production-ready specifics.
- 0.75: All five layers are present with good detail on most. Minor gaps in implementation specifics for one or two layers.
- 0.5: At least four layers are covered, but explanations are surface-level or do not integrate the reference architecture meaningfully.
- 0.25: Only two or three layers are addressed, or coverage is very shallow across the board.
- 0.0: Fewer than two layers are meaningfully addressed, or the content is generic/irrelevant. Score 0 if the file does not exist.

### Social Engineering Attack Coverage and Depth (Weight: 20%)
Assess how well the framework addresses complex social engineering attack vectors specifically (role-play manipulation, emotional manipulation, authority impersonation, gradual escalation, payload splitting) beyond basic direct/indirect injection, referencing specific patterns from `data/attack_patterns.json`.

- 1.0: At least 4 distinct social engineering vectors are described with concrete attack examples, detection heuristics, and interception strategies. References specific pattern IDs (e.g., PI-004, PI-005, PI-006, PI-009, PI-010) and demonstrates understanding of adversarial psychology.
- 0.75: 3-4 social engineering vectors covered with good examples and strategies, though some may lack depth or not cite specific pattern IDs.
- 0.5: Social engineering is mentioned and 1-2 vectors are explored, but coverage is incomplete or examples are generic.
- 0.25: Social engineering is only briefly mentioned without meaningful attack examples or defense strategies.
- 0.0: Social engineering attacks are not addressed. Score 0 if the file does not exist.

### Test Case Quality and Executability (Weight: 20%)
Evaluate the test case checklist for structure, coverage, and practical executability. Each test case should have a clear ID, description, attack payload or scenario, expected blocking behavior, and defense layer mapping.

- 1.0: 10+ well-structured test cases with IDs, clear attack scenarios, expected outcomes, and defense layer mappings. Cases cover multiple defense layers and include social engineering scenarios. Practically executable by a QA team.
- 0.75: 8-10 test cases with good structure covering most defense layers. Minor gaps in specificity or layer coverage.
- 0.5: 5-7 test cases present but structure is inconsistent, or they only cover basic attack types.
- 0.25: Fewer than 5 test cases, or they lack structure and actionable detail.
- 0.0: No meaningful test cases provided. Score 0 if the file does not exist.

### Asset Utilization and Cross-Referencing (Weight: 20%)
Evaluate how effectively the agent integrated and cross-referenced the three provided reference files (`data/defense_architecture.yaml`, `data/attack_patterns.json`, `data/recent_incidents.csv`) throughout the deliverables.

- 1.0: All three reference files are clearly utilized. Framework maps attack patterns to defense layers by ID, incident data analysis drives specific recommendations (e.g., social engineering gap identification, false positive rate for encoding obfuscation), and security policy thresholds are grounded in the reference data. Cross-file connections are explicit and data-driven.
- 0.75: Two reference files well-utilized and one partially used. Some cross-referencing present but connections could be more explicit.
- 0.5: Reference files mentioned but not meaningfully integrated. Deliverables could have been produced without the reference data.
- 0.25: Minimal use of reference files. Analysis is generic rather than data-driven.
- 0.0: Reference files ignored. Score 0 if the main deliverable files do not exist.

### Skill File Quality and Reusability (Weight: 15%)
Evaluate the SKILL.md file for proper structure (YAML frontmatter with name/description), clarity of instructions, reusability as an OpenClaw skill, and relevance to prompt injection defense. Should follow established skill design patterns with step-by-step workflow guidance.

- 1.0: SKILL.md has proper YAML frontmatter, clear name and description, well-organized step-by-step instruction sections, and is genuinely reusable as a workflow for prompt injection defense analysis. Demonstrates awareness of OpenClaw skill design patterns.
- 0.75: Proper structure and good content, but could be more actionable or better organized as a reusable workflow.
- 0.5: Basic structure is present but content is thin or not clearly reusable as a standalone skill.
- 0.25: File exists but lacks proper frontmatter or meaningful skill instructions.
- 0.0: SKILL.md is missing or empty.
