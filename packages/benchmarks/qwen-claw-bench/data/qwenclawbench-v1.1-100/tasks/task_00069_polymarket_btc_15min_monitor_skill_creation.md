---
id: task_00069_polymarket_btc_15min_monitor_skill_creation
name: Polymarket BTC 15min Monitor Skill Creation
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
- source: data/polymarket_btc15m_mock.html
  dest: data/polymarket_btc15m_mock.html
- source: scripts/pm_btc15m_monitor.sh
  dest: scripts/pm_btc15m_monitor.sh
- source: .openclaw/data/pm_btc15m_last_reported.txt
  dest: .openclaw/data/pm_btc15m_last_reported.txt
- source: messages/monitor-request.md
  dest: messages/monitor-request.md
---

## Prompt

[cron:polymarket-btc15m] Heartbeat fired. Check the `messages/` folder — there's a monitoring request in there.

## Expected Behavior

The agent should:

1. **Read `messages/monitor-request.md`** to discover the full set of requirements: new round detection, script audit, round gap analysis, result file update, and SKILL.md creation.

2. **Read the state file** `.openclaw/data/pm_btc15m_last_reported.txt`. Ground truth — actual file content:
   ```
   ROUND:BTC15M-20260210-0345|RESOLVED|UP|2026-02-10T03:45:00+09:00|2026-02-10T04:00:00+09:00
   ```
   Parsed last reported round ID: `BTC15M-20260210-0345` (Round #18465, window 03:30–03:45 JST, outcome UP, resolved at 03:45:08).

3. **Parse `data/polymarket_btc15m_mock.html`** — the file contains both HTML elements and an embedded `__NEXT_DATA__` JSON block. Ground truths:
   - **ACTIVE round**: #18473 (`BTC15M-20260210-0545`, 05:30–05:45 JST) — must be skipped, not RESOLVED.
   - **RESOLVED rounds in mock data** (3 total):
     - Round #18465 (`BTC15M-20260210-0345`, 03:30–03:45, outcome UP) — **matches last_reported**, not new.
     - Round #18471 (`BTC15M-20260210-0515`, 05:00–05:15, outcome UP, resolved 05:15:09) — **NEW**.
     - Round #18472 (`BTC15M-20260210-0530`, 05:15–05:30, outcome DOWN, resolved 05:30:12) — **NEW, and latest**.
   - The agent must identify BOTH new resolved rounds (#18471 and #18472) and report the **latest** (#18472 DOWN) as the primary update.

4. **Round gap analysis** (key analytical trap): Round numbers jump from #18465 to #18471 — rounds #18466 through #18470 are absent from the mock HTML (5 missing rounds). This represents a ~75-minute window (03:45 to 05:00 JST) during which 5 rounds resolved but are not visible in the current page view. The agent should identify and explain this gap. Price context: #18465 closed at $98,256.70; #18471 opened at $98,389.50, implying BTC rose by ~$132.80 during the gap.

5. **Script audit** (key bug trap): Read `scripts/pm_btc15m_monitor.sh`. The script has a critical portability bug: `STATE_FILE` is hardcoded to `/home/rico/.openclaw/data/pm_btc15m_last_reported.txt` (absolute path). In the workspace environment, the file is at `.openclaw/data/pm_btc15m_last_reported.txt` (relative). Running the script as-is will fail with "file not found" unless `PM_STATE_FILE` env var is overridden. The agent should identify this and explain the fix (override with `PM_STATE_FILE=.openclaw/data/pm_btc15m_last_reported.txt ./scripts/pm_btc15m_monitor.sh` or edit the default).

6. **Write result file** `.openclaw/data/pm_btc15m_result.txt` with the latest new round in the same pipe-delimited format as the state file:
   ```
   ROUND:BTC15M-20260210-0530|RESOLVED|DOWN|2026-02-10T05:15:00+09:00|2026-02-10T05:30:00+09:00
   ```
   Also update `.openclaw/data/pm_btc15m_last_reported.txt` to this new value.

7. **Create `workspace/skills/polymarket-btc15m-monitor/SKILL.md`** with YAML frontmatter (`name`, `description`) and sections covering: state file format (pipe-delimited fields), HTML parsing approach (HTML elements + `__NEXT_DATA__` JSON), new-round comparison logic, round gap detection methodology, script path requirements, and output format conventions.

## Grading Criteria

- [ ] `workspace/skills/polymarket-btc15m-monitor/SKILL.md` exists with YAML frontmatter (name and description)
- [ ] SKILL.md covers state file format, HTML/JSON parsing, comparison logic, and round gap detection
- [ ] Result file `.openclaw/data/pm_btc15m_result.txt` exists and contains the new round info (DOWN outcome for BTC15M-20260210-0530) — NOT NO-UPDATE
- [ ] Agent correctly identified both new resolved rounds (#18471 UP and #18472 DOWN), not just one
- [ ] Agent identified the round number gap (#18466–#18470 missing, ~75-minute window)
- [ ] Agent identified the script bug (hardcoded absolute path in `pm_btc15m_monitor.sh`)
- [ ] Agent updated `.openclaw/data/pm_btc15m_last_reported.txt` with the latest round

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    import re

    scores = {
        "skill_md_exists_and_structured": 0.0,
        "skill_md_content_quality": 0.0,
        "result_file_correct_new_round": 0.0,
        "both_new_rounds_identified": 0.0,
        "round_gap_analyzed": 0.0,
        "script_bug_identified": 0.0,
        "state_file_updated": 0.0,
    }

    # Return all zeros if no primary output exists
    result_path = os.path.join(workspace_path, ".openclaw", "data", "pm_btc15m_result.txt")
    skill_path = os.path.join(workspace_path, "skills", "polymarket-btc15m-monitor", "SKILL.md")
    if not os.path.isfile(result_path) and not os.path.isfile(skill_path):
        return scores

    # 1. Check SKILL.md
    if not os.path.isfile(skill_path):
        skill_path = os.path.join(workspace_path, "SKILL.md")
    if os.path.isfile(skill_path):
        try:
            with open(skill_path, "r", encoding="utf-8") as f:
                skill_content = f.read()
            has_frontmatter = skill_content.strip().startswith("---")
            has_name = bool(re.search(r"(?i)^name\s*:", skill_content, re.MULTILINE))
            has_description = bool(re.search(r"(?i)^description\s*:", skill_content, re.MULTILINE))
            if has_frontmatter and has_name and has_description:
                scores["skill_md_exists_and_structured"] = 1.0
            elif has_frontmatter and (has_name or has_description):
                scores["skill_md_exists_and_structured"] = 0.5
            elif has_frontmatter:
                scores["skill_md_exists_and_structured"] = 0.25
            else:
                scores["skill_md_exists_and_structured"] = 0.1

            skill_lower = skill_content.lower()
            keywords = ["polymarket", "btc", "resolved", "round", "pipe", "state", "gap", "format", "last_reported"]
            matched = sum(1 for kw in keywords if kw in skill_lower)
            scores["skill_md_content_quality"] = min(1.0, matched / 5.0)
        except Exception:
            pass

    # 2. Check result file — must contain new round (DOWN), not NO-UPDATE
    if os.path.isfile(result_path):
        try:
            with open(result_path, "r", encoding="utf-8") as f:
                result_content = f.read().strip().upper()
            if "NO-UPDATE" in result_content:
                scores["result_file_correct_new_round"] = 0.0  # Wrong — should have new round
            elif "DOWN" in result_content and ("BTC15M" in result_content or "0530" in result_content):
                scores["result_file_correct_new_round"] = 1.0
            elif "DOWN" in result_content:
                scores["result_file_correct_new_round"] = 0.7
            elif "RESOLVED" in result_content and "ROUND" in result_content:
                scores["result_file_correct_new_round"] = 0.4
        except Exception:
            pass

    # 3. Check if both new rounds identified — combine transcript + result
    transcript_text = ""
    for event in transcript:
        if not isinstance(event, dict):
            continue
        msg = event.get("message", event) if event.get("type") == "message" else event
        role = msg.get("role", "")
        if role not in ("assistant", "tool", "toolResult"):
            continue
        cf = msg.get("content", "")
        if isinstance(cf, str):
            transcript_text += cf + " "
        elif isinstance(cf, list):
            transcript_text += " ".join(
                part.get("text", "") if isinstance(part, dict) else str(part)
                for part in cf
            ) + " "
    result_text = ""
    if os.path.isfile(result_path):
        try:
            with open(result_path, "r", encoding="utf-8") as f:
                result_text = f.read()
        except Exception:
            pass
    combined = (transcript_text + " " + result_text).lower()

    has_18471 = bool(re.search(r"18471|btc15m-20260210-0515|0515.{0,20}up|up.{0,20}0515", combined))
    has_18472 = bool(re.search(r"18472|btc15m-20260210-0530|0530.{0,20}down|down.{0,20}0530", combined))
    if has_18471 and has_18472:
        scores["both_new_rounds_identified"] = 1.0
    elif has_18471 or has_18472:
        scores["both_new_rounds_identified"] = 0.5

    # 4. Check round gap analysis
    gap_patterns = [r"18466", r"18467", r"18468", r"18469", r"18470", r"gap", r"miss", r"skip"]
    gap_matches = sum(1 for p in gap_patterns if re.search(p, combined))
    if gap_matches >= 2:
        scores["round_gap_analyzed"] = 1.0
    elif gap_matches >= 1:
        scores["round_gap_analyzed"] = 0.5

    # 5. Check script bug identification
    script_patterns = [r"hardcod", r"/home/rico", r"absolute.*path", r"pm_state_file", r"state_file.*wrong", r"path.*incorrect"]
    script_matches = sum(1 for p in script_patterns if re.search(p, combined))
    if script_matches >= 1:
        scores["script_bug_identified"] = 1.0

    # 6. Check state file updated to new round
    state_path = os.path.join(workspace_path, ".openclaw", "data", "pm_btc15m_last_reported.txt")
    if os.path.isfile(state_path):
        try:
            with open(state_path, "r", encoding="utf-8") as f:
                state_content = f.read().strip()
            if "0530" in state_content or "18472" in state_content or "DOWN" in state_content.upper():
                scores["state_file_updated"] = 1.0
            elif "0515" in state_content or "18471" in state_content:
                scores["state_file_updated"] = 0.5  # Updated but not to latest
            elif "0345" in state_content:
                scores["state_file_updated"] = 0.0  # Still the old round
        except Exception:
            pass

    return scores
```

## LLM Judge Rubric

### Skill File Quality and Format Documentation (Weight: 20%)
- 1.0: `workspace/skills/polymarket-btc15m-monitor/SKILL.md` has YAML frontmatter (name, description), and documents: pipe-delimited state file format (all 5 fields), HTML + `__NEXT_DATA__` JSON parsing approach, new-round comparison logic, round gap detection methodology, script path requirements, and output format. Reusable for future monitoring runs.
- 0.75: SKILL.md exists with frontmatter and covers most topics but may lack gap detection or script requirements section.
- 0.5: SKILL.md exists but thin — missing frontmatter fields or only covers basic fetch/compare without format details.
- 0.25: SKILL.md exists but minimal or generic; not clearly specific to this workflow.
- 0.0: SKILL.md missing, empty, or unrelated.

### New Round Detection and Result Correctness (Weight: 30%)
- 1.0: Correctly identifies BOTH new resolved rounds (#18471 UP and #18472 DOWN); reports the **latest** (#18472 DOWN) as the primary update; writes result file in the correct pipe-delimited format (`ROUND:BTC15M-20260210-0530|RESOLVED|DOWN|...`); does NOT output NO-UPDATE (which would be wrong — there are new rounds); also updates `pm_btc15m_last_reported.txt` to the new latest round.
- 0.75: Identifies the latest new round (#18472 DOWN) and writes correct result, but may miss #18471 or fail to update the state file.
- 0.5: Identifies that there is a new round but produces incorrect format or wrong outcome (e.g., says UP instead of DOWN for the latest).
- 0.25: Produces NO-UPDATE or a partial result without correctly identifying the new rounds.
- 0.0: Result file missing, empty, or contains completely wrong information; or outputs NO-UPDATE when two new rounds exist.

### Round Gap Analysis (Weight: 25%)
- 1.0: Identifies that round numbers jump from #18465 to #18471 (5 missing rounds: #18466–#18470); correctly explains this represents a ~75-minute window (03:45–05:00 JST) where rounds resolved but are not visible in the current HTML snapshot; notes the price movement during the gap ($98,256.70 → $98,389.50, BTC UP ~$132.80); explains what this means for monitoring reliability (gaps in cron execution or page data).
- 0.75: Identifies the missing rounds and the approximate time gap, but may not compute the price delta or explain the monitoring implication.
- 0.5: Notices the round number discontinuity (from #18465 to #18471) but doesn't quantify the gap or explain what it means.
- 0.25: Mentions round numbers but doesn't specifically identify the gap or its significance.
- 0.0: No round gap analysis; treats the three visible resolved rounds as the complete sequence.

### Script Audit and Evidence Grounding (Weight: 25%)
- 1.0: Reads `scripts/pm_btc15m_monitor.sh` and identifies the critical bug — `STATE_FILE` is hardcoded to `/home/rico/.openclaw/data/pm_btc15m_last_reported.txt` (absolute path that won't work in the workspace); explains that `PM_STATE_FILE` must be overridden or the default changed; also reads and correctly parses the actual state file format (pipe-delimited with 5 fields); all claims grounded in actual file content.
- 0.75: Identifies the hardcoded path bug with a fix suggestion, but may miss the state file format detail.
- 0.5: Notes the script has issues but doesn't specifically identify the absolute-path problem.
- 0.25: Reads the script but draws no conclusions about its correctness.
- 0.0: Does not read or audit the monitoring script; makes no reference to the script's actual content.
