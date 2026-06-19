---
id: task_00026_openclaw_update_skill_creation_and_execution
name: OpenClaw Update Skill Creation and Execution
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
- source: openclaw/package.json
  dest: openclaw/package.json
- source: openclaw/.install-meta.json
  dest: openclaw/.install-meta.json
- source: openclaw/config.yaml
  dest: openclaw/config.yaml
- source: openclaw/CHANGELOG.md
  dest: openclaw/CHANGELOG.md
- source: openclaw/update.sh
  dest: openclaw/update.sh
- source: openclaw/backup.sh
  dest: openclaw/backup.sh
- source: openclaw/TROUBLESHOOTING.md
  dest: openclaw/TROUBLESHOOTING.md
- source: openclaw/logs/update.log
  dest: openclaw/logs/update.log
- source: openclaw/logs/gateway.log
  dest: openclaw/logs/gateway.log
- source: messages/update-request.md
  dest: messages/update-request.md
---

## Prompt

There's a request in the `messages/` folder about updating OpenClaw. Please handle everything described there.

## Expected Behavior

1. **Read `messages/update-request.md`** to discover all six required tasks. The message asks for a changelog analysis, config migration, security review, pre-update report, and then the actual update setup.

2. **Identify the installed version**: Read `openclaw/.install-meta.json` (last update: v2025.12.8 on 2025-12-10) and `openclaw/logs/update.log` (confirms current version 2025.12.8, and that 2026.2.5 is the latest available; auto-update was disabled). The target update is to v2026.2.5.

3. **Analyse the CHANGELOG** for breaking changes across both skipped versions:
   - **2026.1.10**: `gateway.bind` renamed to `gateway.listen.bind`
   - **2026.2.5**: `logging.file` must be a relative path (not absolute); `channels.telegram.allowedUsers` renamed to `channels.telegram.allowedUserIds`

4. **Migrate `openclaw/config.yaml`**:
   - Move `gateway.bind: "0.0.0.0:3017"` → `gateway.listen.bind: "0.0.0.0:3017"` (removing the deprecated `bind` key)
   - Change `logging.file: "/var/log/openclaw/gateway.log"` → `logging.file: "logs/gateway.log"` (relative path, required from 2026.2.5)
   - Change `channels.telegram.allowedUsers` → `channels.telegram.allowedUserIds` (deprecated in 2026.2.5)

5. **Security review**: The config has `gateway.listen.bind: "0.0.0.0:3017"` — this exposes the gateway to all network interfaces. The gateway.log confirms the gateway is indeed listening on all interfaces. The agent should flag this as a potential security risk and recommend using `127.0.0.1:3017` for local-only access unless external access is intentionally needed.

6. **Write `openclaw/logs/pre_update_analysis.md`** covering: current version (2025.12.8), target version (2026.2.5), all three breaking changes identified, every config key migration applied (old → new), the security finding about `0.0.0.0` binding, and any other observations.

7. **Proceed with the update setup**: create `workspace/skills/openclaw_update_skill/SKILL.md` (with YAML frontmatter and instruction sections covering the full update process including changelog review, config migration, and security checks), initialize a git repository, create the standard workspace documentation files (AGENTS.md, BOOTSTRAP.md, HEARTBEAT.md, IDENTITY.md, SOUL.md, TOOLS.md, USER.md), and create `.openclaw/workspace-state.json`.

## Grading Criteria

- [ ] Agent read `messages/update-request.md` and addressed all six tasks
- [ ] Agent identified all three breaking changes (gateway.bind rename, logging.file absolute→relative, allowedUsers rename)
- [ ] `openclaw/config.yaml` migrated: `gateway.listen.bind` present, `gateway.bind` removed; `logging.file` is now relative
- [ ] `openclaw/logs/pre_update_analysis.md` created with breaking changes, config migrations, and security assessment
- [ ] Agent flagged the `0.0.0.0:3017` bind address as a security concern
- [ ] `workspace/skills/openclaw_update_skill/SKILL.md` created with YAML frontmatter and instruction sections
- [ ] Core workspace documentation files present (AGENTS.md, IDENTITY.md, SOUL.md, TOOLS.md, USER.md, HEARTBEAT.md, BOOTSTRAP.md)
- [ ] `.openclaw/workspace-state.json` exists
- [ ] Git repository initialized (`.git/HEAD` exists)

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import re
    import json
    from pathlib import Path

    ws = Path(workspace_path)
    scores = {
        "skill_md_exists_and_structured": 0.0,
        "config_migrated": 0.0,
        "preupdate_report_exists": 0.0,
        "breaking_changes_identified": 0.0,
        "security_review_present": 0.0,
        "workspace_state_json": 0.0,
        "core_docs_present": 0.0,
        "git_initialized": 0.0,
    }

    # 1. SKILL.md structure
    skill_path = ws / "skills" / "openclaw_update_skill" / "SKILL.md"
    if skill_path.is_file():
        try:
            content = skill_path.read_text(encoding="utf-8", errors="replace")
            fm_match = re.search(r'^---\s*\n(.*?)\n---', content, re.DOTALL)
            if fm_match:
                fm = fm_match.group(1)
                has_name = bool(re.search(r'^\s*name\s*:', fm, re.MULTILINE))
                has_desc = bool(re.search(r'^\s*description\s*:', fm, re.MULTILINE))
                headings = re.findall(r'^#+\s+\S', content, re.MULTILINE)
                if has_name and has_desc and len(headings) >= 3:
                    scores["skill_md_exists_and_structured"] = 1.0
                elif (has_name or has_desc) and len(headings) >= 2:
                    scores["skill_md_exists_and_structured"] = 0.6
                else:
                    scores["skill_md_exists_and_structured"] = 0.25
            else:
                scores["skill_md_exists_and_structured"] = 0.2
        except Exception:
            scores["skill_md_exists_and_structured"] = 0.1

    # 2. Config migration check
    config_path = ws / "openclaw" / "config.yaml"
    if config_path.is_file():
        try:
            cfg = config_path.read_text(encoding="utf-8", errors="replace")
            # New key present
            has_listen_bind = bool(re.search(r'listen\s*:\s*\n\s+bind\s*:|listen\.bind', cfg))
            # Old top-level bind removed
            old_bind_gone = not bool(re.search(r'^\s{0,4}bind\s*:\s*"', cfg, re.MULTILINE))
            # logging.file is now relative (not absolute)
            log_file_match = re.search(r'logging:\s*\n(?:.*\n)*?\s+file\s*:\s*"([^"]+)"', cfg)
            log_file_relative = (log_file_match and not log_file_match.group(1).startswith("/"))
            # allowedUsers renamed
            old_users_gone = "allowedUsers:" not in cfg
            new_users_present = "allowedUserIds:" in cfg
            migration_score = 0.0
            if has_listen_bind:
                migration_score += 0.4
            if old_bind_gone:
                migration_score += 0.2
            if log_file_relative:
                migration_score += 0.3
            if old_users_gone and new_users_present:
                migration_score += 0.1
            scores["config_migrated"] = min(migration_score, 1.0)
        except Exception:
            pass

    # 3. Pre-update analysis report
    report_path = ws / "openclaw" / "logs" / "pre_update_analysis.md"
    report_content = ""
    if report_path.is_file():
        try:
            report_content = report_path.read_text(encoding="utf-8", errors="replace")
            if len(report_content.strip()) > 150:
                scores["preupdate_report_exists"] = 1.0
            elif len(report_content.strip()) > 0:
                scores["preupdate_report_exists"] = 0.4
        except Exception:
            pass

    # 4. Breaking changes identified in report or transcript
    combined = report_content
    for event in transcript:
        if event.get("type") != "message":
            continue
        msg = event.get("message", {})
        if msg.get("role") == "assistant":
            c = msg.get("content", "")
            if isinstance(c, str):
                combined += c
            elif isinstance(c, list):
                for part in c:
                    if isinstance(part, dict) and part.get("type") == "text":
                        combined += part.get("text", "")

    bc_patterns = [
        r"gateway\.listen\.bind|gateway\.bind.*rename|listen\.bind",
        r"logging\.file.*relativ|relativ.*log.*path|absolute.*log.*path",
        r"allowedUsers.*allowedUserIds|allowedUserIds",
    ]
    bc_hits = sum(1 for p in bc_patterns if re.search(p, combined, re.IGNORECASE))
    scores["breaking_changes_identified"] = bc_hits / len(bc_patterns)

    if report_content:
        lower_report = report_content.lower()
        if "0.0.0.0:3017" in lower_report and "127.0.0.1:3017" in lower_report:
            scores["security_review_present"] = 1.0
        elif "0.0.0.0:3017" in lower_report:
            scores["security_review_present"] = 0.5

    # 5. Workspace state JSON
    state_path = ws / ".openclaw" / "workspace-state.json"
    if state_path.is_file():
        try:
            data = json.loads(state_path.read_text(encoding="utf-8", errors="replace"))
            scores["workspace_state_json"] = 1.0 if isinstance(data, dict) and data else 0.5
        except Exception:
            scores["workspace_state_json"] = 0.3

    # 6. Core docs present
    core_docs = ["AGENTS.md", "IDENTITY.md", "SOUL.md", "TOOLS.md",
                 "USER.md", "HEARTBEAT.md", "BOOTSTRAP.md"]
    found = sum(1 for d in core_docs if (ws / d).is_file()
                and len((ws / d).read_text(errors="replace").strip()) > 0)
    scores["core_docs_present"] = round(found / len(core_docs), 2)

    if (ws / ".git" / "HEAD").is_file():
        scores["git_initialized"] = 1.0

    return scores
```

## LLM Judge Rubric

### Changelog Analysis and Breaking Change Identification (Weight: 30%)
- 1.0: Agent read `openclaw/CHANGELOG.md` and identified all three breaking changes across the two skipped versions: (a) `gateway.bind` → `gateway.listen.bind` (v2026.1.10); (b) `logging.file` must be a relative path, not absolute (v2026.2.5); (c) `channels.telegram.allowedUsers` → `channels.telegram.allowedUserIds` (v2026.2.5). Agent also confirmed current version 2025.12.8 and target 2026.2.5 from `openclaw/.install-meta.json` and `openclaw/logs/update.log`.
- 0.75: Agent identified two of the three breaking changes and correctly determined the version range.
- 0.5: Agent identified one breaking change and partially referenced version info from workspace files.
- 0.25: Agent mentioned the CHANGELOG but did not identify specific breaking changes, or only referenced version numbers without the associated config changes.
- 0.0: Agent did not read the CHANGELOG or made no reference to breaking changes.

### Config Migration Accuracy (Weight: 25%)
- 1.0: All three config migrations applied to `openclaw/config.yaml`: (a) `gateway.bind` removed and `gateway.listen.bind` added under a `listen:` sub-key; (b) `logging.file` changed from `/var/log/openclaw/gateway.log` to a workspace-relative path such as `logs/gateway.log`; (c) `channels.telegram.allowedUsers` renamed to `channels.telegram.allowedUserIds`. Config remains valid YAML with no other fields damaged.
- 0.75: Two of the three migrations applied correctly; one migration missing or applied incorrectly.
- 0.5: One migration applied; other deprecated keys remain, or the YAML structure was broken in the process.
- 0.25: Agent described the required migrations but did not actually update the config file.
- 0.0: Config unchanged or config file is invalid YAML.

### Security Review and Pre-Update Report (Weight: 25%)
- 1.0: `openclaw/logs/pre_update_analysis.md` created, containing: current version (2025.12.8), target version (2026.2.5), all three breaking changes and the applied migrations, an explicit security flag about `gateway.listen.bind: "0.0.0.0:3017"` exposing the gateway to all interfaces (with a recommendation to use `127.0.0.1:3017` for local-only access), and any other findings (e.g., absolute path in `update.sh` `LOG_FILE` or absolute workspace path in config).
- 0.75: Report exists and covers most elements; security flag present but either the bind recommendation is missing or one breaking change not mentioned.
- 0.5: Report exists but is incomplete — missing the security finding or fewer than two breaking changes documented.
- 0.25: Report file created but very brief with no structured analysis.
- 0.0: No report file created, or agent described the analysis verbally but did not write the file.

### Update Setup Completeness (Weight: 20%)
- 1.0: `workspace/skills/openclaw_update_skill/SKILL.md` created with proper YAML frontmatter and instruction sections that cover the full update process including changelog review, config migration, security checks, and workspace initialization. All 7 core workspace docs created, `.openclaw/workspace-state.json` created, and a git repository is initialized.
- 0.75: SKILL.md created with frontmatter; most core docs present (5–6 of 7); workspace-state.json exists.
- 0.5: Some update artifacts created but incomplete — SKILL.md stub or fewer than 5 core docs.
- 0.25: Only 1–2 artifacts created.
- 0.0: No update artifacts created.
