---
id: task_00025_openclaw_minimax_api_key_troubleshooting
name: OpenClaw Minimax API Key Troubleshooting
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
- source: .openclaw/agents/main/agent/auth-profiles.json
  dest: .openclaw/agents/main/agent/auth-profiles.json
- source: .openclaw/agents/main/agent/openclaw.json
  dest: .openclaw/agents/main/agent/openclaw.json
- source: .openclaw/.env
  dest: .openclaw/.env
---

## Prompt

I'm chatting with OpenClaw in Discord and it keeps failing with this error:

Agent failed before reply: No API key found for provider "minimax". Auth store: /home/user/.openclaw/agents/main/agent/auth-profiles.json (agentDir: /home/user/.openclaw/agents/main/agent). Configure auth for this agent (openclaw agents add <id>) or copy auth-profiles.json from the main agentDir. Logs: openclaw logs --follow

I already tried adding the key to `.env` but it's still broken. Can you read through **all three config files** carefully and diagnose exactly what's going on? I need a clear explanation of every issue you find and a `TROUBLESHOOTING.md` file in my workspace that includes: an issue summary table, root cause analysis, and step-by-step fix instructions.

## Expected Behavior

The agent should:

1. **Read and carefully examine all three workspace files**:
   - `.openclaw/agents/main/agent/auth-profiles.json`: A `minimax:default` profile **exists** but its `"key"` field is an **empty string** (`""`). The `usageStats` for `minimax:default` shows `errorCount: 47`, confirming repeated failures. Three other providers (alibaba-cloud, openai, anthropic) are fully configured.
   - `.openclaw/agents/main/agent/openclaw.json`: `minimax/MiniMax-M2.5` is the primary model. Critically, the top-level `"env"` section contains `"MINIMAX_API_KEY": null`, which **explicitly overrides and nullifies** any `MINIMAX_API_KEY` value set in `.env` — this is why adding the key to `.env` didn't work.
   - `.openclaw/.env`: `MINIMAX_API_KEY=` is present but has **no value** (empty string). Other keys (OPENAI, ANTHROPIC, ALIBABA_CLOUD) are set.

2. **Diagnose three compounding issues**:
   - **Issue 1 (auth-profiles.json)**: `minimax:default` profile has an **empty key** (`"key": ""`). The profile entry was created but no API key was filled in. The 47 error count in usageStats confirms this has been failing repeatedly.
   - **Issue 2 (openclaw.json env override)**: The `"env"` section in `openclaw.json` explicitly sets `"MINIMAX_API_KEY": null`. This overrides any value in `.env`, which is why the user's attempt to "add the key to .env" had no effect.
   - **Issue 3 (.env)**: Even if the null override is removed, `MINIMAX_API_KEY=` in `.env` still has no value and needs to be set to an actual key.

3. **Explain the interaction**: The agent must explain why the `.env` fix didn't work — the null value in `openclaw.json`'s `"env"` section takes precedence over `.env` file values.

4. **Provide fixes for all three locations**:
   - Fix `auth-profiles.json`: Set `minimax:default.key` to the actual API key
   - Fix `openclaw.json`: Remove `"MINIMAX_API_KEY": null` from the `"env"` section (or delete the env entry entirely)
   - Fix `.env`: Set `MINIMAX_API_KEY=<your-minimax-api-key>` with the actual key value
   - Optional alternative: Switch the primary model to `alibaba-cloud/qwen3-max-2026-01-23` (already fully configured as a fallback)

5. **Create `TROUBLESHOOTING.md`** in the workspace root with:
   - An issue summary table with columns: Issue | File | Severity
   - A root cause analysis section explaining the three-layer failure and why `.env` alone didn't fix it
   - Step-by-step resolution (at least 3 numbered steps, one per fix location)
   - Optional: fallback model suggestion

The agent must NOT simply say "minimax is missing from auth-profiles.json" — that profile exists but has an empty key. The agent must identify the `openclaw.json` env override as the reason the user's `.env` fix failed.

## Grading Criteria

- [ ] Agent reads all three workspace files and grounds diagnosis in actual file contents
- [ ] Agent identifies that `minimax:default` in auth-profiles.json EXISTS but has an empty key (not just "missing")
- [ ] Agent identifies the `"MINIMAX_API_KEY": null` override in openclaw.json's `"env"` section
- [ ] Agent explains why adding to `.env` alone didn't work (null override blocks it)
- [ ] Agent provides fixes for all three locations (auth-profiles + openclaw.json env + .env)
- [ ] Agent creates `TROUBLESHOOTING.md` with an issue table, root cause analysis, and step-by-step fix instructions

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import json
    import re
    from pathlib import Path

    scores = {
        "auth_profile_empty_key_identified": 0.0,
        "null_override_identified": 0.0,
        "three_issues_coverage": 0.0,
        "troubleshooting_doc_structured": 0.0,
        "fix_all_locations_addressed": 0.0,
    }

    wp = Path(workspace_path)

    if not transcript:
        return scores

    # Extract all assistant text from transcript
    assistant_text = ""
    for event in transcript:
        if event.get("type") != "message":
            continue
        msg = event.get("message", {})
        if msg.get("role") == "assistant":
            content = msg.get("content", "")
            if isinstance(content, str):
                assistant_text += content + "\n"
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "text":
                        assistant_text += part.get("text", "") + "\n"
    doc_path = wp / "TROUBLESHOOTING.md"
    if doc_path.exists():
        try:
            assistant_text += "\n" + doc_path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            pass

    lower_text = assistant_text.lower()

    # 1. auth-profiles.json diagnosis — check transcript for evidence of identifying empty key
    # (Preferred over file-state check: agent should not be penalized for fixing the file)
    empty_key_patterns = [
        r'"key".*""', r'empty.*key', r'key.*empty', r'blank.*key',
        r'key.*blank', r'key.*no.*value', r'no.*value.*key',
        r'errorcount.*47', r'47.*error', r'"key":\s*""',
    ]
    if any(re.search(p, lower_text) for p in empty_key_patterns):
        scores["auth_profile_empty_key_identified"] = 1.0
    elif "minimax:default" in lower_text and ("key" in lower_text or "empty" in lower_text):
        scores["auth_profile_empty_key_identified"] = 0.7
    else:
        auth_file = wp / ".openclaw" / "agents" / "main" / "agent" / "auth-profiles.json"
        if auth_file.exists():
            try:
                data = json.loads(auth_file.read_text(encoding="utf-8", errors="replace"))
                profiles = data.get("profiles", {})
                mm = profiles.get("minimax:default", {}) if isinstance(profiles, dict) else {}
                if isinstance(mm, dict) and mm.get("key", None) == "":
                    scores["auth_profile_empty_key_identified"] = 1.0
                elif isinstance(profiles, dict) and "minimax:default" in profiles:
                    scores["auth_profile_empty_key_identified"] = 0.4
            except Exception:
                pass

    # 2. KEY CHECK: Did the agent identify the null override in openclaw.json's env section?
    null_patterns = [
        '"minimax_api_key": null',
        '"minimax_api_key":null',
        'minimax_api_key.*null',
        'null.*minimax_api_key',
        'env.*null',
        'null.*override',
        'overrid.*null',
        'set.*null',
        'null.*env section',
        'env section.*null',
    ]
    null_found = any(p in lower_text for p in null_patterns[:4])
    if not null_found:
        null_found = any(re.search(p, lower_text) for p in null_patterns[4:])
    # Also check if both "null" and "openclaw.json" appear with env context
    if not null_found and "null" in lower_text and (
        "openclaw.json" in lower_text or '"env"' in assistant_text
    ):
        null_found = bool(re.search(r'null.{0,200}(env|override|minimax)', lower_text, re.DOTALL))

    if null_found:
        scores["null_override_identified"] = 1.0
    elif "null" in lower_text and "minimax" in lower_text:
        scores["null_override_identified"] = 0.4

    # 3. Coverage of all three issues
    issue_signals = {
        "empty_key": [
            r'"key".*""', r'empty.*key', r'key.*empty', r'blank.*key',
            r'key.*blank', r'no.*value.*key', r'key.*no.*value',
            r'errorcount.*47', r'47.*error', r'error.*47'
        ],
        "null_override": [
            r'null.*override', r'override.*null', r'env.*null',
            r'null.*env', r'"env".*null', r'minimax_api_key.*null'
        ],
        "env_empty": [
            r'minimax_api_key=\s*$', r'\.env.*empty', r'empty.*\.env',
            r'no value.*env', r'env.*no value', r'not set'
        ],
    }
    issues_found = 0
    for issue_key, patterns in issue_signals.items():
        if any(re.search(p, lower_text) for p in patterns):
            issues_found += 1

    if issues_found >= 3:
        scores["three_issues_coverage"] = 1.0
    elif issues_found == 2:
        scores["three_issues_coverage"] = 0.6
    elif issues_found == 1:
        scores["three_issues_coverage"] = 0.3

    # 4. TROUBLESHOOTING.md structure check
    doc_path = wp / "TROUBLESHOOTING.md"
    if doc_path.exists():
        try:
            doc = doc_path.read_text(encoding="utf-8", errors="replace").lower()
            structure_score = 0.0
            if "|" in doc and ("issue" in doc or "problem" in doc):
                structure_score += 0.35   # has table
            if "root cause" in doc or "root-cause" in doc:
                structure_score += 0.35   # has root cause section
            if ("step" in doc or "fix" in doc or "resolv" in doc) and len(doc) > 300:
                structure_score += 0.30   # has fix steps with substance
            scores["troubleshooting_doc_structured"] = min(structure_score, 1.0)
        except Exception:
            pass

    # 5. Fix addresses all three locations
    fix_signals = {
        "fix_auth": [r'auth-profiles', r'minimax:default', r'"key".*<', r'set.*key.*auth'],
        "fix_openclaw_json": [r'openclaw\.json', r'remove.*null', r'delete.*null',
                              r'null.*remov', r'"env".*section', r'env.*section'],
        "fix_env": [r'\.env', r'minimax_api_key=', r'set.*minimax_api_key', r'minimax.*key.*value'],
    }
    locations_fixed = 0
    for loc, patterns in fix_signals.items():
        if any(re.search(p, lower_text) for p in patterns):
            locations_fixed += 1

    if locations_fixed >= 3:
        scores["fix_all_locations_addressed"] = 1.0
    elif locations_fixed == 2:
        scores["fix_all_locations_addressed"] = 0.6
    elif locations_fixed == 1:
        scores["fix_all_locations_addressed"] = 0.3

    return scores
```

## LLM Judge Rubric

### Multi-Layer Root Cause Analysis (Weight: 35%)
Evaluates whether the agent identifies all three compounding issues and explains their interaction.

- **1.0**: Correctly identifies all three issues: (1) `minimax:default` in auth-profiles.json has `"key": ""` (empty, not absent — errorCount 47 confirms repeated failures); (2) `openclaw.json`'s `"env"` section has `"MINIMAX_API_KEY": null` which explicitly overrides and nullifies any `.env` value; (3) `.env` has `MINIMAX_API_KEY=` with no value. Clearly explains that Issue 2 is why the user's `.env` fix had no effect.
- **0.75**: Identifies Issue 2 (null override) and at least one other issue; explains why `.env` fix didn't work.
- **0.5**: Identifies Issue 1 (empty key) and Issue 3 (.env), but misses the null override — cannot explain why `.env` fix failed.
- **0.25**: Identifies only one issue, or incorrectly diagnoses the problem (e.g., says "minimax is absent" without noting the empty key entry).
- **0.0**: Incorrect or hallucinated diagnosis, or ignores workspace files.

### Fix Completeness and Accuracy (Weight: 30%)
Evaluates whether fix instructions address all three locations.

- **1.0**: Provides correct, actionable fixes for all three: (1) Set a real API key value in `minimax:default.key` in auth-profiles.json; (2) Remove or fix the `"MINIMAX_API_KEY": null` line in openclaw.json's `"env"` section; (3) Set `MINIMAX_API_KEY=<actual-key>` in `.env`. Optionally includes switching to alibaba-cloud fallback.
- **0.75**: Provides correct fixes for two of the three locations.
- **0.5**: Provides fix for auth-profiles.json only, or general guidance without covering all three locations.
- **0.25**: Mentions fixes but instructions are too vague or incomplete to act on.
- **0.0**: No fix instructions, or instructions are incorrect/misleading.

### Evidence and Workspace Grounding (Weight: 20%)
Evaluates whether the diagnosis is grounded in actual workspace file contents.

- **1.0**: Directly quotes or references specific details from all three files: `"key": ""` and errorCount 47 from auth-profiles.json; `"MINIMAX_API_KEY": null` from openclaw.json's env section; `MINIMAX_API_KEY=` (empty) from .env. No hallucinated content.
- **0.75**: References specific content from two of the three files with accurate quotes.
- **0.5**: Mentions file names but doesn't demonstrate reading actual content — diagnosis could apply generically.
- **0.25**: Generic response that doesn't reference specific file contents.
- **0.0**: Ignores workspace files, hallucinates file contents, or provides a response disconnected from actual configuration.

### TROUBLESHOOTING.md Quality (Weight: 15%)
Evaluates the created documentation file.

- **1.0**: Well-structured TROUBLESHOOTING.md with: (a) an issue summary table listing all three issues with file and severity; (b) root cause analysis explaining the three-layer failure; (c) numbered step-by-step resolution covering all three fix locations; (d) optional fallback model suggestion.
- **0.75**: TROUBLESHOOTING.md with table and resolution steps, but missing root cause section or only covers two issues.
- **0.5**: TROUBLESHOOTING.md exists with some content but structure is minimal (no table or no root cause).
- **0.25**: A documentation file exists but is trivial or doesn't address the actual three issues.
- **0.0**: No documentation file created.
