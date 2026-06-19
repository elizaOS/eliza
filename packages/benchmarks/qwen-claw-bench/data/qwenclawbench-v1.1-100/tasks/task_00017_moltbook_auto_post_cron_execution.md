---
id: task_00017_moltbook_auto_post_cron_execution
name: Moltbook Auto Post Cron Execution
category: Workflow and Agent Orchestration
subcategory: Workflow and Task Scheduling
grading_type: hybrid
grading_weights:
  automated: 0.4
  llm_judge: 0.6
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: skills/moltbook-auto-post/post.js
  dest: skills/moltbook-auto-post/post.js
- source: skills/moltbook-auto-post/package.json
  dest: skills/moltbook-auto-post/package.json
- source: skills/moltbook-auto-post/state.json
  dest: skills/moltbook-auto-post/state.json
- source: skills/moltbook-auto-post/.env
  dest: skills/moltbook-auto-post/.env
- source: skills/moltbook-auto-post/SKILL.md
  dest: skills/moltbook-auto-post/SKILL.md
- source: skills/moltbook-auto-post/lib/client.js
  dest: skills/moltbook-auto-post/lib/client.js
- source: skills/moltbook-auto-post/lib/config.js
  dest: skills/moltbook-auto-post/lib/config.js
- source: skills/moltbook-auto-post/lib/content-picker.js
  dest: skills/moltbook-auto-post/lib/content-picker.js
- source: skills/moltbook-auto-post/lib/rate-limiter.js
  dest: skills/moltbook-auto-post/lib/rate-limiter.js
---

## Prompt

[cron:163b1d0d-bd9e-4664-ad5a-c93cd0144a35 Moltbook Auto Post] exec: node skills/moltbook-auto-post/post.js
Current time: Tuesday, February 10th, 2026 — 11:42 PM (Asia/Shanghai)

## Expected Behavior

The agent should handle this cron-triggered task by:

1. **Read the skill files** — Read `skills/moltbook-auto-post/post.js`, `skills/moltbook-auto-post/lib/content-picker.js`, `skills/moltbook-auto-post/lib/rate-limiter.js`, `skills/moltbook-auto-post/lib/config.js`, `skills/moltbook-auto-post/.env`, and `skills/moltbook-auto-post/state.json` to understand the script logic and current state before executing.

2. **Trace the execution path** — Walk through the logic to predict what will happen:
   - `loadConfig()` reads `skills/moltbook-auto-post/.env`: `CONTENT_MODE=hybrid`, `POST_INTERVAL_MIN=90`, `MAX_POSTS_PER_DAY=6`
   - `loadState()` reads `skills/moltbook-auto-post/state.json`: `postsToday=3`, `todayDate="2026-02-10"`, `apiCallsThisHour=7`, `hourStart="2026-02-10T14"`, `lastPostAt="2026-02-10T14:18:32.441Z"`
   - Daily counter check: `todayDate` matches → no reset
   - Hourly counter check: `hourStart` (`"2026-02-10T14"`) differs from current hour (`"2026-02-10T15"`) → `apiCallsThisHour` resets to 0
   - Rate limit: `postsToday=3 < maxPostsPerDay=6` and `apiCallsThisHour=0 < 55` → `canPost()` returns `true`
   - Interval check: `lastPostAt` is from `2026-02-10T14:18:32Z`; elapsed >> 90 minutes → interval passed
   - Content pick (hybrid mode): `ContentPicker` checks queue directory first (`queue/` does not exist → null), then falls back to templates directory (`templates/` does not exist → null) → no content found
   - **Result**: script logs `{ts, action: "skip", reason: "no_content"}`, saves state, and exits cleanly

3. **Install dependencies** — Run `npm install` inside `skills/moltbook-auto-post/` to ensure `node_modules/dotenv` is available.

4. **Execute the script** — Run `node skills/moltbook-auto-post/post.js` and observe the output: `[moltbook-auto-post] No content available to post.`

5. **Verify the results** — Confirm that:
   - A log file `skills/moltbook-auto-post/logs/<date>.jsonl` was created containing a skip entry with `action: "skip"` and `reason: "no_content"`
   - `skills/moltbook-auto-post/state.json` was updated and saved by the script (the date fields reflect the new run's date context)

6. **Report results** — Summarize: dependencies installed, script executed, hybrid mode found neither queued content nor templates, normal no-op skip, state saved.

## Grading Criteria

- [ ] Agent installed dependencies (node_modules/dotenv exists)
- [ ] Script was executed and a log file was created in logs/ directory
- [ ] Log entry has action="skip" and reason="no_content" (correct skip path identified)
- [ ] skills/moltbook-auto-post/state.json was saved after script execution
- [ ] Agent correctly explains hybrid-mode content lookup: queue not found, templates not found → no_content skip

## Automated Checks

```python
import json
import os
import glob
import re


def grade(transcript: list, workspace_path: str) -> dict:
    scores = {
        "dependencies_installed": 0.0,
        "log_file_created": 0.0,
        "log_entry_no_content": 0.0,
        "state_saved": 0.0,
        "explains_skip_reason": 0.0,
    }

    if not transcript or not workspace_path or not os.path.exists(workspace_path):
        return scores

    skill_dir = os.path.join(workspace_path, "skills", "moltbook-auto-post")

    # 1. Check that dotenv dependency was installed
    dotenv_path = os.path.join(skill_dir, "node_modules", "dotenv", "package.json")
    if os.path.isfile(dotenv_path):
        try:
            with open(dotenv_path, "r") as f:
                pkg = json.load(f)
            if pkg.get("name") == "dotenv":
                scores["dependencies_installed"] = 1.0
        except Exception:
            pass

    # 2. Check that a log file was created in logs/ directory
    logs_dir = os.path.join(skill_dir, "logs")
    log_files = []
    if os.path.isdir(logs_dir):
        log_files = glob.glob(os.path.join(logs_dir, "*.jsonl"))
    if log_files:
        scores["log_file_created"] = 1.0

    # 3. Check log entry has action="skip" and reason="no_content"
    if log_files:
        try:
            log_files_sorted = sorted(log_files)
            with open(log_files_sorted[-1], "r") as f:
                lines = [l.strip() for l in f.readlines() if l.strip()]
            if lines:
                last_entry = json.loads(lines[-1])
                action_ok = last_entry.get("action") == "skip"
                reason_ok = last_entry.get("reason") == "no_content"
                if action_ok and reason_ok:
                    scores["log_entry_no_content"] = 1.0
                elif action_ok:
                    scores["log_entry_no_content"] = 0.5
        except Exception:
            pass

    # 4. Check state.json was saved after script execution
    # The script always calls saveState() before exit; on a different run date,
    # todayDate and/or hourStart will differ from the original "2026-02-10" values
    state_path = os.path.join(skill_dir, "state.json")
    if os.path.isfile(state_path):
        try:
            with open(state_path, "r") as f:
                state = json.load(f)
            # If run on a different date, todayDate changes and postsToday resets to 0
            if state.get("todayDate") != "2026-02-10":
                scores["state_saved"] = 1.0
            elif "postsToday" in state and "lastPostAt" in state:
                # Same date run: state was still re-saved (valid structure)
                scores["state_saved"] = 0.5
        except Exception:
            pass

    # 5. Check transcript: agent explained hybrid-mode skip (no queue + no templates)
    assistant_text = ""
    tool_calls_text = ""
    for m in transcript:
        if not isinstance(m, dict):
            continue
        if m.get("role") == "assistant":
            content = m.get("content", "")
            if isinstance(content, str):
                assistant_text += " " + content
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict):
                        text_val = block.get("text", "") or ""
                        input_val = str(block.get("input", "") or "")
                        assistant_text += " " + text_val
                        tool_calls_text += " " + input_val

    full_text = (assistant_text + " " + tool_calls_text).lower()

    has_no_content = bool(re.search(
        r"(no.content|no_content|no.queue|queue.empty|queue.*not.*exist|no.template|template.*missing|nothing.to.post)",
        full_text
    ))
    has_hybrid_ref = bool(re.search(
        r"(hybrid.mode|content.mode|content_mode|queue.first|fall.?back|pick.*queue|pick.*template)",
        full_text
    ))
    has_skip_reason = bool(re.search(
        r"(skip|skipping|no.post|not.post)",
        full_text
    ))

    if has_no_content and has_hybrid_ref:
        scores["explains_skip_reason"] = 1.0
    elif has_no_content and has_skip_reason:
        scores["explains_skip_reason"] = 0.75
    elif has_no_content:
        scores["explains_skip_reason"] = 0.5

    return scores
```

## LLM Judge Rubric

### Code Logic Tracing (Weight: 30%)

Evaluates whether the agent correctly read and traced through the multi-file script logic (skills/moltbook-auto-post/post.js, skills/moltbook-auto-post/lib/content-picker.js, skills/moltbook-auto-post/lib/config.js, skills/moltbook-auto-post/lib/rate-limiter.js, skills/moltbook-auto-post/.env, skills/moltbook-auto-post/state.json) to understand the execution path before running.

- **1.0**: Agent read all relevant files, traced the execution path explicitly: config loads from skills/moltbook-auto-post/.env (CONTENT_MODE=hybrid), rate limiter passes, interval passes, ContentPicker tries queue directory (absent → null) then templates directory (absent → null) → no content → skip with "no_content".
- **0.75**: Agent identified that no content would be found in hybrid mode but did not trace the full queue-then-template fallback logic from skills/moltbook-auto-post/lib/content-picker.js.
- **0.5**: Agent read some files and understood the skip outcome but could not explain the code path that led there.
- **0.25**: Agent ran the script and observed the output but made little effort to understand the underlying logic.
- **0.0**: Agent did not read the skill files, hallucinated the outcome, or could not explain why the script skipped.

### Execution Completeness (Weight: 25%)

Evaluates whether the agent completed the full task cycle: install deps, run script, verify outputs.

- **1.0**: Agent ran `npm install`, executed `node skills/moltbook-auto-post/post.js`, verified the log file and state.json, and reported the outcome end-to-end.
- **0.75**: Agent installed deps and ran the script but did not fully verify log/state artifacts.
- **0.5**: Agent ran the script but skipped dependency installation or left errors unresolved.
- **0.25**: Agent attempted but failed to complete execution or left significant gaps.
- **0.0**: Agent did not run the script or took no meaningful action.

### State and Log Verification (Weight: 20%)

Evaluates whether the agent verified that the log file was created with a valid skip entry and that skills/moltbook-auto-post/state.json was updated.

- **1.0**: Agent confirmed the log file was created under `logs/` with `action: "skip"` and `reason: "no_content"`, and verified skills/moltbook-auto-post/state.json was saved by the script.
- **0.75**: Agent checked logs or state but not both, with correct content.
- **0.5**: Agent mentioned state/logs were updated but without actual verification of content.
- **0.25**: Agent made a vague reference to output without verifying specific artifacts.
- **0.0**: Agent did not verify any output artifacts.

### Rate Limit and Interval Analysis (Weight: 15%)

Evaluates whether the agent correctly analyzed the rate limiting and interval state before or after execution.

- **1.0**: Agent read skills/moltbook-auto-post/state.json and skills/moltbook-auto-post/.env, correctly identified that postsToday=3 < MAX_POSTS_PER_DAY=6, that the hourly counter would reset (hourStart mismatch), and that the post interval had long since elapsed — all limits clear.
- **0.75**: Agent identified rate limits and interval were not blocking but without cross-referencing all three sources (skills/moltbook-auto-post/.env, skills/moltbook-auto-post/state.json, skills/moltbook-auto-post/lib/rate-limiter.js).
- **0.5**: Agent noted rate limits were fine but without verifying from the actual config values.
- **0.25**: Agent made an incorrect assessment of rate limit or interval state.
- **0.0**: Agent ignored rate limit and interval logic entirely.

### Communication Quality (Weight: 10%)

- **1.0**: Agent provided a clear, concise summary: deps installed, hybrid-mode content search found nothing (no queue, no templates), script exited cleanly, log entry written, state saved.
- **0.75**: Agent provided a reasonable summary with minor omissions.
- **0.5**: Agent communicated a result but was verbose, confusing, or missing key details.
- **0.25**: Agent's communication was mostly unclear or unhelpful.
- **0.0**: Agent provided no summary or explanation of the task outcome.
