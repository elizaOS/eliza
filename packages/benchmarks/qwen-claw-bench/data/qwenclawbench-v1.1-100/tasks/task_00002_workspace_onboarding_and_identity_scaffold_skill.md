---
id: task_00002_workspace_onboarding_and_identity_scaffold_skill
name: Workspace Onboarding and Identity Scaffold Skill
category: System Operations and Administration
subcategory: System Operations and Monitoring
grading_type: hybrid
grading_weights:
  automated: 0.4
  llm_judge: 0.6
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: memory/heartbeat-state.json
  dest: memory/heartbeat-state.json
- source: memory/2025-06-16.md
  dest: memory/2025-06-16.md
- source: memory/2025-06-17.md
  dest: memory/2025-06-17.md
- source: memory/heartbeat-log.csv
  dest: memory/heartbeat-log.csv
- source: config/heartbeat-config.yaml
  dest: config/heartbeat-config.yaml
- source: config/notification-rules.json
  dest: config/notification-rules.json
- source: logs/agent-activity.log
  dest: logs/agent-activity.log
---

## Prompt

Hey, I've got a workspace with some existing files in it — heartbeat state, config, memory logs, and activity logs for an agent monitoring system. I need you to create a reusable skill for workspace onboarding and self-documentation. Think of it like a "workspace bootstrap" skill — inspired by things like conflict-detection monitors, config-driven pipeline managers, or any system that needs to orient itself and set up its own working environment from scratch.

Create the skill as `workspace/skills/workspace-onboarding/SKILL.md` in the workspace. The skill should describe how an agent should onboard into a new workspace: read existing state files, **detect and surface inconsistencies between them**, create core identity and documentation scaffolding files, and set up a workspace state tracker.

Then actually use that skill — run the full onboarding process. Specifically:
1. Read ALL existing workspace files (`memory/heartbeat-state.json`, `memory/2025-06-17.md`, `memory/2025-06-16.md`, `memory/heartbeat-log.csv`, `config/heartbeat-config.yaml`, `config/notification-rules.json`, `logs/agent-activity.log`) and cross-check them for consistency.
2. Create the following files in the workspace root, grounded in data from the workspace:
   - `AGENTS.md` — must include the current session ID and heartbeat count from `memory/heartbeat-state.json`
   - `SOUL.md` — agent identity principles derived from the monitoring history and check patterns
   - `IDENTITY.md` — fillable identity card including the monitoring scope (check types, location)
  - `HEARTBEAT.md` — **must document the interval discrepancy you found** between the runtime state and config files, explain which source is stale, and note what should be updated
   - `TOOLS.md` — document all 5 check types from `heartbeat-config.yaml` with their priorities; note which notification rule is disabled
   - `USER.md` — user context including location (London, Europe/London), weekend preferences, and any open TODOs from memory notes
3. Create `.openclaw/workspace-state.json` with: `version`, `onboardingCompletedAt` timestamp, `sourceSessionId` (from heartbeat-state.json), and `heartbeatCount` (from heartbeat-state.json).
4. Each file must reflect actual values from the workspace — do not use generic placeholders where specific data is available.

## Expected Behavior

The agent should:

1. **Create `workspace/skills/workspace-onboarding/SKILL.md`** with proper YAML frontmatter (`name`, `description`), 3+ markdown sections describing the onboarding process step-by-step, including a step for cross-checking state files against config files to detect stale or inconsistent values.

2. **Read ALL workspace files** and cross-check for inconsistencies:
   - `memory/heartbeat-state.json`: sessionId = `sess_a3f8c1d2e9b7`, version = `1.2.0`, heartbeatCount = 47, checkIntervalMs = 1800000 (30 min), status = healthy
   - `config/heartbeat-config.yaml`: default_interval_ms = 2700000 (45 min), weekend_interval_ms = 3600000, 5 check types (email/calendar/weather/github/social), timezone = Europe/London
   - **Key inconsistency**: `heartbeat-state.json` has `checkIntervalMs: 1800000` but config has `default_interval_ms: 2700000` — the user requested 45 min on 2025-06-17 but the state file was never updated
   - `config/notification-rules.json`: 4 rules, rule_004 (Weather Alert) is `enabled: false`
   - `logs/agent-activity.log`: gateway version 2.4.2 (upgraded from 2.4.1 on 2025-06-16), most recent heartbeat #47
   - `memory/2025-06-16.md`: open TODO "implement weekend schedule in heartbeat config" — already resolved in current config
   - `memory/2025-06-17.md`: MoltBook API returned 503, social check skipped

3. **Create all six scaffold files** grounded in workspace data:
   - `AGENTS.md`: include current session ID (`sess_a3f8c1d2e9b7`), heartbeat count (47), gateway version (2.4.2), and session startup instructions
   - `SOUL.md`: agent identity derived from monitoring history — London-based assistant monitoring email/calendar/weather/GitHub/social, escalation via Telegram
   - `IDENTITY.md`: identity card with monitoring scope (5 check types, London location, Europe/London timezone)
   - `HEARTBEAT.md`: document the interval discrepancy — state file shows 1800000ms (30 min) while config shows 2700000ms (45 min, per user request 2025-06-17); state file is stale; note weekend schedule (3600000ms) is now implemented (resolves 2025-06-16 TODO)
   - `TOOLS.md`: list all 5 check types from config with priorities (email=high, calendar=medium, weather=low, github=medium, social=low); note rule_004 Weather Alert notification is disabled
   - `USER.md`: London/Europe/London timezone, prefers reduced weekend heartbeat, 1:1 with Sarah on Tuesdays 14:00, PR #342 on moltbot reviewed 2025-06-17

4. **Create `.openclaw/workspace-state.json`** with: `version`, `onboardingCompletedAt` (ISO timestamp), `sourceSessionId: "sess_a3f8c1d2e9b7"`, and `heartbeatCount: 47`.

5. Every file must reflect actual values from the workspace — stale state file discrepancy must be documented.

## Grading Criteria

- [ ] `workspace/skills/workspace-onboarding/SKILL.md` exists with YAML frontmatter (name + description) and 3+ markdown sections including a cross-check/inconsistency-detection step
- [ ] `AGENTS.md` includes session ID (`sess_a3f8c1d2e9b7`) and heartbeat count (47) from workspace state
- [ ] `HEARTBEAT.md` documents the interval discrepancy: state file `checkIntervalMs: 1800000` (30 min) vs config `default_interval_ms: 2700000` (45 min), noting state file is stale
- [ ] `TOOLS.md` lists all 5 check types with priorities and notes that rule_004 Weather Alert notification is disabled
- [ ] `USER.md` references London/Europe/London timezone and weekend heartbeat preference
- [ ] All six scaffold files exist with substantive content (not generic placeholders)
- [ ] `.openclaw/workspace-state.json` contains `version`, `onboardingCompletedAt`, `sourceSessionId`, and `heartbeatCount`
- [ ] `sourceSessionId` in workspace-state.json matches `sess_a3f8c1d2e9b7` from heartbeat-state.json
- [ ] Agent identifies the 2025-06-16 TODO about weekend schedule as resolved in current config

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import re
    import json
    from pathlib import Path

    ws = Path(workspace_path)
    scores = {
        "skill_md_exists_and_structured": 0.0,
        "scaffold_files_exist": 0.0,
        "scaffold_files_have_content": 0.0,
        "workspace_state_json_valid": 0.0,
        "heartbeat_discrepancy_noted": 0.0,
    }

    scaffold_files = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "HEARTBEAT.md", "TOOLS.md", "USER.md"]
    state_path = ws / ".openclaw" / "workspace-state.json"
    skills_dir = ws / "skills"
    if (not any((ws / f).is_file() for f in scaffold_files)
            and not state_path.is_file()
            and not skills_dir.is_dir()):
        return scores

    # 1. SKILL.md: require 3+ sections and cross-check/inconsistency documentation
    skill_path = ws / "skills" / "workspace-onboarding" / "SKILL.md"
    if skill_path.is_file():
        try:
            content = skill_path.read_text(encoding="utf-8")
            content_lower = content.lower()
            has_frontmatter = content.strip().startswith("---")
            has_name = bool(re.search(r"(?m)^name\s*:", content))
            has_description = bool(re.search(r"(?m)^description\s*:", content))
            headings = re.findall(r"(?m)^#{1,3}\s+.+", content)
            has_3_sections = len(headings) >= 3
            # Must mention state-file cross-check or inconsistency detection
            has_crosscheck = bool(re.search(
                r"cross.{0,10}check|inconsisten|discrepan|stale|state.{0,20}file|config.{0,20}mismatch",
                content_lower))
            if has_frontmatter and has_name and has_description and has_3_sections and has_crosscheck:
                scores["skill_md_exists_and_structured"] = 1.0
            elif has_frontmatter and has_name and has_description and has_3_sections:
                scores["skill_md_exists_and_structured"] = 0.7
            elif has_frontmatter and (has_name or has_description) and len(headings) >= 2:
                scores["skill_md_exists_and_structured"] = 0.4
            elif len(content.strip()) > 50:
                scores["skill_md_exists_and_structured"] = 0.15
        except Exception:
            pass

    # 2. Scaffold files exist
    existing_count = sum(1 for f in scaffold_files if (ws / f).is_file())
    scores["scaffold_files_exist"] = existing_count / len(scaffold_files)

    # 3. Scaffold files have workspace-grounded content
    # Check AGENTS.md for session ID and heartbeat count
    agents_score = 0.0
    agents_path = ws / "AGENTS.md"
    if agents_path.is_file():
        try:
            t = agents_path.read_text(encoding="utf-8").lower()
            if "sess_a3f8c1d2e9b7" in t:
                agents_score += 0.5
            if re.search(r"\b47\b.{0,40}heartbeat|heartbeat.{0,40}\b47\b", t):
                agents_score += 0.3
            if len(t) > 100 and "#" in t:
                agents_score += 0.2
        except Exception:
            pass

    # Check TOOLS.md for 5 check types and disabled rule
    tools_score = 0.0
    tools_path = ws / "TOOLS.md"
    if tools_path.is_file():
        try:
            t = tools_path.read_text(encoding="utf-8").lower()
            check_types = ["email", "calendar", "weather", "github", "social"]
            found = sum(1 for c in check_types if c in t)
            tools_score += found / len(check_types) * 0.6
            if re.search(r"weather.{0,60}(disabled|false|off|rule.{0,10}004)|rule.{0,10}004.{0,60}(disabled|false|off)", t):
                tools_score += 0.4
        except Exception:
            pass

    # Check USER.md for London/timezone
    user_score = 0.0
    user_path = ws / "USER.md"
    if user_path.is_file():
        try:
            t = user_path.read_text(encoding="utf-8").lower()
            if "london" in t:
                user_score += 0.4
            if re.search(r"europe/london|utc.{0,3}[\+\-]8|gmt|timezone", t):
                user_score += 0.3
            if re.search(r"weekend|45\s*min|heartbeat.*interval|interval.*heartbeat", t):
                user_score += 0.3
        except Exception:
            pass

    # Check remaining files have substantive content (not just stubs)
    other_files = ["SOUL.md", "IDENTITY.md", "HEARTBEAT.md"]
    other_score = 0.0
    for fname in other_files:
        fpath = ws / fname
        if fpath.is_file():
            try:
                t = fpath.read_text(encoding="utf-8").strip()
                if len(t) >= 100 and "#" in t:
                    other_score += 1.0
                elif len(t) >= 30 and "#" in t:
                    other_score += 0.5
            except Exception:
                pass
    other_score /= len(other_files)

    scores["scaffold_files_have_content"] = min(1.0,
        agents_score * 0.3 + tools_score * 0.3 + user_score * 0.2 + other_score * 0.2)

    # 4. workspace-state.json: require version + timestamp + sourceSessionId + heartbeatCount
    if state_path.is_file():
        try:
            data = json.loads(state_path.read_text(encoding="utf-8"))
            state_score = 0.0
            if "version" in data:
                state_score += 0.2
            if "onboardingCompletedAt" in data:
                ts = str(data["onboardingCompletedAt"])
                if "T" in ts and len(ts) >= 16:
                    state_score += 0.2
                else:
                    state_score += 0.1
            # Require sourceSessionId from heartbeat-state.json
            session_val = str(data.get("sourceSessionId", data.get("sessionId", ""))).lower()
            if "sess_a3f8c1d2e9b7" in session_val or "a3f8c1d2" in session_val:
                state_score += 0.35
            elif "sess_" in session_val or session_val:
                state_score += 0.1
            # Require heartbeatCount
            hb_count = data.get("heartbeatCount", data.get("heartbeat_count", None))
            if hb_count == 47 or str(hb_count) == "47":
                state_score += 0.25
            scores["workspace_state_json_valid"] = min(1.0, state_score)
        except Exception:
            scores["workspace_state_json_valid"] = 0.05

    # 5. Heartbeat discrepancy noted in HEARTBEAT.md
    heartbeat_path = ws / "HEARTBEAT.md"
    if heartbeat_path.is_file():
        try:
            t = heartbeat_path.read_text(encoding="utf-8").lower()
            disc_signals = [
                bool(re.search(r"1800000|1,800,000|30.{0,5}min", t)),
                bool(re.search(r"2700000|2,700,000|45.{0,5}min", t)),
                bool(re.search(r"discrepan|inconsisten|stale|mismatch|not.{0,20}updat|outdated", t)),
                bool(re.search(r"state.{0,30}file|checkintervalms", t)),
            ]
            matched = sum(disc_signals)
            if matched >= 4:
                scores["heartbeat_discrepancy_noted"] = 1.0
            elif matched >= 3:
                scores["heartbeat_discrepancy_noted"] = 0.7
            elif matched >= 2:
                scores["heartbeat_discrepancy_noted"] = 0.4
            elif matched >= 1:
                scores["heartbeat_discrepancy_noted"] = 0.2
        except Exception:
            pass

    return scores
```

## LLM Judge Rubric

### Skill File Quality (Weight: 20%)
- 1.0: SKILL.md has proper YAML frontmatter with name and description, 3+ markdown sections describing onboarding step-by-step, and explicitly includes a step for cross-checking state files against config to detect inconsistencies (like stale checkIntervalMs).
- 0.75: SKILL.md exists with frontmatter and reasonable instructions; mentions state file reading but omits the cross-check/discrepancy detection step.
- 0.5: SKILL.md exists but is generic — describes onboarding abstractly without grounding in the workspace's specific file structure or the need to detect config mismatches.
- 0.25: SKILL.md exists but is essentially a stub with minimal instructional content.
- 0.0: SKILL.md is missing entirely.

### Scaffold File Grounding (Weight: 35%)
- 1.0: All six scaffold files exist with content grounded in workspace data: AGENTS.md includes session ID `sess_a3f8c1d2e9b7` and heartbeat count 47; HEARTBEAT.md documents the 1800000ms vs 2700000ms interval discrepancy and notes state file is stale; TOOLS.md lists all 5 check types with priorities and notes rule_004 Weather Alert is disabled; USER.md references London/Europe/London and weekend preference.
- 0.75: All six files exist; at least 3 contain specific workspace values (e.g., session ID, interval values, tool priorities), but one key file (e.g., HEARTBEAT.md) lacks the discrepancy analysis.
- 0.5: All six files exist but content is mostly generic; only 1–2 files reference actual workspace values.
- 0.25: Fewer than 6 files exist, or all files are generic stubs with no workspace-grounded content.
- 0.0: No scaffold files created or deliverables entirely missing.

### Workspace State Tracking (Weight: 20%)
- 1.0: `.openclaw/workspace-state.json` exists with `version`, `onboardingCompletedAt` (valid ISO timestamp), `sourceSessionId: "sess_a3f8c1d2e9b7"` (matching heartbeat-state.json), and `heartbeatCount: 47`.
- 0.75: File exists with version + timestamp + one of {sourceSessionId, heartbeatCount}; the other is missing or incorrect.
- 0.5: File exists with version and timestamp only; sourceSessionId and heartbeatCount absent.
- 0.25: File exists but is missing multiple fields or has incorrect session ID.
- 0.0: The workspace state file is missing entirely.

### Inconsistency Detection and Analysis (Weight: 25%)
- 1.0: Agent identifies the `checkIntervalMs` discrepancy (state file: 1800000ms / 30 min vs config: 2700000ms / 45 min), correctly traces it to the 2025-06-17 user request, notes the state file is stale and needs updating, AND identifies the 2025-06-16 weekend schedule TODO as already resolved in the current config.
- 0.75: Agent identifies the interval discrepancy with specific values (1800000 vs 2700000, or 30 min vs 45 min) and notes the state file is stale; does not mention the resolved weekend TODO.
- 0.5: Agent mentions an interval inconsistency in a vague way (e.g., "config and state don't match") without citing specific values.
- 0.25: Agent notes the heartbeat config exists but does not identify any inconsistency.
- 0.0: No evidence of cross-checking files; agent treats all workspace files as consistent.