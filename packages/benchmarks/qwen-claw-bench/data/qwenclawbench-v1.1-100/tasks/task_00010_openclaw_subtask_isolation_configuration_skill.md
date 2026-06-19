---
id: task_00010_openclaw_subtask_isolation_configuration_skill
name: OpenClaw Subtask Isolation Configuration Skill
category: Knowledge and Memory Management
subcategory: Memory and Context Management
grading_type: hybrid
grading_weights:
  automated: 0.4
  llm_judge: 0.6
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: .openclaw/openclaw.json
  dest: .openclaw/openclaw.json
- source: .openclaw/openclaw.backup.20250114.json
  dest: .openclaw/openclaw.backup.20250114.json
- source: docs/config.md
  dest: docs/config.md
---

## Prompt

I've been running into problems with subagents spinning out of control — too many running at once, some hanging indefinitely, and I'm also worried about subagents making gateway calls or setting up cron jobs on their own.

I want to tighten up the subagent config in `.openclaw/openclaw.json`. Based on the schema docs at `docs/config.md`, please make the following changes:

1. Cap concurrent subagents at 2 (I've been hitting resource limits)
2. Prevent nesting deeper than 1 level
3. Auto-terminate any subagent that runs longer than 5 minutes
4. Deny subagents from using the `gateway` and `cron` tools

Keep everything else exactly as is — the model config, heartbeat, compaction, sandbox, channels, and the agent list.

Also create a SKILL.md that documents this whole process: what the subagent config fields do, where they live in the schema, and how someone would adjust the limits for a different use case.

## Expected Behavior

1. Agent reads `docs/config.md` and finds the actual `agents.defaults.subagents` schema fields: `maxConcurrent`, `maxSpawnDepth`, `maxChildrenPerAgent`, `runTimeoutSeconds`, `archiveAfterMinutes`. Agent also finds the `tools.subagents` policy section.

2. Agent reads `.openclaw/openclaw.json`. The file uses JSON5 format (contains `//` line comments) — the agent must read it carefully and not corrupt the comment lines or existing structure.

3. Agent adds `agents.defaults.subagents` with the following values:
   - `maxConcurrent: 2`
   - `maxSpawnDepth: 1`
   - `runTimeoutSeconds: 300`
   
   **No other fields should be added under `agents.defaults.subagents`** — only these three are required. Do not add fields like `maxChildrenPerAgent`, `archiveAfterMinutes`, `isolation`, `inherit_context`, or any field not explicitly listed here.

4. Agent adds `tools.subagents.tools.deny: ["gateway", "cron"]` (under the existing `tools` top-level key).

5. All existing configuration is fully preserved:
   - `agents.defaults`: `workspace`, `model` (primary + fallbacks), `models`, `imageModel`, `userTimezone`, `timeFormat`, `maxConcurrent` (3, the global default — not the same as subagents.maxConcurrent), `contextTokens`, `timeoutSeconds`, `heartbeat`, `compaction`, `sandbox`
   - `agents.list`: both the "main" agent (with all tools, identity) and the "research" agent (with tool allow/deny)
   - `channels.defaults` (including `heartbeat` indicators)
   - `tools.exec.shell`
   - `gateway` (port 18789, bind loopback)

6. The output file must remain parseable as JSON5 (valid JSON after stripping `//` comments).

7. SKILL.md is created with YAML frontmatter (name, description) and sections that accurately reference the real schema fields (`maxConcurrent`, `maxSpawnDepth`, `runTimeoutSeconds`, `tools.subagents.tools.deny`), explain what each controls, and give guidance for choosing different values.

**Key traps agents may fall into:**
- Writing nonexistent fields like `isolation: true`, `inherit_context: false`, or `observable: true` under `agents.defaults.subagents` — these do not appear in `docs/config.md` and would fail schema validation.
- Confusing `agents.defaults.maxConcurrent` (already set to 3, controls global concurrent agents) with `agents.defaults.subagents.maxConcurrent` (the new field, controls concurrent sub-agents). Only the subagents version should be added; the existing global one must not be removed or altered.
- Stripping `//` comments from the config file when rewriting it, causing cosmetic differences — not a hard failure but undesirable.
- Accidentally reverting to the backup file's simpler structure (losing the research agent, channels heartbeat config, and tools settings added since the backup).
- Adding `tools.subagents.tools.deny` at the wrong path (e.g., inside `agents.defaults.subagents` rather than under the top-level `tools` key).

## Grading Criteria

- [ ] `agents.defaults.subagents.maxConcurrent` set to 2 in `.openclaw/openclaw.json`
- [ ] `agents.defaults.subagents.maxSpawnDepth` set to 1
- [ ] `agents.defaults.subagents.runTimeoutSeconds` set to 300
- [ ] `tools.subagents.tools.deny` contains "gateway" and "cron"
- [ ] No fake fields (`isolation`, `inherit_context`, `observable`) added to subagents section
- [ ] All existing config preserved: `agents.defaults.maxConcurrent` still 3, research agent still present, channels.defaults.heartbeat still present
- [ ] SKILL.md has YAML frontmatter and references real schema fields

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    import json
    import re

    scores = {
        "subagents_limits_correct": 0.0,
        "tool_deny_policy_correct": 0.0,
        "existing_config_preserved": 0.0,
        "no_fake_fields": 0.0,
        "skill_md_references_real_fields": 0.0,
    }

    config_path = os.path.join(workspace_path, ".openclaw", "openclaw.json")
    if not os.path.exists(config_path):
        return scores

    # Parse JSON5 by stripping // line comments
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            raw = f.read()
        cleaned = re.sub(r'//[^\n]*', '', raw)
        config = json.loads(cleaned)
    except Exception:
        return scores  # unparseable — all config scores stay 0

    # 1. Check agents.defaults.subagents limits
    subagents = config.get("agents", {}).get("defaults", {}).get("subagents", {})
    limit_score = 0.0
    if subagents.get("maxConcurrent") == 2:
        limit_score += 1/3
    if subagents.get("maxSpawnDepth") == 1:
        limit_score += 1/3
    if subagents.get("runTimeoutSeconds") == 300:
        limit_score += 1/3
    scores["subagents_limits_correct"] = round(min(1.0, limit_score), 2)

    # 2. Check tools.subagents.tools.deny contains gateway and cron
    deny_list = (
        config.get("tools", {})
              .get("subagents", {})
              .get("tools", {})
              .get("deny", [])
    )
    has_gateway = "gateway" in deny_list
    has_cron = "cron" in deny_list
    if has_gateway and has_cron:
        scores["tool_deny_policy_correct"] = 1.0
    elif has_gateway or has_cron:
        scores["tool_deny_policy_correct"] = 0.5

    # 3. Check existing config preserved — more exhaustive checks
    preserved = 0.0
    defaults = config.get("agents", {}).get("defaults", {})
    # Global maxConcurrent must still be 3
    if defaults.get("maxConcurrent") == 3:
        preserved += 0.15
    # Heartbeat config preserved
    if defaults.get("heartbeat", {}).get("every") == "30m":
        preserved += 0.15
    # Compaction preserved
    if defaults.get("compaction", {}).get("enabled") is True:
        preserved += 0.10
    # Research agent still in agents.list
    agent_ids = [a.get("id") for a in config.get("agents", {}).get("list", [])]
    if "research" in agent_ids:
        preserved += 0.15
    # Main agent still in agents.list
    if "main" in agent_ids or any("main" in str(a.get("id", "")) for a in config.get("agents", {}).get("list", [])):
        preserved += 0.10
    # channels.defaults.heartbeat preserved
    if config.get("channels", {}).get("defaults", {}).get("heartbeat"):
        preserved += 0.15
    # tools.exec.shell preserved
    if config.get("tools", {}).get("exec", {}).get("shell"):
        preserved += 0.10
    # gateway preserved
    if config.get("gateway"):
        preserved += 0.10
    scores["existing_config_preserved"] = round(min(1.0, preserved), 2)

    # 4. Check no fake fields in subagents section
    fake_fields = {"isolation", "inherit_context", "observable"}
    has_fake = any(f in subagents for f in fake_fields)
    scores["no_fake_fields"] = 0.0 if has_fake else 1.0

    # 5. Check SKILL.md references real schema fields
    skill_path = os.path.join(workspace_path, "SKILL.md")
    if os.path.exists(skill_path):
        try:
            skill = open(skill_path, encoding="utf-8").read()
            skill_lower = skill.lower()
            real_fields = ["maxconcurrent", "maxspawndepth", "runtimeoutseconds", "subagents"]
            has_frontmatter = skill.strip().startswith("---")
            has_name = "name:" in skill[:500]
            field_hits = sum(1 for f in real_fields if f in skill_lower)
            if has_frontmatter and has_name and field_hits >= 3:
                scores["skill_md_references_real_fields"] = 1.0
            elif has_frontmatter and has_name and field_hits >= 1:
                scores["skill_md_references_real_fields"] = 0.5
            elif has_frontmatter and has_name:
                scores["skill_md_references_real_fields"] = 0.25
        except Exception:
            pass

    return scores
```

## LLM Judge Rubric

### Schema Compliance (Weight: 30%)
- 1.0: All added fields use real schema names from `docs/config.md`: `maxConcurrent`, `maxSpawnDepth`, `runTimeoutSeconds` under `agents.defaults.subagents`, and `deny` list under `tools.subagents.tools`. No nonexistent fields (`isolation`, `inherit_context`, `observable`) are present. Agent explicitly references `docs/config.md` when selecting field names.
- 0.75: Real fields are used for the primary requirements, but one minor nonexistent field is also added alongside them.
- 0.5: A mix of real and fake fields — e.g., the agent sets both `maxConcurrent: 2` (real) and `isolation: true` (fake), showing partial schema awareness.
- 0.25: Agent uses only nonexistent fields (`isolation`, `inherit_context`, `observable`) without referencing the actual schema, suggesting it relied on generic knowledge rather than reading `docs/config.md`.
- 0.0: Agent does not modify the subagents config at all, or completely ignores `docs/config.md`.

### Configuration Correctness (Weight: 25%)
- 1.0: All four requirements are implemented with correct field paths and values: `agents.defaults.subagents.maxConcurrent: 2`, `agents.defaults.subagents.maxSpawnDepth: 1`, `agents.defaults.subagents.runTimeoutSeconds: 300`, and `tools.subagents.tools.deny: ["gateway", "cron"]`. Values match the user's intent (5 minutes = 300 seconds).
- 0.75: Three of the four requirements are correctly implemented.
- 0.5: Two requirements implemented correctly, or all four present but one value is wrong (e.g., `runTimeoutSeconds: 600` instead of 300).
- 0.25: One requirement correctly implemented, or multiple requirements present but at wrong paths (e.g., deny list placed under `agents.defaults.subagents` instead of `tools.subagents.tools`).
- 0.0: No correct requirement implemented, or the config file is corrupted.

### Existing Config Preservation (Weight: 25%)
- 1.0: All original fields fully preserved: `agents.defaults.maxConcurrent: 3` (distinct from the new subagents limit), `heartbeat`, `compaction`, `sandbox`, both agent entries (main with full tools list, research with allow/deny), `channels.defaults.heartbeat`, `tools.exec.shell`, and `gateway`. The JSON5 comments are ideally preserved but their absence is not penalized.
- 0.75: Nearly all fields preserved; one non-critical field is missing or slightly altered.
- 0.5: Most fields preserved, but a notable section is lost (e.g., the research agent entry, or the channels heartbeat config).
- 0.25: Agent reverted to the backup file structure (losing research agent, channels heartbeat, tools config), or significant config sections are missing.
- 0.0: Config file is overwritten with a simplified/unrelated structure, or original content is destroyed.

### SKILL.md Documentation Quality (Weight: 20%)
- 1.0: SKILL.md has complete YAML frontmatter (name, description), accurately documents the real schema fields (`maxConcurrent`, `maxSpawnDepth`, `runTimeoutSeconds`, `tools.subagents.tools.deny`) with their types and meanings, explains the path structure (`agents.defaults.subagents`), and provides practical guidance for adjusting values.
- 0.75: SKILL.md covers most real fields correctly but omits one section or uses one incorrect field name.
- 0.5: SKILL.md exists with frontmatter but documents only generic concepts without referencing the actual field names from `docs/config.md`.
- 0.25: SKILL.md is a stub — minimal content, no frontmatter, or content that contradicts the actual schema (e.g., instructs the user to set `isolation: true`).
- 0.0: SKILL.md is missing or empty.
