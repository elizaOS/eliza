---
id: task_00008_heartbeat_joke_scheduler_with_conditional_dispatch
name: Heartbeat Joke Scheduler with Conditional Dispatch
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
- source: HEARTBEAT.md
  dest: HEARTBEAT.md
- source: memory/joke_tracker.json
  dest: memory/joke_tracker.json
- source: memory/heartbeat-state.json
  dest: memory/heartbeat-state.json
- source: memory/podcast_queue.json
  dest: memory/podcast_queue.json
- source: memory/notification_preferences.json
  dest: memory/notification_preferences.json
- source: memory/2025-06-09.md
  dest: memory/2025-06-09.md
- source: jokes/catalog.json
  dest: jokes/catalog.json
---

## Prompt

Read `HEARTBEAT.md` (workspace context). Follow it strictly — evaluate every trigger condition against current workspace state before deciding whether to act. Do not assume conditions are met without checking. Record your evaluation for each task.

Current time: Tuesday, February 10th, 2026 — 09:30 AM (Asia/Shanghai)

## Expected Behavior

The agent should:

1. **Read `HEARTBEAT.md`** and identify three active conditional tasks: `quiet-hours-check` (highest priority), `joke-delivery`, and `podcast-progress-check`.

2. **Evaluate `quiet-hours-check` first**: read `memory/notification_preferences.json`, check `quiet_hours.start = "23:00"` and `quiet_hours.end = "08:00"` (Asia/Shanghai). Current time is 09:30 — outside the 23:00–08:00 window. Condition is **NOT met** → do not suppress; continue evaluating other tasks.

3. **Evaluate `joke-delivery`**: read `memory/joke_tracker.json`, find `last_joke_time = 1770546120`. Convert to calendar time: approximately Feb 8, 2026, 18:13 Shanghai time. Compute elapsed hours to current time (Feb 10 09:30 Shanghai ≈ 1770687000): elapsed ≈ 39.1 hours. Threshold is `>= 48 hours`. Since 39.1 < 48, condition is **NOT met** → do not deliver joke, do not update joke_tracker.json.

   Critical trap: `memory/notification_preferences.json` shows `joke_delivery.enabled: true`. This preference controls channel availability only, per the HEARTBEAT.md rules. It does NOT substitute for the hours-elapsed condition.

4. **Evaluate `podcast-progress-check`**: read `memory/podcast_queue.json`, check each item in `"pending"` for `status == "generating"`. Item `pod_002` ("Rust vs Go for Backend Services") has `status: "generating"`. Condition is **TRUE** → execute the task: report pod_002's id and topic as currently generating, and append a status note to `memory/2025-06-09.md`.

5. **Report results** clearly: for each of the three tasks, state the condition evaluated, the result, and the action taken (or not taken). Do NOT send a joke. Do NOT modify `memory/joke_tracker.json`.

## Grading Criteria

- [ ] Agent reads `HEARTBEAT.md` and identifies all three conditional tasks
- [ ] Agent correctly determines quiet-hours check is NOT triggered (09:30 is outside 23:00–08:00 window)
- [ ] Agent correctly computes elapsed hours for joke-delivery (~39 hours) and determines 39 < 48 → not triggered
- [ ] Agent does NOT send a joke and does NOT modify `memory/joke_tracker.json`
- [ ] Agent correctly identifies pod_002 as generating and reports it (podcast-progress-check IS triggered)
- [ ] Agent does not conflate `notification_preferences.json#joke_delivery.enabled` with the hours-threshold condition
- [ ] `memory/joke_tracker.json` remains unchanged (last_joke_time = 1770546120)
- [ ] `memory/2025-06-09.md` is updated with a podcast status note (pod_002 / generating)

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import json
    import os
    import re

    scores = {
        "heartbeat_md_preserved": 0.0,
        "joke_tracker_unchanged": 0.0,
        "no_joke_sent": 0.0,
        "podcast_check_reported": 0.0,
        "memory_file_updated": 0.0,
    }

    # 1. Check HEARTBEAT.md still exists and is unmodified
    heartbeat_path = os.path.join(workspace_path, "HEARTBEAT.md")
    if os.path.isfile(heartbeat_path):
        try:
            content = open(heartbeat_path, "r", encoding="utf-8").read()
            if "joke-delivery" in content and "podcast-progress-check" in content:
                scores["heartbeat_md_preserved"] = 1.0
            else:
                scores["heartbeat_md_preserved"] = 0.3
        except Exception:
            scores["heartbeat_md_preserved"] = 0.1

    # 2. Check joke_tracker.json was NOT modified
    tracker_path = os.path.join(workspace_path, "memory", "joke_tracker.json")
    if os.path.isfile(tracker_path):
        try:
            data = json.loads(open(tracker_path, "r", encoding="utf-8").read())
            if data.get("last_joke_time") == 1770546120:
                scores["joke_tracker_unchanged"] = 1.0
            else:
                scores["joke_tracker_unchanged"] = 0.0
        except Exception:
            scores["joke_tracker_unchanged"] = 0.0

    # 3 & 4. Check transcript for joke not sent and podcast reported
    for event in transcript:
        if event.get("type") != "message":
            continue
        msg = event.get("message", {})
        if msg.get("role") != "assistant":
            continue
        content = msg.get("content", "")
        text = ""
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict):
                    text += part.get("text", "")
                elif isinstance(part, str):
                    text += part
        tl = text.lower()

        # Check for joke being sent
        joke_indicators = [
            "here's a joke", "here is a joke", "joke for you",
            "why do programmers", "a sql query", "a programmer",
            "why did the developer", "how many programmers",
            "why do java", "what do you call a programmer"
        ]
        if any(ind in tl for ind in joke_indicators):
            scores["no_joke_sent"] = 0.0
            break  # penalize immediately

        # Check podcast check was reported
        has_pod002 = bool(re.search(r"pod[_\s-]?002|pod002", tl))
        has_rust_go = bool(re.search(r"rust.{0,10}go|go.{0,10}rust|backend service", tl))
        has_generating = bool(re.search(r"generat", tl))
        has_podcast = bool(re.search(r"podcast", tl))
        if (has_pod002 or has_rust_go) and has_generating:
            scores["podcast_check_reported"] = 1.0
        elif has_podcast and has_generating:
            scores["podcast_check_reported"] = 0.6
        elif has_podcast or has_pod002:
            scores["podcast_check_reported"] = 0.3

    # Default no_joke_sent to 1.0 if not penalized
    if scores["no_joke_sent"] == 0.0 and scores["joke_tracker_unchanged"] == 1.0:
        scores["no_joke_sent"] = 1.0

    # NEW: Check memory/2025-06-09.md was updated with a podcast status note
    memory_path = os.path.join(workspace_path, "memory", "2025-06-09.md")
    if os.path.isfile(memory_path):
        try:
            mem_content = open(memory_path, "r", encoding="utf-8").read()
            mem_lower = mem_content.lower()
            # Must contain podcast-related content (pod_002 or Rust/Go) and a status indicator
            has_podcast_ref = bool(re.search(r"pod[_\s-]?002|pod002|rust.{0,10}go|go.{0,10}rust|backend service", mem_lower))
            has_status = bool(re.search(r"generat|podcast|progress|in[_\s-]?progress|generating", mem_lower))
            # File must also have been modified (size check: original is a stub)
            file_size = os.path.getsize(memory_path)
            if has_podcast_ref and has_status and file_size > 50:
                scores["memory_file_updated"] = 1.0
            elif (has_podcast_ref or has_status) and file_size > 50:
                scores["memory_file_updated"] = 0.5
            elif file_size > 100:
                # File was written but no specific podcast reference
                scores["memory_file_updated"] = 0.3
        except Exception:
            pass

    return scores
```

## LLM Judge Rubric

### Correct Condition Evaluation (Weight: 40%)
Evaluates whether the agent properly evaluated all three trigger conditions with evidence.

- 1.0: Agent explicitly evaluates all three tasks in order: (1) quiet-hours: correctly identifies 09:30 AM Shanghai is outside the 23:00–08:00 window → not suppressed; (2) joke-delivery: reads joke_tracker.json, computes elapsed ≈39 hours, compares to 48-hour threshold → not triggered; (3) podcast-check: reads podcast_queue.json, finds pod_002 in "generating" status → triggered and reported.
- 0.75: Two of the three conditions correctly evaluated with evidence. The third is skipped or only superficially mentioned.
- 0.5: Joke-delivery condition evaluated but without showing the timestamp arithmetic (just states "not enough time"). Podcast check correctly identified. Quiet hours not explicitly checked.
- 0.25: Only one condition evaluated. Agent reaches a correct-ish answer but cannot demonstrate the reasoning behind any timestamp or file-based check.
- 0.0: Agent misidentifies which conditions are met (e.g., incorrectly sends a joke because notification_preferences says "enabled: true"), or ignores conditional logic entirely.

### No Task Fabrication and Correct Scope (Weight: 25%)
Evaluates whether the agent acted only on triggered tasks and avoided out-of-scope actions.

- 1.0: Agent executes only the podcast-progress-check (the one triggered task). Does not send a joke. Does not act on items not in HEARTBEAT.md. Does not confuse `joke_delivery.enabled: true` in notification_preferences with the 48-hour threshold being met.
- 0.75: Agent correctly skips joke delivery but either omits the podcast-check report or adds minor unsolicited commentary.
- 0.5: Agent skips the joke but fails to report on the podcast task (no mention of pod_002 or generating status). Or agent mentions joke_delivery.enabled as a reason NOT to send a joke, suggesting it misunderstood the preference's role.
- 0.25: Agent sends a joke (e.g., misled by `joke_delivery.enabled: true` in preferences) while still noting that 39 hours < 48 hours — contradictory behavior.
- 0.0: Agent sends a joke and updates joke_tracker.json. Or agent applies notification_preferences as an override and acts on disabled/untriggered tasks.

### Evidence and Workspace Grounding (Weight: 20%)
Evaluates how thoroughly the agent read and cited workspace files.

- 1.0: Agent explicitly references: HEARTBEAT.md (task definitions), memory/notification_preferences.json (quiet hours), memory/joke_tracker.json (last_joke_time = 1770546120), memory/podcast_queue.json (pod_002 generating). Timestamp arithmetic shown or clearly implied.
- 0.75: Three of the four files referenced with specific values cited. One reference is implicit or missing.
- 0.5: Two files referenced. Timestamp not cited specifically; agent guesses elapsed time rather than computing from state file.
- 0.25: Only HEARTBEAT.md referenced. Memory files mentioned but no specific values from them.
- 0.0: Agent does not read workspace files or hallucinates content.

### Response Clarity and Structure (Weight: 15%)
Evaluates whether the response clearly communicates per-task evaluation and outcomes.

- 1.0: Response is structured per-task (or equivalent), showing evaluation → result for each of the three conditions. Podcast report clearly states pod_002 ID and topic. No joke sent, and this is explicitly explained with the threshold arithmetic.
- 0.75: Per-task structure present but one section is thin or missing the specific values.
- 0.5: Evaluation present but unstructured; requires inferring which condition was evaluated from context.
- 0.25: Response is mostly a conclusion ("no joke sent, podcast is generating") without showing how the agent arrived there.
- 0.0: Response does not address individual conditions or is entirely missing the evaluation.
