---
id: task_00005_daily_briefing_scheduler_skill_creation_and_recovery
name: Daily Briefing Scheduler Skill Creation and Recovery
category: System Operations and Administration
subcategory: Software and Environment Management
grading_type: hybrid
grading_weights:
  automated: 0.4
  llm_judge: 0.6
timeout_seconds: 1800
input_modality: text-only
external_dependency: feishu
workspace_files:
- source: config/daily-reports.yaml
  dest: config/daily-reports.yaml
- source: config/feishu-credentials.env
  dest: config/feishu-credentials.env
- source: logs/daily-reports.log
  dest: logs/daily-reports.log
- source: scripts/fetch-ai-news.py
  dest: scripts/fetch-ai-news.py
- source: scripts/fetch-weather.sh
  dest: scripts/fetch-weather.sh
- source: templates/ai-news-briefing.md
  dest: templates/ai-news-briefing.md
- source: templates/weather-briefing.md
  dest: templates/weather-briefing.md
- source: messages/user-a-feishu-2026-02-10.md
  dest: messages/user-a-feishu-2026-02-10.md
---

## Prompt

Hey Jarvis, User A just messaged about the daily briefing system. Check the messages/ folder — there's a Feishu message from him in there with everything he needs.

Please do two things:

1. Create or update the SKILL.md at `workspace/skills/daily_briefing_scheduler_skill/SKILL.md` to document the full briefing pipeline methodology, covering all briefing types that should be running.

2. Handle everything User A asked for in his message and make sure the workspace is properly configured for when the briefings resume. Reply to him on Feishu once the setup is done.

## Expected Behavior

The agent should:

1. Read `messages/user-a-feishu-2026-02-10.md` and identify all six of User A's requests, then cross-reference them against the existing `config/daily-reports.yaml` (which still has outdated values) and `logs/daily-reports.log` (which records why briefings stopped).

2. Apply all six changes to the workspace:
   - Update the weather city from Beijing to **Chengdu** in `config/daily-reports.yaml`
   - Update both weather and AI news cron schedules from `"0 7 * * *"` to **`"0 8 * * *"`**
   - Update `forecast_days` from 3 to **5** in the weather config
   - Add **MIT Technology Review** (`https://www.technologyreview.com/`, max 3 items) to the AI news sources list
   - Add a **tech_calendar** section to the config (schedule `"10 8 * * *"`, target user unchanged, a script reference, and a template reference)
   - Update `scripts/fetch-weather.sh` to add **Open-Meteo** (`https://api.open-meteo.com`) as a fallback source when wttr.in returns a non-200 response

3. Create new supporting files as needed: a `scripts/fetch-tech-calendar.py` (or equivalent) for the tech calendar briefing, and a `templates/tech-calendar-briefing.md` template.

4. Create `workspace/skills/daily_briefing_scheduler_skill/SKILL.md` with proper YAML frontmatter (name and description) and substantive sections covering: all three briefing types (weather, AI news, tech calendar), Feishu delivery, scheduling/cron setup, fallback strategy for API failures, and troubleshooting.

5. Attempt to fetch current weather data for Chengdu and recent AI news when possible, or explicitly note any sandbox/network limitation, then send a Feishu DM to User A (ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01) confirming that all six requests have been applied and that briefings will resume the next morning.

6. Initialize the workspace as a git repository.

## Grading Criteria

- [ ] SKILL.md exists with proper YAML frontmatter (name and description fields)
- [ ] SKILL.md covers all three briefing types (weather, AI news, tech calendar) and the fallback strategy
- [ ] config/daily-reports.yaml updated: city changed from Beijing to Chengdu
- [ ] config/daily-reports.yaml updated: weather and AI news schedule changed to "0 8 * * *"
- [ ] config/daily-reports.yaml updated: forecast_days changed to 5
- [ ] config/daily-reports.yaml updated: MIT Technology Review added as news source
- [ ] config/daily-reports.yaml updated: tech_calendar section added
- [ ] scripts/fetch-weather.sh updated with Open-Meteo fallback logic
- [ ] Tech calendar script (fetch-tech-calendar.py or equivalent) created
- [ ] Agent attempted to fetch weather data for Chengdu (visible in transcript)
- [ ] Agent sent or attempted to send a Feishu DM to User A confirming the changes
- [ ] Workspace initialized as a git repository (.git/HEAD exists)

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    from pathlib import Path

    scores = {
        "skill_md_exists_and_structured": 0.0,
        "skill_md_content_quality": 0.0,
        "config_updated_correctly": 0.0,
        "weather_fallback_implemented": 0.0,
        "tech_calendar_files_created": 0.0,
        "feishu_reply_attempted": 0.0,
        "git_repository_initialized": 0.0,
    }

    ws = Path(workspace_path)

    skill_path = ws / "skills" / "daily_briefing_scheduler_skill" / "SKILL.md"
    if not skill_path.exists():
        return scores

    # 1. SKILL.md structure
    try:
        content = skill_path.read_text(encoding="utf-8", errors="replace")
        if content.strip().startswith("---"):
            parts = content.split("---", 2)
            if len(parts) >= 3:
                fm = parts[1].lower()
                has_name = "name:" in fm
                has_desc = "description:" in fm
                if has_name and has_desc:
                    scores["skill_md_exists_and_structured"] = 1.0
                elif has_name or has_desc:
                    scores["skill_md_exists_and_structured"] = 0.5
                else:
                    scores["skill_md_exists_and_structured"] = 0.25
            else:
                scores["skill_md_exists_and_structured"] = 0.25
        else:
            scores["skill_md_exists_and_structured"] = 0.2
    except Exception:
        scores["skill_md_exists_and_structured"] = 0.1

    # 2. SKILL.md content quality
    try:
        cl = content.lower()
        keywords = ["weather", "news", "feishu", "schedul", "cron", "briefing", "fallback", "tech", "calendar"]
        found = sum(1 for kw in keywords if kw in cl)
        scores["skill_md_content_quality"] = min(1.0, found / 5.0)
    except Exception:
        pass

    # 3. Config updated correctly
    config_path = ws / "config" / "daily-reports.yaml"
    if config_path.exists():
        try:
            cfg = config_path.read_text(encoding="utf-8", errors="replace")
            lower_cfg = cfg.lower()
            cfg_score = 0.0

            weather_section = ""
            ai_section = ""
            tech_section = ""
            import re
            wm = re.search(r"(?ms)^\s*weather:\s*\n(.*?)(?:^\s{2}\S|^\S|\Z)", cfg)
            am = re.search(r"(?ms)^\s*ai_news:\s*\n(.*?)(?:^\s{2}\S|^\S|\Z)", cfg)
            tm = re.search(r"(?ms)^\s*tech_calendar:\s*\n(.*?)(?:^\s{2}\S|^\S|\Z)", cfg)
            if wm:
                weather_section = wm.group(1).lower()
            if am:
                ai_section = am.group(1).lower()
            if tm:
                tech_section = tm.group(1).lower()

            weather_ok = (
                "chengdu" in weather_section and
                '0 8 * * *' in weather_section and
                "forecast_days: 5" in weather_section
            )
            ai_ok = (
                '0 8 * * *' in ai_section and
                "technologyreview.com" in ai_section and
                "max_items: 3" in ai_section
            )
            tech_ok = (
                bool(tech_section) and
                '10 8 * * *' in tech_section and
                "ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01" in tech_section and
                ("fetch-tech-calendar.py" in tech_section or "fetch_tech_calendar.py" in tech_section) and
                "tech-calendar-briefing.md" in tech_section
            )
            if weather_ok:
                cfg_score += 0.35
            if ai_ok:
                cfg_score += 0.3
            if tech_ok:
                cfg_score += 0.35
            elif "tech_calendar" in lower_cfg or "tech-calendar" in lower_cfg:
                cfg_score += 0.15
            scores["config_updated_correctly"] = min(round(cfg_score, 2), 1.0)
        except Exception:
            pass

    # 4. Weather fallback implemented
    weather_script = ws / "scripts" / "fetch-weather.sh"
    if weather_script.exists():
        try:
            sh = weather_script.read_text(encoding="utf-8", errors="replace").lower()
            has_open_meteo = "open-meteo" in sh or "openmeteo" in sh or "api.open-meteo" in sh
            has_status_handling = any(k in sh for k in ["non-200", "http_code", "curl -w", "status", "fallback", "backup", "retry"])
            if has_open_meteo and has_status_handling:
                scores["weather_fallback_implemented"] = 1.0
            elif has_open_meteo:
                scores["weather_fallback_implemented"] = 0.7
            elif "fallback" in sh or "backup" in sh or "retry" in sh:
                scores["weather_fallback_implemented"] = 0.5
        except Exception:
            pass

    # 5. Tech calendar script and/or template created
    tech_score = 0.0
    for candidate in ["scripts/fetch-tech-calendar.py", "scripts/fetch_tech_calendar.py",
                      "scripts/tech-calendar.py", "scripts/tech_calendar.py"]:
        if (ws / candidate).exists():
            tech_score = max(tech_score, 0.6)
    for candidate in ["templates/tech-calendar-briefing.md", "templates/tech_calendar_briefing.md",
                      "templates/tech-calendar.md"]:
        if (ws / candidate).exists():
            tech_score = max(tech_score, tech_score + 0.4)
    scores["tech_calendar_files_created"] = min(tech_score, 1.0)

    # 6. Feishu reply attempted
    for event in transcript:
        if event.get("type") != "tool_call":
            continue
        tool_name = event.get("tool_call", {}).get("name", "")
        args = str(event.get("tool_call", {}).get("arguments", "")).lower()
        if "feishu" in tool_name.lower() or "send" in tool_name.lower():
            if "ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01" in args or "zhang" in args:
                scores["feishu_reply_attempted"] = 1.0
                break
        if tool_name in ("reply", "reply_feishu", "feishu_reply", "send_feishu_message"):
            scores["feishu_reply_attempted"] = 1.0
            break

    if scores["feishu_reply_attempted"] == 0.0:
        for event in transcript:
            if event.get("type") != "message":
                continue
            msg = event.get("message", {})
            if msg.get("role") == "assistant":
                text = str(msg.get("content", "")).lower()
                if "ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01" in text and ("send" in text or "reply" in text or "message" in text):
                    scores["feishu_reply_attempted"] = 0.5
                    break

    git_head = ws / ".git" / "HEAD"
    if git_head.exists():
        scores["git_repository_initialized"] = 1.0

    return scores
```

## LLM Judge Rubric

### SKILL.md Quality and Completeness (Weight: 20%)
- 1.0: SKILL.md exists at `workspace/skills/daily_briefing_scheduler_skill/SKILL.md` with proper YAML frontmatter (name, description), and contains well-organized sections covering all three briefing types (weather, AI news, tech calendar), Feishu delivery, cron scheduling, and fallback strategy for API failures.
- 0.75: SKILL.md exists with frontmatter and covers most topics but is missing one key area (e.g., no tech calendar section or no mention of fallback).
- 0.5: SKILL.md exists with frontmatter but only covers the original two briefing types with minimal depth.
- 0.25: SKILL.md exists but is very minimal — missing frontmatter or only generic content.
- 0.0: SKILL.md missing, empty, or contains no meaningful instructions.

### Configuration and Script Updates (Weight: 35%)
- 1.0: All six of User A's requests correctly applied: city=Chengdu, both schedule changes made, forecast_days=5, MIT Technology Review added to news sources, a correctly wired `tech_calendar` section added to config, and Open-Meteo fallback logic added to `fetch-weather.sh`. Supporting files (tech calendar script and template) are also created.
- 0.75: Five of six requests applied correctly, with one missing or misconfigured (e.g., forecast_days still 3, or MIT TR added but tech_calendar section absent).
- 0.5: Three or four requests applied; at least one major omission (e.g., weather fallback not implemented, or tech_calendar entirely absent).
- 0.25: One or two changes applied; most of the config remains at the outdated values from before User A's message.
- 0.0: Config and scripts unchanged from the original workspace files, or agent applied incorrect values.

### User A Communication (Weight: 25%)
- 1.0: Agent sent a Feishu DM to ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01 confirming all changes were applied, included a brief summary of what was updated, and indicated when briefings will resume. Also included whatever current weather/news data was fetched.
- 0.75: Feishu reply sent with most elements — confirmed restart and key changes, but missed summarizing one or two updates or omitted the data fetch.
- 0.5: Feishu reply sent but only addressed the restart, with little mention of the specific changes applied.
- 0.25: Feishu reply attempted but minimal or sent to the wrong recipient.
- 0.0: No Feishu reply sent or attempted, or agent only described what it would do without actually sending.

### Requirement Discovery and Conflict Resolution (Weight: 10%)
- 1.0: Agent correctly read `messages/user-a-feishu-2026-02-10.md`, identified all six requests, and resolved all conflicts between the message and the existing config (Beijing→Chengdu, 7 AM / 7:05 AM → 8 AM, forecast 3→5). Also notes from the logs why the briefings had previously stopped.
- 0.75: Agent discovered the messages file and applied most requirements, but missed one conflict resolution (e.g., schedule updated but city not changed) or did not acknowledge the pause event from the logs.
- 0.5: Agent partially processed the message — applied some requirements but missed others, or addressed old log info without reading the new message.
- 0.25: Agent ignored the messages/ folder and worked only from the existing config and logs.
- 0.0: No evidence the agent found or read the messages file; all actions are based solely on the Prompt text.

### Workspace Initialization (Weight: 10%)
- 1.0: Workspace is initialized as a git repository, and the agent's final setup is coherent with the updated config / scripts / templates.
- 0.75: Git is initialized and the setup is mostly coherent, with only a small mismatch.
- 0.5: Core file edits are present but git initialization is missing.
- 0.25: Only a subset of required edits is present.
- 0.0: Workspace bootstrap was not completed.
