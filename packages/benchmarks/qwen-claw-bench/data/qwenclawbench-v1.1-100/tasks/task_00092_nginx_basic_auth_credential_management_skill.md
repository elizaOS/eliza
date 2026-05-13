---
id: task_00092_nginx_basic_auth_credential_management_skill
name: Nginx Basic Auth Credential Management Skill
category: Security and Vulnerability Management
subcategory: Identity Authentication and Access Control
grading_type: hybrid
grading_weights:
  automated: 0.6
  llm_judge: 0.4
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: etc/nginx/nginx.conf
  dest: etc/nginx/nginx.conf
- source: etc/nginx/.htpasswd
  dest: etc/nginx/.htpasswd
- source: etc/nginx/.htpasswd.admin
  dest: etc/nginx/.htpasswd.admin
- source: etc/nginx/ssl/moltbot.zone.crt
  dest: etc/nginx/ssl/moltbot.zone.crt
- source: etc/nginx/ssl/moltbot.zone.key
  dest: etc/nginx/ssl/moltbot.zone.key
- source: etc/nginx/conf.d/security-headers.conf
  dest: etc/nginx/conf.d/security-headers.conf
- source: etc/nginx/sites-available/api.moltbot.zone
  dest: etc/nginx/sites-available/api.moltbot.zone
- source: etc/nginx/sites-available/www.moltbot.zone
  dest: etc/nginx/sites-available/www.moltbot.zone
- source: etc/nginx/logs/moltbot.zone.access.log
  dest: etc/nginx/logs/moltbot.zone.access.log
---

## Prompt

I have nginx installed with basic auth already configured. The full nginx setup is available in the workspace. Can you create a skill at `workspace/skills/nginx-basic-auth/SKILL.md` that covers managing nginx basic auth: locating the correct htpasswd file for a given site or location block, adding individual users without wiping others, deleting specific users by name, updating passwords for existing users, handling sites that use multiple htpasswd files across different location blocks, backup procedures before any credential changes, and reloading nginx safely.

Then help me make these changes to `www.moltbot.zone`:

1. **Main site** (`/`): Add a new user `zjc` with password `123zjc123`. The user `devteam` is still actively used (you can check the access logs), so do NOT remove them. After `zjc` is successfully added, remove the old `admin` user.

2. **Admin area** (`/admin`): Update the password for user `sysadmin` to `adminSecure2025!`.

Read the site config and htpasswd files in the workspace first to understand the current credential setup, then give me the **exact commands** to run on the server, including a `cp` backup command before any modification, followed by `nginx -t && systemctl reload nginx` to apply the changes. Also check the access log to confirm which users are actively accessing the site before deciding who to preserve or remove. For security hygiene, keep the plaintext passwords only inside the copy-paste-ready commands themselves, not repeated elsewhere in the explanation or the skill examples.

## Expected Behavior

The agent should:

1. **Create `workspace/skills/nginx-basic-auth/SKILL.md`** with YAML frontmatter (`name`, `description`) and sections covering:
   - Locating htpasswd files by reading `auth_basic_user_file` directives in site configs — including the possibility of multiple htpasswd files for different location blocks within the same site
   - Adding individual users with `htpasswd -b` (NOT `-bc`) to avoid overwriting the entire file
   - Explicit warning: using `htpasswd -bc` (with `-c`) creates a new file and wipes all existing users
   - Deleting a specific user with `htpasswd -D <file> <username>`
   - Updating a user's password with `htpasswd -b <file> <username> <newpassword>`
   - Backup procedure: `cp <htpasswd_file> <htpasswd_file>.bak` before any changes
   - Testing and reloading nginx: `nginx -t && systemctl reload nginx`

2. **Read `etc/nginx/sites-available/www.moltbot.zone`** to identify both htpasswd files:
   - Main area (`/`): `auth_basic_user_file /etc/nginx/.htpasswd`
   - Admin area (`/admin`): `auth_basic_user_file /etc/nginx/.htpasswd.admin`

3. **Read `etc/nginx/.htpasswd`** to confirm current users are `admin` and `devteam`. Cross-reference `etc/nginx/logs/moltbot.zone.access.log` to confirm `devteam` is actively logging in (3 successful GET requests at 02:16:22, 02:52:33, 03:45:12) and must be preserved. The `-c` flag must NOT be used for adding `zjc` (it would wipe `devteam`). Also note the suspicious scanning attempts from `45.33.22.11` (/.env, /wp-admin, /xmlrpc.php) visible in the log.

4. **Provide correct commands for the main area** (in sequence):
   - Backup first: `cp /etc/nginx/.htpasswd /etc/nginx/.htpasswd.bak`
   - Add zjc without overwriting others: `htpasswd -b /etc/nginx/.htpasswd zjc 123zjc123`
     - Must use `-b` not `-bc`; `-c` would recreate the file and delete `devteam`
   - Delete admin only: `htpasswd -D /etc/nginx/.htpasswd admin`

5. **Read `etc/nginx/.htpasswd.admin`** to confirm current user is `sysadmin`, then provide the correct update command:
   - Backup first: `cp /etc/nginx/.htpasswd.admin /etc/nginx/.htpasswd.admin.bak`
   - Update password: `htpasswd -b /etc/nginx/.htpasswd.admin sysadmin adminSecure2025!`
     - Must use `-b` not `-bc`; `-c` would wipe the .htpasswd.admin file

6. **Provide nginx config test followed by reload**: `nginx -t && systemctl reload nginx` — `nginx -t` must come before `reload` to catch config errors

7. If the agent cannot access the server directly, it should clearly communicate this and provide copy-paste-ready commands for the user to run.

## Grading Criteria

- [ ] `workspace/skills/nginx-basic-auth/SKILL.md` exists with YAML frontmatter and sections covering: per-user add with `htpasswd -b`, explicit `-bc` danger warning (wiping all users), `htpasswd -D` delete syntax, `auth_basic_user_file` directive discovery, multiple htpasswd files per location block, backup procedure (`cp <file> <file>.bak`)
- [ ] Agent reads `etc/nginx/sites-available/www.moltbot.zone` and identifies BOTH htpasswd file paths: `/etc/nginx/.htpasswd` for `/` and `/etc/nginx/.htpasswd.admin` for `/admin`
- [ ] Agent checks access log, cites `devteam` active logins (at least 02:16:22 or 03:45:12 timestamps), then provides `cp /etc/nginx/.htpasswd /etc/nginx/.htpasswd.bak` backup before any modification
- [ ] Agent uses `htpasswd -b /etc/nginx/.htpasswd zjc 123zjc123` (exact file path, `-b` not `-bc`) to add `zjc` — with explicit note that `-c` would delete `devteam`
- [ ] Agent provides `htpasswd -D /etc/nginx/.htpasswd admin` with the correct full file path to remove only `admin`
- [ ] Agent provides `htpasswd -b /etc/nginx/.htpasswd.admin sysadmin adminSecure2025!` to update the admin area password
- [ ] Agent provides `nginx -t && systemctl reload nginx` — both the config test and reload, in that order

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    import re

    scores = {
        "skill_md_exists": 0.0,
        "skill_md_frontmatter": 0.0,
        "skill_md_content_quality": 0.0,
        "correct_add_without_overwrite": 0.0,
        "correct_delete_admin": 0.0,
        "identifies_admin_htpasswd": 0.0,
        "mentions_nginx_reload": 0.0,
        "backup_and_log_evidence": 0.0,
    }

    # 1. Check SKILL.md exists — prefer skills/ subdirectory
    skill_path = None
    skills_dir = os.path.join(workspace_path, "skills")
    if os.path.isdir(skills_dir):
        found = False
        for root, dirs, files in os.walk(skills_dir):
            for f in files:
                if f.upper() == "SKILL.MD":
                    skill_path = os.path.join(root, f)
                    found = True
                    break
            if found:
                break
    if skill_path is None:
        fallback = os.path.join(workspace_path, "SKILL.MD")
        if os.path.isfile(fallback):
            skill_path = fallback

    skill_content = ""
    if skill_path and os.path.isfile(skill_path):
        scores["skill_md_exists"] = 1.0
        try:
            with open(skill_path, "r", encoding="utf-8") as f:
                skill_content = f.read()
        except Exception:
            pass

        # 2. Check YAML frontmatter with name and description
        frontmatter_match = re.search(r'^---\s*\n(.*?)\n---', skill_content, re.DOTALL)
        if frontmatter_match:
            fm = frontmatter_match.group(1)
            has_name = bool(re.search(r'^\s*name\s*:', fm, re.MULTILINE))
            has_desc = bool(re.search(r'^\s*description\s*:', fm, re.MULTILINE))
            if has_name and has_desc:
                scores["skill_md_frontmatter"] = 1.0
            elif has_name or has_desc:
                scores["skill_md_frontmatter"] = 0.5

        # 3. Strict content quality: require specific commands and the -c danger warning
        sc = skill_content.lower()
        quality_signals = [
            # Must mention the -b flag specifically (htpasswd -b), not just "htpasswd"
            bool(re.search(r'htpasswd\s+-b\b|htpasswd.*-b\s', sc)),
            # Must warn about the danger of -c / -bc overwriting the file
            bool(re.search(r'-bc|-c\s.{0,60}(wipe|overwrite|creat|replac|delet|remov)|'
                           r'(wipe|overwrite|creat|replac|delet|remov).{0,60}-c\b', sc)),
            # Must mention the -D flag for deletion
            bool(re.search(r'htpasswd\s+-[a-z]*d\b|htpasswd.*-d\s|--delete', sc)),
            # Must mention auth_basic_user_file directive to locate htpasswd files
            bool(re.search(r'auth_basic_user_file|auth_basic\s+user\s*file', sc)),
            # Must cover backup procedure
            bool(re.search(r'\.bak\b|backup|cp\s.{0,60}htpasswd', sc)),
            # Must mention handling multiple htpasswd files or multiple location blocks
            bool(re.search(r'multiple|location\s+block|per.{0,15}location|different.{0,30}(htpasswd|file)', sc)),
        ]
        hits = sum(quality_signals)
        if hits >= 5:
            scores["skill_md_content_quality"] = 1.0
        elif hits >= 4:
            scores["skill_md_content_quality"] = 0.75
        elif hits >= 3:
            scores["skill_md_content_quality"] = 0.5
        elif hits >= 2:
            scores["skill_md_content_quality"] = 0.3
        elif hits >= 1:
            scores["skill_md_content_quality"] = 0.15

    # Build combined assistant transcript text (assistant + tool messages)
    assistant_text = ""
    for event in transcript:
        if event.get("type") != "message":
            continue
        msg = event.get("message", {})
        if msg.get("role") in ("assistant", "tool"):
            content = msg.get("content", "")
            if isinstance(content, str):
                assistant_text += " " + content
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "text":
                        assistant_text += " " + part.get("text", "")

    assistant_lower = assistant_text.lower()

    # 4. Correct add command for zjc:
    #    - Must include the exact file path /etc/nginx/.htpasswd
    #    - Must include zjc and 123zjc123
    #    - Must NOT use -c flag (which would wipe devteam)
    has_correct_file = bool(re.search(r'/etc/nginx/\.htpasswd(?!\.admin)', assistant_text))
    has_zjc = "zjc" in assistant_text
    has_password = "123zjc123" in assistant_text
    uses_c_flag_with_zjc = bool(
        re.search(r'htpasswd\s+-[a-zA-Z]*c[a-zA-Z]*\s[^\n]*zjc', assistant_text)
        or re.search(r'htpasswd\s+-[a-zA-Z]*c[a-zA-Z]*\s[^\n]*zjc', assistant_lower)
    )
    if has_correct_file and has_zjc and has_password and not uses_c_flag_with_zjc:
        scores["correct_add_without_overwrite"] = 1.0
    elif has_zjc and has_password and not uses_c_flag_with_zjc:
        scores["correct_add_without_overwrite"] = 0.6  # right command but missing file path
    elif has_zjc and has_password and uses_c_flag_with_zjc:
        scores["correct_add_without_overwrite"] = 0.2  # correct user/pass but -c would wipe devteam
    elif "htpasswd" in assistant_lower and has_zjc:
        scores["correct_add_without_overwrite"] = 0.3

    # 5. Correct delete command for admin:
    #    - Must use -D flag targeting /etc/nginx/.htpasswd (not .htpasswd.admin)
    #    - Must specifically name "admin" as the user to delete
    has_delete_with_path = bool(
        re.search(r'htpasswd\s+-[a-zA-Z]*D[a-zA-Z]*\s+/etc/nginx/\.htpasswd\s+admin', assistant_text)
    )
    has_delete_any = bool(
        re.search(r'htpasswd\s+-[a-zA-Z]*D[a-zA-Z]*\s[^\n]*admin', assistant_text)
        or re.search(r'htpasswd\s+--delete[^\n]*admin', assistant_lower)
    )
    if has_delete_with_path:
        scores["correct_delete_admin"] = 1.0
    elif has_delete_any and has_correct_file:
        scores["correct_delete_admin"] = 0.75
    elif has_delete_any:
        scores["correct_delete_admin"] = 0.5
    elif "htpasswd" in assistant_lower and "admin" in assistant_lower and \
         any(kw in assistant_lower for kw in ["delet", "remov", "-d "]):
        scores["correct_delete_admin"] = 0.25

    # 6. Admin area htpasswd update:
    #    - Must identify .htpasswd.admin from reading the config
    #    - Must provide sysadmin password update with -b (not -bc) and the new password
    has_admin_file = bool(re.search(r'htpasswd\.admin|/etc/nginx/\.htpasswd\.admin', assistant_lower))
    has_sysadmin = "sysadmin" in assistant_lower
    has_new_pass = "adminSecure2025!" in assistant_text
    has_b_flag_admin = bool(re.search(
        r'htpasswd\s+-b\s+/etc/nginx/\.htpasswd\.admin\s+sysadmin', assistant_text))
    uses_c_flag_admin = bool(
        re.search(r'htpasswd\s+-[a-zA-Z]*c[a-zA-Z]*\s[^\n]*sysadmin', assistant_text))
    if has_b_flag_admin and has_new_pass and not uses_c_flag_admin:
        scores["identifies_admin_htpasswd"] = 1.0
    elif has_admin_file and has_sysadmin and has_new_pass and not uses_c_flag_admin:
        scores["identifies_admin_htpasswd"] = 0.75
    elif has_admin_file and has_sysadmin and has_new_pass:
        scores["identifies_admin_htpasswd"] = 0.5  # correct but used -c
    elif has_admin_file and has_sysadmin:
        scores["identifies_admin_htpasswd"] = 0.35
    elif has_sysadmin:
        scores["identifies_admin_htpasswd"] = 0.15

    # 7. nginx -t test BEFORE reload (both must be present, in correct order or combined)
    has_nginx_test = bool(re.search(r'nginx\s+-t\b', assistant_lower))
    has_nginx_reload = bool(
        re.search(r'(reload|restart)\s*(nginx|systemctl)', assistant_lower)
        or re.search(r'(systemctl|service)\s*(reload|restart)\s*nginx', assistant_lower)
        or re.search(r'nginx\s+-s\s+reload', assistant_lower)
    )
    if has_nginx_test and has_nginx_reload:
        scores["mentions_nginx_reload"] = 1.0
    elif has_nginx_reload:
        scores["mentions_nginx_reload"] = 0.4  # reload without test is incomplete
    elif has_nginx_test:
        scores["mentions_nginx_reload"] = 0.3

    # 8. Backup step + access log evidence for devteam
    #    - Must provide cp backup command for .htpasswd file
    #    - Must cite access log evidence that devteam is active (timestamps or explicit log reference)
    has_backup_main = bool(re.search(
        r'cp\s+/etc/nginx/\.htpasswd\s+/etc/nginx/\.htpasswd\.bak|'
        r'cp\s+.*htpasswd.*\.bak', assistant_text))
    has_backup_admin = bool(re.search(
        r'cp\s+/etc/nginx/\.htpasswd\.admin\s+/etc/nginx/\.htpasswd\.admin\.bak|'
        r'cp\s+.*htpasswd\.admin.*\.bak', assistant_text))
    has_backup_any = bool(re.search(r'\.htpasswd\.bak|htpasswd.*\.bak|cp.*htpasswd', assistant_lower))
    # devteam log evidence: access log file referenced AND devteam active login timestamps or explicit note
    has_log_file_ref = bool(re.search(r'access\.log|moltbot\.zone\.access', assistant_lower))
    has_devteam_log = bool(re.search(
        r'devteam.{0,100}(02:16|02:52|03:45|active|log|login|access)|'
        r'(02:16|02:52|03:45).{0,100}devteam', assistant_lower))
    backup_score = 0.0
    if has_backup_main and has_backup_admin:
        backup_score += 0.5
    elif has_backup_main:
        backup_score += 0.35
    elif has_backup_any:
        backup_score += 0.3
    if has_log_file_ref and has_devteam_log:
        backup_score += 0.5
    elif has_log_file_ref:
        backup_score += 0.25
    scores["backup_and_log_evidence"] = min(1.0, backup_score)

    return scores
```

## LLM Judge Rubric

### Skill File Quality and Structure (Weight: 20%)
- 1.0: SKILL.md exists with YAML frontmatter (name, description) and covers ALL of: locating htpasswd files via `auth_basic_user_file` directive, `htpasswd -b` for adding individual users, **explicit warning** that `-bc` (or `-c`) creates a new file and deletes all existing users, `htpasswd -D` for per-user deletion, handling multiple htpasswd files across different `location` blocks, `cp <file> <file>.bak` backup before changes, and `nginx -t && systemctl reload nginx`.
- 0.75: Covers most topics but missing one key item (e.g., no explicit `-c` danger warning, or no `auth_basic_user_file` directive mention, or no multi-location-block guidance).
- 0.5: Covers basic htpasswd operations (add/delete/update) with frontmatter but lacks the `-c` danger warning or multi-file handling.
- 0.25: SKILL.md exists with some htpasswd content but is missing multiple critical sections.
- 0.0: No SKILL.md file, empty file, or unrelated content.

### Correctness of Main Site Credential Changes (Weight: 25%)
- 1.0: Provides `htpasswd -b /etc/nginx/.htpasswd zjc 123zjc123` (exact file path, `-b` not `-bc`), followed by `htpasswd -D /etc/nginx/.htpasswd admin` (exact file path, `-D` flag). Both commands target the correct file. Explicitly states that `-c` must not be used because it would overwrite and delete `devteam`.
- 0.75: Both add and delete commands are correct but missing the full file path in one of them, OR correct commands but `-c` danger is not explicitly mentioned.
- 0.5: Add command uses `-bc` (would wipe devteam) OR only one of the two operations (add or delete) is correctly provided.
- 0.25: Attempts main site changes but has significant errors (wrong user, wrong file path, omits password).
- 0.0: Does not attempt main site changes, or instructions are completely wrong.

### Admin Area Credential Update (Weight: 20%)
- 1.0: Reads `www.moltbot.zone` config to identify `/admin` uses `/etc/nginx/.htpasswd.admin`. Reads the file to confirm `sysadmin` is the existing user. Provides `htpasswd -b /etc/nginx/.htpasswd.admin sysadmin adminSecure2025!` (with `-b` not `-bc`). Includes backup step for `.htpasswd.admin`.
- 0.75: Correctly identifies the admin htpasswd file and provides the update command with correct syntax, but omits the backup step or does not confirm current username.
- 0.5: Mentions `/admin` uses a separate htpasswd file and attempts the update command, but has syntax errors or wrong file path.
- 0.25: Identifies `/admin` location block but fails to identify the separate htpasswd file or provide any meaningful update command.
- 0.0: Ignores `/admin` area entirely or conflates it with the main htpasswd file.

### Log-Grounded User Preservation (Weight: 20%)
- 1.0: Explicitly reads `moltbot.zone.access.log`, cites specific `devteam` login entries (e.g., timestamps 02:16:22, 02:52:33, or 03:45:12), uses this evidence to justify preserving `devteam`, and correctly uses `-b` (not `-bc`) on that basis. Optionally notes the suspicious scanning activity from `45.33.22.11`.
- 0.75: Reads the access log and notes devteam is active, but does not cite specific timestamps. Uses `-b` correctly.
- 0.5: Avoids `-c` flag and mentions devteam but does not reference the access log as evidence.
- 0.25: References the access log but still uses `-bc` or does not explicitly justify preserving devteam.
- 0.0: Does not read the access log, uses `-bc` for adding zjc (wiping devteam), or ignores user preservation entirely.

### Safety Procedures and Command Completeness (Weight: 15%)
- 1.0: Provides `cp /etc/nginx/.htpasswd /etc/nginx/.htpasswd.bak` backup before main site changes AND backup for `.htpasswd.admin`, AND `nginx -t && systemctl reload nginx` (both test and reload). Commands are copy-paste-ready with full paths.
- 0.75: Provides backup step and reload command but missing nginx -t test, OR provides all steps but backup command lacks explicit file paths.
- 0.5: Mentions backup or nginx reload but not both, or commands are incomplete/vague.
- 0.25: Mentions safety procedures in passing without providing actionable commands.
- 0.0: No backup step, no nginx test, or response is too incomplete to be actionable.