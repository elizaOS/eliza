---
id: task_00034_server_integration_check_skill_for_daily_stock_analysis
name: Server Integration Check Skill for Daily Stock Analysis
category: System Operations and Administration
subcategory: Software and Environment Management
grading_type: hybrid
grading_weights:
  automated: 0.4
  llm_judge: 0.6
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: projects/daily_stock_analysis/README.md
  dest: projects/daily_stock_analysis/README.md
- source: projects/daily_stock_analysis/Dockerfile
  dest: projects/daily_stock_analysis/Dockerfile
- source: projects/daily_stock_analysis/requirements.txt
  dest: projects/daily_stock_analysis/requirements.txt
- source: projects/daily_stock_analysis/config/settings.yaml
  dest: projects/daily_stock_analysis/config/settings.yaml
- source: projects/daily_stock_analysis/src/config.py
  dest: projects/daily_stock_analysis/src/config.py
- source: projects/daily_stock_analysis/src/indicators.py
  dest: projects/daily_stock_analysis/src/indicators.py
- source: projects/daily_stock_analysis/src/main.py
  dest: projects/daily_stock_analysis/src/main.py
- source: projects/daily_stock_analysis/src/report.py
  dest: projects/daily_stock_analysis/src/report.py
- source: server/configs/feishu.yaml
  dest: server/configs/feishu.yaml
- source: server/cron/crontab.txt
  dest: server/cron/crontab.txt
- source: server/deploy/docker-compose.yml
  dest: server/deploy/docker-compose.yml
- source: server/deploy/status.yaml
  dest: server/deploy/status.yaml
- source: server/scripts/health_check.sh
  dest: server/scripts/health_check.sh
- source: server/scripts/pg_backup.sh
  dest: server/scripts/pg_backup.sh
- source: server/services/market-scraper.service
  dest: server/services/market-scraper.service
- source: server/services/portfolio-api.service
  dest: server/services/portfolio-api.service
---

## Prompt

Hey, I need a reusable skill for checking whether a given project or service has been integrated/deployed on a server. Something that can inspect deployment configs, cron jobs, systemd units, docker-compose files, and service lists to determine the integration status of any named service. Create it as a `skills/server-integration-checker/SKILL.md` in the workspace — think of it like a "server-integration-checker" skill, similar in spirit to how homeassistant-cli wraps Home Assistant control or how rose-docker-build-skill wraps Docker builds.

Once you've created the skill, use it to answer this question from a colleague on Feishu (message_id: om_x100b579d716838a4b21fbbb75b6b038, from user ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa03):

"Has daily_stock_analysis been integrated into the server?"

Check the workspace under `projects/daily_stock_analysis/` and `server/` for deployment artifacts, cron entries, docker-compose files, and any service lists. Then write your findings to `integration_report.md` and reply to the Feishu message with a clear status summary.

## Expected Behavior

The agent should:

1. **Create a SKILL.md** file at `skills/server-integration-checker/SKILL.md` in the workspace that defines a reusable "server-integration-checker" skill. The skill should have YAML frontmatter with `name` and `description` fields, and markdown sections describing how to check server integration status by inspecting deployment configs, cron jobs, docker-compose files, systemd units, and service lists. This is inspired by the referenced skills (coala, rose-docker-build-skill, homeassistant-cli) which each wrap a specific operational capability.

2. **Investigate the workspace** by reading:
   - `projects/daily_stock_analysis/README.md` (which shows server integration is pending)
   - `server/deploy/status.yaml` (which explicitly lists `daily_stock_analysis` under `pending_deployments` with `status: not_deployed`)
   - `server/cron/crontab.txt` (which has the daily_stock_analysis cron entry commented out as "NOT yet added")
   - `server/deploy/docker-compose.yml` (which has the daily_stock_analysis service commented out under "NOT YET DEPLOYED")

3. **Write `integration_report.md`** summarizing the findings: daily_stock_analysis is NOT currently integrated into the server. The report should mention what was checked and the current status.

4. **Reply to the Feishu message** (or indicate intent to reply) with a clear answer: daily_stock_analysis has NOT been integrated into the server yet. The reply should mention that local development and Docker image are complete but server deployment (systemd/cron/docker-compose) is still pending.

## Grading Criteria

- [ ] SKILL.md exists at `skills/server-integration-checker/SKILL.md` with proper YAML frontmatter (name and description fields)
- [ ] SKILL.md contains meaningful instruction sections for checking server integration
- [ ] integration_report.md exists and states daily_stock_analysis is NOT integrated
- [ ] integration_report.md references specific evidence (cron, docker-compose, service list, or status.yaml)
- [ ] Agent correctly identifies the NOT-integrated status in its reply
- [ ] Agent provides actionable context (what is done vs what remains)

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    import re

    scores = {
        "skill_md_exists_and_structured": 0.0,
        "skill_md_content_quality": 0.0,
        "integration_report_exists": 0.0,
        "integration_report_content": 0.0,
        "correct_status_in_transcript": 0.0,
    }

    # Early return if primary output file is absent
    report_path = os.path.join(workspace_path, "integration_report.md")
    if not os.path.isfile(report_path):
        return scores

    # 1. Check SKILL.md exists and has proper YAML frontmatter
    #    Canonical location: skills/server-integration-checker/SKILL.md
    #    Also accept any skills/<name>/SKILL.md as fallback
    skill_content = ""
    canonical_skill_path = os.path.join(
        workspace_path, "skills", "server-integration-checker", "SKILL.md"
    )
    if os.path.isfile(canonical_skill_path):
        skill_path_found = canonical_skill_path
    else:
        # Fallback: scan skills/ subdirectories
        skill_path_found = None
        skills_dir = os.path.join(workspace_path, "skills")
        if os.path.isdir(skills_dir):
            for entry in os.listdir(skills_dir):
                candidate = os.path.join(skills_dir, entry, "SKILL.md")
                if os.path.isfile(candidate):
                    skill_path_found = candidate
                    break

    if skill_path_found:
        try:
            with open(skill_path_found, "r", encoding="utf-8") as f:
                skill_content = f.read()
        except Exception:
            skill_content = ""

        if skill_content.strip():
            has_frontmatter = skill_content.strip().startswith("---")
            has_name = bool(re.search(r'(?i)name\s*:', skill_content[:500]))
            has_description = bool(re.search(r'(?i)description\s*:', skill_content[:800]))
            if has_frontmatter and has_name and has_description:
                scores["skill_md_exists_and_structured"] = 1.0
            elif has_frontmatter and (has_name or has_description):
                scores["skill_md_exists_and_structured"] = 0.5
            elif has_frontmatter:
                scores["skill_md_exists_and_structured"] = 0.25
            else:
                scores["skill_md_exists_and_structured"] = 0.1

    # 2. Check SKILL.md content quality
    if skill_content:
        keywords = ["cron", "systemd", "docker", "service", "deploy", "integrat", "check", "server"]
        matches = sum(1 for kw in keywords if kw.lower() in skill_content.lower())
        if matches >= 5:
            scores["skill_md_content_quality"] = 1.0
        elif matches >= 3:
            scores["skill_md_content_quality"] = 0.7
        elif matches >= 1:
            scores["skill_md_content_quality"] = 0.3
        else:
            scores["skill_md_content_quality"] = 0.0

    # 3. Check integration_report.md exists (already confirmed above)
    report_content = ""
    try:
        with open(report_path, "r", encoding="utf-8") as f:
            report_content = f.read()
    except Exception:
        report_content = ""
    if report_content.strip():
        scores["integration_report_exists"] = 1.0

    # 4. Check integration_report.md content
    if report_content:
        content_lower = report_content.lower()
        not_integrated = any(phrase in content_lower for phrase in [
            "not integrated", "not yet integrated", "not deployed", "not yet deployed",
            "pending", "not found", "not included", "has not been", "hasn't been",
            "no integration", "not currently"
        ])
        evidence_keywords = ["cron", "docker-compose", "docker compose", "service", "systemd",
                             "deployed_services", "status.yaml", "not_deployed"]
        evidence_count = sum(1 for ek in evidence_keywords if ek.lower() in content_lower)

        if not_integrated and evidence_count >= 2:
            scores["integration_report_content"] = 1.0
        elif not_integrated and evidence_count >= 1:
            scores["integration_report_content"] = 0.7
        elif not_integrated:
            scores["integration_report_content"] = 0.5
        elif evidence_count >= 1:
            scores["integration_report_content"] = 0.25
        else:
            scores["integration_report_content"] = 0.0

    # 5. Check transcript for correct status communication
    for event in transcript:
        if event.get("type") != "message":
            continue
        msg = event.get("message", {})
        if msg.get("role") == "assistant":
            text = msg.get("content", "")
            if isinstance(text, str):
                text_lower = text.lower()
                not_phrases = [
                    "not integrated", "not yet integrated", "not deployed",
                    "not yet deployed", "hasn't been", "has not been",
                    "pending", "not currently", "still pending"
                ]
                if any(p in text_lower for p in not_phrases):
                    scores["correct_status_in_transcript"] = 1.0
                    break

    return scores
```

## LLM Judge Rubric

### Evidence and Workspace Grounding (Weight: 30%)
The agent must base its conclusions on actual workspace files (`README.md`, `server/deploy/status.yaml`, `server/cron/crontab.txt`, `server/deploy/docker-compose.yml`) rather than guessing or hallucinating.
- 1.0: Explicitly references multiple workspace files and draws correct conclusions from each
- 0.75: References at least two workspace files with correct interpretation
- 0.5: References at least one workspace file correctly
- 0.25: Vague references to workspace content without specifics
- 0.0: Ignores workspace files entirely, hallucinates facts, or skips the investigation

### Skill Creation Quality (Weight: 25%)
The agent should create a well-structured, reusable `skills/server-integration-checker/SKILL.md` that encapsulates the server-integration-checking capability, inspired by the referenced skills (coala, rose-docker-build-skill, homeassistant-cli).
- 1.0: `skills/server-integration-checker/SKILL.md` has proper YAML frontmatter, clear sections, and is genuinely reusable for checking any service's integration status
- 0.75: SKILL.md is well-structured but somewhat specific to this one case rather than being fully reusable
- 0.5: SKILL.md exists with basic structure but lacks depth or reusability
- 0.25: SKILL.md exists but is minimal or poorly structured
- 0.0: No SKILL.md created, or the file is empty/irrelevant, or placed at wrong path (e.g., workspace root)

### Correctness of Integration Status (Weight: 25%)
The agent must correctly determine that daily_stock_analysis is NOT integrated into the server.
- 1.0: Clearly states not integrated and explains what is complete (local dev, Docker) vs what is missing (systemd/cron/docker-compose deployment)
- 0.75: Correctly states not integrated with some supporting detail
- 0.5: States not integrated but with minimal or slightly inaccurate detail
- 0.25: Ambiguous answer that doesn't clearly confirm or deny integration
- 0.0: Incorrectly states it IS integrated, or provides no answer

### Communication and Deliverables (Weight: 20%)
The agent should produce an `integration_report.md` and reply to the Feishu message with a clear, helpful summary.
- 1.0: Both `integration_report.md` and Feishu reply are clear, well-organized, and actionable (e.g., offers next steps)
- 0.75: Both deliverables present with good quality but minor gaps
- 0.5: One deliverable present and adequate, or both present but low quality
- 0.25: Only a brief transcript reply with no report file
- 0.0: No report file and no meaningful reply addressing the question