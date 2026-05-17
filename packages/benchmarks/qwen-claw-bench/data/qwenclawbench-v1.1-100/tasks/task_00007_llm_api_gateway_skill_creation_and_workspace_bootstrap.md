---
id: task_00007_llm_api_gateway_skill_creation_and_workspace_bootstrap
name: LLM API Gateway Skill Creation and Workspace Bootstrap
category: System Operations and Administration
subcategory: Software and Environment Management
grading_type: hybrid
grading_weights:
  automated: 0.4
  llm_judge: 0.6
timeout_seconds: 1800
input_modality: text-only
external_dependency: requires_mock
workspace_files:
- source: .env
  dest: .env
- source: .openclaw/config.yaml
  dest: .openclaw/config.yaml
- source: .openclaw/gateway.log
  dest: .openclaw/gateway.log
- source: README.md
  dest: README.md
- source: models.json
  dest: models.json
- source: scripts/setup_provider.sh
  dest: scripts/setup_provider.sh
- source: scripts/test_gpt4o.py
  dest: scripts/test_gpt4o.py
- source: skills/sample-skill/SKILL.md
  dest: skills/sample-skill/SKILL.md
- source: skills/sample-skill/scripts/call_api.sh
  dest: skills/sample-skill/scripts/call_api.sh
- source: skills/searxng/SKILL.md
  dest: skills/searxng/SKILL.md
---

## Prompt

I need two things done on this workspace.

**1. Create an LLM API Gateway skill.** The workspace already has `skills/sample-skill/` and `skills/searxng/` as examples of the skill format. Following the same convention, create the new skill at `workspace/skills/llm-api-gateway/SKILL.md`. The skill should describe how to route prompts to an external GPT-4o endpoint — covering configuration, how to make requests, response handling, and when to use the external model versus handling things locally.

**2. Configure and activate the external provider, then bootstrap the workspace.** The GPT-4o endpoint details are:
- API URL: `https://api.zecoba.com`
- API Key: `sk-PLACEHOLDER_KEY_DO_NOT_USE` (use this placeholder value; do not attempt live API calls)

Look at the existing workspace files: `.env` has commented entries for external providers, `.openclaw/config.yaml` has a commented-out `agent.providers` section, and `models.json` shows the OpenAI provider as `"not_configured"`. You need to configure all three consistently for the new provider. Check `README.md` for how provider setup works. Note: since this is an isolated environment, `scripts/test_gpt4o.py` cannot reach the external endpoint — document what the expected output would be if run in a live environment instead of executing it.

After that, bootstrap the workspace fully:
- Initialize a git repo
- Create: `IDENTITY.md`, `AGENTS.md`, `TOOLS.md`, `USER.md`, `SOUL.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`
- Create `.openclaw/workspace-state.json`

## Expected Behavior

The agent should:

1. **Create the skill at the correct path** — `workspace/skills/llm-api-gateway/SKILL.md`, following the workspace convention of `skills/<name>/SKILL.md`. NOT at the workspace root. The skill should have YAML frontmatter with `name` and `description` fields, and cover: API config (URL + key), request format (OpenAI-compatible chat completions), response parsing, error handling, rate limits, and decision logic for when to use external LLM vs. local model.

2. **Configure `.env`** — Uncomment and fill in the OpenAI provider entries:
   - `OPENAI_API_KEY=sk-PLACEHOLDER_KEY_DO_NOT_USE`
   - `OPENAI_BASE_URL=https://api.zecoba.com/v1`
   
   **Trap**: `.env` already has `# OPENAI_BASE_URL=https://api.openai.com` commented out — the agent must NOT use the default `api.openai.com` URL; the correct base URL is `api.zecoba.com`.

3. **Update `.openclaw/config.yaml`** — Uncomment the `agent.providers` section and fill in the zecoba endpoint:
   ```yaml
   providers:
     - name: openai
       baseUrl: https://api.zecoba.com/v1
       apiKey: sk-PLACEHOLDER_KEY_DO_NOT_USE
       models:
         - gpt-4o
         - gpt-4o-mini
   ```
   The three files (.env, config.yaml, models.json) must all reference `api.zecoba.com`, not `api.openai.com`.

4. **Update `models.json`** — Change the `openai` provider `"status"` from `"not_configured"` to `"active"` and add a `"baseUrl": "https://api.zecoba.com/v1"` field. Do NOT hardcode the API key in models.json (it belongs in `.env` and `config.yaml`).

5. **Document expected connectivity test result** — Since the environment is isolated and `scripts/test_gpt4o.py` cannot reach the external endpoint, describe what the expected output would be if run in a live environment (e.g., expected HTTP 200 with model list, or a sample chat completion response). Do NOT attempt to execute the test against a live API.

6. **Bootstrap the workspace**: `git init`, create 7 core docs with meaningful content, create `.openclaw/workspace-state.json`.

7. **Traps and common failures**:
   - Creating skill at workspace root (`SKILL.md`) instead of `workspace/skills/llm-api-gateway/SKILL.md`
   - Using `https://api.openai.com` (from the commented .env line) instead of `https://api.zecoba.com`
   - Updating only `.env` but not `config.yaml` or `models.json` — all three must be consistent
   - Storing the API key in `models.json` (it should only be in `.env` and `config.yaml`)
   - Not running `test_gpt4o.py` to verify the configuration
   - Attempting to make a live network call to the external API (the environment is isolated — document expected behavior instead)

## Grading Criteria

- [ ] Skill file at `workspace/skills/llm-api-gateway/SKILL.md` with valid YAML frontmatter (`name` and `description`)
- [ ] `.env` updated with `OPENAI_API_KEY` and `OPENAI_BASE_URL` pointing to `api.zecoba.com` (not `api.openai.com`)
- [ ] `.openclaw/config.yaml` providers section configured with `api.zecoba.com/v1` base URL
- [ ] `models.json` openai provider status changed from `not_configured` to `active`; all three config files consistent on `api.zecoba.com`
- [ ] Git repository initialized (`.git/HEAD` exists)
- [ ] All 7 core docs exist with non-trivial content; `.openclaw/workspace-state.json` exists as valid JSON
- [ ] Agent documents the expected test_gpt4o.py outcome instead of attempting a live network call

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import json
    import re
    from pathlib import Path

    ws = Path(workspace_path)
    scores = {
        "skill_correct_path_and_quality": 0.0,
        "env_configured_zecoba": 0.0,
        "config_yaml_updated": 0.0,
        "models_json_updated": 0.0,
        "git_and_workspace_state": 0.0,
        "core_docs_complete": 0.0,
    }

    # 1. Skill at correct path (skills/llm-api-gateway/SKILL.md)
    skill_preferred = ws / "skills" / "llm-api-gateway" / "SKILL.md"
    skill_root = ws / "SKILL.md"
    found_skill = None
    if skill_preferred.exists():
        scores["skill_correct_path_and_quality"] = 0.5  # start at 0.5 for correct path
        found_skill = skill_preferred
    elif skill_root.exists():
        scores["skill_correct_path_and_quality"] = 0.2  # wrong path, partial credit
        found_skill = skill_root
    else:
        # check any skill in skills/ (excluding existing ones)
        for p in (ws / "skills").rglob("SKILL.md") if (ws / "skills").exists() else []:
            if p.parent.name not in ("sample-skill", "searxng"):
                scores["skill_correct_path_and_quality"] = 0.35
                found_skill = p
                break
    if found_skill and found_skill.exists():
        try:
            content = found_skill.read_text(encoding="utf-8")
            fm = re.match(r"^---\s*\n(.*?)\n---", content, re.DOTALL)
            has_name = bool(fm and re.search(r"(?m)^name\s*:", fm.group(1)))
            has_desc = bool(fm and re.search(r"(?m)^description\s*:", fm.group(1)))
            body = content[fm.end():] if fm else content
            kw_hits = sum(1 for kw in ["gpt-4o", "zecoba", "api_key", "api key", "request", "external", "route", "model"]
                          if kw.lower() in body.lower())
            sub = scores["skill_correct_path_and_quality"]
            if has_name and has_desc:
                sub += 0.3
            elif has_name or has_desc:
                sub += 0.15
            if kw_hits >= 4:
                sub += 0.2
            elif kw_hits >= 2:
                sub += 0.1
            scores["skill_correct_path_and_quality"] = min(sub, 1.0)
        except Exception:
            pass

    # 2. .env configured with correct zecoba URL (not api.openai.com)
    env_path = ws / ".env"
    if env_path.exists():
        try:
            env_text = env_path.read_text(encoding="utf-8")
            has_key = bool(re.search(r"(?m)^OPENAI_API_KEY\s*=\s*\S+", env_text))
            has_zecoba_url = bool(re.search(r"(?m)^OPENAI_BASE_URL\s*=.*zecoba", env_text))
            has_openai_url = bool(re.search(r"(?m)^OPENAI_BASE_URL\s*=.*api\.openai\.com", env_text))
            if has_key and has_zecoba_url and not has_openai_url:
                scores["env_configured_zecoba"] = 1.0
            elif has_key and has_zecoba_url:
                scores["env_configured_zecoba"] = 0.7
            elif has_key or has_zecoba_url:
                scores["env_configured_zecoba"] = 0.4
        except Exception:
            pass

    # 3. config.yaml providers section configured with zecoba
    config_path = ws / ".openclaw" / "config.yaml"
    if config_path.exists():
        try:
            cfg = config_path.read_text(encoding="utf-8")
            has_providers = "providers:" in cfg and not all(
                line.lstrip().startswith("#") for line in cfg.split("\n")
                if "providers:" in line
            )
            has_zecoba = "zecoba" in cfg
            has_api_key = bool(re.search(r"apiKey\s*:", cfg))
            if has_providers and has_zecoba and has_api_key:
                scores["config_yaml_updated"] = 1.0
            elif has_zecoba and has_api_key:
                scores["config_yaml_updated"] = 0.7
            elif has_zecoba or has_api_key:
                scores["config_yaml_updated"] = 0.4
        except Exception:
            pass

    # 4. models.json updated: openai status = active, baseUrl = zecoba
    models_path = ws / "models.json"
    if models_path.exists():
        try:
            data = json.loads(models_path.read_text(encoding="utf-8"))
            providers = data.get("providers", [])
            openai_provider = next((p for p in providers if p.get("name") == "openai"), None)
            if openai_provider:
                is_active = openai_provider.get("status") == "active"
                has_zecoba = "zecoba" in str(openai_provider.get("baseUrl", ""))
                if is_active and has_zecoba:
                    scores["models_json_updated"] = 1.0
                elif is_active:
                    scores["models_json_updated"] = 0.6
                elif has_zecoba:
                    scores["models_json_updated"] = 0.4
        except Exception:
            pass

    # 5. Git initialized and workspace-state.json
    git_head = ws / ".git" / "HEAD"
    state_path = ws / ".openclaw" / "workspace-state.json"
    git_ok = git_head.exists() and "ref:" in (git_head.read_text(encoding="utf-8") if git_head.exists() else "")
    state_ok = False
    if state_path.exists():
        try:
            state_ok = isinstance(json.loads(state_path.read_text(encoding="utf-8")), dict)
        except Exception:
            pass
    if git_ok and state_ok:
        scores["git_and_workspace_state"] = 1.0
    elif git_ok or state_ok:
        scores["git_and_workspace_state"] = 0.5

    # 6. Core docs completeness (7 required)
    core_docs = ["IDENTITY.md", "AGENTS.md", "TOOLS.md", "USER.md", "SOUL.md", "HEARTBEAT.md", "BOOTSTRAP.md"]
    present = 0
    with_content = 0
    for doc in core_docs:
        p = ws / doc
        if p.exists():
            present += 1
            try:
                if len(p.read_text(encoding="utf-8").strip()) > 50:
                    with_content += 1
            except Exception:
                pass
    if present == len(core_docs) and with_content == len(core_docs):
        scores["core_docs_complete"] = 1.0
    elif present >= 5 and with_content >= 5:
        scores["core_docs_complete"] = 0.8
    else:
        scores["core_docs_complete"] = present / len(core_docs) * 0.7

    return scores
```

## LLM Judge Rubric

### Skill File Quality and Placement (Weight: 25%)
- 1.0: Skill created at `workspace/skills/llm-api-gateway/SKILL.md` (following workspace convention), has complete YAML frontmatter (`name`, `description`), and structured sections covering API configuration, request format (OpenAI-compatible), response handling, error scenarios, and decision criteria for when to call the external LLM vs. handling locally. References `api.zecoba.com`.
- 0.75: Skill at correct path with frontmatter but missing one or two coverage areas (e.g., no error handling section or no decision criteria).
- 0.5: Skill exists but placed at workspace root instead of `workspace/skills/llm-api-gateway/SKILL.md`, OR placed correctly but content is thin.
- 0.25: Skill exists somewhere but is a stub or doesn't mention the endpoint.
- 0.0: No skill file created, or file contains only a heading with no content.

### Provider Configuration Consistency (Weight: 35%)
- 1.0: All three configuration files updated consistently with `api.zecoba.com`: (1) `.env` has `OPENAI_API_KEY` set and `OPENAI_BASE_URL=https://api.zecoba.com/v1` (NOT `api.openai.com`); (2) `.openclaw/config.yaml` providers section uncommented and filled with `baseUrl: https://api.zecoba.com/v1` and `apiKey`; (3) `models.json` openai status changed to `"active"` with a `baseUrl` pointing to `api.zecoba.com`. API key not stored in models.json.
- 0.75: Two of the three files correctly configured with `api.zecoba.com`; third file partially updated or missing.
- 0.5: Only one file configured, OR all files updated but using `api.openai.com` (wrong URL from the commented .env line).
- 0.25: Agent attempted configuration but values are inconsistent across files or the wrong API URL is used.
- 0.0: No configuration changes made to any of the three files.

### Workspace Bootstrap Completeness (Weight: 25%)
- 1.0: Git repo initialized, all 7 core docs created with meaningful content appropriate to their roles, and `.openclaw/workspace-state.json` present and valid JSON.
- 0.75: Six of seven docs present with content, git init done, state file present.
- 0.5: Most deliverables present but some docs are empty stubs or git init was skipped.
- 0.25: Only a few docs created; incomplete bootstrap.
- 0.0: No bootstrap artifacts created.

### Verification and Workspace Grounding (Weight: 15%)
- 1.0: Agent acknowledges the isolated environment and explains what `test_gpt4o.py` would return if run live (expected response format, headers, model list endpoint); all configured values match the prompt specification exactly; agent references `README.md` or existing workspace files to guide setup.
- 0.75: Agent references the test script and existing config files but skips documenting the expected output.
- 0.5: Agent acknowledges the test script exists but neither runs it nor describes the expected result.
- 0.25: Agent works primarily from scratch without using the existing workspace files as guides.
- 0.0: Agent ignores the workspace context entirely, or creates configurations that contradict the existing workspace structure.
