---
id: task_00020_expert_workbench_implementation_plan_for_engineering_operations_support
name: Expert Workbench Implementation Plan for Engineering Operations Support Center
category: Workflow and Agent Orchestration
grading_type: hybrid
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
grading_weights:
  automated: 0.45
  llm_judge: 0.55
workspace_files:
- source: data/current_system_inventory.csv
  dest: data/current_system_inventory.csv
- source: data/expert_roster.csv
  dest: data/expert_roster.csv
- source: data/incident_log_2024.csv
  dest: data/incident_log_2024.csv
- source: config/project_charter_v2.yaml
  dest: config/project_charter_v2.yaml
- source: config/infrastructure_specs.json
  dest: config/infrastructure_specs.json
- source: docs/stakeholder_requirements.md
  dest: docs/stakeholder_requirements.md
- source: docs/ai_model_catalog.json
  dest: docs/ai_model_catalog.json
- source: data/budget_breakdown_v1.csv
  dest: data/budget_breakdown_v1.csv
- source: docs/competitor_analysis_2023.md
  dest: docs/competitor_analysis_2023.md
- source: config/data_classification_policy.yaml
  dest: config/data_classification_policy.yaml
- source: data/kpi_targets_2025.json
  dest: data/kpi_targets_2025.json
- source: logs/integration_test_results.log
  dest: logs/integration_test_results.log
- source: docs/org_chart_engineering.md
  dest: docs/org_chart_engineering.md
- source: config/api_gateway_config.yaml
  dest: config/api_gateway_config.yaml
subcategory: Scenario-Based Automation Applications
---
## Prompt

We're about three weeks from our steering committee presentation for the Expert Workbench initiative — the intelligent support center platform for our engineering operations division. I've been pulled onto a parallel workstream and I need someone to synthesize the project materials into a decision-ready implementation plan.

Please create `deliverables/expert_workbench_plan.md`.

The steering committee will have the same source files, so the document needs to do more than summarize: it should reconcile conflicts, show which sources you treated as authoritative, and use concrete evidence where the data supports a claim. Some documents were produced at different times and not all of them line up cleanly. If two sources disagree, don't just pick one silently — explain the conflict, the operational impact, and your recommended resolution.

Structure the plan with these seven sections:

- **Executive Summary**
- **Current State Analysis**
- **Technical Architecture**
- **Resource & Budget Plan**
- **Risk Register**
- **KPI Framework**
- **Phased Roadmap**

What I need from the plan:

- A clear statement of scope, objectives, budget, timeline, and staffing assumptions grounded in the most authoritative documents
- A current-state assessment of the existing systems landscape, including what is active vs. deprecated vs. planned and how systems integrate today
- A quantitative analysis of the 2024 incident data and expert roster, using actual figures rather than rough impressions
- An architecture recommendation that is realistically deployable under the stated infrastructure, network, security, and data-classification constraints
- A budget and resourcing view that surfaces discrepancies rather than smoothing them over
- A risk register with at least 8 material risks, not just generic project risks
- A KPI framework tied to platform capabilities and measurement mechanisms
- A roadmap that is consistent with the governing plan, including dates, phase dependencies, and likely bottlenecks

A few things I especially care about:
- outdated recommendations should not be treated as current simply because they sound attractive
- if a configuration or operational assumption looks internally inconsistent, call it out
- if a requirement appears hard to satisfy under current infrastructure conditions, say so and explain the trade-off
- avoid generic “best practice” filler unless it is directly tied to evidence in the workspace

This should read like something I can put in front of a steering committee without getting challenged on the numbers.

## Expected Behavior

The agent should review the workspace files and produce a comprehensive implementation plan at `deliverables/expert_workbench_plan.md`.

A correct solution is not just a polished narrative. It must make grounded judgments under conflicting evidence and include quantitative claims that are consistent with the assets.

### Data Synthesis Expectations

1. **System Inventory**
   - Parse `data/current_system_inventory.csv`.
   - Correct counts are:
     - total systems: **35**
     - active: **25**
     - deprecated: **6**
     - planned: **4**
     - API integrations: **24**
     - batch integrations: **7**
     - manual integrations: **4**
   - Good solutions will distinguish present-state systems from planned additions and may call out that the environment is already API-heavy but still carries batch/manual legacy dependencies.

2. **Incident Log**
   - Parse `data/incident_log_2024.csv` (200 incidents).
   - At minimum, the plan should use correctly computed values close to the following:
     - P1 incident count: **18**
     - P1 average response time: **49.7 minutes**
     - P1 average resolution time: **4.4 hours**
     - overall average resolution time: **13.7 hours**
   - Additional valid observations include:
     - severity volumes: P1 **18**, P2 **43**, P3 **71**, P4 **68**
     - by category volumes: equipment_failure **63**, knowledge_query **53**, process_anomaly **42**, remote_diagnosis **24**, safety_alert **18**
     - average response times by severity are approximately:
       - P1 **49.7**
       - P2 **89.5**
       - P3 **126.6**
       - P4 **172.1**
   - The model does not need to reproduce every number above, but any quantitative claims it makes about incident patterns should be consistent with the CSV, not invented.
   - A strong answer should notice the gap between the charter/KPI ambition (P1 target 15 min) and the actual 2024 baseline in the incident log (~50 min), even though another file states a baseline of 45 min. This is a data-governance issue worth calling out rather than averaging away.

3. **Expert Roster**
   - Parse `data/expert_roster.csv`.
   - Correct values include:
     - total experts: **48**
     - average availability: **0.57** (56.7%)
     - HQ experts: **9**, onshore: **24**, offshore: **15**
     - specialty distribution:
       - geology **8**
       - drilling **8**
       - completion **8**
       - production **8**
       - reservoir **6**
       - HSE **6**
   - Useful higher-order reasoning:
     - 48 named experts sounds ample, but average availability implies only ~**27.2 effective FTE-equivalents**
     - this is close to, not massively above, the charter's 25-person delivery team
     - therefore any roadmap assuming abundant SME capacity throughout all phases is risky

4. **Budget and Charter**
   - `config/project_charter_v2.yaml` is the governing source for approved budget, timeline, and team size unless the plan makes a compelling reason otherwise.
   - Correct charter values:
     - budget total: **18,500,000 CNY**
     - timeline: **18 months**
     - dates: **2025-03-01 to 2026-08-31**
     - team size: **25**
   - `data/budget_breakdown_v1.csv` sums to **15,200,000 CNY**, creating a **3,300,000 CNY** gap relative to the approved charter.
   - A stronger answer may also note that `BUD-014` is explicitly scoped as “Core Development Team (12 months),” which does not cleanly align with an 18-month chartered timeline and suggests the v1 budget is not only lower but structurally outdated.

5. **Outdated/Lower-Authority Recommendations**
   - `docs/competitor_analysis_2023.md` contains recommendations that are plausible-sounding but should not be adopted as current truth:
     - **12-month timeline**
     - **team of 15**
     - **monolithic architecture**
     - **GPT-3.5 as primary LLM**
   - The plan should identify this document as older and lower-authority, ideally by citing **Document ID EOISC-CA-2023-001** and/or its 2023 date / Q2 2023 footer.
   - Correct handling is not “ignore this file”; it is to use it as contextual market input while explicitly rejecting superseded delivery assumptions where they conflict with the approved charter and current requirements.

6. **API Gateway / Configuration Trap**
   - In `config/api_gateway_config.yaml`, the route `/expert-workbench/api/v1/*` is rate-limited at **1000 per minute**, while the nested sessions route `/expert-workbench/api/v1/sessions/*` is set to **1000 per second**.
   - The plan should identify this as a material inconsistency and quantify that it is a **60x** difference in allowed request rate.
   - Good answers should explain why this matters operationally (e.g., overload risk, unfair throttling, ambiguous intended policy, test instability).

7. **Requirement vs Infrastructure Tension**
   - A stronger solution should not treat all requirements as equally easy.
   - One important tension: `REQ-001` requires real-time video consultation with latency **<=500ms** on 4G/5G networks, while offshore platforms in `config/infrastructure_specs.json` currently show **VSAT satellite** with average latency **600ms**.
   - Correct interpretation: the requirement may be achievable for onshore / future upgraded sites but is not credibly met for current offshore connectivity without mitigation, scoping, or phased dependency on planned network improvements.
   - This is not a simple contradiction in text; it requires cross-document reasoning and should influence architecture, risk, and roadmap.

### Required Conflict Handling

The implementation plan should explicitly identify and resolve these issues:

1. **Budget discrepancy**
   - Charter v2 approved total: **18.5M CNY**
   - Budget breakdown v1 total: **15.2M CNY**
   - Gap: **3.3M CNY**
   - Correct resolution: treat charter v2 as authoritative approved total and recommend budget-breakdown refresh.

2. **Timeline/team conflict with outdated competitor analysis**
   - Competitor analysis recommends **12 months / 15 people**
   - Charter v2 specifies **18 months / 25 people**
   - Correct resolution: use charter values and explicitly mark the competitor recommendations as outdated / superseded.

3. **API rate-limit inconsistency**
   - `per_minute` vs `per_second` mismatch
   - Must be flagged as a deployment/configuration risk.

4. **Requirement/infrastructure feasibility gap**
   - Offshore network latency (600 ms) vs REQ-001 latency target (<=500 ms)
   - Good solutions should either scope the requirement, phase it behind network upgrades, or propose fallback behavior rather than pretending full compliance is immediate.

### Document Quality Expectations

- The output should be well-structured Markdown with the seven requested sections.
- Quantitative claims should be traceable to the workspace files.
- The risk register should contain at least 8 distinct, material risks and should include data inconsistency / governance risks rather than only generic delivery risks.
- The roadmap should align to the charter’s five phases and dates:
  - Requirements & Analysis: **2025-03 to 2025-05**
  - System Design: **2025-06 to 2025-08**
  - Development & Integration: **2025-09 to 2026-02**
  - Testing & Validation: **2026-03 to 2026-05**
  - Deployment & Rollout: **2026-06 to 2026-08**
- Strong solutions will connect analysis to action: e.g., budget issues affect funding governance, connectivity issues affect rollout scope, expert availability affects staffing and milestone realism.

## Grading Criteria

- [ ] Output file exists at `deliverables/expert_workbench_plan.md` and is structured Markdown with all seven requested sections
- [ ] Executive Summary uses the approved charter values: **18,500,000 CNY**, **18 months**, **25 people**, and includes the charter date range (**2025-03-01 to 2026-08-31**) or an equivalent month-level rendering
- [ ] Current State Analysis includes correct quantitative system inventory analysis with counts that match the CSV (35 total; 25 active; 6 deprecated; 4 planned; integration mix)
- [ ] Current State Analysis includes at least two correct incident metrics derived from the CSV, with one severity-based metric and one broader metric (e.g. P1 count, P1 avg response time, overall avg resolution time, category distribution)
- [ ] Current State Analysis includes correct expert-roster analysis, including **48 experts** and either average availability (~56.7%) or the implied ~27 FTE-equivalent capacity
- [ ] Resource & Budget Plan explicitly identifies the **18.5M vs 15.2M** discrepancy, quantifies the **3.3M CNY** gap, and treats charter v2 as authoritative
- [ ] The plan explicitly identifies the competitor analysis as outdated / lower authority (ideally citing **EOISC-CA-2023-001**) and does **not** adopt its **12-month / 15-person / monolith / GPT-3.5-primary** recommendations as the governing plan
- [ ] The plan identifies the API gateway inconsistency as **1000/minute vs 1000/second** and explains the risk of the **60x** mismatch
- [ ] Technical Architecture references specific AI models from the catalog and addresses data classification / security controls from the policy
- [ ] Risk Register contains at least **8 distinct risks**, including document/configuration inconsistency risks and at least one feasibility risk driven by infrastructure or staffing constraints
- [ ] KPI Framework references specific KPI targets from `data/kpi_targets_2025.json`, including the **P1 response time target of 15 minutes** in KPI context
- [ ] Phased Roadmap aligns with the charter’s **5-phase** structure and **2025-03 to 2026-08** timeline, with dependencies or bottlenecks rather than a generic sequence
- [ ] Higher-scoring solutions will also surface at least one non-obvious cross-file issue, such as the offshore latency vs REQ-001 tension or the 12-month staffing/budget assumptions embedded in the v1 budget line items

## Automated Checks

```python
import os
import re
import csv
import json
from pathlib import Path
from collections import Counter, defaultdict

def _read_text(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()

def _normalize_number(s):
    return re.sub(r"[,\s]", "", s)

def _extract_heading_blocks(content):
    lines = content.splitlines()
    headings = []
    for i, line in enumerate(lines):
        if re.match(r'^\s{0,3}#{1,6}\s+', line):
            headings.append((i, line.strip()))
    return headings, lines

def _section_exists(content, terms):
    pattern = r'(?im)^\s{0,3}#{1,6}\s+.*(?:' + "|".join(terms) + r')'
    return bool(re.search(pattern, content))

def _find_numbers_near_terms(content, term_patterns, window=120):
    out = []
    for term_pat in term_patterns:
        for m in re.finditer(term_pat, content, flags=re.I | re.S):
            start = max(0, m.start() - window)
            end = min(len(content), m.end() + window)
            out.append(content[start:end])
    return out

def _contains_number_with_context(content, number_patterns, context_patterns, window=120):
    contexts = _find_numbers_near_terms(content, context_patterns, window=window)
    for chunk in contexts:
        for np in number_patterns:
            if re.search(np, chunk, flags=re.I):
                return True
    return False

def _parse_markdown_table_risk_count(content):
    risk_section = re.search(
        r'(?is)^\s{0,3}#{1,6}\s+.*risk register.*?(.*?)(?=^\s{0,3}#{1,6}\s+|\Z)',
        content
    )
    if not risk_section:
        risk_section = re.search(
            r'(?is)^\s{0,3}#{1,6}\s+.*risk.*?(.*?)(?=^\s{0,3}#{1,6}\s+|\Z)',
            content
        )
    if not risk_section:
        return 0
    body = risk_section.group(1)
    lines = [ln.strip() for ln in body.splitlines() if ln.strip()]
    bullet_count = sum(1 for ln in lines if re.match(r'^[-*]\s+', ln) or re.match(r'^\d+\.\s+', ln))
    table_rows = 0
    table_lines = [ln for ln in lines if "|" in ln]
    if len(table_lines) >= 3:
        for ln in table_lines[2:]:
            if re.search(r'\|', ln) and not re.fullmatch(r'[\|\-\s:]+', ln):
                table_rows += 1
    return max(bullet_count, table_rows)

def _load_ground_truth(workspace_path):
    gt = {}

    inv_path = os.path.join(workspace_path, "data", "current_system_inventory.csv")
    with open(inv_path, "r", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    gt["systems_total"] = len(rows)
    gt["status_counts"] = Counter(r["status"].strip().lower() for r in rows)
    gt["integration_counts"] = Counter(r["integration_type"].strip().lower() for r in rows)

    expert_path = os.path.join(workspace_path, "data", "expert_roster.csv")
    with open(expert_path, "r", encoding="utf-8") as f:
        erows = list(csv.DictReader(f))
    gt["expert_total"] = len(erows)
    gt["expert_avg_availability"] = sum(float(r["availability_pct"]) for r in erows) / len(erows)
    gt["expert_location_counts"] = Counter(r["location"].strip().lower() for r in erows)
    gt["expert_specialty_counts"] = Counter(r["specialty"].strip().lower() for r in erows)

    incident_path = os.path.join(workspace_path, "data", "incident_log_2024.csv")
    with open(incident_path, "r", encoding="utf-8") as f:
        irows = list(csv.DictReader(f))
    gt["incident_total"] = len(irows)
    sev_counts = Counter(r["severity"].strip() for r in irows)
    gt["incident_severity_counts"] = sev_counts
    cat_counts = Counter(r["category"].strip() for r in irows)
    gt["incident_category_counts"] = cat_counts

    p1_rows = [r for r in irows if r["severity"].strip() == "P1"]
    gt["p1_count"] = len(p1_rows)
    gt["p1_avg_response"] = sum(float(r["response_time_minutes"]) for r in p1_rows) / len(p1_rows)
    gt["p1_avg_resolution"] = sum(float(r["resolution_time_hours"]) for r in p1_rows) / len(p1_rows)
    gt["overall_avg_resolution"] = sum(float(r["resolution_time_hours"]) for r in irows) / len(irows)

    budget_path = os.path.join(workspace_path, "data", "budget_breakdown_v1.csv")
    with open(budget_path, "r", encoding="utf-8") as f:
        brows = list(csv.DictReader(f))
    gt["budget_v1_total"] = sum(int(r["amount_cny"]) for r in brows)
    gt["budget_gap"] = 18500000 - gt["budget_v1_total"]

    return gt

def grade(transcript: list, workspace_path: str) -> dict:
    output_file = os.path.join(workspace_path, "deliverables", "expert_workbench_plan.md")

    results = {
        "file_created": 0.0,
        "section_executive_summary": 0.0,
        "section_current_state": 0.0,
        "section_technical_architecture": 0.0,
        "section_resource_budget": 0.0,
        "section_risk_register": 0.0,
        "section_kpi_framework": 0.0,
        "section_phased_roadmap": 0.0,
        "correct_budget_reference": 0.0,
        "correct_timeline_18_months": 0.0,
        "correct_team_size_25": 0.0,
        "roadmap_date_range_present": 0.0,
        "system_inventory_counts_present": 0.0,
        "incident_p1_count_correct": 0.0,
        "incident_p1_response_correct": 0.0,
        "incident_overall_resolution_correct": 0.0,
        "expert_roster_metrics_present": 0.0,
        "budget_gap_33m_flagged": 0.0,
        "competitor_doc_outdated_flagged": 0.0,
        "avoids_adopting_outdated_12_month_15_person_plan": 0.0,
        "flags_api_rate_limit_inconsistency": 0.0,
        "api_60x_difference_quantified": 0.0,
        "kpi_response_time_target_contextualized": 0.0,
        "mentions_specific_ai_models": 0.0,
        "data_security_mentioned": 0.0,
        "risk_register_at_least_8": 0.0,
        "roadmap_5_phases_dates": 0.0,
        "cross_file_feasibility_gap_flagged": 0.0,
    }

    if not os.path.isfile(output_file):
        return results
    results["file_created"] = 1.0

    try:
        content = _read_text(output_file)
    except Exception:
        return results

    if not content.strip():
        return results

    try:
        gt = _load_ground_truth(workspace_path)
    except Exception:
        return results

    # Section checks
    if _section_exists(content, ["executive\\s+summary"]):
        results["section_executive_summary"] = 1.0
    if _section_exists(content, ["current\\s+state\\s+analysis"]):
        results["section_current_state"] = 1.0
    if _section_exists(content, ["technical\\s+architecture"]):
        results["section_technical_architecture"] = 1.0
    if _section_exists(content, ["resource\\s*&\\s*budget\\s+plan", "resource\\s+and\\s+budget\\s+plan"]):
        results["section_resource_budget"] = 1.0
    if _section_exists(content, ["risk\\s+register"]):
        results["section_risk_register"] = 1.0
    if _section_exists(content, ["kpi\\s+framework"]):
        results["section_kpi_framework"] = 1.0
    if _section_exists(content, ["phased\\s+roadmap"]):
        results["section_phased_roadmap"] = 1.0

    # Charter values with context
    if re.search(r'18[,\s]?500[,\s]?000', content) or re.search(r'18\.5\s*[Mm]', content) or re.search(r'1850\s*万', content):
        results["correct_budget_reference"] = 1.0

    if _contains_number_with_context(
        content,
        [r'\b18\s*months?\b', r'\b18\s*个月\b'],
        [r'timeline', r'project', r'charter', r'roadmap', r'implementation']
    ):
        results["correct_timeline_18_months"] = 1.0

    if _contains_number_with_context(
        content,
        [r'\b25\b', r'\b25\s*people\b', r'\b25\s*(?:person|persons|members)\b', r'\b25\s*人\b'],
        [r'team', r'staff', r'headcount', r'people', r'members']
    ):
        results["correct_team_size_25"] = 1.0

    if re.search(r'2025[-/ ]0?3', content) and re.search(r'2026[-/ ]0?8', content):
        results["roadmap_date_range_present"] = 1.0

    # System inventory counts
    system_count_hits = 0
    if _contains_number_with_context(content, [rf'\b{gt["systems_total"]}\b'], [r'systems?', r'inventory']):
        system_count_hits += 1
    if _contains_number_with_context(content, [rf'\b{gt["status_counts"]["active"]}\b'], [r'active']):
        system_count_hits += 1
    if _contains_number_with_context(content, [rf'\b{gt["status_counts"]["deprecated"]}\b'], [r'deprecated']):
        system_count_hits += 1
    if _contains_number_with_context(content, [rf'\b{gt["status_counts"]["planned"]}\b'], [r'planned']):
        system_count_hits += 1
    if _contains_number_with_context(content, [rf'\b{gt["integration_counts"]["api"]}\b'], [r'api']):
        system_count_hits += 1
    if _contains_number_with_context(content, [rf'\b{gt["integration_counts"]["batch"]}\b'], [r'batch']):
        system_count_hits += 1
    if _contains_number_with_context(content, [rf'\b{gt["integration_counts"]["manual"]}\b'], [r'manual']):
        system_count_hits += 1
    if system_count_hits >= 4:
        results["system_inventory_counts_present"] = 1.0

    # Incident metrics checks with tolerance
    p1_count = gt["p1_count"]
    p1_resp = gt["p1_avg_response"]
    overall_res = gt["overall_avg_resolution"]

    if _contains_number_with_context(
        content,
        [rf'\b{p1_count}\b', rf'\b{p1_count-1}\b', rf'\b{p1_count+1}\b'],
        [r'P1', r'priority\s*1', r'incident']
    ):
        results["incident_p1_count_correct"] = 1.0

    p1_resp_patterns = [
        r'\b49(?:\.\d+)?\b', r'\b50(?:\.\d+)?\b', r'\b4[5-9]\.\d+\b'
    ]
    if _contains_number_with_context(
        content,
        p1_resp_patterns,
        [r'P1', r'response\s*time', r'avg(?:erage)?\s*response']
    ):
        results["incident_p1_response_correct"] = 1.0

    overall_res_patterns = [
        r'\b13(?:\.\d+)?\b', r'\b14(?:\.\d+)?\b'
    ]
    if _contains_number_with_context(
        content,
        overall_res_patterns,
        [r'overall', r'average', r'resolution\s*time']
    ):
        results["incident_overall_resolution_correct"] = 1.0

    # Expert roster checks
    expert_hits = 0
    if _contains_number_with_context(content, [rf'\b{gt["expert_total"]}\b'], [r'experts?', r'roster']):
        expert_hits += 1
    if _contains_number_with_context(content, [r'\b56(?:\.\d+)?%?\b', r'\b57(?:\.\d+)?%?\b', r'\b0\.56\b', r'\b0\.57\b'], [r'availability']):
        expert_hits += 1
    if _contains_number_with_context(content, [r'\b27(?:\.\d+)?\b'], [r'fte', r'effective', r'capacity']):
        expert_hits += 1
    if expert_hits >= 2:
        results["expert_roster_metrics_present"] = 1.0

    # Budget discrepancy
    if (
        (re.search(r'18[,\s]?500[,\s]?000', content) or re.search(r'18\.5\s*[Mm]', content)) and
        (re.search(r'15[,\s]?200[,\s]?000', content) or re.search(r'15\.2\s*[Mm]', content)) and
        (re.search(r'3[,\s]?300[,\s]?000', content) or re.search(r'3\.3\s*[Mm]', content))
    ):
        results["budget_gap_33m_flagged"] = 1.0

    # Competitor outdated handling
    if re.search(r'EOISC-CA-2023-001', content, flags=re.I) or (
        re.search(r'competitor analysis', content, flags=re.I) and re.search(r'outdated|supersed|2023|lower[- ]authority', content, flags=re.I)
    ):
        results["competitor_doc_outdated_flagged"] = 1.0

    adopts_12 = _contains_number_with_context(
        content,
        [r'\b12\s*months?\b', r'\b12-month\b', r'\b12\s*个月\b'],
        [r'project', r'timeline', r'roadmap', r'plan']
    )
    adopts_15 = _contains_number_with_context(
        content,
        [r'\b15\s*people\b', r'\b15\s*(?:person|persons|members)\b', r'\b15\s*人\b'],
        [r'team', r'staff', r'headcount', r'people']
    )
    outdated_qualified = bool(re.search(r'(?is)(12\s*months?|15\s*(?:people|person|members|人)).{0,80}(outdated|supersed|competitor|2023|not\s+adopt)', content))
    if (not adopts_12 and not adopts_15) or outdated_qualified:
        results["avoids_adopting_outdated_12_month_15_person_plan"] = 1.0

    # API inconsistency
    if re.search(r'1000.{0,40}(?:per[_ -]?minute|/min|minute).{0,120}1000.{0,40}(?:per[_ -]?second|/sec|second)', content, flags=re.I | re.S) or \
       re.search(r'1000.{0,40}(?:per[_ -]?second|/sec|second).{0,120}1000.{0,40}(?:per[_ -]?minute|/min|minute)', content, flags=re.I | re.S):
        results["flags_api_rate_limit_inconsistency"] = 1.0
    elif re.search(r'rate.?limit.*inconsisten|api.*gateway.*conflict|sessions.*per_second|per_minute.*per_second', content, flags=re.I | re.S):
        results["flags_api_rate_limit_inconsistency"] = 1.0

    if re.search(r'\b60x\b', content, flags=re.I) or re.search(r'\b60\s*times\b', content, flags=re.I):
        results["api_60x_difference_quantified"] = 1.0

    # KPI target in context
    if _contains_number_with_context(
        content,
        [r'\b15\s*(?:minutes?|mins?)\b', r'\b15\s*分钟\b'],
        [r'P1', r'KPI', r'target', r'response\s*time']
    ):
        results["kpi_response_time_target_contextualized"] = 1.0

    # AI models
    model_names = [
        "EquipFaultDiag-CNN", "WellboreAnomaly-LSTM", "KnowledgeGraph-QA",
        "DocSummarizer-LLM", "ExpertMatch-RecSys", "LeakDetection-AE"
    ]
    model_hits = sum(1 for m in model_names if re.search(re.escape(m), content, flags=re.I))
    if model_hits >= 2:
        results["mentions_specific_ai_models"] = 1.0

    # Security / policy
    if re.search(r'data classif|RBAC|MFA|encrypt|TLS 1\.3|AES-256|restricted|confidential|audit logging', content, flags=re.I):
        results["data_security_mentioned"] = 1.0

    # Risk register count
    if _parse_markdown_table_risk_count(content) >= 8:
        results["risk_register_at_least_8"] = 1.0

    # Roadmap phases and dates
    phase_hits = 0
    for phase in [
        r'Requirements\s*&\s*Analysis',
        r'System\s*Design',
        r'Development\s*&\s*Integration',
        r'Testing\s*&\s*Validation',
        r'Deployment\s*&\s*Rollout'
    ]:
        if re.search(phase, content, flags=re.I):
            phase_hits += 1
    if phase_hits >= 4 and results["roadmap_date_range_present"] == 1.0:
        results["roadmap_5_phases_dates"] = 1.0

    # Cross-file feasibility gap (REQ-001 <=500ms vs offshore 600ms)
    if (
        re.search(r'REQ-001|500\s*ms|500ms', content, flags=re.I) and
        re.search(r'offshore|VSAT|satellite', content, flags=re.I) and
        re.search(r'600\s*ms|600ms', content, flags=re.I)
    ):
        results["cross_file_feasibility_gap_flagged"] = 1.0

    return results
```

## LLM Judge Rubric

### Criterion 1: Conflict Detection, Source Authority, and Resolution Quality (Weight: 35%)
**Score 1.0**: The plan explicitly identifies all major cross-document conflicts and resolves them with clear authority logic. At minimum: (a) charter v2 budget **18.5M CNY** vs budget v1 **15.2M CNY**, with the **3.3M** gap quantified and the charter treated as approved authority; (b) competitor analysis **12 months / 15 people** explicitly rejected as outdated or lower-authority, ideally citing **EOISC-CA-2023-001** and/or its 2023 vintage; (c) API gateway inconsistency **1000/minute vs 1000/second** clearly explained as a **60x** mismatch with operational consequences; and (d) at least one harder cross-file tension such as offshore **600ms** latency vs REQ-001 **<=500ms**, or the v1 budget’s 12-month staffing assumptions conflicting with an 18-month charter. Resolution guidance is concrete, not just observational.
**Score 0.75**: Correctly identifies and resolves at least three major conflicts, including the budget gap and the outdated competitor-analysis assumptions. May mention the API inconsistency or requirement/infrastructure tension with limited quantification or weaker operational reasoning. Authority choices are mostly sound.
**Score 0.5**: Identifies some conflicts, but treatment is partial. The plan may use correct charter values yet fail to explain why, or mention discrepancies without quantifying them. It may miss one of the important traps or treat older documents too casually.
**Score 0.25**: Shows implicit awareness of conflicts by using some right values, but does not transparently resolve them. Little source attribution; limited distinction between approved, outdated, and contextual documents.
**Score 0.0**: No meaningful conflict handling. The plan mixes inconsistent values, adopts outdated recommendations, or fabricates its own assumptions.

### Criterion 2: Quantitative Accuracy and Data-Grounded Analysis (Weight: 30%)
**Score 1.0**: The plan contains multiple quantitative claims that are clearly derived from the assets and are materially correct. It accurately analyzes system inventory, incident data, and expert roster using specific figures (for example, **35** systems with correct status/integration mix; **18** P1 incidents with ~**49.7 min** average response; overall average resolution ~**13.7 h**; **48** experts with ~**56.7%** average availability / ~**27 FTE** effective capacity). It distinguishes observed 2024 data from target-state KPIs and, where files disagree (e.g. P1 baseline 45 in KPI file vs ~50 from incident log), treats that as a governance issue instead of silently collapsing the numbers.
**Score 0.75**: Uses several correct numbers from the assets across at least two datasets, with only minor omissions or small inaccuracies. Evidence is mostly grounded, though one area may be shallow or not fully reconciled.
**Score 0.5**: Includes some quantitative analysis, but it is uneven. One dataset may be handled well while another is summarized vaguely. A few numbers may appear estimated, rounded too aggressively, or unsupported.
**Score 0.25**: Mostly generic analysis with scattered numbers that do not clearly map to the assets. Some quantitative claims may be wrong, cherry-picked, or implausible.
**Score 0.0**: Little or no real analysis of the provided data. Numbers are absent, obviously invented, or inconsistent with the assets.

### Criterion 3: Architecture Feasibility, Trade-offs, and Requirement Coverage (Weight: 20%)
**Score 1.0**: Recommends an architecture that is credibly aligned to the actual environment and constraints. It references specific models from the catalog, addresses data-classification controls (e.g. RBAC/MFA/encryption/audit), and reasons through feasibility trade-offs such as offline edge requirements, on-prem/private-cloud data residency, offshore connectivity limits, and integration with mixed API/batch/manual legacy systems. It does not simply restate requirements; it explains what can be delivered in which phase and what depends on infrastructure changes or governance clarification.
**Score 0.75**: Architecture is specific and mostly realistic, with some evidence from the model catalog, infrastructure specs, and security policy. Trade-off discussion is present but not especially deep.
**Score 0.5**: Architecture is serviceable but generic. It references some relevant files but does limited feasibility reasoning; difficult requirements are acknowledged only superficially.
**Score 0.25**: Architecture reads like a template. It may mention AI and security buzzwords but shows weak connection to the actual infrastructure, requirements, or policy constraints.
**Score 0.0**: Architecture is incoherent, incompatible with the provided constraints, or largely detached from the workspace materials.

### Criterion 4: Roadmap, Resource Logic, and Steering-Committee Readiness (Weight: 15%)
**Score 1.0**: The roadmap is tightly aligned to the charter’s five phases and **2025-03 to 2026-08** dates, and it identifies dependencies, bottlenecks, or sequencing implications (e.g. network readiness before offshore video commitments, budget reconciliation before procurement, SME availability constraints during design/testing). Resource and budget logic are credible and connected to the analysis. The document reads like a steering-committee artifact: concise where needed, explicit about risks/decisions, and internally consistent.
**Score 0.75**: Roadmap aligns well with the charter and includes some milestones or dependencies. Resource logic is reasonable, though not deeply stress-tested.
**Score 0.5**: Roadmap includes the right broad phases but is generic or weak on dependencies. Resource and sequencing logic are only partially developed.
**Score 0.25**: Roadmap is superficial, under-specified, or not clearly tied to the charter dates/phases. The document would need substantial revision before leadership review.
**Score 0.0**: No usable roadmap or strategic implementation logic is present.
