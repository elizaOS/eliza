---
id: task_00035_delete_installed_skill_directory_with_verification
name: Delete Installed Skill Directory with Verification
category: System Operations and Administration
subcategory: Storage and Data Management
grading_type: hybrid
grading_weights:
  automated: 0.7
  llm: 0.3
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- path: .openclaw/workspace/skills/tushare-finance/skill.json
  content: "{\n  \"name\": \"tushare-finance\",\n  \"version\": \"1.0.0\",\n  \"description\": \"A skill for fetching financial data via the Tushare API.\"\n}\n"
- path: .openclaw/workspace/skills/tushare-finance/main.py
  content: "# Tushare Finance Skill - Main Entry Point\ndef run():\n    print(\"Fetching financial data...\")\n"
- path: .openclaw/workspace/skills/tushare-finance/README.md
  content: '# Tushare Finance Skill

    This skill provides access to financial market data through the Tushare API.

    '
- path: .openclaw/workspace/skills/stock-alerts/skill.json
  content: "{\n  \"name\": \"stock-alerts\",\n  \"version\": \"1.2.0\",\n  \"description\": \"Monitor stocks and send threshold alerts.\"\n}\n"
- path: .openclaw/workspace/skills/stock-alerts/SKILL.md
  content: "---\nname: stock-alerts\ndescription: \"Set price alerts for stocks and receive notifications when thresholds are crossed. Use when: user wants to be notified about stock price movements. Requires a market data source (e.g. tushare, yahoo finance).\"\nmetadata:\n  openclaw:\n    emoji: \"\U0001F514\"\n    requires:\n      bins: [\"python3\"]\n---\n\n# Stock Alerts Skill\n\nMonitor stock prices and send alerts when thresholds are crossed.\n\n## When to Use\n\n✅ **USE this skill when:**\n\n- \"Alert me when AAPL drops below $150\"\n- \"Notify me if 000001.SZ goes above 15 CNY\"\n- \"Set a price alert for Tesla\"\n\n## Commands\n\n### Set Alert\n\n```bash\npython3 skills/stock-alerts/scripts/alert.py set --symbol AAPL --condition below --price 150.00\n```\n\n## Notes\n\n- Checks run on heartbeat intervals (not real-time)\n- Stores alerts in `data/stock-alerts.json`\n- Works with any market data skill (tushare, yahoo, etc.)\n"
- path: .openclaw/workspace/skills/portfolio-dashboard/skill.json
  content: "{\n  \"name\": \"portfolio-dashboard\",\n  \"version\": \"0.4.0\",\n  \"description\": \"Generate local portfolio snapshots.\"\n}\n"
- path: .openclaw/workspace/skills/portfolio-dashboard/SKILL.md
  content: "---\nname: portfolio-dashboard\ndescription: \"Build local portfolio summaries from CSV positions and optional market-data providers.\"\nmetadata:\n  openclaw:\n    emoji: \"\U0001F4CA\"\n---\n\n# Portfolio Dashboard Skill\n\nBuild portfolio summaries from local positions data.\n\n## Notes\n\n- Can consume static CSV input only\n- Optional integrations may be configured separately\n"
- path: .openclaw/workspace/config/skill-registry.json
  content: "{\n  \"installed_skills\": [\n    \"tushare-finance\",\n    \"stock-alerts\",\n    \"portfolio-dashboard\"\n  ],\n  \"default_market_data_skill\": \"tushare-finance\"\n}\n"
- path: .openclaw/workspace/config/skill-dependencies.json
  content: "{\n  \"stock-alerts\": {\n    \"requires_any\": [\"tushare-finance\", \"yahoo-finance\"],\n    \"requires_all\": []\n  },\n  \"portfolio-dashboard\": {\n    \"requires_any\": [],\n    \"requires_all\": []\n  },\n  \"tushare-finance\": {\n    \"requires_any\": [],\n    \"requires_all\": []\n  }\n}\n"
- path: .openclaw/workspace/config/user-preferences.json
  content: "{\n  \"preferred_quote_sources\": [\n    \"tushare-finance\",\n    \"manual-csv\"\n  ],\n  \"watchlist_currency\": \"CNY\"\n}"
---

## Prompt

I need you to clean up my OpenClaw workspace, but do it carefully rather than just deleting folders blindly.

Please create a reusable `SKILL.md` in the workspace root for safely uninstalling installed skills. You can use the provided example skills in the assets/workspace as style references. The skill document should be practical enough that someone could follow it later to decide whether a skill can be removed, how to remove it, and how to verify the result.

Then handle the currently installed `tushare-finance` skill. Before removing it, check whether anything in the workspace still depends on it or treats it as a default/preferred provider. If it is still referenced in a way that would leave the workspace inconsistent, clean up the relevant references as part of the uninstall. Do not break unrelated skills.

After that, remove the installed `tushare-finance` skill directory itself and verify the uninstall. In your final response, briefly summarize what you changed and what you verified.

## Expected Behavior

The agent should:

1. Create a `SKILL.md` file in the workspace root that documents a reusable uninstall procedure for OpenClaw skills.
   - It must include YAML frontmatter with at least `name` and `description`.
   - The markdown body should include clear sections covering:
     - when to use the skill,
     - a pre-removal dependency/reference audit,
     - uninstall/removal commands or steps,
     - verification steps,
     - notes/cautions.
   - The document should be consistent with the style of the provided skill examples and should describe safe removal rather than blind deletion.

2. Inspect the workspace configuration files and detect that `tushare-finance` is still actively referenced:
   - In `.openclaw/workspace/config/skill-registry.json`:
     - `installed_skills` contains `tushare-finance`
     - `default_market_data_skill` is `tushare-finance`
   - In `.openclaw/workspace/config/skill-dependencies.json`:
     - `stock-alerts.requires_any` includes `tushare-finance`
   - In `.openclaw/workspace/config/user-preferences.json`:
     - `preferred_quote_sources` includes `tushare-finance`

3. Safely uninstall `tushare-finance` by making the workspace internally consistent:
   - Remove `.openclaw/workspace/skills/tushare-finance/`
   - Update `.openclaw/workspace/config/skill-registry.json` so:
     - `tushare-finance` is removed from `installed_skills`
     - `default_market_data_skill` is no longer `tushare-finance`
   - Update `.openclaw/workspace/config/skill-dependencies.json` so:
     - `stock-alerts.requires_any` no longer contains `tushare-finance`
     - other unrelated entries remain intact
   - Update `.openclaw/workspace/config/user-preferences.json` so:
     - `preferred_quote_sources` no longer contains `tushare-finance`
   - The correct behavior is to preserve consistency without inventing unsupported replacements. In particular:
     - if no valid replacement is provided in the workspace, the agent should remove the stale reference rather than set a fake/new default
     - it should not delete unrelated skills such as `stock-alerts` or `portfolio-dashboard`

4. Verify the uninstall after changes:
   - Confirm the `tushare-finance` directory no longer exists
   - Confirm no remaining references to `tushare-finance` exist in the three config files above
   - Communicate the verification result in the final response

## Grading Criteria

### Automated
- [ ] `SKILL.md` exists in the workspace root
- [ ] `SKILL.md` has YAML frontmatter with `name` and `description`
- [ ] `SKILL.md` includes uninstall-oriented sections for audit/removal/verification
- [ ] `.openclaw/workspace/skills/tushare-finance` has been removed
- [ ] `.openclaw/workspace/config/skill-registry.json` is correctly updated without breaking unrelated entries
- [ ] `.openclaw/workspace/config/skill-dependencies.json` is correctly updated without breaking unrelated entries
- [ ] `.openclaw/workspace/config/user-preferences.json` is correctly updated without breaking unrelated entries
- [ ] Final assistant message reports both actions taken and verification outcome with specific mention of config cleanup and deletion verification

### LLM Judge
- [ ] `SKILL.md` is genuinely reusable and safety-oriented rather than a generic template
- [ ] The final response reflects sound decision-making about references/defaults/dependencies, especially avoiding unsupported replacement values
- [ ] The response shows evidence of verification rather than unsupported claims

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import json
    import re
    from pathlib import Path

    scores = {
        "skill_md_exists": 0.0,
        "skill_md_frontmatter": 0.0,
        "skill_md_structure": 0.0,
        "tushare_uninstalled": 0.0,
        "registry_updated_correctly": 0.0,
        "dependencies_updated_correctly": 0.0,
        "preferences_updated_correctly": 0.0,
        "final_report_quality": 0.0,
    }

    workspace = Path(workspace_path)

    # Ground-truth paths
    skill_md_path = workspace / "SKILL.md"
    tushare_dir = workspace / ".openclaw" / "workspace" / "skills" / "tushare-finance"
    registry_path = workspace / ".openclaw" / "workspace" / "config" / "skill-registry.json"
    deps_path = workspace / ".openclaw" / "workspace" / "config" / "skill-dependencies.json"
    prefs_path = workspace / ".openclaw" / "workspace" / "config" / "user-preferences.json"

    # 1) SKILL.md existence and content
    if skill_md_path.exists() and skill_md_path.is_file():
        scores["skill_md_exists"] = 1.0
        content = skill_md_path.read_text(encoding="utf-8", errors="replace")

        frontmatter_match = re.search(r"^---\s*\n(.*?)\n---\s*", content, re.DOTALL)
        if frontmatter_match:
            fm = frontmatter_match.group(1)
            has_name = bool(re.search(r"^\s*name\s*:\s*.+$", fm, re.MULTILINE))
            has_desc = bool(re.search(r'^\s*description\s*:\s*.+$', fm, re.MULTILINE))
            if has_name and has_desc:
                scores["skill_md_frontmatter"] = 1.0
            elif has_name or has_desc:
                scores["skill_md_frontmatter"] = 0.5

        body = re.sub(r"^---\s*\n.*?\n---\s*\n?", "", content, count=1, flags=re.DOTALL).lower()
        section_hits = 0
        for pattern in [
            r"##\s+when to use",
            r"(dependency|reference).*(audit|check)|pre-.*(audit|check)",
            r"##\s+(commands|steps|removal|uninstall)",
            r"##\s+verif",
            r"##\s+(notes|cautions|warnings)",
        ]:
            if re.search(pattern, body, re.DOTALL):
                section_hits += 1
        if section_hits >= 5:
            scores["skill_md_structure"] = 1.0
        elif section_hits >= 3:
            scores["skill_md_structure"] = 0.5

    # 2) Directory removed
    if not tushare_dir.exists():
        scores["tushare_uninstalled"] = 1.0

    # Helper for JSON loading
    def load_json(path: Path):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None

    # 3) Registry correctness
    registry = load_json(registry_path)
    if isinstance(registry, dict):
        ok = True
        installed = registry.get("installed_skills")
        if not isinstance(installed, list):
            ok = False
        else:
            if "tushare-finance" in installed:
                ok = False
            if sorted(installed) != sorted(["stock-alerts", "portfolio-dashboard"]):
                ok = False

        # Must not keep stale default or invent unsupported replacement
        if registry.get("default_market_data_skill", "__missing__") == "tushare-finance":
            ok = False

        if ok:
            scores["registry_updated_correctly"] = 1.0

    # 4) Dependency cleanup correctness
    deps = load_json(deps_path)
    if isinstance(deps, dict):
        ok = True
        expected_top_keys = {"stock-alerts", "portfolio-dashboard", "tushare-finance"}
        if set(deps.keys()) != expected_top_keys:
            ok = False
        else:
            stock_alerts = deps.get("stock-alerts")
            portfolio = deps.get("portfolio-dashboard")
            tushare = deps.get("tushare-finance")
            if not all(isinstance(x, dict) for x in [stock_alerts, portfolio, tushare]):
                ok = False
            else:
                sa_any = stock_alerts.get("requires_any")
                sa_all = stock_alerts.get("requires_all")
                if not isinstance(sa_any, list) or not isinstance(sa_all, list):
                    ok = False
                else:
                    if "tushare-finance" in sa_any:
                        ok = False
                    if sa_any != ["yahoo-finance"]:
                        ok = False
                    if sa_all != []:
                        ok = False

                if portfolio.get("requires_any") != [] or portfolio.get("requires_all") != []:
                    ok = False

                if tushare.get("requires_any") != [] or tushare.get("requires_all") != []:
                    ok = False
        if ok:
            scores["dependencies_updated_correctly"] = 1.0

    # 5) Preferences cleanup correctness
    prefs = load_json(prefs_path)
    if isinstance(prefs, dict):
        ok = True
        sources = prefs.get("preferred_quote_sources")
        if not isinstance(sources, list):
            ok = False
        else:
            if "tushare-finance" in sources:
                ok = False
            if sources != ["manual-csv"]:
                ok = False
        if prefs.get("watchlist_currency") != "CNY":
            ok = False
        if ok:
            scores["preferences_updated_correctly"] = 1.0

    # 6) Final assistant report quality: must mention both cleanup and verification
    assistant_messages = []
    for event in transcript:
        if event.get("type") != "message":
            continue
        msg = event.get("message", {})
        if msg.get("role") != "assistant":
            continue
        raw = msg.get("content", "")
        text = ""
        if isinstance(raw, str):
            text = raw
        elif isinstance(raw, list):
            for block in raw:
                if isinstance(block, dict) and block.get("type") == "text":
                    text += block.get("text", "") + " "
        assistant_messages.append(text.strip())

    if assistant_messages:
        final_text = assistant_messages[-1].lower()
        mentions_delete = ("tushare-finance" in final_text) and (
            "deleted" in final_text or "removed" in final_text or "uninstalled" in final_text
        )
        mentions_config = (
            "skill-registry" in final_text
            or "skill-dependencies" in final_text
            or "user-preferences" in final_text
            or "config" in final_text
            or "reference" in final_text
            or "dependency" in final_text
        )
        mentions_verify = (
            "verified" in final_text
            or "confirmed" in final_text
            or "no longer exists" in final_text
            or "no remaining reference" in final_text
            or "references removed" in final_text
        )
        if mentions_delete and mentions_config and mentions_verify:
            scores["final_report_quality"] = 1.0
        elif (mentions_delete and mentions_verify) or (mentions_delete and mentions_config):
            scores["final_report_quality"] = 0.5

    return scores
```

## LLM Judge Rubric

Evaluate two artifacts together: (A) the created `SKILL.md`, and (B) the assistant's final response.

### Dimension 1: Reusable uninstall skill quality
- **1.0**: `SKILL.md` is clearly reusable for future uninstall tasks, not just this one instance. It includes frontmatter plus concrete sections for when to use, pre-removal audit of references/dependencies/defaults, removal procedure, verification procedure, and cautions. Instructions are operational and safety-oriented.
- **0.75**: Mostly reusable and structured, but one area is somewhat thin (e.g. audit or verification is present but superficial).
- **0.5**: Basic template exists, but it reads as generic notes or mostly describes deleting a folder without a meaningful safety workflow.
- **0.25**: Minimal content with weak structure; hard to follow in practice.
- **0.0**: Missing or unusable.

### Dimension 2: Correct decision-making about dependency/reference cleanup
- **1.0**: Final response shows correct reasoning that `tushare-finance` cannot simply be deleted because it is still referenced as installed/default/preferred and in dependency configuration; cleanup is handled without inventing unsupported replacements or deleting unrelated skills.
- **0.75**: Mostly correct reasoning, but explanation is incomplete or misses one reference type while the actual edits are still largely sound.
- **0.5**: Mixed reasoning; may acknowledge some references but gloss over edge cases or imply an unjustified replacement/default.
- **0.25**: Weak reasoning; treats task as plain folder deletion or gives unsafe/unsupported justification.
- **0.0**: Clearly incorrect reasoning that would leave the workspace inconsistent.

### Dimension 3: Verification quality and evidence
- **1.0**: Final response explicitly states what was verified after edits: directory removal and reference cleanup in config files, with wording that indicates verification rather than assumption.
- **0.75**: Verification is stated but somewhat high-level.
- **0.5**: Claims success with limited evidence or only verifies one aspect.
- **0.25**: Bare success claim with little or no verification detail.
- **0.0**: No verification mentioned.

### Dimension 4: Consistency with provided examples and user-facing clarity
- **1.0**: `SKILL.md` matches the general style of provided sample skills (clear headings, actionable notes, concise but useful) and the final response is brief, direct, and user-facing.
- **0.75**: Generally clear and reasonably aligned, with minor style inconsistencies.
- **0.5**: Understandable but rough, overly generic, or stylistically inconsistent.
- **0.25**: Confusing or poorly structured.
- **0.0**: Not understandable.

Use the rubric to distinguish strong execution from superficial folder deletion plus boilerplate documentation.
