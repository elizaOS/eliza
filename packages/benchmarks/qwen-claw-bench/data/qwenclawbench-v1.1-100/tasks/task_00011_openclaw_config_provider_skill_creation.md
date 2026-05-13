---
id: task_00011_openclaw_config_provider_skill_creation
name: OpenClaw Config Provider Skill Creation
category: System Operations and Administration
subcategory: Software and Environment Management
grading_type: hybrid
grading_weights:
  automated: 0.4
  llm_judge: 0.6
verification_method: rubric
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: .openclaw/openclaw.json
  dest: .openclaw/openclaw.json
---

## Prompt

I need to set up a reusable skill for configuring OpenClaw model providers. Can you create a SKILL.md in the workspace that walks through how to add a new LLM provider to an OpenClaw config — covering provider definition, model entries, and agent defaults? Something like a docker-skill or cli-deadline-monitor skill but for OpenClaw provider setup.

Once the skill is ready, go ahead and use it. There's already an empty config at `.openclaw/openclaw.json`. Update it to add a provider called "bailian" with baseUrl `https://coding.dashscope.aliyuncs.com/v1`, api set to "openai-completions", and an apiKey field. Then add these models under it: qwen3-max-2026-01-23, qwen3.5-plus, qwen3-coder-next, qwen3-coder-plus, glm-4.7, kimi-k2.5 — each one should have contextWindow, maxTokens, and reasoning set to reasonable values. Also wire up agents.defaults.model.primary to "bailian/qwen3.5-plus" and make sure agents.defaults.models lists all six bailian/* models.

After that, verify the JSON is valid and walk me through how I'd confirm the config is actually being picked up by OpenClaw.

## Expected Behavior

The agent should:

1. **Create a SKILL.md file** in the workspace (at the workspace root or under a `skills/` subdirectory following platform conventions) describing a reusable skill for configuring OpenClaw model providers. The file should have YAML frontmatter with `name` and `description` fields, and contain markdown sections with clear instructions on how to add providers, define models, and configure agent defaults in an OpenClaw config. The skill should be generic enough to apply to any provider, not just the "bailian" example.

2. **Read the existing config** at `.openclaw/openclaw.json` (which starts as an empty JSON object `{}`) and build a complete config structure on top of it.

3. **Write a valid JSON config** to `.openclaw/openclaw.json` containing:
   - A `models.providers` section with a "bailian" provider entry: `baseUrl: "https://coding.dashscope.aliyuncs.com/v1"`, `api: "openai-completions"`, and an `apiKey` field (any placeholder value is acceptable, e.g. `"YOUR_API_KEY"`).
   - Model definitions for all six specified models (qwen3-max-2026-01-23, qwen3.5-plus, qwen3-coder-next, qwen3-coder-plus, glm-4.7, kimi-k2.5), each with `contextWindow`, `maxTokens`, and `reasoning` fields set to plausible values.
   - An `agents.defaults` section with `model.primary` set to `"bailian/qwen3.5-plus"` and a `models` array or object referencing all six `bailian/*` models.

4. **Validate** the resulting JSON file is syntactically correct (e.g., using `python -m json.tool`, `jq .`, or reading the file back and parsing it).

5. **Explain** how to verify the config is applied — for example, running OpenClaw and checking which model is selected, using `jq` to inspect specific fields, or checking startup logs.

### Common Pitfalls

- The agent should correctly handle the pre-existing `.openclaw/openclaw.json` that starts as `{}`, building the full nested structure from scratch rather than attempting to patch a non-existent complex object.
- The agent should register all six models both in the provider's model definitions and in the `agents.defaults.models` section — these are two distinct locations in the config.
- The agent should produce syntactically valid JSON (no comments, no trailing commas) to ensure the config parses correctly.
- The agent should create the SKILL.md first, then apply the skill's instructions to complete the config task, demonstrating the skill's practical utility.

## Grading Criteria

- [ ] SKILL.md exists in the workspace (at workspace root or under a `skills/` subdirectory) with YAML frontmatter (name and description) and instructional sections
- [ ] .openclaw/openclaw.json is valid JSON after modification
- [ ] Config contains a "bailian" provider with correct baseUrl and api fields
- [ ] All six models (qwen3-max-2026-01-23, qwen3.5-plus, qwen3-coder-next, qwen3-coder-plus, glm-4.7, kimi-k2.5) are defined
- [ ] agents.defaults.model.primary is set to "bailian/qwen3.5-plus"
- [ ] agents.defaults.models contains references for all six bailian/* models
- [ ] Agent provides a clear explanation of how to verify the config is applied

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import json
    import os
    import re
    from pathlib import Path

    scores = {
        "skill_md_exists": 0.0,
        "config_valid_json": 0.0,
        "bailian_provider_configured": 0.0,
        "all_six_models_defined": 0.0,
        "primary_model_set": 0.0,
        "defaults_models_populated": 0.0,
        "verification_explained": 0.0,
    }

    # 1. SKILL.md – search workspace root first, then skills/*/, then any direct subdir
    skill_path = None
    _root = Path(workspace_path) / "SKILL.md"
    if _root.exists():
        skill_path = _root
    else:
        _matches = sorted(Path(workspace_path).glob("skills/*/SKILL.md"))
        if _matches:
            skill_path = _matches[0]
        else:
            for _sub in Path(workspace_path).iterdir():
                if _sub.is_dir():
                    _cand = _sub / "SKILL.md"
                    if _cand.exists():
                        skill_path = _cand
                        break

    if skill_path is not None:
        content = skill_path.read_text(encoding="utf-8", errors="replace")
        has_fm = content.strip().startswith("---")
        has_name = bool(re.search(r"^name\s*:", content, re.MULTILINE))
        has_desc = bool(re.search(r"^description\s*:", content, re.MULTILINE))
        has_sections = len(re.findall(r"^#{1,3}\s+", content, re.MULTILINE)) >= 2
        if has_fm and has_name and has_desc and has_sections:
            scores["skill_md_exists"] = 1.0
        elif has_fm and (has_name or has_desc):
            scores["skill_md_exists"] = 0.5
        elif skill_path.stat().st_size > 50:
            scores["skill_md_exists"] = 0.25

    # 2. Config file – prefer workspace, fall back to home dir
    ws = Path(workspace_path)
    config_path = ws / ".openclaw" / "openclaw.json"
    home_config = Path(os.path.expanduser("~")) / ".openclaw" / "openclaw.json"
    cfg = None
    for cp in [config_path, home_config]:
        if cp.exists():
            try:
                raw = cp.read_text(encoding="utf-8", errors="replace").strip()
                parsed = json.loads(raw)
                if parsed:
                    scores["config_valid_json"] = 1.0
                    cfg = parsed
                    break
            except (json.JSONDecodeError, Exception):
                pass

    if cfg is None:
        return scores

    # 3. Bailian provider
    providers = None
    if isinstance(cfg.get("models"), dict):
        providers = cfg["models"].get("providers", {})
    if not providers and isinstance(cfg.get("providers"), dict):
        providers = cfg["providers"]

    if providers and "bailian" in providers:
        b = providers["bailian"]
        url_ok = str(b.get("baseUrl", "")).strip() == "https://coding.dashscope.aliyuncs.com/v1"
        api_ok = str(b.get("api", "")).strip() == "openai-completions"
        key_ok = "apiKey" in b
        if url_ok and api_ok and key_ok:
            scores["bailian_provider_configured"] = 1.0
        elif url_ok and api_ok:
            scores["bailian_provider_configured"] = 0.75
        elif url_ok or api_ok:
            scores["bailian_provider_configured"] = 0.5

    # 4. Six models
    required = [
        "qwen3-max-2026-01-23", "qwen3.5-plus", "qwen3-coder-next",
        "qwen3-coder-plus", "glm-4.7", "kimi-k2.5",
    ]
    cfg_lower = json.dumps(cfg).lower()
    found = sum(1 for m in required if m.lower() in cfg_lower)
    scores["all_six_models_defined"] = found / len(required)

    # 5. Primary model
    primary = str(
        cfg.get("agents", {}).get("defaults", {}).get("model", {}).get("primary", "")
    ).strip()
    if primary == "bailian/qwen3.5-plus":
        scores["primary_model_set"] = 1.0
    elif "qwen3.5-plus" in primary.lower():
        scores["primary_model_set"] = 0.5

    # 6. defaults.models
    dm = cfg.get("agents", {}).get("defaults", {}).get("models", [])
    if isinstance(dm, list):
        hits = [x for x in dm if "bailian" in str(x).lower()]
    elif isinstance(dm, dict):
        hits = [k for k in dm if "bailian" in str(k).lower()
                or "bailian" in str(dm[k]).lower()]
    else:
        hits = []
    if len(hits) >= 6:
        scores["defaults_models_populated"] = 1.0
    elif len(hits) >= 3:
        scores["defaults_models_populated"] = 0.5
    elif len(hits) >= 1:
        scores["defaults_models_populated"] = 0.25

    # 7. Verification explanation in transcript
    def _extract_content(c):
        if isinstance(c, list):
            return " ".join(
                b.get("text", "") for b in c
                if isinstance(b, dict) and b.get("type") == "text"
            )
        return str(c) if c else ""

    t_text = " ".join(
        _extract_content(m.get("content", "")) if isinstance(m, dict) else str(m)
        for m in transcript
    ).lower()
    strong = [r"verif", r"confirm.*config", r"jq\b", r"json\.tool",
              r"check.*config.*appl", r"applied"]
    weak = [r"inspect", r"open.*config", r"cat.*openclaw"]
    if any(re.search(p, t_text) for p in strong):
        scores["verification_explained"] = 1.0
    elif any(re.search(p, t_text) for p in weak):
        scores["verification_explained"] = 0.5

    return scores
```

## LLM Judge Rubric

**Fallback rule**: If the main output files (SKILL.md and .openclaw/openclaw.json) do not exist, all dimensions below should be scored 0.

### SKILL.md Quality and Reusability (Weight: 25%)
- 1.0: SKILL.md has proper YAML frontmatter (name, description), multiple well-organized sections covering provider setup, model definition, and agent defaults configuration. Instructions are clear, generic, and reusable for any provider.
- 0.75: SKILL.md exists with frontmatter and reasonable instructions but missing some detail or generality.
- 0.5: SKILL.md exists but is minimal, lacks frontmatter, or is too specific to the bailian example to be reusable.
- 0.25: SKILL.md exists but is essentially empty or just a placeholder.
- 0.0: No SKILL.md created, or file does not exist.

### Config File Correctness (Weight: 30%)
- 1.0: .openclaw/openclaw.json is valid JSON with bailian provider correctly configured (baseUrl, api, apiKey), all six models defined with contextWindow/maxTokens/reasoning fields, and agents.defaults properly set with primary model and models list.
- 0.75: Config is valid and mostly correct but missing one or two minor fields (e.g., reasoning on some models, or apiKey absent).
- 0.5: Config is valid JSON with the provider and some models but significant omissions in structure.
- 0.25: Config exists but has major structural issues or is missing most required elements.
- 0.0: Config not created, still an empty `{}`, or invalid JSON.

### Verification Explanation (Weight: 20%)
- 1.0: Agent provides clear, actionable steps to verify the config is applied (e.g., using jq to inspect fields, running OpenClaw to check model selection, checking startup logs).
- 0.75: Agent provides a reasonable verification approach but missing some detail.
- 0.5: Agent mentions verification briefly but without actionable steps.
- 0.25: Agent vaguely references verification.
- 0.0: No verification explanation provided.

### Skill-Then-Apply Workflow (Weight: 25%)
- 1.0: Agent clearly creates the skill first, then explicitly references or follows the skill's instructions to complete the config task, demonstrating the skill's utility.
- 0.75: Agent creates the skill and completes the task, with some connection between the two.
- 0.5: Agent creates both artifacts but the skill and task completion seem disconnected.
- 0.25: Agent completes the task but the skill is an afterthought or barely related.
- 0.0: Agent does not follow a skill-creation-then-application workflow.
