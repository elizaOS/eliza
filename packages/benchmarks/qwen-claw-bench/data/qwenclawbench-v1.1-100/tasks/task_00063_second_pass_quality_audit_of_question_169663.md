---
id: task_00063_second_pass_quality_audit_of_question_169663
name: Second-Pass Quality Audit of Question 169663
category: Data Analysis and Modeling
grading_type: hybrid
verification_method: rubric
timeout_seconds: 1800
grading_weights:
  automated: 0.35
  llm_judge: 0.65
workspace_files:
- source: data/questions_batch_42.json
  dest: data/questions_batch_42.json
- source: data/first_pass_audit.json
  dest: data/first_pass_audit.json
- source: svg/169663.svg
  dest: svg/169663.svg
- source: data/answer_key_v2.csv
  dest: data/answer_key_v2.csv
- source: data/answer_key_v1.csv
  dest: data/answer_key_v1.csv
- source: data/answer_key_v3.csv
  dest: data/answer_key_v3.csv
- source: config/audit_rules.yaml
  dest: config/audit_rules.yaml
- source: data/math_formulas_reference.md
  dest: data/math_formulas_reference.md
- source: logs/audit_system.log
  dest: logs/audit_system.log
- source: data/difficulty_ratings.csv
  dest: data/difficulty_ratings.csv
- source: svg/169660.svg
  dest: svg/169660.svg
- source: data/svg_audit_checklist.json
  dest: data/svg_audit_checklist.json
- source: reports/batch_42_summary.md
  dest: reports/batch_42_summary.md
subcategory: Quality Auditing and Diagnosis
---
## Prompt

Our first-pass audit on Batch 42 came back clean — all questions passed. But a teacher who used question **169663** in class said the numbers didn't add up when her students tried solving it. She wants us to take another look.

Everything's in the workspace — question bank at `data/questions_batch_42.json`, first-pass results at `data/first_pass_audit.json`, SVGs in `svg/`, answer keys in `data/`, audit config at `config/audit_rules.yaml`, SVG audit checklist at `data/svg_audit_checklist.json`, and some reference material. Do a thorough second-pass on 169663 and figure out what's going on.

Write up your findings in `audit_report.md` — what you looked at, what you found, the math you checked. I also want to understand how the first-pass review missed whatever you find, so walk me through the gaps in their process. Then give me the verdict in `audit_result.json` (fields: `question_id`, `is_really_wrong`, `confidence`, `issues`). If there are problems, fix the question in `corrected_question.json` — make sure the corrected analysis walks through the right methodology step by step, not just the final number. Run through the rules in the audit config — log those results in `config_compliance.csv` (`rule_name`, `status`, `severity`, `evidence`), include severity levels from the config.

Rank every issue you find by severity in `severity_ranking.json` — I need to know what to fix first, with references to which audit rules each one violates.

Also, put together a `validate_batch.py` that checks ALL questions in the batch for duplicate options, answer-key consistency across the key files, and SVG integrity (hidden text, answer leaks). Run the SVG checks from `data/svg_audit_checklist.json` against the batch SVGs. I've got a feeling 169663 might not be the only one with problems — have the script also output a `cross_reference_matrix.csv` comparing the three answer keys for every question in the batch.

Flag anything that looks off — better safe than sorry with student-facing content.

## Expected Behavior

The agent must perform a comprehensive second-pass audit of question 169663, produce a detailed analysis report, a validation script, and identify **all three** critical issues:

### Issue 1: Deceptive analysis methodology error — semicircle diameter incorrectly re-added
The question describes a composite shape: a rectangle (8cm × 5cm) with a semicircle attached to one short side (diameter = 5cm). Using the rules and formulas in `data/math_formulas_reference.md`:
- Section 6 states: "When a semicircle replaces one side of a rectangle, subtract that side length and add the semicircle arc length"
- Formula: Perimeter = 2 × length + width + π × width ÷ 2
- Applying to the question: P = 2(8) + 5 + 3.14 × 5 / 2 = 16 + 5 + 7.85 = **28.85 cm**
- Equivalently: Rectangle perimeter 2(8+5) = 26cm → subtract shared edge 26 − 5 = 21cm → add arc 7.85cm → total 28.85cm

The question's analysis correctly identifies that the semicircle replaces one width side and correctly performs the initial steps:
- Rectangle perimeter: (8+5)×2 = 26cm ✓
- Subtracts the shared edge: 26 − 5 = 21cm ✓
- Semicircle arc length: 3.14 × 5 ÷ 2 = 7.85cm ✓

But then makes a critical error: it treats the semicircle as contributing BOTH its arc (7.85cm) AND its diameter (5cm) to the perimeter, computing 21 + 7.85 + 5 = 33.85cm. This is wrong because the semicircle's diameter IS the shared edge that was already subtracted — it is an internal boundary between the rectangle and semicircle, not part of the outer perimeter. The correct perimeter only includes the arc: 21 + 7.85 = **28.85cm**.

This error is particularly deceptive because:
- The analysis explicitly shows the shared-edge subtraction step (giving a false sense of methodological rigor)
- The reasoning "semicircle = arc + diameter" sounds geometrically plausible to a casual reviewer
- The arithmetic is internally consistent (21 + 7.85 + 5 = 33.85)
- The error corresponds exactly to Common Mistake #3 in Section 7 of the reference: "Including the diameter of the semicircle when it's an internal edge"
- The first-pass auditor's notes in `data/first_pass_audit.json` explicitly state the "analysis methodology verified — correctly accounts for semicircle construction via subtraction and addition steps," which is actively misleading

The agent must: (a) apply the formula from Section 6 independently to get 28.85cm, (b) recognize that the analysis arriving at 33.85cm is wrong despite showing a subtraction step, and (c) specifically identify that the diameter was incorrectly re-added after the shared edge was subtracted. The worked example in Section 6 uses different dimensions (12×7), so the agent cannot simply copy its answer.

No answer key provides the correct value: `data/answer_key_v1.csv` says B/33.85, `data/answer_key_v2.csv` says C/31.85, and `data/answer_key_v3.csv` says A/36.85. All three disagree, and none matches the correct value of 28.85cm. The agent must perform independent calculation and not trust any answer key. None of the four answer options (A: 36.85, B: 33.85, C: 31.85, D: 33.85) equals the correct answer of 28.85cm, meaning the question itself is fundamentally broken.

### Issue 2: Duplicate answer options (B and D are identical)
Options B and D both read "33.85厘米". This violates the audit rules in `config/audit_rules.yaml` which specify `allow_duplicates: false`. The first-pass audit in `data/first_pass_audit.json` completely missed this. The agent should detect that two options have identical text.

### Issue 3: SVG answer leak amid multiple hidden elements
The SVG file `svg/169663.svg` contains five near-invisible text elements in an annotation group (`<g id="qa-meta">`). The agent must inspect the raw SVG XML and evaluate each hidden element individually:

1. **Tracking ID** (`qc:b42-169663-r2`): opacity 0.04, font-size 3, fill #fefefe — asset management metadata, not an answer leak
2. **Perimeter value** (`周长=33.85厘米`): opacity 0.03, font-size 4, fill white — **this is the answer leak**, as the value 33.85 matches answer options B and D
3. **Area red herring** (`面积=40平方厘米`): opacity 0.05, font-size 3, fill #fdfdfd — an area annotation that does not match any answer option, not an answer leak
4. **Incorrect formula** (`P=2(l+w)+πd/2`): opacity 0.02, font-size 2, fill white — a hidden formula that, if followed, would yield the wrong answer (26+7.85=33.85); this is a formula artifact, not an answer leak per se, but reinforces the wrong methodology
5. **Review stamp** (`review:approved:auditor_07:20241115`): opacity 0.03, font-size 2, fill #fefefe — a review tracking stamp, not answer-relevant content

Per the audit rules (`svg_rules.check_answer_leak: true`, `leak_verdict: 'svg_error'`), element #2 must be flagged because its value matches an answer option. The agent should distinguish this genuine answer leak from the other four non-leak elements (metadata, red herrings, formula artifacts). The hidden incorrect formula (#4) is an additional complexity trap — it matches the analysis's wrong methodology and could mislead an agent that encounters it before doing independent calculation. The first-pass audit marked the SVG as having no issues.

### Expected Deliverables

**`audit_report.md`** should contain:
- A walkthrough of the audit methodology and files examined
- Step-by-step perimeter calculation with intermediate values (26cm, 21cm, 7.85cm, 28.85cm), demonstrating the shared-edge subtraction, with explicit reference to the formula from `data/math_formulas_reference.md` Section 6
- Cross-reference analysis between all three answer key files showing their mutual disagreement
- Specific evidence for each issue found (quoting SVG source attributes, explaining the analysis methodology error, etc.)
- References to specific rules from `config/audit_rules.yaml` by name (e.g. `allow_duplicates`, `check_answer_leak`, `verify_analysis_math`, `judgment_policy`) when reporting violations
- References to relevant SVG audit checks from `data/svg_audit_checklist.json` (e.g. SVG-01, SVG-02)
- A first-pass gap analysis section explaining how the initial audit by auditor_07 missed these issues and what process failures allowed them through

**`audit_result.json`** should contain:
- `question_id`: 169663
- `is_really_wrong`: true
- `confidence`: "high" (given clear evidence of multiple quality issues)
- `issues`: an array containing at least 3 entries covering the math/answer error, duplicate options, and SVG answer leak, with each issue citing the relevant workspace file(s) as evidence sources

**`corrected_question.json`** should contain:
- The original question structure with corrected answer options (one option must be 28.85cm)
- No duplicate option values
- Correct labeled answer pointing to 28.85cm
- Updated analysis text that correctly walks through the methodology: rectangle perimeter → subtract shared edge → add arc length, showing intermediate steps (not just the final answer)

**`config_compliance.csv`** should contain:
- One row per rule from `config/audit_rules.yaml`
- Columns: `rule_name`, `status` (pass/fail), `severity` (from the config's categories), `evidence` (brief justification)
- At least the `allow_duplicates`, `check_answer_leak`, and `verify_analysis_math` rules should show "fail" status

**`severity_ranking.json`** should contain:
- An array of issues ranked from most to least critical
- Each entry should include a severity level (e.g. "critical", "major", "minor"), the specific audit rule it violates, and a description
- At least 3 issues ranked

**`validate_batch.py`** should:
- Read `data/questions_batch_42.json` and the answer key CSV files
- Check each question for duplicate option values
- Cross-reference answer keys for consistency (detect when different keys disagree on the correct answer for any question)
- Check SVG files for hidden text and answer leaks using criteria from `data/svg_audit_checklist.json`
- Output a `cross_reference_matrix.csv` comparing the three answer keys across all questions in the batch

**`cross_reference_matrix.csv`** should contain:
- A row per question in the batch
- Columns showing the answer from each key file (v1, v2, v3) and whether they agree
- Should reveal discrepancies not just for 169663 but also for any other questions where keys disagree (e.g. 169665 where v2 gives a different value, 169668 where v3 gives a different option letter)

### Batch-Wide Discrepancies

Beyond question 169663, the answer keys contain additional discrepancies that the `validate_batch.py` and `cross_reference_matrix.csv` should detect:

- **169665**: `answer_key_v2.csv` lists the value as 624, while `answer_key_v1.csv` and `answer_key_v3.csv` both list 623. The question (245 + 378) has the correct answer of 623, making v2's entry an off-by-one data entry error. This is subtle and easily overlooked.
- **169668**: `answer_key_v3.csv` lists the option letter as A, while `answer_key_v1.csv` and `answer_key_v2.csv` both list B. The value (113.04) is the same across all three, but the option letter mismatch means v3 points to the wrong option.

These are NOT issues with the questions themselves — the questions in `data/questions_batch_42.json` are correct. They are purely answer-key data integrity issues that a thorough batch-level validation should catch.

### Quality Levels

**Basic completion**: The agent produces `audit_result.json` and `audit_report.md`, correctly identifies `is_really_wrong: true`, and finds at least 1-2 of the three issues with 169663. The audit report exists but may be superficial — stating the answer is wrong without explaining the specific methodology error. Supplementary deliverables (`corrected_question.json`, `config_compliance.csv`, `validate_batch.py`, `severity_ranking.json`, `cross_reference_matrix.csv`) may be absent or incomplete. SVG inspection, if performed, may not cite specific hidden element attributes.

**Competent completion**: The agent finds all three issues and provides supporting evidence including the correct value of 28.85cm from independent calculation. However, the analysis may not fully explain *why* the error is deceptive — e.g., it identifies the diameter re-addition but does not connect it to the subtraction step that creates false confidence, or it finds the SVG leak but does not classify the other hidden elements. At least 4 supplementary deliverables are produced but may not meet professional quality (e.g., severity ranking exists but lacks specific rule references, config compliance report lacks severity column, cross-reference matrix does not reveal batch-wide discrepancies beyond 169663).

**High-quality completion**: The agent demonstrates expert-level audit capability across all five evaluation dimensions: (1) **Mathematical Rigor** — not only calculates 28.85cm independently with all intermediate steps (26→21→7.85→28.85), but explains the trap mechanism: the subtraction step creates false rigor, the "semicircle = arc + diameter" reasoning sounds plausible, the arithmetic is self-consistent (21+7.85+5=33.85), and this corresponds to Common Mistake #3 in the reference document. (2) **SVG Forensics** — enumerates all five hidden elements individually, classifies each by type (answer leak / tracking metadata / area red herring / formula artifact / review stamp), cites technical attributes, and notes the hidden formula reinforces the wrong methodology. (3) **Systematic Audit** — analyzes why the first-pass failed as a systemic process issue (confirmation bias in auditor_07, no independent verification, no XML-level inspection, no cross-key validation), not just that it missed things; identifies the system log re-verification as rubber-stamping the same error. (4) **Deliverable Quality** — all seven deliverables produced at professional quality: corrected question with methodology-correct analysis, rule-by-rule compliance with severity levels citing rules by name, ranked issues referencing audit rules, functional batch validation script checking options + keys + SVG, and cross-reference matrix revealing discrepancies in 169665 and 169668. (5) **Source Credibility** — does not defer to any single authority source, rejects the misleading log re-verification, and cross-references all three answer keys showing three-way disagreement as systemic evidence.

### Common Pitfalls — Expected Correct Handling

The agent should demonstrate critical, independent reasoning throughout the audit:

- **Deceptive analysis with correct-looking subtraction**: The question's analysis explicitly subtracts the shared edge (26−5=21) but then incorrectly adds the semicircle diameter back (21+7.85+5=33.85). Because the subtraction step is visible, a casual reviewer might assume the shared-edge issue is handled. The agent must recognize that the diameter IS the shared edge and should not be re-added — only the arc contributes to the outer perimeter. Section 7 Common Mistake #3 ("Including the diameter of the semicircle when it's an internal edge") directly describes this error.
- **Misleading first-pass notes**: The first-pass audit for 169663 explicitly states "Analysis methodology verified — correctly accounts for semicircle construction via subtraction and addition steps." The agent must not defer to this assessment — the first-pass auditor was also fooled by the deceptive subtraction step.
- **Formula reference dimensions**: The worked example in Section 6 uses different dimensions (12×7 → 41.99cm). The agent must apply the general formula or step-by-step method to the question's specific dimensions (8×5) rather than copying the example answer.
- **Three conflicting answer keys**: `data/answer_key_v1.csv` (B/33.85), `data/answer_key_v2.csv` (C/31.85), and `data/answer_key_v3.csv` (A/36.85) all disagree. The agent should recognize this widespread disagreement as a strong signal and perform independent verification rather than trusting any single key.
- **SVG hidden content discrimination**: The SVG contains five near-invisible elements with varying attributes. The agent should examine the raw XML, enumerate individual hidden elements, identify which contain answer-relevant content (the perimeter value matching an option), and distinguish these from innocuous metadata (tracking IDs, area annotations, formula artifacts, review stamps). The hidden incorrect formula (`P=2(l+w)+πd/2`) is a trap that reinforces the wrong methodology.
- **Noise files**: The agent should focus on the core question data, SVG, and audit rules, and correctly treat system logs and difficulty ratings as irrelevant to the audit verdict.
- **Misleading system log entry**: The `logs/audit_system.log` contains an entry "Re-check requested for Q169663: auditor_07 re-verified perimeter=33.85cm against labeled answer — PASS confirmed". This is a false trail — the "re-verification" merely confirmed the same wrong value (33.85cm) without catching the methodology error. The agent should not treat system log entries as authoritative verification.
- **First-pass false confidence**: The `data/first_pass_audit.json` entry for 169663 states "Question reviewed. SVG renders correctly. Options and answer verified." — all three of these claims are demonstrably wrong (SVG contains hidden text, options have duplicates, answer is incorrect). The agent should analyze what specific process failures led to these false claims passing the first audit.
- **Batch-wide tunnel vision**: Focusing exclusively on 169663 and missing that answer keys for other questions also have discrepancies. The `validate_batch.py` should reveal problems in 169665 (v2 value off by one) and 169668 (v3 option letter mismatch).

## Grading Criteria

- [ ] Output file `audit_result.json` exists (`output_file_exists`)
- [ ] `audit_result.json` is valid JSON with all four required fields (`question_id` = 169663, `is_really_wrong` boolean, `confidence` string, `issues` array) and correct types (`valid_json_structure`)
- [ ] `is_really_wrong` field is set to `true` (`is_really_wrong_true`)
- [ ] `confidence` field indicates high or medium confidence (`confidence_appropriate`)
- [ ] `issues` array contains at least 3 substantive entries (≥10 chars each) citing specific numerical values (28.85, 33.85, 31.85, 36.85) or technical details (opacity 0.03, font-size), with the independently calculated value 28.85 appearing in at least one issue; full credit requires each issue to also cite the relevant source file (e.g. `answer_key_v1`, `169663.svg`, `math_formulas`) (`issues_array_quality`)
- [ ] Issues identify the analysis methodology error — the analysis correctly subtracts the shared edge (26−5=21) but then incorrectly re-adds the semicircle diameter (21+7.85+5=33.85), when only the arc should be added (21+7.85=28.85); full credit requires identifying the diameter re-addition error specifically and referencing the formula from `math_formulas_reference.md` (`detects_analysis_error`)
- [ ] Issues include the correct perimeter value of 28.85cm, demonstrating independent calculation rather than trusting existing answer keys (`correct_perimeter_value`)
- [ ] Issues identify that none of the four answer options (A: 36.85, B: 33.85, C: 31.85, D: 33.85) matches the correct value of 28.85cm (`detects_no_correct_option`)
- [ ] Issues identify duplicate answer options — B and D are both "33.85厘米" (`detects_duplicate_options`)
- [ ] Issues identify hidden text in the SVG source code that leaks an answer, citing specific technical attributes (opacity, font-size, fill) (`detects_svg_hidden_content`)
- [ ] Issues identify the conflict between all three answer key files — v1 says B/33.85, v2 says C/31.85, v3 says A/36.85, and none matches the correct value (`identifies_answer_key_conflict`)
- [ ] Audit report `audit_report.md` exists and contains substantive analysis (≥500 chars for full credit, ≥200 chars for partial) (`audit_report_exists`)
- [ ] Audit report contains step-by-step perimeter calculation showing all intermediate values including the shared-edge subtraction (26, 21, 7.85, 28.85), with explicit reference to the formula from `data/math_formulas_reference.md` Section 6 or the composite shape perimeter formula (`report_shows_calculations`)
- [ ] `corrected_question.json` exists, is valid JSON with `question_id` 169663, includes 28.85cm as the correct answer, has no duplicate options, and the corrected analysis text shows the shared-edge subtraction methodology (intermediate value 21 or explicit subtraction of 5 from 26) (`corrected_question_valid`)
- [ ] `config_compliance.csv` exists with a severity column, references specific rule names from `config/audit_rules.yaml` (e.g. `allow_duplicates`, `check_answer_leak`, `verify_analysis_math`), has at least 5 data rows and correctly identifies failing rules (`config_compliance_report`)
- [ ] Audit report references at least 6 specific rules/checks by name from `config/audit_rules.yaml` (e.g. `allow_duplicates`, `check_answer_leak`, `verify_analysis_math`, `judgment_policy`, `require_consistent_keys`) and `data/svg_audit_checklist.json` (e.g. SVG-01, SVG-02) (`report_cites_audit_rules`)
- [ ] Issues in `audit_result.json` cite specific workspace files as evidence sources (≥5 file references including answer_key_v3) (`issues_cite_sources`)
- [ ] `validate_batch.py` exists with valid Python syntax, checks duplicate options, cross-references answer keys, checks SVG files for hidden text/answer leaks, and outputs a `cross_reference_matrix.csv` (`validate_script_quality`)
- [ ] `severity_ranking.json` exists, is valid JSON with at least 3 issues each containing a severity level (e.g. "critical") and referencing a specific audit rule it violates (`severity_ranking_valid`)
- [ ] Audit report contains a first-pass gap analysis explaining how the initial audit missed the identified issues, what process failures occurred, and why the first-pass claims ("SVG renders correctly", "Options and answer verified") were wrong (`first_pass_gap_analysis`)
- [ ] `cross_reference_matrix.csv` exists with answer key comparisons across all batch questions, including columns for v1/v2/v3 answers, and identifies discrepancies beyond 169663 (e.g. 169665 value mismatch in v2, 169668 option mismatch in v3) (`batch_cross_reference`)
- [ ] Audit report or issues reference specific sections or formulas from `data/math_formulas_reference.md` — e.g. Section 6 composite shape formula, Section 7 Common Mistakes #3 about diameter as internal edge, or the explicit formula P = 2l + w + πw/2 (`formula_reference_cited`)
- [ ] Issues or report enumerate individual SVG hidden elements and distinguish the answer leak (周长=33.85) from non-leak elements (tracking ID, area annotation, incorrect formula, review stamp); full credit requires identifying ≥3 distinct hidden elements and categorizing the perimeter value as the actual leak (`svg_element_discrimination`)
- [ ] `corrected_question.json` includes an `analysis` field demonstrating correct methodology — showing the shared-edge subtraction (26−5=21 or intermediate value 21) and arriving at 28.85 by adding only the arc (not the diameter) (`corrected_analysis_methodology`)

## Automated Checks

```python
import json
import os
import re
import ast

def grade(transcript: list, workspace_path: str) -> dict:
    results = {
        "output_file_exists": 0.0,
        "valid_json_structure": 0.0,
        "is_really_wrong_true": 0.0,
        "confidence_appropriate": 0.0,
        "issues_array_quality": 0.0,
        "detects_analysis_error": 0.0,
        "correct_perimeter_value": 0.0,
        "detects_no_correct_option": 0.0,
        "detects_duplicate_options": 0.0,
        "detects_svg_hidden_content": 0.0,
        "identifies_answer_key_conflict": 0.0,
        "audit_report_exists": 0.0,
        "report_shows_calculations": 0.0,
        "corrected_question_valid": 0.0,
        "config_compliance_report": 0.0,
        "report_cites_audit_rules": 0.0,
        "issues_cite_sources": 0.0,
        "validate_script_quality": 0.0,
        "severity_ranking_valid": 0.0,
        "first_pass_gap_analysis": 0.0,
        "batch_cross_reference": 0.0,
        "formula_reference_cited": 0.0,
        "svg_element_discrimination": 0.0,
        "corrected_analysis_methodology": 0.0,
    }

    output_path = os.path.join(workspace_path, "audit_result.json")
    report_path = os.path.join(workspace_path, "audit_report.md")

    if not os.path.isfile(output_path):
        return results

    results["output_file_exists"] = 0.5

    try:
        with open(output_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return results

    if not content.strip():
        return results

    results["output_file_exists"] = 1.0

    data = None
    try:
        data = json.loads(content)
    except (json.JSONDecodeError, ValueError):
        pass

    if isinstance(data, dict):
        has_qid = data.get("question_id") in (169663, "169663")
        has_wrong = isinstance(data.get("is_really_wrong"), bool)
        has_conf = isinstance(data.get("confidence"), (str, int, float))
        has_issues = isinstance(data.get("issues"), list)
        has_extra = any(k in data for k in [
            "severity_level", "audit_scope", "source_files",
            "violated_rules", "sources_examined"])
        field_count = sum([has_qid, has_wrong, has_conf, has_issues])
        if field_count == 4 and has_extra:
            results["valid_json_structure"] = 1.0
        elif field_count == 4:
            results["valid_json_structure"] = 0.5
        elif field_count >= 2:
            results["valid_json_structure"] = 0.25
    elif re.search(r'\b169663\b', content):
        results["valid_json_structure"] = 0.25

    lower = content.lower()

    if isinstance(data, dict) and data.get("is_really_wrong") is True:
        results["is_really_wrong_true"] = 1.0
    elif re.search(r'"is_really_wrong"\s*:\s*true', lower):
        results["is_really_wrong_true"] = 1.0

    if isinstance(data, dict):
        conf = data.get("confidence", "")
        n_issues = len(data.get("issues", [])) if isinstance(
            data.get("issues"), list) else 0
        if isinstance(conf, (int, float)) and conf >= 0.9 and n_issues >= 4:
            results["confidence_appropriate"] = 1.0
        elif isinstance(conf, str) and conf.strip().lower() == "high":
            results["confidence_appropriate"] = 0.5
        elif isinstance(conf, str) and conf.strip().lower() == "medium":
            results["confidence_appropriate"] = 0.25
        elif isinstance(conf, (int, float)) and conf >= 0.85:
            results["confidence_appropriate"] = 0.5
        elif isinstance(conf, (int, float)) and conf >= 0.6:
            results["confidence_appropriate"] = 0.25
    elif re.search(r'"confidence"\s*:\s*"(high|medium)"', lower):
        results["confidence_appropriate"] = 0.5

    issues_list = []
    if isinstance(data, dict) and isinstance(data.get("issues"), list):
        issues_list = data["issues"]

    def _issue_text(item):
        if isinstance(item, str):
            return item
        if isinstance(item, dict):
            return json.dumps(item, ensure_ascii=False)
        return str(item) if item else ""

    quality_re = re.compile(
        r'(?<!\d)(?:28\.85|33\.85|31\.85|36\.85)(?!\d)|'
        r'opacity.{0,20}0\.03|'
        r'font.?size.{0,20}[34]\b|'
        r'周长\s*[=＝]\s*33\.85|'
        r'allow_duplicates|check_answer_leak|'
        r'v[123].{0,40}(?:33\.85|31\.85|28\.85|36\.85)',
        re.IGNORECASE | re.DOTALL
    )
    file_ref_re = re.compile(
        r'answer_key|questions_batch|first_pass|audit_rules|169663\.svg|'
        r'math_formulas|svg_audit|difficulty_rating|batch_42',
        re.IGNORECASE
    )
    quality_issues = [
        i for i in issues_list
        if len(_issue_text(i).strip()) > 10 and quality_re.search(_issue_text(i))
    ]
    issues_with_refs = [
        i for i in quality_issues
        if file_ref_re.search(_issue_text(i))
    ]
    has_independent = any(
        re.search(r'(?<!\d)28\.85(?!\d)', _issue_text(i))
        for i in issues_list
    )
    if len(issues_with_refs) >= 3 and has_independent:
        results["issues_array_quality"] = 1.0
    elif len(quality_issues) >= 3 and has_independent:
        results["issues_array_quality"] = 0.67
    elif len(quality_issues) >= 2 and has_independent:
        results["issues_array_quality"] = 0.5
    elif has_independent:
        results["issues_array_quality"] = 0.33
    elif len(quality_issues) >= 2:
        results["issues_array_quality"] = 0.25
    elif len(quality_issues) >= 1:
        results["issues_array_quality"] = 0.17

    all_text = lower
    if os.path.isfile(report_path):
        try:
            with open(report_path, "r", encoding="utf-8") as f:
                all_text = lower + "\n" + f.read().lower()
        except Exception:
            pass

    diameter_error_identified = bool(
        re.search(r'(diameter|直径).{0,80}(internal|内部|shared|公共|重合|共用|not.{0,20}(?:part|count|include|属于|计入|算)|shouldn.t.{0,10}(?:add|be|include|加))', all_text, re.DOTALL | re.I) or
        re.search(r'(internal|内部|shared|公共|重合|共用).{0,60}(diameter|直径)', all_text, re.DOTALL | re.I) or
        re.search(r'(add|加).{0,30}(diameter|直径).{0,30}(back|again|错误|incorrect|wrong|不应|shouldn|多余|redundant)', all_text, re.DOTALL | re.I) or
        re.search(r'(double.?count|重复计算|重复加).{0,60}(diameter|直径|edge|边|5)', all_text, re.DOTALL | re.I) or
        re.search(r'21\s*[+＋]\s*7\.85\s*[+＋]\s*5\s*[=＝]\s*33\.85', all_text) or
        re.search(r'(only|仅|只).{0,30}(arc|弧).{0,30}(not|而非|不含|without).{0,20}(diameter|直径)', all_text, re.DOTALL | re.I) or
        re.search(r'(not|不|shouldn|无需|不需要|不应).{0,20}(add|include|加|计入|含).{0,20}(diameter|直径)', all_text, re.DOTALL | re.I) or
        re.search(r'common.{0,10}mistake.{0,20}(?:#\s*3|no\.?\s*3|三)', all_text, re.I | re.DOTALL)
    )
    methodology_explained = bool(
        diameter_error_identified or
        re.search(r'21\s*[+＋]\s*7\.85\s*[=＝]\s*28\.85', all_text) or
        re.search(r'(subtract|减去|去掉|扣除).{0,40}(shared|公共|重合|共用).{0,60}(add|加).{0,40}(arc|弧).{0,40}(?:only|仅|只)', all_text, re.DOTALL | re.I) or
        re.search(r'(subtract|减去|去掉|扣除|removed?).{0,60}(shared|common|replaced|internal|接合|公共|重合|共用|宽)', all_text, re.DOTALL) or
        re.search(r'(omit|miss|forgot|fail|忽略|遗漏|漏).{0,60}(subtract|减|edge|side|边|width|宽|diameter|直径)', all_text, re.DOTALL)
    )
    formula_referenced = bool(
        re.search(r'section\s*[67]|第\s*[67]\s*节|§\s*[67]', all_text, re.I) or
        re.search(r'math.?formulas?.?reference', all_text, re.I) or
        re.search(r'2\s*[×x*]\s*(?:length|l|长)\s*[+＋]\s*(?:width|w|宽)\s*[+＋]', all_text, re.I) or
        re.search(r'P\s*=\s*2l\s*[+＋]\s*w\s*[+＋]', all_text, re.I)
    )
    has_both_values = bool(re.search(r'28\.85', all_text) and re.search(r'33\.85', all_text))

    cites_exact_error_step = bool(re.search(r'21\s*[+＋]\s*7\.85\s*[+＋]\s*5\s*[=＝]\s*33\.85', all_text))
    cites_section_number = bool(re.search(r'(?:section|第)\s*[67]\s*(?:节)?', all_text, re.I))
    if diameter_error_identified and has_both_values and formula_referenced and cites_exact_error_step and cites_section_number:
        results["detects_analysis_error"] = 1.0
    elif diameter_error_identified and has_both_values and formula_referenced:
        results["detects_analysis_error"] = 0.5
    elif diameter_error_identified and has_both_values:
        results["detects_analysis_error"] = 0.4
    elif methodology_explained and has_both_values:
        results["detects_analysis_error"] = 0.33
    elif methodology_explained or (has_both_values and re.search(r'(analysis|解析).{0,80}(wrong|error|incorrect|错误|有误)', all_text, re.DOTALL)):
        results["detects_analysis_error"] = 0.25
    elif has_both_values:
        results["detects_analysis_error"] = 0.17

    if re.search(r'(?<!\d)28\.85(?!\d)', lower):
        rpt_cp_combined = lower
        if os.path.isfile(report_path):
            try:
                with open(report_path, "r", encoding="utf-8") as f:
                    rpt_cp_combined = lower + "\n" + f.read().lower()
            except Exception:
                pass
        cp_has_26 = bool(re.search(r'(?<!\d)26(?!\d)', rpt_cp_combined))
        cp_has_21 = bool(re.search(r'(?<!\d)21(?!\d)', rpt_cp_combined))
        cp_has_785 = bool(re.search(r'7\.85', rpt_cp_combined))
        cp_has_pi = bool(re.search(r'3\.14|[πpi]', rpt_cp_combined, re.I))
        if cp_has_26 and cp_has_21 and cp_has_785 and cp_has_pi:
            results["correct_perimeter_value"] = 1.0
        elif cp_has_26 and cp_has_21:
            results["correct_perimeter_value"] = 0.5
        else:
            results["correct_perimeter_value"] = 0.25

    no_correct_basic = bool(
        re.search(r'\bno\b.{0,10}correct.{0,10}option', lower) or
        re.search(r'\bnone\b.{0,10}of.{0,20}option.{0,80}(correct|match)', lower, re.DOTALL) or
        re.search(r'(all|every|four|4).{0,30}option.{0,60}(wrong|incorrect|not.{0,10}correct)', lower, re.DOTALL) or
        re.search(r'28\.85.{0,120}(not.{0,30}(option|available|listed|among|any)|none.{0,10}(of|match))', lower, re.DOTALL) or
        re.search(r'(none|no)\b.{0,40}(option|choice|选项).{0,40}(correct|match|right|正确)', lower, re.DOTALL))
    enumerates_all_options = bool(
        re.search(r'36\.85', lower) and
        re.search(r'33\.85', lower) and
        re.search(r'31\.85', lower) and
        re.search(r'28\.85', lower))
    if no_correct_basic and enumerates_all_options:
        results["detects_no_correct_option"] = 1.0
    elif no_correct_basic:
        results["detects_no_correct_option"] = 0.5

    dup_has_value = bool(
        re.search(r'(duplicate|重复|identical|相同|same).{0,80}33\.85', lower, re.DOTALL) or
        re.search(r'33\.85.{0,80}(duplicate|重复|identical|相同|same)', lower, re.DOTALL) or
        re.search(r'[bd].{0,10}(?:and|&|与|和).{0,10}[bd].{0,60}33\.85', lower, re.DOTALL) or
        re.search(r'33\.85.{0,60}[bd].{0,10}(?:and|&|与|和).{0,10}[bd]', lower, re.DOTALL))
    dup_keyword = bool(
        re.search(r'(duplicate|重复|identical|相同|same).{0,60}(option|选项|choice)', lower, re.DOTALL) or
        re.search(r'(option|选项|choice).{0,60}(duplicate|重复|identical|相同|same)', lower, re.DOTALL) or
        re.search(r'\b[bd]\b.{0,40}(identical|same|duplicate|重复|相同).{0,40}\b[bd]\b', lower, re.DOTALL) or
        re.search(r'[bd].{0,5}(?:and|&|与|和).{0,5}[bd].{0,40}(identical|same|duplicate|重复|相同|both)', lower, re.DOTALL))
    dup_names_bd = bool(
        re.search(r'\bb\b.{0,20}(?:and|&|与|和).{0,20}\bd\b', all_text, re.I) or
        re.search(r'\bd\b.{0,20}(?:and|&|与|和).{0,20}\bb\b', all_text, re.I))
    dup_only_3_effective = bool(
        re.search(r'(?:only|仅|只).{0,30}(?:3|三|three).{0,30}(?:effective|valid|unique|有效|不同|独立)', all_text, re.DOTALL | re.I) or
        re.search(r'(?:3|三|three).{0,30}(?:effective|valid|unique|有效|不同|独立).{0,30}(?:option|选项)', all_text, re.DOTALL | re.I))
    if dup_has_value and dup_keyword and dup_names_bd and dup_only_3_effective:
        results["detects_duplicate_options"] = 1.0
    elif dup_has_value and dup_keyword:
        results["detects_duplicate_options"] = 0.5
    elif dup_has_value:
        results["detects_duplicate_options"] = 0.33
    elif dup_keyword:
        results["detects_duplicate_options"] = 0.17

    svg_detail = bool(
        re.search(r'opacity.{0,20}0\.03', lower) or
        re.search(r'font.?size.{0,20}[34]\b', lower) or
        re.search(r'周长\s*[=＝]\s*33\.85', lower) or
        re.search(r'white.{0,20}fill.{0,60}(hidden|隐藏|text|文字)', lower, re.DOTALL) or
        re.search(r'fill.{0,10}white.{0,60}(hidden|隐藏|text|文字)', lower, re.DOTALL))
    svg_keyword = bool(
        re.search(r'svg.{0,120}(leak|泄露|hidden|隐藏)', lower, re.DOTALL) or
        re.search(r'(leak|泄露|hidden|隐藏).{0,120}svg', lower, re.DOTALL))
    svg_attr_count = 0
    if re.search(r'opacity.{0,10}0\.0[2-5]', all_text): svg_attr_count += 1
    if re.search(r'font.?size.{0,10}[2-4]\b', all_text): svg_attr_count += 1
    if re.search(r'fill.{0,15}(?:white|#f[de]f[de]f[de]|#ffffff)', all_text, re.I): svg_attr_count += 1
    if svg_detail and svg_keyword and svg_attr_count >= 3:
        results["detects_svg_hidden_content"] = 1.0
    elif svg_detail and svg_keyword and svg_attr_count >= 2:
        results["detects_svg_hidden_content"] = 0.5
    elif svg_detail and svg_keyword:
        results["detects_svg_hidden_content"] = 0.33
    elif svg_detail:
        results["detects_svg_hidden_content"] = 0.33
    elif svg_keyword:
        results["detects_svg_hidden_content"] = 0.17

    has_v1v2 = bool(re.search(r'33\.85', lower) and re.search(r'31\.85', lower))
    has_v3 = bool(re.search(r'(?<!\d)36\.85(?!\d)', lower) and
                  (re.search(r'v3|answer.?key.{0,30}(?:three|3|third|第三)', lower, re.DOTALL) or
                   re.search(r'answer_key_v3', lower)))
    conflict_keyword = bool(
        re.search(r'(answer.?key|v[123]).{0,100}(conflict|disagree|inconsist|differ|contradict|mismatch|不一致|矛盾|冲突)', lower, re.DOTALL) or
        re.search(r'(conflict|disagree|inconsist|differ|contradict|mismatch).{0,100}(answer.?key|v[123])', lower, re.DOTALL))
    lists_all_three_pairs = bool(
        re.search(r'v1.{0,60}(?:B|33\.85)', all_text, re.I | re.DOTALL) and
        re.search(r'v2.{0,60}(?:C|31\.85)', all_text, re.I | re.DOTALL) and
        re.search(r'v3.{0,60}(?:A|36\.85)', all_text, re.I | re.DOTALL))
    states_none_correct = bool(
        re.search(r'(?:none|no|都不|均不|没有|皆).{0,60}(?:correct|right|正确|匹配|match)', all_text, re.I | re.DOTALL) and
        re.search(r'(?:answer.?key|密钥|版本|key)', all_text, re.I))
    if has_v1v2 and has_v3 and conflict_keyword and lists_all_three_pairs and states_none_correct:
        results["identifies_answer_key_conflict"] = 1.0
    elif has_v1v2 and has_v3 and conflict_keyword:
        results["identifies_answer_key_conflict"] = 0.5
    elif has_v1v2 and conflict_keyword:
        results["identifies_answer_key_conflict"] = 0.33
    elif has_v1v2:
        results["identifies_answer_key_conflict"] = 0.25
    elif conflict_keyword:
        results["identifies_answer_key_conflict"] = 0.17

    if os.path.isfile(report_path):
        try:
            with open(report_path, "r", encoding="utf-8") as f:
                report_content = f.read()
            rlen = len(report_content.strip())
            has_exec_summary = bool(re.search(
                r'(executive\s+summar|summary|overview|结论|摘要|概述)',
                report_content[:500], re.I))
            if rlen >= 2000 and has_exec_summary:
                results["audit_report_exists"] = 1.0
            elif rlen >= 500:
                results["audit_report_exists"] = 0.5
            elif rlen >= 200:
                results["audit_report_exists"] = 0.25
        except Exception:
            pass

    if os.path.isfile(report_path):
        try:
            with open(report_path, "r", encoding="utf-8") as f:
                rpt = f.read().lower()
            has_rect = bool(re.search(r'2\s*[×x*]\s*\(?\s*8\s*[+]\s*5\s*\)?|(?<!\d)26(?!\d)', rpt))
            has_sub = bool(re.search(r'26\s*[-−]\s*5|(?<!\d)21(?!\d)', rpt))
            has_arc = bool(re.search(r'3\.14\s*[×x*]\s*5\s*[÷/]\s*2|(?<!\d)7\.85(?!\d)', rpt))
            has_total = bool(re.search(r'(?<!\d)28\.85(?!\d)', rpt))
            has_formula_ref = bool(
                re.search(r'section\s*6|第\s*6\s*节|math.?formulas.?reference|composite.{0,20}shape.{0,20}perimeter', rpt, re.DOTALL) or
                re.search(r'2\s*[×x*]\s*l(ength)?\s*[+＋]\s*w(idth)?\s*[+＋]\s*[πpi]', rpt, re.DOTALL)
            )
            has_pi_ref = bool(re.search(r'[πpi]\s*[≈≒=]\s*3\.14|3\.14\s*[≈≒=]\s*[πpi]|π\s*≈\s*3\.14', rpt, re.I))
            has_arc_formula = bool(re.search(r'[πpi]\s*[×x*·]?\s*d\s*[÷/]\s*2|半圆弧长\s*=|arc.{0,20}length.{0,20}=', rpt, re.I))
            steps = sum([has_rect, has_sub, has_arc, has_total])
            if steps >= 4 and has_formula_ref and has_pi_ref and has_arc_formula:
                results["report_shows_calculations"] = 1.0
            elif steps >= 4 and has_formula_ref:
                results["report_shows_calculations"] = 0.5
            elif steps >= 4:
                results["report_shows_calculations"] = 0.4
            elif steps >= 3:
                results["report_shows_calculations"] = 0.33
            elif steps >= 2:
                results["report_shows_calculations"] = 0.25
            elif steps >= 1:
                results["report_shows_calculations"] = 0.17
        except Exception:
            pass

    cq_path = os.path.join(workspace_path, "corrected_question.json")
    if os.path.isfile(cq_path):
        try:
            with open(cq_path, "r", encoding="utf-8") as f:
                cq_raw = f.read()
            cq_data = json.loads(cq_raw)
            if isinstance(cq_data, dict):
                cq_lower = cq_raw.lower()
                has_qid = cq_data.get("question_id") in (169663, "169663")
                has_correct = bool(re.search(r'28\.85', cq_lower))
                opts = cq_data.get("options", {})
                if isinstance(opts, dict):
                    vals = [str(v).strip() for v in opts.values()]
                elif isinstance(opts, list):
                    vals = [str(v).strip() for v in opts]
                else:
                    vals = []
                no_dup = len(vals) == len(set(vals)) if vals else False
                analysis_text = ""
                for key in ("analysis", "解析", "explanation", "solution"):
                    if key in cq_data and isinstance(cq_data[key], str):
                        analysis_text = cq_data[key].lower()
                        break
                has_subtraction = bool(
                    re.search(r'(?<!\d)21(?!\d)', analysis_text) or
                    re.search(r'26\s*[-−–]\s*5', analysis_text) or
                    re.search(r'(subtract|减去|去掉|扣除).{0,40}(5|width|宽|边)', analysis_text, re.DOTALL)
                )
                cq_analysis_full = bool(
                    has_subtraction and
                    re.search(r'(?<!\d)7\.85(?!\d)', analysis_text) and
                    re.search(r'28\.85', analysis_text))
                cq_has_distractor_rationale = bool(
                    re.search(r'(?:常见错误|common.{0,10}mistake|干扰|distract|误导|plausible|典型错误)', analysis_text, re.I))
                cq_opt_vals = [re.sub(r'[^\d.]', '', str(v)) for v in vals]
                cq_has_2885_option = '28.85' in cq_opt_vals
                if has_qid and has_correct and no_dup and cq_analysis_full and cq_has_2885_option and cq_has_distractor_rationale:
                    results["corrected_question_valid"] = 1.0
                elif has_qid and has_correct and no_dup and has_subtraction:
                    results["corrected_question_valid"] = 0.5
                elif has_qid and has_correct and no_dup:
                    results["corrected_question_valid"] = 0.4
                elif has_qid and has_correct:
                    results["corrected_question_valid"] = 0.33
                elif has_qid:
                    results["corrected_question_valid"] = 0.25
                else:
                    results["corrected_question_valid"] = 0.17
        except (json.JSONDecodeError, Exception):
            results["corrected_question_valid"] = 0.1

    cc_path = os.path.join(workspace_path, "config_compliance.csv")
    if os.path.isfile(cc_path):
        try:
            with open(cc_path, "r", encoding="utf-8") as f:
                cc_raw = f.read()
            cc_lower = cc_raw.lower()
            lines = [l.strip() for l in cc_raw.strip().split('\n') if l.strip()]
            header = lines[0].lower() if lines else ""
            data_lines = lines[1:] if len(lines) > 1 else []
            has_fail = bool(re.search(r'\bfail\b', cc_lower))
            has_severity_col = bool(re.search(r'severity', header))
            yaml_rules = ['allow_duplicates', 'check_answer_leak', 'verify_analysis_math',
                         'require_consistent_keys', 'check_hidden_text', 'check_low_opacity',
                         'verify_methodology', 'check_common_mistakes']
            rule_count = sum(1 for r in yaml_rules if r in cc_lower)
            if len(data_lines) >= 8 and has_fail and has_severity_col and rule_count >= 6:
                results["config_compliance_report"] = 1.0
            elif len(data_lines) >= 5 and has_fail and has_severity_col and rule_count >= 4:
                results["config_compliance_report"] = 0.5
            elif len(data_lines) >= 3 and has_fail and (has_severity_col or rule_count >= 3):
                results["config_compliance_report"] = 0.4
            elif len(data_lines) >= 3 and has_fail:
                results["config_compliance_report"] = 0.33
            elif len(data_lines) >= 3:
                results["config_compliance_report"] = 0.25
            elif len(data_lines) >= 1:
                results["config_compliance_report"] = 0.17
        except Exception:
            results["config_compliance_report"] = 0.1

    if os.path.isfile(report_path):
        try:
            with open(report_path, "r", encoding="utf-8") as f:
                rpt_text = f.read().lower()
            rule_refs = [
                r'allow_duplicates',
                r'check_answer_leak',
                r'audit_rules\.yaml',
                r'svg_rules',
                r'leak_verdict',
                r'judgment_policy',
                r'svg.?audit.?checklist|svg-0[1-4]',
                r'verify_analysis_math|independent_calculation',
                r'require_consistent_keys',
                r'verify_methodology',
                r'check_step_by_step',
                r'require_formula_citation',
                r'check_common_mistakes',
                r'diameter_handling|check_internal_edge',
            ]
            rule_count = sum(1 for p in rule_refs if re.search(p, rpt_text))
            if rule_count >= 9:
                results["report_cites_audit_rules"] = 1.0
            elif rule_count >= 6:
                results["report_cites_audit_rules"] = 0.5
            elif rule_count >= 4:
                results["report_cites_audit_rules"] = 0.4
            elif rule_count >= 3:
                results["report_cites_audit_rules"] = 0.33
            elif rule_count >= 2:
                results["report_cites_audit_rules"] = 0.25
            elif rule_count >= 1:
                results["report_cites_audit_rules"] = 0.17
        except Exception:
            pass

    source_refs = [
        r'answer_key_v1',
        r'answer_key_v2',
        r'answer_key_v3',
        r'audit_rules',
        r'169663\.svg',
        r'first_pass',
        r'math_formulas',
        r'questions_batch',
    ]
    src_count = sum(1 for p in source_refs if re.search(p, lower))
    if src_count >= 6:
        results["issues_cite_sources"] = 1.0
    elif src_count >= 5:
        results["issues_cite_sources"] = 0.67
    elif src_count >= 4:
        results["issues_cite_sources"] = 0.33

    vb_path = os.path.join(workspace_path, "validate_batch.py")
    if os.path.isfile(vb_path):
        try:
            with open(vb_path, "r", encoding="utf-8") as f:
                vb_content = f.read()
            vb_lower = vb_content.lower()

            valid_syntax = False
            try:
                ast.parse(vb_content)
                valid_syntax = True
            except SyntaxError:
                pass

            reads_json = bool(re.search(r'questions_batch|\.json', vb_lower))
            reads_csv = bool(re.search(r'answer_key|\.csv', vb_lower))
            checks_dup = bool(
                re.search(r'duplicat|重复|unique|set\s*\(|len\s*\(.{0,30}\)\s*[!=<>]=?\s*len', vb_lower, re.DOTALL))
            checks_keys = bool(
                re.search(r'(answer.?key|v[123]).{0,80}(conflict|match|compar|consist|differ|!=)', vb_lower, re.DOTALL) or
                re.search(r'(conflict|match|compar|consist|differ).{0,80}(answer.?key|v[123])', vb_lower, re.DOTALL) or
                re.search(r'cross.{0,20}(ref|check|valid)', vb_lower, re.DOTALL))
            checks_svg = bool(
                re.search(r'svg.{0,80}(hidden|opacity|leak|text)', vb_lower, re.DOTALL) or
                re.search(r'(hidden|opacity|leak).{0,80}\.svg', vb_lower, re.DOTALL) or
                re.search(r'\.svg.{0,80}(open|read|parse|element)', vb_lower, re.DOTALL) or
                re.search(r'(xml|etree|minidom|beautifulsoup|lxml)', vb_lower))
            outputs_matrix = bool(
                re.search(r'cross.?ref.{0,30}matrix|matrix\.csv', vb_lower, re.DOTALL) or
                re.search(r'csv.{0,60}(write|open|save).{0,80}(matrix|cross|compar)', vb_lower, re.DOTALL))
            features = sum([reads_json, reads_csv, checks_dup, checks_keys, checks_svg, outputs_matrix])

            has_argparse = bool(re.search(r'argparse|ArgumentParser', vb_content))
            has_svg_hidden_check = bool(
                re.search(r'opacity.{0,40}(?:float|<|>|threshold|0\.\d)', vb_lower, re.DOTALL) or
                re.search(r'hidden.{0,40}text.{0,40}svg', vb_lower, re.DOTALL))
            if valid_syntax and features >= 6 and has_argparse and has_svg_hidden_check:
                results["validate_script_quality"] = 1.0
            elif valid_syntax and features >= 5:
                results["validate_script_quality"] = 0.5
            elif valid_syntax and features >= 4:
                results["validate_script_quality"] = 0.4
            elif valid_syntax and features >= 3:
                results["validate_script_quality"] = 0.33
            elif valid_syntax and features >= 2:
                results["validate_script_quality"] = 0.25
            elif valid_syntax:
                results["validate_script_quality"] = 0.17
            elif len(vb_content.strip()) > 50:
                results["validate_script_quality"] = 0.1
        except Exception:
            results["validate_script_quality"] = 0.1

    sr_path = os.path.join(workspace_path, "severity_ranking.json")
    if os.path.isfile(sr_path):
        try:
            with open(sr_path, "r", encoding="utf-8") as f:
                sr_raw = f.read()
            sr_data = json.loads(sr_raw)
            sr_lower = sr_raw.lower()
            items = sr_data if isinstance(sr_data, list) else sr_data.get("issues", sr_data.get("ranking", []))
            if not isinstance(items, list):
                items = []
            has_severity_field = bool(re.search(r'"(severity|level)"\s*:', sr_lower))
            has_rule_ref = bool(re.search(
                r'allow_duplicates|check_answer_leak|verify_analysis_math|'
                r'svg_error|option_error|math_error|duplicate_option|'
                r'answer_key_conflict|svg_answer_leak|incorrect_labeled_answer',
                sr_lower))
            has_3_items = len(items) >= 3
            has_ranking_order = bool(re.search(r'critical|严重|major|重要', sr_lower, re.IGNORECASE))
            has_three_levels = bool(
                re.search(r'critical', sr_lower) and
                re.search(r'major', sr_lower) and
                re.search(r'minor', sr_lower))
            has_rule_reference_field = bool(re.search(r'"rule_reference"\s*:', sr_lower))
            if has_3_items and has_severity_field and has_rule_ref and has_three_levels and has_rule_reference_field and len(items) >= 4:
                results["severity_ranking_valid"] = 1.0
            elif has_3_items and has_severity_field and has_rule_ref and has_ranking_order:
                results["severity_ranking_valid"] = 0.5
            elif has_3_items and has_severity_field and has_rule_ref:
                results["severity_ranking_valid"] = 0.4
            elif has_3_items and has_severity_field:
                results["severity_ranking_valid"] = 0.33
            elif has_3_items:
                results["severity_ranking_valid"] = 0.25
            elif len(sr_raw.strip()) > 20:
                results["severity_ranking_valid"] = 0.17
        except (json.JSONDecodeError, Exception):
            results["severity_ranking_valid"] = 0.1

    if os.path.isfile(report_path):
        try:
            with open(report_path, "r", encoding="utf-8") as f:
                rpt_full = f.read().lower()
            mentions_first_pass = bool(
                re.search(r'first.?pass|初审|初次审核|initial.?review|initial.?audit', rpt_full))
            mentions_missed = bool(
                re.search(r'(first.?pass|初审|initial).{0,120}(miss|fail|overlook|忽略|遗漏|没有发现|未检出|inadequat|insufficien)', rpt_full, re.DOTALL) or
                re.search(r'(miss|fail|overlook|忽略|遗漏|没有发现|未检出|inadequat|insufficien).{0,120}(first.?pass|初审|initial)', rpt_full, re.DOTALL))
            explains_why = bool(
                re.search(r'(did\s*n.t|didn.t|failed?\s+to|没有|未).{0,80}(check|inspect|verify|验证|检查|examine).{0,80}(svg|xml|math|计算|选项|option|formula)', rpt_full, re.DOTALL) or
                re.search(r'(spot.?check|抽查|surface|表面|shallow|粗浅|cursory|rubber.?stamp).{0,80}(review|审核|audit|检查)', rpt_full, re.DOTALL) or
                re.search(r'(gap|缺陷|不足|failure|shortcoming|weakness|limitation).{0,100}(first.?pass|初审|initial|methodology|方法|process|流程)', rpt_full, re.DOTALL))
            quotes_false_claims = bool(
                re.search(r'svg\s+renders?\s+correctly', rpt_full) or
                re.search(r'options?\s+and\s+answer\s+verified', rpt_full))
            suggests_improvements = bool(
                re.search(r'(改进|improvement|recommend|建议|should|应当).{0,100}(process|流程|procedure|method|方法|审核)', rpt_full, re.DOTALL | re.I))
            mentions_misleading_log = bool(
                re.search(r'(re.?(?:check|verif)|复查|重新验证).{0,60}(33\.85|pass|confirmed|通过)', rpt_full, re.DOTALL | re.I) or
                re.search(r'(log|日志).{0,80}(mislead|误导|false|虚假|incorrect)', rpt_full, re.DOTALL | re.I))
            if mentions_first_pass and mentions_missed and explains_why and quotes_false_claims and suggests_improvements and mentions_misleading_log:
                results["first_pass_gap_analysis"] = 1.0
            elif mentions_first_pass and mentions_missed and explains_why and quotes_false_claims:
                results["first_pass_gap_analysis"] = 0.5
            elif mentions_first_pass and mentions_missed:
                results["first_pass_gap_analysis"] = 0.4
            elif mentions_first_pass:
                results["first_pass_gap_analysis"] = 0.25
        except Exception:
            pass

    cr_path = os.path.join(workspace_path, "cross_reference_matrix.csv")
    cr_found = False
    if os.path.isfile(cr_path):
        cr_found = True
        try:
            with open(cr_path, "r", encoding="utf-8") as f:
                cr_raw = f.read()
            cr_lower = cr_raw.lower()
            lines = [l.strip() for l in cr_raw.strip().split('\n') if l.strip()]
            data_lines = lines[1:] if len(lines) > 1 else []
            has_multi_qs = len(data_lines) >= 8
            has_key_cols = bool(re.search(r'v[123]|key', cr_lower))
            mentions_169663 = bool(re.search(r'169663', cr_raw))
            finds_other = bool(
                re.search(r'169665.{0,200}(624|disagree|mismatch|differ|discrepan)', cr_raw, re.DOTALL) or
                re.search(r'169668.{0,200}(disagree|mismatch|differ|discrepan|\bA\b)', cr_raw, re.DOTALL))
            finds_both_others = bool(
                re.search(r'169665', cr_raw) and re.search(r'169668', cr_raw) and finds_other)
            has_agree_col = bool(re.search(r'agree|match|consistent|一致', cr_lower))
            if has_multi_qs and has_key_cols and mentions_169663 and finds_both_others and has_agree_col:
                results["batch_cross_reference"] = 1.0
            elif has_multi_qs and has_key_cols and mentions_169663 and finds_other:
                results["batch_cross_reference"] = 0.5
            elif has_multi_qs and has_key_cols and mentions_169663:
                results["batch_cross_reference"] = 0.4
            elif has_multi_qs and mentions_169663:
                results["batch_cross_reference"] = 0.33
            elif has_multi_qs:
                results["batch_cross_reference"] = 0.25
            elif len(cr_raw.strip()) > 50:
                results["batch_cross_reference"] = 0.17
        except Exception:
            results["batch_cross_reference"] = 0.1
    if not cr_found:
        for alt_name in ["batch_validation_results.csv", "batch_results.csv", "validation_results.csv"]:
            alt_path = os.path.join(workspace_path, alt_name)
            if os.path.isfile(alt_path):
                try:
                    with open(alt_path, "r", encoding="utf-8") as f:
                        alt_raw = f.read()
                    if re.search(r'169663', alt_raw) and re.search(r'v[123]|key', alt_raw.lower()):
                        results["batch_cross_reference"] = 0.25
                        break
                except Exception:
                    pass

    formula_patterns = [
        r'section\s*[67]|第\s*[67]\s*节|§\s*[67]',
        r'math.?formulas?.?reference',
        r'common\s+mistake|常见错误',
        r'2\s*[×x*]\s*(?:length|l|长)\s*[+＋]\s*(?:width|w|宽)\s*[+＋]\s*[πpi]',
        r'P\s*=\s*2l\s*[+＋]\s*w\s*[+＋]\s*[πpi]',
        r'2\s*[×x*]\s*8\s*[+＋]\s*5\s*[+＋]\s*(?:3\.14|[πpi])',
        r'(?:diameter|直径).{0,40}(?:internal|内部|not\s+(?:part|counted)|不.{0,10}(?:计入|算)|共用|shared)',
        r'common.{0,10}mistake.{0,20}(?:#\s*3|no\.?\s*3|三)',
    ]
    fm_count = sum(1 for p in formula_patterns if re.search(p, all_text, re.I | re.DOTALL))
    if fm_count >= 7:
        results["formula_reference_cited"] = 1.0
    elif fm_count >= 4:
        results["formula_reference_cited"] = 0.5
    elif fm_count >= 2:
        results["formula_reference_cited"] = 0.33
    elif fm_count >= 1:
        results["formula_reference_cited"] = 0.25

    elem_count = 0
    if re.search(r'周长.{0,10}33\.85', all_text): elem_count += 1
    if re.search(r'面积.{0,10}40', all_text): elem_count += 1
    if re.search(r'qc.{0,5}b42|tracking.{0,20}(?:id|标识)', all_text, re.I): elem_count += 1
    if re.search(r'review.{0,5}:?.{0,5}approved', all_text, re.I): elem_count += 1
    if re.search(r'P\s*=\s*2\s*\(\s*l\s*\+\s*w\s*\).{0,10}[πpi]', all_text, re.I): elem_count += 1
    has_categorization = bool(
        re.search(r'(答案泄露|answer.?leak|leak).{0,120}(元数据|metadata|非泄露|not.{0,10}leak|无关|red.?herring|干扰|tracking|跟踪)', all_text, re.DOTALL | re.I) or
        re.search(r'(元数据|metadata|非泄露|not.{0,10}leak|无关|红鲱鱼|干扰|tracking|跟踪).{0,120}(答案泄露|answer.?leak|leak)', all_text, re.DOTALL | re.I) or
        re.search(r'(周长|perimeter).{0,60}(leak|泄露).{0,120}(面积|area|tracking|qc:|review).{0,60}(not|non|metadata|无关|元数据|irrelevant)', all_text, re.DOTALL | re.I))
    identifies_perimeter_as_leak = bool(
        re.search(r'(周长|perimeter).{0,40}(33\.85).{0,60}(leak|泄露|答案)', all_text, re.DOTALL | re.I) or
        re.search(r'(leak|泄露|答案).{0,60}(周长|perimeter).{0,40}(33\.85)', all_text, re.DOTALL | re.I))
    if elem_count >= 5 and has_categorization and identifies_perimeter_as_leak:
        results["svg_element_discrimination"] = 1.0
    elif elem_count >= 3 and has_categorization:
        results["svg_element_discrimination"] = 0.5
    elif elem_count >= 3 or (elem_count >= 2 and has_categorization):
        results["svg_element_discrimination"] = 0.33
    elif elem_count >= 2:
        results["svg_element_discrimination"] = 0.25
    elif elem_count >= 1:
        results["svg_element_discrimination"] = 0.17

    cq_path2 = os.path.join(workspace_path, "corrected_question.json")
    if os.path.isfile(cq_path2):
        try:
            with open(cq_path2, "r", encoding="utf-8") as f:
                cq_raw2 = f.read()
            cq_data2 = json.loads(cq_raw2)
            if isinstance(cq_data2, dict):
                analysis_txt = ""
                for akey in ("analysis", "解析", "explanation", "solution"):
                    if akey in cq_data2 and isinstance(cq_data2[akey], str):
                        analysis_txt = cq_data2[akey].lower()
                        break
                if len(analysis_txt) > 20:
                    a_has_sub = bool(re.search(r'(?<!\d)21(?!\d)', analysis_txt) or re.search(r'26\s*[-−–]\s*5', analysis_txt))
                    a_has_arc = bool(re.search(r'7\.85', analysis_txt))
                    a_has_total = bool(re.search(r'28\.85', analysis_txt))
                    a_no_diam_err = not bool(re.search(r'21\s*[+＋]\s*7\.85\s*[+＋]\s*5', analysis_txt))
                    a_explains_no_diameter = bool(
                        re.search(r'(直径|diameter).{0,40}(不|not|shouldn|无需|内部|internal|共用|shared)', analysis_txt, re.DOTALL | re.I) or
                        re.search(r'(only|仅|只).{0,20}(arc|弧)', analysis_txt, re.DOTALL | re.I))
                    a_cites_formula = bool(
                        re.search(r'section|第.{0,2}节|math.?formulas', analysis_txt, re.I))
                    if a_has_sub and a_has_arc and a_has_total and a_no_diam_err and a_explains_no_diameter and a_cites_formula:
                        results["corrected_analysis_methodology"] = 1.0
                    elif a_has_sub and a_has_arc and a_has_total and a_no_diam_err:
                        results["corrected_analysis_methodology"] = 0.5
                    elif a_has_total and a_has_sub:
                        results["corrected_analysis_methodology"] = 0.33
                    elif a_has_total:
                        results["corrected_analysis_methodology"] = 0.25
        except Exception:
            pass

    return results
```

## LLM Judge Rubric

If `audit_result.json` does not exist, all dimensions score 0.

### Criterion 1: Mathematical Rigor and Trap Mechanism Analysis (Weight: 30%)

- **1.0**: The agent performs independent step-by-step perimeter calculation arriving at 28.85cm with all intermediate values (26cm → 21cm → 7.85cm → 28.85cm), explicitly references the formula from `data/math_formulas_reference.md` Section 6 (P = 2×length + width + π×width÷2) or Section 7 Common Mistake #3, identifies the *specific* erroneous step — that the analysis correctly subtracts the shared edge (26−5=21) but then incorrectly re-adds the semicircle diameter (21+7.85+5=33.85), and **explains why this error is deceptive**: the visible subtraction step creates a false sense of methodological rigor, the reasoning "semicircle contributes arc + diameter" sounds geometrically plausible, the arithmetic is internally self-consistent (21+7.85+5=33.85), and the first-pass auditor was specifically deceived by the subtraction step (as evidenced by their note "correctly accounts for semicircle construction via subtraction and addition steps"). A senior mathematics educator would reject this analysis because the diameter IS the shared edge — once subtracted, it cannot reappear in the perimeter. The corrected question file, if produced, must show the correct methodology without the diameter re-addition.
- **0.75**: Independent calculation reaching 28.85cm with intermediate steps. Identifies the diameter re-addition as the error and references the formula document, but does not fully explain why the error is deceptive (e.g., omits the discussion of how the subtraction step creates false confidence, or does not connect to Common Mistake #3).
- **0.5**: Reaches 28.85cm independently and identifies a math error, but only states "the answer is wrong" or "the analysis has an error" without pinpointing the diameter re-addition step. May note that the shared edge was subtracted but not that the diameter was re-added. Does not explain the trap mechanism.
- **0.25**: Mentions a potential math discrepancy but provides no independent calculation, or arrives at a different incorrect value, or accepts the analysis at face value because the arithmetic is internally consistent (21+7.85+5=33.85 checks out) and the subtraction step is visible.
- **0.0**: No mathematical verification attempted. Accepts the analysis conclusion or the first-pass "PASS" verdict. File does not exist.

### Criterion 2: SVG Forensics and Hidden Element Classification (Weight: 15%)

- **1.0**: Inspects the raw SVG XML of `svg/169663.svg`, enumerates all five near-invisible text elements in the `<g id="qa-meta">` annotation group individually, and classifies each by type and intent: (1) Tracking ID (`qc:b42-169663-r2`) — asset management metadata, not an answer leak; (2) Perimeter value (`周长=33.85厘米`) — **answer leak** because 33.85 matches options B and D; (3) Area annotation (`面积=40平方厘米`) — red herring, 40 does not match any answer option; (4) Incorrect formula (`P=2(l+w)+πd/2`) — formula artifact that reinforces the wrong methodology (yields 26+7.85=33.85), not a direct answer leak but an additional complexity trap; (5) Review stamp (`review:approved:auditor_07:20241115`) — review tracking metadata, not answer-relevant. Cites specific technical attributes for the leak element (opacity 0.03, font-size 4, fill white). Correctly identifies only element #2 as the actionable answer leak per the audit rules (`check_answer_leak: true`, `leak_verdict: 'svg_error'`), while explaining why the other four are not answer leaks. Notes that the hidden formula (#4) is particularly insidious because it would lead an agent that encounters it before performing independent calculation to the same wrong answer (33.85).
- **0.75**: Identifies the answer leak with specific technical attributes (opacity, font-size), mentions at least 2 other hidden elements and distinguishes them from the leak, but does not enumerate or classify all five elements.
- **0.5**: Finds hidden text in the SVG and correctly identifies it as an answer leak, but does not cite technical attributes or distinguish the leak from other hidden elements. May say "SVG contains hidden answer text" without specifics.
- **0.25**: Mentions the SVG might have issues but provides no evidence from the raw XML. No attribute citations.
- **0.0**: No SVG source inspection. Accepts the first-pass assessment that the SVG is fine. File does not exist.

### Criterion 3: Systematic Audit Quality and First-Pass Process Evaluation (Weight: 20%)

- **1.0**: Goes beyond identifying what the first-pass missed to analyzing *why* the first-pass process systematically failed. Identifies at least three specific process failures: (a) no independent mathematical verification was performed — the auditor accepted the analysis's internal arithmetic without checking the geometric reasoning; (b) no SVG XML-level inspection was performed — only visual rendering was checked, missing near-invisible elements; (c) no cross-validation between answer key versions was performed — accepting one key without comparing to others. Recognizes auditor_07's note ("Analysis methodology verified — correctly accounts for semicircle construction via subtraction and addition steps") as evidence of confirmation bias — the auditor saw the subtraction step and assumed the methodology was correct without verifying the final result independently. Identifies the system log re-verification ("Re-check requested for Q169663: auditor_07 re-verified perimeter=33.85cm against labeled answer — PASS confirmed") as rubber-stamping the same error rather than independent verification. Evaluates whether the first-pass process has systemic reliability issues that could affect other questions in the batch, linking to batch-wide discrepancies in 169665 and 169668 as corroborating evidence.
- **0.75**: Provides a gap analysis explaining how the first-pass missed the issues, mentions 2+ specific failures, but does not analyze systemic patterns or the auditor's confirmation bias.
- **0.5**: Notes that the first-pass audit failed and lists what was missed, but provides only a surface-level explanation without identifying root causes or process mechanisms.
- **0.25**: Mentions the first-pass was incorrect but provides no analysis of why or how.
- **0.0**: No discussion of the first-pass audit process. File does not exist.

### Criterion 4: Deliverable Completeness and Professional Quality (Weight: 20%)

- **1.0**: All seven deliverables are produced at professional quality: `audit_report.md` is at the level of a senior mathematics educator's audit report — with independent calculation walkthrough showing all intermediate values, explicit formula citations from the reference document, rule-by-rule compliance assessment citing at least 6 rules/checks by name, first-pass process analysis, and evidence-based conclusions that demonstrate independent reasoning (not parroting file contents). `audit_result.json` has well-structured issues that each cite relevant workspace file(s) as evidence sources. `corrected_question.json` contains 28.85cm as the correct answer, no duplicate options, and an `analysis` field that walks through the correct methodology step-by-step (subtract shared edge → add only the arc, with intermediate value 21). `config_compliance.csv` has a severity column, ≥5 data rows, and correctly identifies failing rules by their exact names from `audit_rules.yaml`. `severity_ranking.json` has ≥3 ranked issues with severity levels (critical/major/minor) and specific audit rule references. `validate_batch.py` is syntactically valid Python that checks duplicate options, cross-references answer keys, inspects SVGs for hidden text/leaks, and outputs `cross_reference_matrix.csv`. `cross_reference_matrix.csv` covers all batch questions with v1/v2/v3 columns and reveals discrepancies beyond 169663 (169665 value, 169668 option letter).
- **0.75**: 5–6 deliverables produced at good quality. Key content (correct answer, methodology) is present in the primary deliverables (audit report, result, corrected question).
- **0.5**: 3–4 deliverables produced. Core audit files exist but supplementary files (severity ranking, cross-reference matrix, batch script) are missing or contain only stub content.
- **0.25**: Only 1–2 deliverables produced, and they may be incomplete or contain significant errors.
- **0.0**: No deliverables produced or only an empty/minimal file. File does not exist.

### Criterion 5: Cross-File Analysis and Source Credibility Assessment (Weight: 15%)

- **1.0**: Cross-references at least 5 workspace files including all three answer key versions (v1: B/33.85, v2: C/31.85, v3: A/36.85), identifies their three-way disagreement as evidence of a systemic data integrity failure (not just "keys differ"), performs independent calculation rather than trusting any key, compares answer key versions for the full batch and discovers discrepancies beyond 169663 (169665: v2 has 624 vs correct 623; 169668: v3 has option A vs correct B), does not defer to any single authority source — specifically rejects the first-pass audit's "all pass" verdict, auditor_07's methodology endorsement, and the system log's re-verification claim. Each issue in `audit_result.json` cites its evidence source file(s). The report references specific rules from both `config/audit_rules.yaml` (by rule name) and `data/svg_audit_checklist.json` (by check ID).
- **0.75**: Cross-references 3–4 sources, identifies answer key disagreement with specific values, demonstrates independent reasoning. May not find batch-wide discrepancies or may miss the v3 key.
- **0.5**: References multiple workspace files but cross-referencing is shallow — e.g., compares only two answer keys, or notes file names without comparing their specific contents.
- **0.25**: Mentions file names without meaningful cross-referencing or critical evaluation. Takes one source at face value.
- **0.0**: Examines only a single file. File does not exist.