---
id: task_00096_create_protected_secrets_directory_with_access_rules
name: Create Protected Secrets Directory with Access Rules
category: Security and Vulnerability Management
subcategory: Credentials and Certificate Management
grading_type: hybrid
grading_weights:
  automated: 0.6
  llm_judge: 0.4
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: project/.gitignore
  dest: .gitignore
- source: project/.env.example
  dest: .env.example
- source: project/SECURITY.md
  dest: SECURITY.md
- source: project/security_config.json
  dest: security_config.json
- source: project/old_notes.txt
  dest: old_notes.txt
- source: project/config.json
  dest: config.json
---

## Prompt

I need you to set up a proper secrets management structure for this project. Check the workspace files first, do all of the following:

1. **Create a `.secrets/` directory** with owner-only permissions. This is where secrets files will live, nothing in this directory should ever be committed.

2. **Create `.secrets/.env.template`** — a template listing all the credential environment variable names from `.env.example` that require actual secrets (database passwords, API keys, OAuth secrets, etc.), with placeholder values. Include a comment header explaining this file's purpose and reminding users never to store real values here.

3. **Create `.secrets/README.md`** documenting:
   - Purpose of this directory and how to use it
   - Access rules: the AI agent may only use these secrets when explicitly authorized by the user
   - The credential rotation schedule from `old_notes.txt` (API keys: every 90 days, DB passwords: every 60 days, OAuth secrets: every 180 days, SSH keys: annually)
   - The security standards from `security_config.json` that apply to any credentials stored here

4. **Update `.gitignore`** to add an entry that excludes the `.secrets/` directory.

5. **Update `SECURITY.md`** to add a section about the `.secrets/` directory: how it's structured, the access rules, and how it fits into the overall credential management policy.

6. **Flag the hardcoded credential in `config.json`**: the `database.password` field is set to `"REPLACE_ME"`, note in the `.secrets/README.md` that this field should reference an environment variable rather than a hardcoded value.

## Expected Behavior

The agent should:

1. Read `old_notes.txt` to extract the rotation schedule (API keys: 90 days, DB passwords: 60 days, OAuth secrets: 180 days, SSH keys: annually) and the incident context (credentials exposed in a commit).
2. Read `.env.example` to identify all credential environment variable names that need real secret values (OPENAI_API_KEY, GITHUB_TOKEN, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, STRIPE_SECRET_KEY, SENDGRID_API_KEY, GOOGLE_CLIENT_SECRET, DB_PASS, POSTGRES_PASSWORD).
3. Read `SECURITY.md` to understand the existing policy structure and add a new `.secrets/` section without disrupting existing content.
4. Read `security_config.json` to reference the encryption/password standards (AES-256-GCM, PBKDF2, min password length 12, max_age_days 90) in the README documentation.
5. Read `config.json` and identify that `database.password: "REPLACE_ME"` is a hardcoded placeholder that violates the project's policy of using environment variables for credentials.
6. Produce the following files:
   - `.secrets/` directory with `chmod 700`
   - `.secrets/.env.template` listing at minimum: DB_PASS, OPENAI_API_KEY, GITHUB_TOKEN, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, STRIPE_SECRET_KEY, with placeholder values
   - `.secrets/README.md` with rotation schedule (specific days), access/authorization rules, and security standards reference
   - Updated `.gitignore` with `.secrets/` exclusion entry
   - Updated `SECURITY.md` with new `.secrets/` section

## Grading Criteria

- [ ] A `.secrets/` directory exists in the workspace
- [ ] The `.secrets/` directory has restrictive permissions (mode 700 or equivalent, no group/other bits)
- [ ] `.secrets/.env.template` (or equivalent) exists and lists at least 5 specific credential variable names from `.env.example`
- [ ] `.secrets/README.md` exists and contains the specific rotation schedule from `old_notes.txt` (at least two of: 90-day API keys, 60-day DB passwords, 180-day OAuth, annual SSH)
- [ ] `.gitignore` contains an entry excluding the `.secrets/` directory
- [ ] `SECURITY.md` is updated with a new section mentioning the `.secrets/` directory
- [ ] The `config.json` hardcoded credential issue (`REPLACE_ME` password) is flagged somewhere in the written output

## Automated Checks

```python
import os
import re
import stat
from pathlib import Path

def grade(transcript: list, workspace_path: str) -> dict:
    scores = {
        "secrets_directory_exists": 0.0,
        "directory_permissions_restrictive": 0.0,
        "credentials_template_complete": 0.0,
        "rotation_schedule_cited": 0.0,
        "gitignore_excludes_secrets": 0.0,
        "security_md_updated": 0.0,
        "config_json_flagged": 0.0,
    }

    ws = Path(workspace_path)

    # Locate secrets directory
    secrets_dir = None
    for candidate in [".secrets", ".private", "secrets", "private",
                      ".credentials", ".vault", ".creds", ".keys"]:
        d = ws / candidate
        if d.is_dir():
            secrets_dir = d
            break

    if secrets_dir is not None:
        scores["secrets_directory_exists"] = 1.0

        # ── directory_permissions_restrictive ──
        try:
            mode = stat.S_IMODE(os.stat(secrets_dir).st_mode)
            group_other_bits = mode & 0o077
            if group_other_bits == 0:
                scores["directory_permissions_restrictive"] = 1.0
            elif group_other_bits <= 0o010:
                scores["directory_permissions_restrictive"] = 0.5
        except Exception:
            pass

        # ── credentials_template_complete ──
        # Score 1.0: a template file exists in .secrets/ listing at least 5 specific
        # credential variable names from .env.example.
        # Score 0.5: file exists but fewer than 5 credential keys are present.
        required_cred_keys = [
            r"DB_PASS|DB_PASSWORD|POSTGRES_PASSWORD",
            r"OPENAI_API_KEY",
            r"GITHUB_TOKEN|GITHUB_PAT",
            r"AWS_ACCESS_KEY_ID",
            r"AWS_SECRET_ACCESS_KEY",
            r"STRIPE_SECRET_KEY",
            r"SENDGRID_API_KEY",
            r"GOOGLE_CLIENT_SECRET",
        ]
        template_content = ""
        for f in secrets_dir.iterdir():
            fname = f.name.lower()
            if f.is_file() and (
                fname.endswith(".template") or
                fname.startswith(".env") or
                fname in ("template.env", "env.template", "credentials.template", "secrets.template")
            ):
                try:
                    template_content = f.read_text(encoding="utf-8")
                    break
                except Exception:
                    pass
        if template_content:
            hits = sum(1 for pat in required_cred_keys if re.search(pat, template_content, re.IGNORECASE))
            if hits >= 5:
                scores["credentials_template_complete"] = 1.0
            elif hits >= 3:
                scores["credentials_template_complete"] = 0.5
            elif hits >= 1:
                scores["credentials_template_complete"] = 0.25

        # ── rotation_schedule_cited ──
        # Score 1.0: README inside .secrets/ mentions at least TWO specific rotation
        # periods from old_notes.txt (90-day API keys, 60-day DB passwords, 180-day OAuth, annual SSH).
        # Score 0.5: only ONE rotation period is mentioned.
        readme_content = ""
        for f in secrets_dir.iterdir():
            if f.is_file() and f.suffix.lower() == ".md":
                try:
                    readme_content = f.read_text(encoding="utf-8").lower()
                    break
                except Exception:
                    pass
        if readme_content:
            rotation_patterns = [
                r"90.day|every.90|api.key.*90|90.*api",        # API keys: 90 days
                r"60.day|every.60|db.*60|60.*db|database.*60|60.*database|password.*60|60.*password",  # DB: 60 days
                r"180.day|every.180|oauth.*180|180.*oauth",     # OAuth: 180 days
                r"annual|yearly|ssh.key|once.a.year",           # SSH: annually
            ]
            rotation_hits = sum(
                1 for pat in rotation_patterns if re.search(pat, readme_content)
            )
            has_access_rules = bool(re.search(
                r"explicit.*authoriz|authoriz.*explicit|only.*authoriz|user.*authoriz|"
                r"access.*rule|authorization.*required",
                readme_content
            ))
            if rotation_hits >= 2 and has_access_rules:
                scores["rotation_schedule_cited"] = 1.0
            elif rotation_hits >= 2:
                scores["rotation_schedule_cited"] = 0.75
            elif rotation_hits >= 1 and has_access_rules:
                scores["rotation_schedule_cited"] = 0.5
            elif rotation_hits >= 1 or has_access_rules:
                scores["rotation_schedule_cited"] = 0.25

    # ── gitignore_excludes_secrets ──
    secrets_dir_name = secrets_dir.name if secrets_dir else ".secrets"
    gitignore_path = ws / ".gitignore"
    if gitignore_path.is_file():
        try:
            gi_content = gitignore_path.read_text(encoding="utf-8")
            for line in gi_content.splitlines():
                stripped = line.strip()
                if not stripped.startswith("#") and secrets_dir_name in stripped:
                    scores["gitignore_excludes_secrets"] = 1.0
                    break
        except Exception:
            pass

    # ── security_md_updated ──
    # Score 1.0 if SECURITY.md now contains a section referencing .secrets/ directory.
    # Score 0.5 if SECURITY.md mentions secrets but without a dedicated section.
    security_md_path = ws / "SECURITY.md"
    if security_md_path.is_file():
        try:
            sec_content = security_md_path.read_text(encoding="utf-8").lower()
            has_secrets_section = bool(re.search(
                r"##.*secret|##.*\.secrets|\.secrets.*directory|secrets.*directory",
                sec_content
            ))
            has_secrets_mention = ".secrets" in sec_content or "secrets directory" in sec_content
            if has_secrets_section:
                scores["security_md_updated"] = 1.0
            elif has_secrets_mention:
                scores["security_md_updated"] = 0.5
        except Exception:
            pass

    # ── config_json_flagged ──
    # Score 1.0 if the hardcoded config.json credential issue (REPLACE_ME database password)
    # is flagged in .secrets/README.md, in SECURITY.md, or in the transcript.
    # Must reference "config.json" AND "REPLACE_ME" or "hardcoded" or "environment variable".
    _config_flag_text = readme_content + " "
    if security_md_path.is_file():
        try:
            _config_flag_text += security_md_path.read_text(encoding="utf-8").lower()
        except Exception:
            pass
    if transcript:
        _config_flag_text += " ".join(
            str(m.get("content", m) if isinstance(m, dict) else m) for m in transcript
        ).lower()
    has_config_ref = bool(re.search(r"config\.json", _config_flag_text))
    has_issue_ref = bool(re.search(
        r"replace_me|hardcod|env.*var|environment.variable|should.not|"
        r"must.not.*hardcod|move.*to.*env",
        _config_flag_text
    ))
    if has_config_ref and has_issue_ref:
        scores["config_json_flagged"] = 1.0
    elif has_config_ref or has_issue_ref:
        scores["config_json_flagged"] = 0.25

    return scores
```

## LLM Judge Rubric

### Secrets Directory and Credentials Template (Weight: 25%)
- 1.0: `.secrets/` directory created with `chmod 700` (or equivalent) AND `.secrets/.env.template` lists all major credential categories from `.env.example` (database, API keys, OAuth, monitoring) with placeholder values and a clear comment header explaining the file's purpose
- 0.75: Directory created with correct permissions and template exists but is missing some credential categories (e.g., only API keys, not DB or OAuth)
- 0.5: Directory created but either permissions are not restricted or the template is missing or very sparse
- 0.25: Some attempt at a secrets directory with minimal content
- 0.0: No `.secrets/` directory created

### README Documentation Quality (Weight: 25%)
- 1.0: `.secrets/README.md` is comprehensive: includes clear access authorization rules (AI agent requires explicit user permission), the specific rotation schedule from `old_notes.txt` (at minimum: 90-day API keys AND 60-day DB passwords), references to `security_config.json` standards, and guidance on how to use the secrets directory. The content clearly demonstrates that the agent read and synthesized information from multiple workspace files.
- 0.75: README covers access rules and rotation schedule but either cites only one rotation period or lacks reference to security_config.json standards
- 0.5: README exists with access rules but no specific rotation schedule, or has rotation schedule but no access authorization rules
- 0.25: README exists but is generic — doesn't reference any workspace-specific data (rotation schedule, config standards)
- 0.0: No README in `.secrets/`

### SECURITY.md Update and config.json Issue (Weight: 25%)
- 1.0: `SECURITY.md` is updated with a new dedicated section about `.secrets/` directory (covering its structure, access rules, and how it fits the existing credential management policy) AND the `config.json` hardcoded `REPLACE_ME` database password is flagged in writing (README, SECURITY.md, or clearly in the response) with guidance to use an environment variable instead
- 0.75: SECURITY.md is updated with a .secrets/ section OR config.json issue is flagged, but not both
- 0.5: SECURITY.md is only marginally updated (a brief mention) and/or the config.json issue is mentioned without specific guidance
- 0.25: Neither SECURITY.md is substantively updated nor the config.json issue is clearly flagged
- 0.0: SECURITY.md is not updated and config.json issue is not mentioned

### Version Control Exclusion and Overall Integration (Weight: 25%)
- 1.0: `.gitignore` is updated with the `.secrets/` exclusion pattern; the response/documentation demonstrates that the agent read and cross-referenced all provided files (`old_notes.txt`, `.env.example`, `SECURITY.md`, `security_config.json`, `config.json`) to produce contextually grounded outputs rather than generic security advice
- 0.75: `.gitignore` is updated AND most workspace files were referenced, but one or two were ignored
- 0.5: `.gitignore` is updated but the documentation is generic and doesn't reference workspace-specific data
- 0.25: `.gitignore` is updated but none of the workspace files were cross-referenced
- 0.0: `.gitignore` is not updated