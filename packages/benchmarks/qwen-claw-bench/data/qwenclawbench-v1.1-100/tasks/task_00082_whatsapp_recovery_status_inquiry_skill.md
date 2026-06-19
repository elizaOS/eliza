---
id: task_00082_whatsapp_recovery_status_inquiry_skill
name: WhatsApp Recovery Status Inquiry Skill
category: System Operations and Administration
subcategory: Storage and Data Management
grading_type: hybrid
grading_weights:
  automated: 0.4
  llm_judge: 0.6
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: config/alert-rules.yaml
  dest: config/alert-rules.yaml
- source: config/messaging-routes.yaml
  dest: config/messaging-routes.yaml
- source: config/whatsapp-gateway.yaml
  dest: config/whatsapp-gateway.yaml
- source: data/conversation-history.json
  dest: data/conversation-history.json
- source: data/nas-status.json
  dest: data/nas-status.json
- source: data/service-inventory.json
  dest: data/service-inventory.json
- source: logs/nas-events.log
  dest: logs/nas-events.log
- source: logs/whatsapp-gateway.log
  dest: logs/whatsapp-gateway.log
- source: memory/2026-02-10.md
  dest: memory/2026-02-10.md
- source: scripts/check-nas-status.sh
  dest: scripts/check-nas-status.sh
---

## Prompt

Zhang Wei (+86188xxxxxxxx01) just sent a WhatsApp message: "Recovered yet?" (original: 恢复了吗). Check the conversation history and available status files to understand what he's asking about, then draft an accurate reply.

Also create a `workspace/skills/whatsapp-recovery-status/SKILL.md` that documents the methodology for handling incoming ops status queries via WhatsApp — specifically how to trace context, cross-check live status files, and compose a grounded reply.

## Expected Behavior

The agent should:

1. **Trace the full prior conversation** by reading `data/conversation-history.json`. This reveals Zhang Wei sent "What's the NAS status?" earlier today, was told disk 3 (WD-WCC7K0RD4215) failed and a RAID rebuild started with ~6h ETA, and explicitly instructed "Don't touch the other disks, wait for the rebuild to finish." The latest "Recovered yet?" is a follow-up about the RAID rebuild, not a generic health check.

2. **Detect the timestamp inconsistency** in `data/conversation-history.json`: the NAS status exchange shows timestamps of `06:45–06:46Z`, but the disk failure (`logs/nas-events.log`) happened at `12:30:14Z` — making the exchange timestamps impossible. Cross-referencing `logs/whatsapp-gateway.log` reveals the actual timestamps: the NAS exchange happened at `14:45–14:46 UTC`, and "Recovered yet?" arrived at `15:07:11 UTC`. The conversation-history.json timestamps appear to be in local time (CST, UTC+8) stored without timezone suffix — they are 8 hours behind the correct UTC times. `memory/2026-02-10.md` confirms the exchange was "~14:45 UTC." The agent should use the gateway log timestamps as authoritative.

3. **Read `data/nas-status.json`** for current rebuild status: 42.7% complete, rebuild started at `12:35:00Z`, ETA `18:30:00Z`. All main services (SMB, NFS, Docker, Surveillance) are running; Hyper Backup is `paused_during_rebuild`. The pool is still in `degraded` status — not recovered.

4. **Check `logs/nas-events.log`** as additional evidence: the last progress entry at `15:00 UTC` shows 40.3%, and at `15:04 UTC` it's 42.7%. Disk 3 was already flagging elevated `Reallocated_Sector_Ct` at the midnight SMART check (148 vs threshold 140) before it exceeded threshold at 12:30.

5. **Write `reply-draft.txt`** with a reply that:
   - Clearly states the rebuild is NOT complete (pool still in degraded/rebuilding status)
   - Gives the current progress: ~42.7% as of 15:04 UTC
   - States the ETA: approximately 18:30 UTC (about 3.5 hours from message time)
   - Mentions Hyper Backup is still paused
   - Lists the services that ARE running (SMB, NFS, Docker, Surveillance)
   - Does NOT suggest any disk operations (respecting Zhang Wei's constraint "don't touch other disks")
   - Does NOT claim recovery is complete

6. **Note the timestamp discrepancy** in the reply or in a separate comment: the conversation-history.json timestamps are in CST (UTC+8) without timezone markers, which may cause log correlation issues.

7. **Create `workspace/skills/whatsapp-recovery-status/SKILL.md`** with YAML frontmatter documenting the ops WhatsApp status-inquiry workflow: trace conversation history → verify identity and prior context → cross-check live status files → detect data quality issues (like timezone-naive timestamps) → respect prior owner constraints → compose reply with concrete data citations.

8. Do NOT create identity files (AGENTS.md, SOUL.md, etc.) or modify workspace-state.json — these are not required.

## Grading Criteria

- [ ] reply-draft.txt exists and contains concrete rebuild progress data (specifically ~42% figure from nas-status.json)
- [ ] reply-draft.txt states ETA or remaining time (~18:30 UTC or ~3.5h)
- [ ] reply-draft.txt mentions Hyper Backup is paused
- [ ] reply-draft.txt does NOT falsely claim the rebuild is complete or NAS is recovered
- [ ] reply-draft.txt does NOT suggest disk operations (respects the "don't touch other disks" constraint)
- [ ] Agent identifies the timestamp discrepancy between conversation-history.json and whatsapp-gateway.log (CST vs UTC confusion) and uses gateway log as authoritative
- [ ] SKILL.md created at `workspace/skills/whatsapp-recovery-status/SKILL.md` with proper YAML frontmatter

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    import re
    from pathlib import Path

    ws = Path(workspace_path)
    scores = {
        "reply_draft_exists": 0.0,
        "rebuild_progress_in_reply": 0.0,
        "eta_in_reply": 0.0,
        "hyper_backup_paused_mentioned": 0.0,
        "no_false_recovery_claim": 0.0,
        "timezone_discrepancy_noted": 0.0,
        "skill_md_structured": 0.0,
    }

    # 1. reply-draft.txt exists
    reply_path = ws / "reply-draft.txt"
    reply_content = ""
    if reply_path.exists():
        reply_content = reply_path.read_text(encoding="utf-8", errors="replace")
        if len(reply_content.strip()) > 30:
            scores["reply_draft_exists"] = 1.0
        elif len(reply_content.strip()) > 0:
            scores["reply_draft_exists"] = 0.4

    reply_lower = reply_content.lower()

    # 2. Rebuild progress figure present (42.7% from nas-status.json)
    # Accept 42-43 range or explicit "42.7"
    if re.search(r'42\.7|42\s*%|43\s*%|42\.', reply_lower):
        scores["rebuild_progress_in_reply"] = 1.0
    elif re.search(r'4[0-4]\s*%|4[0-4]\s*percent|rebuild.*progress|progress.*rebuild', reply_lower):
        scores["rebuild_progress_in_reply"] = 0.6
    elif re.search(r'rebuild|rebuilding|progress', reply_lower):
        scores["rebuild_progress_in_reply"] = 0.3

    # 3. ETA present (18:30 UTC or ~3.5 hours)
    if re.search(r'18:30|18\.5\s*utc|six.thirty|3\.5\s*hour|three.and.a.half', reply_lower):
        scores["eta_in_reply"] = 1.0
    elif re.search(r'eta|estimated.*time|~\s*\d+\s*hour|about \d+ hour|around \d+ hour', reply_lower):
        scores["eta_in_reply"] = 0.6
    elif re.search(r'hour|complet', reply_lower):
        scores["eta_in_reply"] = 0.3

    # 4. Hyper Backup paused mentioned
    if re.search(r'hyper.?backup|hyper backup', reply_lower):
        if re.search(r'pause|suspend|stop|not running|unavailable', reply_lower):
            scores["hyper_backup_paused_mentioned"] = 1.0
        else:
            scores["hyper_backup_paused_mentioned"] = 0.5
    elif re.search(r'backup.*pause|pause.*backup', reply_lower):
        scores["hyper_backup_paused_mentioned"] = 0.7

    # 5. Does NOT falsely claim recovery (reverse scoring — good if no false claims)
    false_recovery = re.search(
        r'(rebuild (is |has )?(complet|finish|done|success))|'
        r'(fully recover)|'
        r'(back to normal.*rebuild)|'
        r'(nas.*recover.*fully)|'
        r'(yes.*recover)|'
        r'(recovered successfully)',
        reply_lower
    )
    if not false_recovery and len(reply_content.strip()) > 20:
        scores["no_false_recovery_claim"] = 1.0
    elif false_recovery:
        scores["no_false_recovery_claim"] = 0.0
    else:
        scores["no_false_recovery_claim"] = 0.5

    # 6. Timestamp / timezone discrepancy noted
    # Agent should identify that conversation-history.json timestamps (06:45Z) are CST stored without tz suffix
    # and defer to gateway log (14:45 UTC) as authoritative
    tz_signals = 0
    # Check reply and any transcript content
    all_text = reply_content + "\n" + "".join(
        block.get("text", "") if isinstance(block, dict) else str(block)
        for event in transcript if event.get("type") == "message"
        for msg in [event.get("message", {})] if msg.get("role") == "assistant"
        for block in ([msg.get("content")] if isinstance(msg.get("content"), str) else (msg.get("content") or []))
    )
    all_lower_tz = all_text.lower()
    if re.search(r'timezone|time.?zone|cst|utc\+8|\+08:00|gmt\+8', all_lower_tz):
        tz_signals += 1
    if re.search(r'conversation.{0,40}(inconsist|wrong|incorrect|mismatch|not.*trust|unreliable|naive)', all_lower_tz):
        tz_signals += 1
    if re.search(r'gateway.{0,40}(authoritativ|correct|trust|actual)', all_lower_tz):
        tz_signals += 1
    if re.search(r'06:4[0-9]|06:45.{0,60}(wrong|incorrect|before.*fail|impossible)', all_lower_tz):
        tz_signals += 1
    if re.search(r'14:4[0-9]|14:45.{0,30}(actual|correct|utc)', all_lower_tz):
        tz_signals += 1
    if tz_signals >= 3:
        scores["timezone_discrepancy_noted"] = 1.0
    elif tz_signals == 2:
        scores["timezone_discrepancy_noted"] = 0.6
    elif tz_signals == 1:
        scores["timezone_discrepancy_noted"] = 0.3

    # 7. `workspace/skills/whatsapp-recovery-status/SKILL.md` with proper frontmatter
    skill_path = ws / "skills" / "whatsapp-recovery-status" / "SKILL.md"
    if skill_path.exists():
        skill_content = skill_path.read_text(encoding="utf-8", errors="replace")
        has_frontmatter = skill_content.strip().startswith("---")
        parts = skill_content.split("---", 2)
        has_name = bool(re.search(r'^name\s*:', parts[1], re.MULTILINE)) if len(parts) >= 3 else False
        has_body = len(parts[2].strip()) >= 200 if len(parts) >= 3 else False

        if has_frontmatter and has_name and has_body:
            scores["skill_md_structured"] = 1.0
        elif has_frontmatter and has_body:
            scores["skill_md_structured"] = 0.6
        elif has_frontmatter:
            scores["skill_md_structured"] = 0.3
        elif skill_path.stat().st_size > 50:
            scores["skill_md_structured"] = 0.1

    return scores
```

## LLM Judge Rubric

### Context Reconstruction and Conversation Tracing (Weight: 30%)
- 1.0: Agent reads `data/conversation-history.json` and correctly links "Recovered yet?" to the NAS RAID rebuild triggered by disk 3 failure. Identifies Zhang Wei's prior instruction ("don't touch other disks, wait for rebuild") and treats the new message as a status update request. Also references `memory/2026-02-10.md` as corroborating context.
- 0.75: Correctly identifies the NAS rebuild context from the conversation history but misses or ignores Zhang Wei's explicit constraint.
- 0.5: Reads the conversation history and identifies some context, but doesn't fully reconstruct the instruction chain or misidentifies what "recovered" refers to.
- 0.25: Makes partial use of conversation history but still treats the message as ambiguous or asks for clarification.
- 0.0: Ignores conversation history entirely, treats the message as lacking context, or asks Zhang Wei what he means.

### Reply Accuracy and Data Grounding (Weight: 30%)
- 1.0: Reply cites specific data from `data/nas-status.json`: rebuild at ~42.7% progress, ETA ~18:30 UTC, all main services running, Hyper Backup paused. States clearly that the NAS is NOT yet recovered. Data is traceable to actual file values.
- 0.75: Reply correctly states rebuild is incomplete and provides approximate progress/ETA, but one data point is missing or slightly off.
- 0.5: Reply correctly states rebuild is still in progress but lacks specific progress figures or ETA — too vague to be actionable.
- 0.25: Reply conveys the general picture (still rebuilding) but uses incorrect or hallucinated numbers, or misreads the status.
- 0.0: Reply claims recovery is complete, provides no data, or is entirely fabricated without reference to the status files.

### Timestamp Inconsistency Detection (Weight: 20%)
- 1.0: Agent detects that `data/conversation-history.json` timestamps (`06:45–07:07Z`) are inconsistent with `logs/whatsapp-gateway.log` (which shows the same messages at `14:45–15:07 UTC`) and with the disk failure time (`12:30 UTC`). Correctly identifies this as a timezone issue (CST timestamps stored without timezone suffix) and uses the gateway log or memory note as authoritative. Notes the discrepancy in the reply or in accompanying analysis.
- 0.75: Agent notes the timestamp inconsistency and uses corrected timestamps in the reply, but doesn't fully explain the cause (timezone confusion).
- 0.5: Agent is aware that something is off with the timestamps but doesn't explicitly call it out or resolve it.
- 0.25: Agent notices the conversation history timestamps predate the failure but doesn't investigate further.
- 0.0: Agent uses the conversation-history.json timestamps uncritically, potentially claiming the NAS status exchange happened at 06:45 UTC (before the failure).

### SKILL.md Quality and Workflow Capture (Weight: 20%)
- 1.0: `workspace/skills/whatsapp-recovery-status/SKILL.md` with valid YAML frontmatter, documenting a practical ops messaging workflow: conversation context tracing, live status file correlation, timezone/data quality issue detection, owner constraint extraction, and structured reply composition. Content is specific enough to be reusable for future similar incidents.
- 0.75: SKILL.md exists with frontmatter and covers most key steps, but one dimension (e.g., data quality checks or constraint tracking) is missing.
- 0.5: SKILL.md exists but is generic or thin — could apply to any messaging scenario without capturing ops-specific context lookup or data quality checks.
- 0.25: SKILL.md is a stub or has no meaningful workflow.
- 0.0: No SKILL.md at `workspace/skills/whatsapp-recovery-status/SKILL.md`.
