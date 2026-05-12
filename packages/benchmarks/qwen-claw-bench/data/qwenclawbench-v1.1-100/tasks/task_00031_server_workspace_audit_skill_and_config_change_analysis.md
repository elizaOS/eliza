---
id: task_00031_server_workspace_audit_skill_and_config_change_analysis
name: Server Workspace Audit Skill and Config Change Analysis
category: Workflow and Agent Orchestration
subcategory: Script and Terminal Automation
grading_type: hybrid
grading_weights:
  automated: 0.4
  llm_judge: 0.6
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: project_info.md
  dest: project_info.md
- source: etc/hosts
  dest: etc/hosts
- source: home/admin/.moltbot/moltbot.json
  dest: home/admin/.moltbot/moltbot.json
- source: home/admin/.moltbot/moltbot.json.new
  dest: home/admin/.moltbot/moltbot.json.new
- source: opt/moltbot/docs/channels/telegram.md
  dest: opt/moltbot/docs/channels/telegram.md
- source: opt/moltbot/docs/plugin.md
  dest: opt/moltbot/docs/plugin.md
- source: opt/moltbot/docs/plugins/telegram.md
  dest: opt/moltbot/docs/plugins/telegram.md
- source: www/server/nginx/conf/enable-php-80.conf
  dest: www/server/nginx/conf/enable-php-80.conf
- source: www/server/panel/data/site.json
  dest: www/server/panel/data/site.json
- source: www/server/panel/vhost/nginx/extension/www.fzw.best/site_total.conf
  dest: www/server/panel/vhost/nginx/extension/www.fzw.best/site_total.conf
- source: www/server/panel/vhost/nginx/www.fzw.best.conf
  dest: www/server/panel/vhost/nginx/www.fzw.best.conf
- source: www/server/panel/vhost/nginx/www.fzw.best.conf.new
  dest: www/server/panel/vhost/nginx/www.fzw.best.conf.new
- source: www/server/panel/vhost/rewrite/www.fzw.best.conf
  dest: www/server/panel/vhost/rewrite/www.fzw.best.conf
---

## Prompt

I've got a production server running a few web projects and I want to properly audit and document its current state. The workspace contains config snapshots from the server — nginx vhosts, Moltbot settings, site panel data, etc. See `project_info.md` for an overview of the file structure.

First, create a reusable workspace audit skill and save it to `workspace/skills/server-workspace/SKILL.md`. The skill should describe a repeatable procedure for auditing a web server workspace: inventorying hosted sites, checking SSL cert expiry, identifying pending config changes, and flagging security issues.

Then, actually run the audit on this workspace and write the results to `server_audit.json` at the workspace root. The audit should cover: all hosted sites (from `www/server/panel/data/site.json`), SSL certificate expiry status for each site, any `.new` config files found and what they change compared to the current configs, and any credentials or security issues found in config files. Also set up `.openclaw/workspace-state.json` with the current server state.

## Expected Behavior

The agent must read and cross-reference all 13 workspace files to produce the skill definition and a grounded audit report.

**SKILL.md** must be saved at `workspace/skills/server-workspace/SKILL.md` (not at the workspace root). It should have YAML frontmatter with `name` and `description`, and contain a structured procedure for server workspace auditing.

**SSL expiry findings (critical):**
- `www/server/panel/data/site.json` shows www.fzw.best SSL expires `2025-09-15` and auth.wslf.cc SSL expires `2025-08-22`
- Both dates are in 2025; the current year is 2026 — both certs are **expired**
- `server_audit.json` must mark both sites with `ssl_status: "expired"` (or equivalent)

**Pending config changes (two files):**
- `www/server/panel/vhost/nginx/www.fzw.best.conf.new` vs the current conf: the `.new` version adds a `location /api/telegram/webhook` proxy block forwarding to `127.0.0.1:3781` (Moltbot gateway port)
- `home/admin/.moltbot/moltbot.json.new` vs current: enables `gateway.remote.enabled: true`, enables `webhook.enabled: true` with URL `https://fzw.best/api/telegram/webhook`, and switches logging from `info` to `debug`
- The two `.new` configs are **interdependent**: the nginx proxy route is required for the moltbot webhook to function; both must be applied together

**Security observations:**
- `home/admin/.moltbot/moltbot.json` and the `.new` variant contain a Telegram bot token in plaintext — should be flagged
- The webhook secret in `moltbot.json.new` is a new credential introduced by the pending change

**Expected `server_audit.json` structure:**
```json
{
  "audit_date": "...",
  "sites": [
    {
      "name": "www.fzw.best",
      "path": "/www/wwwroot/www.fzw.best",
      "php_version": "80",
      "ssl_expiry": "2025-09-15",
      "ssl_status": "expired"
    },
    {
      "name": "auth.wslf.cc",
      "path": "/www/wwwroot/auth.wslf.cc",
      "php_version": "80",
      "ssl_expiry": "2025-08-22",
      "ssl_status": "expired"
    }
  ],
  "pending_changes": [
    {
      "file": "www/server/panel/vhost/nginx/www.fzw.best.conf.new",
      "summary": "Adds /api/telegram/webhook proxy block to route webhook requests to Moltbot on port 3781"
    },
    {
      "file": "home/admin/.moltbot/moltbot.json.new",
      "summary": "Enables moltbot remote gateway and webhook mode; changes logging level to debug"
    }
  ],
  "pending_change_dependency": "The nginx and moltbot pending configs are interdependent — both must be applied together for the webhook to function",
  "security_flags": [
    "Telegram bot token stored in plaintext in moltbot.json and moltbot.json.new",
    "Webhook secret introduced in moltbot.json.new stored in plaintext"
  ]
}
```

**Expected `.openclaw/workspace-state.json`:** must contain actual data derived from the workspace files (e.g., site names, Moltbot version, SSL expiry status).

## Grading Criteria

- [ ] SKILL.md exists at workspace/skills/server-workspace/SKILL.md with proper YAML frontmatter and audit procedure content
- [ ] server_audit.json exists and is valid JSON
- [ ] Both sites identified with correct ssl_expiry dates and marked as expired
- [ ] Both .new config files referenced in server_audit.json with a description of what they change
- [ ] Interdependency between the two pending configs noted (nginx webhook proxy ↔ moltbot webhook enable)
- [ ] .openclaw/workspace-state.json contains actual server data (not generic placeholder content)

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    import json

    scores = {
        "skill_md_quality": 0.0,
        "server_audit_exists": 0.0,
        "ssl_expiry_identified": 0.0,
        "pending_configs_detected": 0.0,
        "workspace_state_populated": 0.0,
    }

    # SKILL.md must be at workspace/skills/server-workspace/SKILL.md
    skill_path = os.path.join(workspace_path, "workspace", "skills", "server-workspace", "SKILL.md")
    if os.path.isfile(skill_path):
        try:
            content = open(skill_path, "r", encoding="utf-8").read()
            has_frontmatter = content.strip().startswith("---")
            has_name = "name:" in content
            has_desc = "description:" in content.lower()
            has_sections = content.count("#") >= 2
            # Require audit-relevant content, not just generic boilerplate
            audit_kws = ["ssl", "expiry", "nginx", "pending", "security", "audit", "config", "vhost", "site"]
            audit_kw_count = sum(1 for k in audit_kws if k in content.lower())
            if has_frontmatter and has_name and has_desc and has_sections and audit_kw_count >= 3:
                scores["skill_md_quality"] = 1.0
            elif has_frontmatter and (has_name or has_desc) and has_sections:
                scores["skill_md_quality"] = 0.6
            elif has_frontmatter and (has_name or has_desc):
                scores["skill_md_quality"] = 0.4
            elif os.path.getsize(skill_path) > 0:
                scores["skill_md_quality"] = 0.2
        except Exception:
            scores["skill_md_quality"] = 0.1
    else:
        # Partial credit if SKILL.md exists at wrong path (workspace root)
        alt_path = os.path.join(workspace_path, "SKILL.md")
        if os.path.isfile(alt_path):
            scores["skill_md_quality"] = 0.3

    # server_audit.json
    audit_path = os.path.join(workspace_path, "server_audit.json")
    if not os.path.isfile(audit_path):
        return scores

    try:
        with open(audit_path, "r", encoding="utf-8") as f:
            audit = json.load(f)
        scores["server_audit_exists"] = 1.0
        audit_str = json.dumps(audit).lower()
    except Exception:
        scores["server_audit_exists"] = 0.3
        return scores

    has_fzw = "fzw.best" in audit_str
    has_auth = "auth.wslf.cc" in audit_str
    has_expired = "expired" in audit_str
    has_2025_dates = ("2025-09-15" in audit_str or "2025-09" in audit_str) and ("2025-08-22" in audit_str or "2025-08" in audit_str)

    # SSL expiry: both sites identified as expired
    # Check for exact expiry dates from site.json AND "expired" status in audit JSON
    sites_list = audit.get("sites", [])
    fzw_site = next((s for s in sites_list if isinstance(s, dict) and "fzw.best" in str(s.get("name", "")).lower()), None)
    auth_site = next((s for s in sites_list if isinstance(s, dict) and "auth.wslf.cc" in str(s.get("name", "")).lower()), None)
    fzw_expired = fzw_site and (
        "expired" in str(fzw_site.get("ssl_status", "")).lower()
        or "expired" in str(fzw_site.get("status", "")).lower()
        or "2025-09-15" in str(fzw_site.get("ssl_expiry", ""))
        or "2025-09" in str(fzw_site.get("ssl_expiry", ""))
    )
    auth_expired = auth_site and (
        "expired" in str(auth_site.get("ssl_status", "")).lower()
        or "expired" in str(auth_site.get("status", "")).lower()
        or "2025-08-22" in str(auth_site.get("ssl_expiry", ""))
        or "2025-08" in str(auth_site.get("ssl_expiry", ""))
    )
    if fzw_expired and auth_expired:
        scores["ssl_expiry_identified"] = 1.0
    elif fzw_expired or auth_expired:
        scores["ssl_expiry_identified"] = 0.5
    elif has_fzw and has_auth and has_expired and has_2025_dates:
        # Fallback: string-level match if JSON structure differs
        scores["ssl_expiry_identified"] = 0.7
    elif has_expired and (has_fzw or has_auth):
        scores["ssl_expiry_identified"] = 0.4

    # Pending .new configs detected
    new_nginx = "www.fzw.best.conf.new" in audit_str or ("nginx" in audit_str and ".new" in audit_str)
    new_moltbot = "moltbot.json.new" in audit_str or ("moltbot" in audit_str and ".new" in audit_str)
    webhook_noted = "webhook" in audit_str and ("proxy" in audit_str or "3781" in audit_str or "interdepend" in audit_str)
    if new_nginx and new_moltbot and webhook_noted:
        scores["pending_configs_detected"] = 1.0
    elif new_nginx and new_moltbot:
        scores["pending_configs_detected"] = 0.7
    elif new_nginx or new_moltbot:
        scores["pending_configs_detected"] = 0.35

    # .openclaw/workspace-state.json populated with actual data
    state_path = os.path.join(workspace_path, ".openclaw", "workspace-state.json")
    if os.path.isfile(state_path):
        try:
            with open(state_path, "r", encoding="utf-8") as f:
                state = json.load(f)
            state_str = json.dumps(state).lower()
            has_real_data = (
                "fzw.best" in state_str
                or "auth.wslf.cc" in state_str
                or "moltbot" in state_str
            )
            if isinstance(state, dict) and len(state) > 0 and has_real_data:
                scores["workspace_state_populated"] = 1.0
            elif isinstance(state, dict) and len(state) > 0:
                scores["workspace_state_populated"] = 0.4
        except Exception:
            scores["workspace_state_populated"] = 0.1

    return scores
```

## LLM Judge Rubric

### SSL Expiry Detection (Weight: 30%)
- 1.0: server_audit.json correctly identifies both www.fzw.best (expires 2025-09-15) and auth.wslf.cc (expires 2025-08-22) as expired, citing the exact expiry dates from site.json; marks both as `expired` or equivalent status.
- 0.75: Both sites identified with one cert correctly dated and marked expired; minor inaccuracy for the second.
- 0.5: At least one site's SSL correctly identified as expired with a date cited; the other omitted or wrong.
- 0.25: SSL expiry mentioned in the report but dates not from actual files, or only one site covered without the expiry date.
- 0.0: SSL status not assessed, or both sites marked as valid despite expired dates.

### Pending Config Change Analysis (Weight: 30%)
- 1.0: Both `.new` config files identified and their changes precisely described — nginx adds webhook proxy for `/api/telegram/webhook → port 3781`; moltbot.json.new enables remote gateway, webhook mode (with URL), and switches to debug logging; the interdependency between the two changes is explicitly noted.
- 0.75: Both `.new` files identified with correct high-level change descriptions; interdependency mentioned but not fully explained.
- 0.5: At least one `.new` file identified with a correct change description; the other missing or vaguely described.
- 0.25: `.new` files mentioned but no meaningful analysis of what changes they introduce.
- 0.0: Pending config changes not detected or not reported.

### Skill Definition Quality (Weight: 20%)
- 1.0: SKILL.md saved at correct path (`workspace/skills/server-workspace/SKILL.md`), has YAML frontmatter with name/description, and contains a structured multi-step audit procedure covering SSL expiry checking, pending config detection, and security scanning — reusable beyond this specific server.
- 0.75: SKILL.md at correct path with frontmatter; procedure covers most audit steps but is incomplete or too server-specific.
- 0.5: SKILL.md exists but at wrong path (e.g., workspace root), or has frontmatter but only generic content.
- 0.25: SKILL.md exists at wrong path with minimal/stub content.
- 0.0: SKILL.md not created.

### Cross-file Synthesis and Security Flagging (Weight: 15%)
- 1.0: Report synthesizes findings from at least 5 distinct source files with explicit citations (e.g., "from site.json, from www.fzw.best.conf.new, from moltbot.json.new"); plaintext bot token and webhook secret correctly flagged as security issues with file references.
- 0.75: Findings traceable to 3–4 source files; credential exposure flagged but without specifying which files.
- 0.5: Evidence from 2–3 files cited; security section present but incomplete.
- 0.25: Generic analysis with minimal file citations; security issues missed or mentioned only vaguely.
- 0.0: No cross-file synthesis; content is hallucinated or does not reflect actual workspace files.

### Output Completeness and Grounding (Weight: 5%)
- 1.0: server_audit.json is valid JSON with all required sections (sites, pending_changes, security_flags); .openclaw/workspace-state.json populated with actual site/service data extracted from config files.
- 0.75: Both files present with mostly correct structure; one section missing or contains generic placeholder values.
- 0.5: server_audit.json exists but missing 2+ required sections; .openclaw file absent or empty.
- 0.25: Only one of the two output files produced with minimal content.
- 0.0: Neither server_audit.json nor .openclaw/workspace-state.json created.
