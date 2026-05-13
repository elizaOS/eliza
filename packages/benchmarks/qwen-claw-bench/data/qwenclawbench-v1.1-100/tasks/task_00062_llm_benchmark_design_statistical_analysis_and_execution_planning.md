---
id: task_00062_llm_benchmark_design_statistical_analysis_and_execution_planning
name: LLM Benchmark Design - Statistical Analysis and Execution Planning
category: Data Analysis and Modeling
grading_type: hybrid
timeout_seconds: 1800
workspace_files:
- source: data/pilot_model_performance.csv
  dest: data/pilot_model_performance.csv
- source: data/existing_benchmarks_meta.csv
  dest: data/existing_benchmarks_meta.csv
- source: data/api_throughput_logs.csv
  dest: data/api_throughput_logs.csv
- source: data/item_response_theory_params.csv
  dest: data/item_response_theory_params.csv
- source: data/dimension_correlation_matrix.csv
  dest: data/dimension_correlation_matrix.csv
- source: config/evaluation_constraints.yaml
  dest: config/evaluation_constraints.yaml
- source: config/scoring_rubric_templates.json
  dest: config/scoring_rubric_templates.json
- source: data/token_cost_schedule.csv
  dest: data/token_cost_schedule.csv
- source: reports/previous_benchmark_analysis.md
  dest: reports/previous_benchmark_analysis.md
- source: data/difficulty_calibration_study.csv
  dest: data/difficulty_calibration_study.csv
- source: config/batch_execution_plan_v1.json
  dest: config/batch_execution_plan_v1.json
- source: data/dimension_taxonomy_draft.csv
  dest: data/dimension_taxonomy_draft.csv
- source: data/contamination_check_hashes.csv
  dest: data/contamination_check_hashes.csv
- source: reports/psychometric_standards.md
  dest: reports/psychometric_standards.md
- source: logs/api_error_log_sample.log
  dest: logs/api_error_log_sample.log
- source: data/model_capability_profiles.json
  dest: data/model_capability_profiles.json
- source: config/quality_assurance_checklist.yaml
  dest: config/quality_assurance_checklist.yaml
- source: data/inter_rater_reliability_pilot.csv
  dest: data/inter_rater_reliability_pilot.csv
grading_weights:
  automated: 0.45
  llm_judge: 0.55
verification_method: rubric
subcategory: Statistical Analysis and Modeling
---
## Prompt

We're gearing up to launch the next version of our internal LLM evaluation benchmark. I need to get a proper design document ready before the evaluation committee meeting next week — all the raw data, prior reports, and config files are sitting in the workspace for you to work with.

Here's where things stand: we ran a pilot with 5 SOTA models across 12 dimensions, and I've got IRT calibration data for 200 items, a dimension correlation matrix, API throughput logs from about a week of testing, and a taxonomy draft for expanding the dimension set. Someone on the infra team also put together a batch execution plan, there's a difficulty calibration study, inter-rater reliability numbers from a small pilot, and the hard constraints for the evaluation run are in the YAML config file.

I need you to pull all of this together into a comprehensive benchmark design document — save it as `benchmark_design.md`. Here's what it should cover:

**Psychometric quality analysis** — Dig into the IRT parameters and figure out which items we should keep vs. filter out. Look at the dimension correlation matrix for redundancy. Check the inter-rater reliability data and flag anything concerning. Use the pilot model performance to see if the current dimensions actually differentiate between models or if we're seeing ceiling/floor effects.

**Dimension architecture** — We need to reconcile the existing 12 dimensions with the proposed expansion. Both the taxonomy draft and the previous benchmark analysis have suggestions. Work out the right final set of dimensions that hits our target numbers while cutting redundancy.

**Feasibility and budget** — This one's really important. We've got a hard 3-hour execution window, a fixed API rate limit, and a $500 budget cap. I need you to actually do the math on whether 970 questions across all dimensions can be completed within those constraints. Use realistic latency numbers from the pilot and throughput logs, and be specific about token costs using the pricing schedule.

**Execution plan** — Give me a concrete batching strategy, scheduling approach, and error-handling protocol. Factor in the daily throughput patterns you can see in the API logs.

**Scoring framework** — Map each dimension to the right scoring method using the rubric templates we have. Think through the automated-vs-human scoring tradeoff, especially for the more subjective dimensions.

One important thing — cross-reference everything. These files were created at different points in time by different people, so they may not all agree with each other. If you spot inconsistencies, call them out and explain which source you're going with and why.

## Expected Behavior

The agent must produce a comprehensive `benchmark_design.md` document that synthesizes data from multiple workspace files while correctly navigating four embedded traps:

### Trap 1 — Unit Mismatch in Difficulty Calibration Study
The file `data/difficulty_calibration_study.csv` contains an `avg_latency` column with values ranging from 3,000 to 45,000. These are in **milliseconds**, but the column header does not specify units. All other files in the workspace (notably `data/pilot_model_performance.csv`) report latency in **seconds** with values ranging from 2–45. The agent should recognize that the calibration study values are ~1000x larger than expected (consistent with milliseconds rather than seconds), convert them by dividing by 1000, and use the corrected values (~3–45 seconds per question) in all time budget calculations. The correct average latency across the pilot data is approximately 10–12 seconds per question.

### Trap 2 — Outdated Rate Limit in Batch Execution Plan
The file `config/batch_execution_plan_v1.json` specifies a rate limit of 60 RPM, but the authoritative constraint file `config/evaluation_constraints.yaml` specifies **80 RPM**. The batch plan is outdated (also confirmed by the error log showing 80 RPM enforcement). The agent should identify this discrepancy, select the authoritative 80 RPM value from the constraints YAML, and explicitly document why the batch plan's 60 RPM is superseded. With the correct 80 RPM, the execution is feasible within 3 hours; the incorrect 60 RPM would incorrectly suggest ~4.2 hours, exceeding the constraint.

### Trap 3 — Contradictory Dimension Count and Question Total
The file `data/dimension_taxonomy_draft.csv` proposes 20 dimensions totaling 1,050 questions, while `config/evaluation_constraints.yaml` specifies a target of **18 dimensions and 970 questions**. The agent must recognize this contradiction and resolve it by: (a) consulting the dimension correlation matrix (`data/dimension_correlation_matrix.csv`) to identify highly correlated dimension pairs (correlations > 0.75, e.g., Reasoning/Logical Deduction at 0.786) that should be merged, and (b) adjusting the question count down from 1,050 to 970 to meet budget and time constraints. The final design should propose exactly 18 dimensions with 970 total questions.

### Trap 4 — Decimal Separator Issues in Inter-Rater Reliability Data
The file `data/inter_rater_reliability_pilot.csv` contains mixed decimal separators (commas and periods) in approximately 15% of rows. The agent should detect this data quality issue when computing inter-rater reliability statistics (e.g., ICC or Krippendorff's alpha). Naive parsing will produce incorrect reliability coefficients. The agent should flag this issue, clean the data (standardize to period decimals), and report corrected reliability statistics.

### Overall Correct Solution
The agent should produce `benchmark_design.md` containing:

1. **Psychometric Analysis**: Filter IRT items with discrimination_a < 0.5 (from `data/item_response_theory_params.csv`). **Ground Truth**: 32 items have discrimination_a < 0.5 and should be flagged for removal; 168 of 200 items are retained. Compute and report inter-rater reliability from cleaned data (after standardizing decimal separators). Identify redundant dimension pairs from the correlation matrix.

2. **Dimension Architecture**: Propose 18 final dimensions by merging 2 redundant pairs from the 20 in the taxonomy draft. **Ground Truth**: The two highest-correlation pairs are Reasoning / Logical Deduction (r = 0.786) and Mathematics / Data Analysis (r = 0.755), both above the 0.75 threshold for merging. Map dimensions to scoring methods from `config/scoring_rubric_templates.json`.

3. **Feasibility Analysis**: Using 80 RPM (not 60), latency in seconds (not milliseconds), and the token cost schedule, demonstrate that 970 questions can be completed within 3 hours and $500. Show the arithmetic: at 80 RPM with realistic average latency (~10-12 seconds from pilot data), throughput supports ~970 questions in approximately 2-2.5 hours with buffer.

4. **Execution Plan**: Propose batching that accounts for daily load patterns visible in `data/api_throughput_logs.csv` (lower traffic in early morning hours), error retry logic, and concurrent connection management within the 16-connection limit.

5. **Scoring Framework**: Map each of 18 dimensions to appropriate scoring methods, distinguishing automated (exact match, code execution) from human-judged (creative writing, open-ended) categories.

6. **Data Quality Notes**: Explicitly document all discovered discrepancies between files and justify resolution decisions.

## Grading Criteria

- [ ] **output_file_exists**: The output file `benchmark_design.md` exists and is a well-structured document with clearly labeled sections covering psychometric analysis, dimension architecture, feasibility/budget, execution planning, and scoring framework
- [ ] **unit_mismatch_identified**: The agent identifies the unit mismatch in `data/difficulty_calibration_study.csv` (milliseconds vs. seconds) and either converts values or explicitly flags the discrepancy, using correct latency values (~3–45 seconds) in time budget calculations
- [ ] **correct_rate_limit_used**: The agent uses the correct 80 RPM rate limit from `config/evaluation_constraints.yaml` rather than the outdated 60 RPM from `config/batch_execution_plan_v1.json`, and notes the discrepancy between these files
- [ ] **eighteen_dimensions_resolved**: The agent resolves the dimension count contradiction between the taxonomy draft (20 dimensions, 1,050 questions) and the constraints (18 dimensions, 970 questions), proposing a final set of 18 dimensions with justification
- [ ] **total_970_questions**: The document references the target of 970 total questions and uses this number in feasibility and budget calculations
- [ ] **correlated_dimensions_identified**: The agent identifies at least one pair of highly correlated dimensions (r > 0.75) from `data/dimension_correlation_matrix.csv` as candidates for merging (e.g., Reasoning and Logical Deduction at r = 0.786)
- [ ] **decimal_separator_addressed**: The agent detects and addresses the data quality issue with mixed decimal separators in `data/inter_rater_reliability_pilot.csv` before computing reliability statistics
- [ ] **irt_item_filtering**: The IRT analysis identifies items with discrimination_a < 0.5 as candidates for removal and reports the count of retained vs. filtered items (168 retained out of 200)
- [ ] **feasibility_analysis_complete**: The feasibility analysis includes concrete arithmetic showing that 970 questions are achievable within the 3-hour window and $500 budget, using token cost data and realistic latency estimates
- [ ] **execution_plan_with_scheduling**: The execution plan accounts for daily throughput patterns from `data/api_throughput_logs.csv`, proposes scheduling during lower-traffic periods, and addresses batching/concurrency
- [ ] **scoring_framework_section**: The scoring framework maps dimensions to appropriate scoring methods referencing `config/scoring_rubric_templates.json` and distinguishes between automated and human-judged evaluation types
- [ ] **cross_referencing_documented**: The document explicitly calls out discrepancies between data sources and explains which source is trusted and why, demonstrating cross-referencing rather than naive acceptance of any single file

## Automated Checks

```python
import os
import re
from pathlib import Path


def grade(transcript: list, workspace_path: str) -> dict:
    """Grade the benchmark_design.md output file."""

    results = {
        "output_file_exists": 0.0,
        "unit_mismatch_identified": 0.0,
        "correct_rate_limit_used": 0.0,
        "eighteen_dimensions_resolved": 0.0,
        "total_970_questions": 0.0,
        "correlated_dimensions_identified": 0.0,
        "decimal_separator_addressed": 0.0,
        "irt_item_filtering": 0.0,
        "feasibility_analysis_complete": 0.0,
        "execution_plan_with_scheduling": 0.0,
        "scoring_framework_section": 0.0,
        "cross_referencing_documented": 0.0,
    }

    output_path = Path(workspace_path) / "benchmark_design.md"
    if not output_path.is_file():
        return results

    content = output_path.read_text(encoding="utf-8", errors="replace")
    if not content.strip():
        return results
    content_lower = content.lower()
    paragraphs = re.split(r'\n\s*\n', content)

    # --- output_file_exists ---
    has_sections = sum(
        1 for kw in ["psychometric", "dimension", "feasib", "execution", "scoring"]
        if kw in content_lower
    )
    results["output_file_exists"] = 1.0 if has_sections >= 4 else (0.5 if has_sections >= 2 else 0.25)

    # --- unit_mismatch_identified ---
    mentions_ms = re.search(r'\bmilliseconds?\b', content_lower)
    mentions_unit_issue = re.search(r'(?:unit\s+(?:mismatch|discrepanc|conversion|inconsistenc)|\bconvert)', content_lower)
    mentions_latency = re.search(r'\blatency\b', content_lower)
    if mentions_ms and mentions_latency:
        results["unit_mismatch_identified"] = 1.0
    elif mentions_unit_issue and mentions_latency:
        results["unit_mismatch_identified"] = 0.75
    elif mentions_ms or mentions_unit_issue:
        results["unit_mismatch_identified"] = 0.5

    # --- correct_rate_limit_used ---
    has_80_rpm = bool(re.search(r'\b80\b', content) and re.search(r'(?i)(rpm|rate[\s_-]*limit|requests?\s*per\s*minute)', content))
    notes_60_discrepancy = bool(re.search(r'\b60\b', content) and re.search(r'(?i)(outdated|incorrect|old|superseded|discrepanc|overrid)', content_lower))
    if has_80_rpm and notes_60_discrepancy:
        results["correct_rate_limit_used"] = 1.0
    elif has_80_rpm:
        results["correct_rate_limit_used"] = 0.75
    elif re.search(r'\b80\b', content):
        results["correct_rate_limit_used"] = 0.25

    # --- eighteen_dimensions_resolved ---
    has_18 = bool(re.search(r'(?i)\b(18|eighteen)\s*dimensions?', content))
    mentions_20_to_18 = bool(re.search(r'\b20\b', content) and re.search(r'\b18\b', content) and re.search(r'(?i)(merg|consolidat|reduc|reconcil)', content_lower))
    if has_18 and mentions_20_to_18:
        results["eighteen_dimensions_resolved"] = 1.0
    elif has_18:
        results["eighteen_dimensions_resolved"] = 0.75
    elif re.search(r'\b18\b', content):
        results["eighteen_dimensions_resolved"] = 0.25

    # --- total_970_questions ---
    if re.search(r'\b970\b', content):
        results["total_970_questions"] = 1.0
    elif re.search(r'\b9[67]\d\b', content):
        results["total_970_questions"] = 0.5

    # --- correlated_dimensions_identified ---
    mentions_correlation = re.search(r'(?i)(correlat|redundan)', content_lower)
    mentions_specific_pair = re.search(r'(?i)(reasoning.*logical|logical.*reasoning|mathematics.*data\s*analysis|data\s*analysis.*mathematics)', content_lower)
    mentions_threshold = re.search(r'0\.7[5-9]|0\.8', content)
    score = 0.0
    if mentions_correlation:
        score += 0.25
    if mentions_specific_pair:
        score += 0.5
    if mentions_threshold:
        score += 0.25
    results["correlated_dimensions_identified"] = min(score, 1.0)

    # --- decimal_separator_addressed ---
    mentions_decimal = re.search(r'(?i)(decimal\s*separator|comma\s*(?:as\s*)?decimal|mixed\s*(?:decimal|format)|separator\s*issue)', content_lower)
    mentions_irr = re.search(r'(?i)(inter[\s-]*rater|reliability|icc|kappa|krippendorff)', content_lower)
    if mentions_decimal and mentions_irr:
        results["decimal_separator_addressed"] = 1.0
    elif mentions_decimal:
        results["decimal_separator_addressed"] = 0.75
    elif mentions_irr:
        results["decimal_separator_addressed"] = 0.25

    # --- irt_item_filtering ---
    mentions_irt = re.search(r'(?i)(item\s*response\s*theory|\bIRT\b|discrimination)', content)
    mentions_filtering = re.search(r'(?i)(filter|remov|retain|discard|flagg)', content_lower)
    mentions_threshold_05 = re.search(r'0\.5', content)
    mentions_count = re.search(r'\b(168|32)\b', content)
    score = 0.0
    if mentions_irt:
        score += 0.25
    if mentions_filtering:
        score += 0.25
    if mentions_threshold_05:
        score += 0.25
    if mentions_count:
        score += 0.25
    results["irt_item_filtering"] = min(score, 1.0)

    # --- feasibility_analysis_complete ---
    mentions_3hr = re.search(r'(?i)(3[\s-]*hours?|three[\s-]*hours?|180\s*min)', content)
    mentions_budget = re.search(r'(?i)(\$\s*500|500\s*dollar|\bbudget\b)', content)
    has_arithmetic = re.search(r'(?i)(970\s*/\s*80|970\s*÷|questions?\s*/\s*\d|minutes?\s*per)', content)
    score = 0.0
    if mentions_3hr:
        score += 0.35
    if mentions_budget:
        score += 0.35
    if has_arithmetic:
        score += 0.3
    results["feasibility_analysis_complete"] = min(score, 1.0)

    # --- execution_plan_with_scheduling ---
    mentions_batch = re.search(r'(?i)(batch|concurrent|parallel)', content_lower)
    mentions_scheduling = re.search(r'(?i)(schedul|throughput\s*pattern|low[\s-]*traffic|off[\s-]*peak|morning|daily\s*pattern)', content_lower)
    mentions_error_handling = re.search(r'(?i)(retry|error[\s-]*handl|fault[\s-]*toler|timeout)', content_lower)
    score = 0.0
    if mentions_batch:
        score += 0.4
    if mentions_scheduling:
        score += 0.35
    if mentions_error_handling:
        score += 0.25
    results["execution_plan_with_scheduling"] = min(score, 1.0)

    # --- scoring_framework_section ---
    mentions_scoring = re.search(r'(?i)(scoring\s*(framework|rubric|method|approach|strateg)|evaluation\s*method)', content_lower)
    mentions_auto_vs_human = re.search(r'(?i)(automat|human[\s-]*judg|manual[\s-]*eval|subjective)', content_lower)
    if mentions_scoring and mentions_auto_vs_human:
        results["scoring_framework_section"] = 1.0
    elif mentions_scoring:
        results["scoring_framework_section"] = 0.5

    # --- cross_referencing_documented ---
    mentions_discrepancy = re.search(r'(?i)(discrepanc|inconsistenc|conflict|contradict|mismatch)', content_lower)
    mentions_trust = re.search(r'(?i)(trust|authorit|supersed|overrid|prefer|reliable|canonical)', content_lower)
    if mentions_discrepancy and mentions_trust:
        results["cross_referencing_documented"] = 1.0
    elif mentions_discrepancy:
        results["cross_referencing_documented"] = 0.5

    return results
```

## LLM Judge Rubric

> **Fallback Rule**: If the output file `benchmark_design.md` does not exist or is empty, all rubric dimensions receive a score of **0.0** regardless of other criteria.

### Criterion 1: Trap Detection Reasoning Quality (Weight: 40%)
**Score 1.0**: The document demonstrates explicit, well-reasoned detection and resolution of all four embedded traps. For each trap, the agent articulates *why* the discrepancy exists (e.g., explains the ~1000x magnitude difference in latency values, notes the batch plan version is outdated relative to the YAML config, identifies specific redundant dimension pairs from the correlation matrix with thresholds cited, and flags the comma-decimal formatting issue in inter-rater reliability data). Resolutions are justified with cross-referencing between multiple files, not just assertions.
**Score 0.75**: The agent explicitly detects and resolves at least three of the four traps with clear reasoning, and shows partial awareness of the fourth (e.g., arrives at the correct answer but doesn't explain the root cause). Cross-referencing between files is present but may lack depth for one trap.
**Score 0.5**: The agent detects and resolves two traps with sound reasoning, but misses or silently handles the others without explanation. Some correct numbers appear in the output but without evidence that the agent understood the underlying data conflict (e.g., uses 80 RPM without noting the discrepancy with the batch plan, or uses correct latency values without acknowledging the unit mismatch).
**Score 0.25**: The agent detects only one trap explicitly. Other correct values may appear coincidentally or through hallucination rather than demonstrated analytical reasoning. The document shows minimal evidence of cross-file validation.
**Score 0.0**: The agent fails to detect any traps or actively propagates incorrect values (e.g., uses 60 RPM, treats millisecond latencies as seconds, accepts 20 dimensions and 1050 questions without reconciliation, or reports corrupted reliability statistics from unparsed comma decimals).

### Criterion 2: Analytical Depth and Data-Grounded Argumentation (Weight: 35%)
**Score 1.0**: The psychometric analysis section provides specific, data-grounded arguments: cites actual IRT discrimination/difficulty parameter ranges and thresholds for item retention, identifies specific dimension pairs from the correlation matrix with their correlation coefficients, discusses inter-rater reliability metrics (e.g., Cohen's kappa or ICC values) with interpretation, and uses pilot model performance data to argue which dimensions differentiate models versus which show ceiling/floor effects. Recommendations clearly flow from the data rather than generic best practices.
**Score 0.75**: Most analytical sections reference specific data points and parameter values from the workspace files. The reasoning chain from data to recommendation is clear in most sections, though one area (e.g., dimension differentiation analysis or IRT filtering criteria) may rely more on general psychometric principles than on the specific pilot data.
**Score 0.5**: The document contains some specific data references but frequently falls back on generic psychometric guidance without tying it to the actual pilot results. The dimension architecture rationale mentions correlations but doesn't cite specific pairs or values. Item retention criteria are stated but not grounded in the observed IRT parameter distributions.
**Score 0.25**: The analysis is largely generic, reading like a textbook summary of benchmark design rather than an analysis of this specific pilot data. Few or no specific values from the workspace files are cited. Recommendations could apply to any benchmark without modification.
**Score 0.0**: The document contains no meaningful analysis of the provided data. Sections are either empty, purely aspirational, or contain hallucinated statistics that don't correspond to any workspace file.

### Criterion 3: Document Coherence, Professional Quality, and Completeness as a Committee-Ready Deliverable (Weight: 25%)
**Score 1.0**: The document reads as a polished, committee-ready design document with logical flow from problem statement through analysis to concrete recommendations. Sections build on each other (e.g., psychometric findings feed into dimension architecture, which feeds into execution planning). The writing is precise, uses appropriate technical terminology, includes clear section structure with headings, and provides actionable next steps. Constraints from the YAML config are woven throughout as governing parameters rather than mentioned in isolation.
**Score 0.75**: The document is well-structured and mostly coherent, with clear sections and professional tone. Minor issues such as occasional redundancy between sections, one section that doesn't clearly connect to the others, or a missing transition between analysis and recommendations. Overall suitable for committee review with minor edits.
**Score 0.5**: The document covers the required topics but reads more like a collection of independent analyses than an integrated design document. Some sections may contradict others or repeat information without synthesis. The tone is inconsistent (mixing informal notes with formal analysis), or the logical flow requires the reader to infer connections between sections.
**Score 0.25**: The document is disorganized, with sections that appear in illogical order, significant gaps in coverage, or a structure that doesn't serve the stated purpose of committee review. Key decisions are buried or unstated, and the reader cannot easily extract the final design choices.
**Score 0.0**: The output is incoherent, fragmentary, or so poorly structured that it would not be usable as a committee deliverable. Major sections are missing, or the document contradicts itself on fundamental design choices without resolution.