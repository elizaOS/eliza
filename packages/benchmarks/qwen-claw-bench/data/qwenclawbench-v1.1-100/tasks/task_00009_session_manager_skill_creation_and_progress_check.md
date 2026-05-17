---
id: task_00009_session_manager_skill_creation_and_progress_check
name: Session Manager Skill Creation and Progress Check
category: Knowledge and Memory Management
subcategory: Logging, Planning, and Learning Research
grading_type: hybrid
grading_weights:
  automated: 0.4
  llm_judge: 0.6
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: BOOTSTRAP.md
  dest: BOOTSTRAP.md
- source: logs/nova-for-20260210-090603.log
  dest: logs/nova-for-20260210-090603.log
- source: logs/arxiv-downloads-20260209.log
  dest: logs/arxiv-downloads-20260209.log
- source: contacts/feishu_users.json
  dest: contacts/feishu_users.json
- source: contacts/team-channels.yaml
  dest: contacts/team-channels.yaml
- source: memory/session-state.json
  dest: memory/session-state.json
- source: memory/2026-02-09.md
  dest: memory/2026-02-09.md
- source: tasks/progress.md
  dest: tasks/progress.md
- source: tasks/paper-categories.json
  dest: tasks/paper-categories.json
---

## Prompt

Kevin Zhang sent me two Feishu messages this morning:

1. "Check on the progress" (sent at 09:05:17)
2. "/new session" (sent at 09:08:04)

His user ID is ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02 — look him up in the contacts file. For the progress check, give him a specific, honest update: how many papers have been categorized so far, which ones are still missing their tags, and whether we're realistically on track to hit the deadline. Check the categorization status file for the exact numbers.

For the session reset, archive the current session in memory/session-state.json and start a fresh one. Actually update the file.

Also create a reusable session manager skill at `workspace/skills/session-manager/SKILL.md` that documents how the /new session flow works in this workspace — including how to read the current session from session-state.json, wrap it up into previous_sessions with a summary, and initialize a new current_session. Base the schema details on the actual file format you see.

If BOOTSTRAP.md is present, complete the workspace onboarding as well.

## Expected Behavior

1. Agent reads `contacts/feishu_users.json` and resolves `ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02` to Kevin Zhang (Senior Researcher, Research dept, kevin.zhang@example.com).

2. Agent reads `tasks/progress.md` and finds: project deadline 2026-02-14, Phase 1 complete (18 papers collected), Phase 2 in progress (11/18 categorized), Phase 3 and 4 not started.

3. Agent reads `tasks/paper-categories.json` and identifies the 7 uncategorized papers (those with `"categorized": false`):
   - 2403.15672v1 — Equity in AI-Assisted Science Education
   - 2405.02341v1 — Multimodal Learning Analytics for Physics Labs
   - 2408.11456v1 — Retrieval-Augmented Tutoring for Introductory Mechanics
   - 2410.06789v2 — Physics Education in the Age of Foundation Models
   - 2411.13245v1 — Simulated Experiments with Generative AI Agents
   - 2501.02178v1 — RL-Based Curriculum Sequencing for STEM Courses
   - 2501.08934v1 — Benchmarking LLM Physics Problem-Solving Across Difficulty Levels

4. Agent responds to the progress check with specific numbers: 11 of 18 papers categorized, 7 papers remaining (ideally listing them), deadline 2026-02-14 (4 days from 2026-02-10), and a note that Phases 3 and 4 have not yet started — flagging that the timeline is tight.

5. Agent reads `memory/session-state.json` and identifies the current session: `sess_a8f3c2d1e4b5`, started 2026-02-10T08:50:00+08:00, message_count 3.

6. Agent updates `memory/session-state.json` to:
   - Move `current_session` (sess_a8f3c2d1e4b5) into `previous_sessions`, adding fields `ended_at` and `summary` to it.
   - Create a new `current_session` with a fresh `session_id`, `started_at` reflecting the current time (approximately 09:08), `channel: feishu`, `user_open_id: ou_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02`, `message_count: 0`.

7. Agent creates `workspace/skills/session-manager/SKILL.md` with:
   - YAML frontmatter including `name` and `description` fields.
   - Step-by-step instructions for handling `/new session`, referencing the actual field names used in `session-state.json` (session_id, started_at, ended_at, channel, user_open_id, message_count, summary, previous_sessions).
   - A section describing how to compose a session summary before archiving.

8. Since BOOTSTRAP.md is present, agent creates the 7 onboarding files: AGENTS.md, SOUL.md, IDENTITY.md, HEARTBEAT.md, TOOLS.md, USER.md, .openclaw/workspace-state.json. These should contain contextually relevant content (e.g., USER.md references Kevin Zhang and the literature review project; HEARTBEAT.md reflects the pending research tasks).

**Key traps agents may fall into:**
- Reading a non-existent or wrong contacts file instead of `contacts/feishu_users.json`, and identifying the user only as "Kevin" without the full name and title.
- Giving a vague progress update ("still in progress, some papers remain") without citing the specific count of 7 uncategorized papers or identifying them by ID/title.
- Saying "session reset" in the transcript without actually modifying `memory/session-state.json`.
- Creating a generic SKILL.md that does not reference the actual field names from `session-state.json`.
- Missing the deadline risk: with 4 days left and Phases 3 and 4 not started, the timeline is tight.
- Creating onboarding files as empty stubs that do not reference the actual workspace context.

## Grading Criteria

- [ ] Agent correctly identifies Kevin Zhang by full name from feishu_users.json (not just "Kevin")
- [ ] Progress update cites specific counts: 11 categorized, 7 remaining, and deadline 2026-02-14
- [ ] Agent lists or references the 7 uncategorized papers by ID or title
- [ ] memory/session-state.json is updated: old session sess_a8f3c2d1e4b5 archived in previous_sessions with ended_at and summary; new current_session created with a different session_id
- [ ] `workspace/skills/session-manager/SKILL.md` exists with YAML frontmatter and references actual session-state.json field names
- [ ] Onboarding files created (AGENTS.md, SOUL.md, IDENTITY.md, HEARTBEAT.md, TOOLS.md, USER.md, .openclaw/workspace-state.json)

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    import json
    import re
    from pathlib import Path

    ws = Path(workspace_path)
    scores = {
        "skill_md_created": 0.0,
        "session_state_archived": 0.0,
        "new_session_initialized": 0.0,
        "paper_counts_in_transcript": 0.0,
        "onboarding_files_created": 0.0,
        "kevin_zhang_full_name": 0.0,
    }

    # 1. Check skill SKILL.md — prefer skills/session-manager/SKILL.md (canonical path)
    skill_path = ws / "skills" / "session-manager" / "SKILL.md"
    if not skill_path.exists():
        skill_path = ws / "workspace" / "skills" / "session-manager" / "SKILL.md"
    if skill_path.exists():
        content = skill_path.read_text(encoding="utf-8", errors="replace")
        has_frontmatter = content.strip().startswith("---")
        has_name = "name:" in content.lower()
        has_session_fields = any(
            kw in content for kw in ["session_id", "previous_sessions", "ended_at", "started_at"]
        )
        if has_frontmatter and has_name and has_session_fields:
            scores["skill_md_created"] = 1.0
        elif has_frontmatter and has_name:
            scores["skill_md_created"] = 0.6
        elif has_frontmatter or has_session_fields:
            scores["skill_md_created"] = 0.3

    # 2. Check session-state.json: old session archived and new session created
    state_path = ws / "memory" / "session-state.json"
    if state_path.exists():
        try:
            data = json.loads(state_path.read_text(encoding="utf-8", errors="replace"))
            previous = data.get("previous_sessions", [])
            current = data.get("current_session", {})

            # Old session should be in previous_sessions with an ended_at field
            old_archived = any(
                s.get("session_id") == "sess_a8f3c2d1e4b5" and "ended_at" in s
                for s in previous
            )
            if old_archived:
                scores["session_state_archived"] = 1.0

            # New current_session should exist with a different session_id
            new_id = current.get("session_id", "")
            if new_id and new_id != "sess_a8f3c2d1e4b5" and "started_at" in current:
                scores["new_session_initialized"] = 1.0
            elif new_id and new_id != "sess_a8f3c2d1e4b5":
                scores["new_session_initialized"] = 0.5
        except Exception:
            pass

    # 3. Check transcript for specific paper counts (7 remaining, 11 categorized)
    mentioned_7 = False
    mentioned_11 = False
    mentioned_kevin_zhang = False
    for event in transcript:
        if event.get("type") != "message":
            continue
        msg = event.get("message", {})
        if msg.get("role") == "assistant":
            content = msg.get("content", "")
            if isinstance(content, list):
                text = " ".join(
                    p.get("text", "") for p in content if isinstance(p, dict)
                )
            else:
                text = str(content)
            text_lower = text.lower()
            # Require the number to appear in a semantic context (not just any occurrence)
            if re.search(r'7\s*(paper|remaining|uncategor|left|missing|still)', text_lower) or \
               re.search(r'(paper|remaining|uncategor|left|missing|still)\s*7\b', text_lower) or \
               "seven paper" in text_lower or "seven uncategor" in text_lower:
                mentioned_7 = True
            if re.search(r'11\s*(paper|categorized|complete|done|of\s*18)', text_lower) or \
               re.search(r'(paper|categorized|complete|done|of\s*18)\s*11\b', text_lower) or \
               "eleven paper" in text_lower or re.search(r'11\s*/\s*18', text):
                mentioned_11 = True
            if "kevin zhang" in text_lower:
                mentioned_kevin_zhang = True

    if mentioned_7 and mentioned_11:
        scores["paper_counts_in_transcript"] = 1.0
    elif mentioned_7 or mentioned_11:
        scores["paper_counts_in_transcript"] = 0.5

    scores["kevin_zhang_full_name"] = 1.0 if mentioned_kevin_zhang else 0.0

    # 4. Check onboarding files created with contextually relevant content
    onboarding_files = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "HEARTBEAT.md", "TOOLS.md", "USER.md"]
    found = 0
    for f in onboarding_files:
        fpath = ws / f
        if fpath.exists():
            try:
                text = fpath.read_text(encoding="utf-8", errors="replace")
                size_ok = len(text.strip()) > 50
                # Content relevance: should reference workspace context (Kevin, research, feishu, papers)
                context_relevant = bool(re.search(
                    r"kevin|research|feishu|paper|literature|deadline|session",
                    text.lower()
                ))
                if size_ok and context_relevant:
                    found += 1
                elif size_ok:
                    found += 0.5  # has content but not workspace-specific
            except Exception:
                pass
    state_json = ws / ".openclaw" / "workspace-state.json"
    if state_json.exists():
        try:
            state_content = state_json.read_text(encoding="utf-8", errors="replace")
            import json as _json
            _json.loads(state_content)  # must be valid JSON
            found += 1
        except Exception:
            found += 0.5
    scores["onboarding_files_created"] = round(min(1.0, found / 7), 3)

    return scores
```

## LLM Judge Rubric

### Progress Report Accuracy and Specificity (Weight: 30%)
- 1.0: Agent cites exactly 11/18 categorized and 7 remaining, lists the 7 uncategorized papers by ID or title (from paper-categories.json), identifies deadline as 2026-02-14, and explicitly flags that Phases 3 and 4 have not started, noting timeline risk.
- 0.75: Agent cites correct counts (11/18, 7 remaining) and mentions the deadline, but does not list the specific uncategorized papers or does not note the timeline risk.
- 0.5: Agent gives partially correct counts (e.g., mentions 18 total papers and some remaining) but at least one key number is wrong or missing; deadline may or may not be mentioned.
- 0.25: Agent gives a vague update ("some papers are not yet categorized") without citing specific numbers from paper-categories.json.
- 0.0: Agent provides no meaningful progress update, ignores tasks/progress.md and tasks/paper-categories.json, or makes up numbers.

### Session State Management (Weight: 25%)
- 1.0: memory/session-state.json is correctly updated: sess_a8f3c2d1e4b5 is moved to previous_sessions with ended_at and a meaningful summary; a new current_session is created with a fresh session_id, started_at, channel, user_open_id, and message_count: 0.
- 0.75: Old session is correctly archived but the new current_session is missing some fields (e.g., no message_count or no channel), or the ended_at timestamp is missing from the archived entry.
- 0.5: The file is modified and shows some attempt at session archival, but the structure is incomplete or the old session_id was overwritten rather than moved.
- 0.25: Agent claims to reset the session in conversation but does not modify memory/session-state.json at all, or the file is corrupted.
- 0.0: No session update attempted.

### Session Manager Skill Quality (Weight: 25%)
- 1.0: workspace/skills/session-manager/SKILL.md has complete YAML frontmatter, step-by-step instructions that reference actual field names from session-state.json (session_id, previous_sessions, ended_at, started_at, summary), and covers the full /new session flow: detection, summary generation, archival, and new session initialization.
- 0.75: Skill file exists with frontmatter and covers most of the flow, but field names from session-state.json are partially referenced or one step in the flow is missing.
- 0.5: Skill file exists with frontmatter but is generic (does not reference actual field names) or covers only detection without describing how to update the state file.
- 0.25: Skill file exists but is a thin stub — minimal content, no actionable instructions.
- 0.0: Skill file is missing.

### Workspace Grounding and Onboarding Quality (Weight: 20%)
- 1.0: All 7 onboarding files created with contextually accurate content — USER.md references Kevin Zhang (Senior Researcher), the literature review project, and Feishu; HEARTBEAT.md reflects upcoming research deadlines; AGENTS.md describes the research-assistant role; workspace-state.json has valid JSON with an onboarding timestamp.
- 0.75: Most onboarding files created (5-6 out of 7) with reasonable context, or all 7 created but 1-2 are generic without workspace-specific content.
- 0.5: Several files created (3-4) or files exist but contain only placeholder text with no reference to Kevin Zhang, the research project, or the Feishu integration.
- 0.25: Only 1-2 onboarding files created, or all files are essentially empty.
- 0.0: No onboarding files created.
