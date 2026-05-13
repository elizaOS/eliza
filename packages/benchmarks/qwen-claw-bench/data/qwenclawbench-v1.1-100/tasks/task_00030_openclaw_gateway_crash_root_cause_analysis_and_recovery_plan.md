---
id: task_00030_openclaw_gateway_crash_root_cause_analysis_and_recovery_plan
name: OpenClaw Gateway Crash Root-Cause Analysis and Recovery Plan
category: System Operations and Administration
subcategory: System Operations and Monitoring
grading_type: hybrid
grading_weights:
  automated: 0.5
  llm_judge: 0.5
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: scripts/check_openclaw.sh
  dest: scripts/check_openclaw.sh
- source: etc/systemd/system/openclaw.service
  dest: etc/systemd/system/openclaw.service
- source: scripts/backup_config.sh
  dest: scripts/backup_config.sh
- source: etc/openclaw/plugins.json
  dest: etc/openclaw/plugins.json
- source: etc/openclaw/gateway.yaml
  dest: etc/openclaw/gateway.yaml
- source: scripts/rotate_logs.sh
  dest: scripts/rotate_logs.sh
- source: var/log/gateway-error.log
  dest: var/log/gateway-error.log
- source: proc/ps_output.txt
  dest: proc/ps_output.txt
- source: var/log/openclaw-monitor.log
  dest: var/log/openclaw-monitor.log
- source: var/log/gateway.log
  dest: var/log/gateway.log
---

## Prompt

The system-gateway-monitor cron job just fired again with a "process not found" alert for openclaw. I've dropped the relevant system snapshot files into the workspace (`proc/ps_output.txt`, `var/log/openclaw-monitor.log`, `var/log/gateway-error.log`, `var/log/gateway.log`, `etc/openclaw/gateway.yaml`, `etc/systemd/system/openclaw.service`). Can you go through them and figure out what's actually going on — how many times has it crashed, what's causing it, and whether we can safely restart it right now? Write up your findings and recommendations to `openclaw-diagnosis.md`.

## Expected Behavior

The agent should:

1. **Confirm current process status**: Read `proc/ps_output.txt` and verify openclaw is absent from the process list. The file lists all running processes — openclaw does not appear, confirming it is currently down.

2. **Reconstruct crash history from `var/log/openclaw-monitor.log`**: The monitor log shows:
   - PID 14823 running stably from 02:15 to 03:15 (every 5 minutes — 13 healthy checks)
   - 03:20:01: NOT running (first crash, first down event)
   - 03:20:03–03:20:06: Restart attempted → PID 15102 started successfully
   - 03:25–03:40: PID 15102 running (4 healthy checks)
   - 03:42:18: NOT running (second crash, second down event)
   - 03:42:22: Failed to start — port 3000 in use; stale process killed at 03:42:25; retry succeeded at 03:42:30 → PID 15387
   - 03:45–03:48: PID 15387 running (2 healthy checks)
   - After 03:48: No further entries → third crash (most recent, current down state)
   - Total: 3 crash events; most recent crash occurred after 03:48 with no subsequent recovery

3. **Identify root causes from `var/log/gateway-error.log`**:
   - First crash (03:20:06.445+08:00): SIGTERM received — graceful shutdown; 2 active sessions were terminated. This was an external termination signal.
   - Second crash (03:40:11.223+08:00): **OOM killer triggered — memory usage exceeded limit: 512MB**. This is a non-recoverable memory pressure event.
   - The third crash (after 03:48, currently down) is not explicitly logged in gateway-error.log, but the pattern strongly suggests another OOM event given the recurring nature.

4. **Cross-reference `var/log/gateway.log`**: Confirms PID 15387 started at 03:42:30, loaded config, connected to remote, restored one session, and was last seen at 03:48:00 (second heartbeat check). Log ends at 03:48 with no shutdown entry — consistent with a sudden OOM kill after that point.

5. **Read `etc/openclaw/gateway.yaml`**: Identify `sessions.maxConcurrent: 5`. Each session consumes significant memory; with up to 5 concurrent sessions active, the gateway can exceed the 512 MB OOM threshold. This is the likely root cause of the memory pressure.

6. **Assess restart safety**: Restarting openclaw immediately without changing the configuration will likely result in another OOM crash within minutes, repeating the same pattern (as seen with PID 15102 and 15387). A configuration change is recommended before restarting.

7. **Identify the correct start command**: Systemd is available (systemd-journald and systemd-logind are visible in `proc/ps_output.txt`). The correct command is `systemctl start openclaw` (uses the `etc/systemd/system/openclaw.service` unit). Alternatively: `/usr/local/bin/openclaw gateway start --foreground` (per ExecStart in the service file). The agent should recognize that `scripts/backup_config.sh` and `scripts/rotate_logs.sh` are unrelated to the recovery task.

8. **Write `openclaw-diagnosis.md`** with the following content:
   - Current status: openclaw is NOT running (confirmed by ps_output.txt)
   - Crash timeline with at least crash counts, timestamps (03:20, 03:40, post-03:48), and PID progression (14823 → 15102 → 15387 → dead)
   - Root cause analysis: OOM killer is the recurring cause (memory > 512MB); first crash was SIGTERM (different cause)
   - Config issue: `maxConcurrent: 5` in `etc/openclaw/gateway.yaml` should be reduced (e.g., to 2 or 3) to limit per-process memory consumption
   - Recovery recommendation: Update `sessions.maxConcurrent` in `gateway.yaml` before restarting; do NOT restart immediately without this change
   - Restart command: `systemctl start openclaw`

**Key traps / common failure modes:**
- Agent reads only `ps_output.txt` and says "not running, let's restart" without investigating why it keeps crashing
- Agent identifies only 2 crashes instead of 3 (misses the post-03:48 current crash)
- Agent conflates SIGTERM (first crash) with OOM (second/third crashes) as the same root cause
- Agent recommends immediate restart without flagging the OOM risk from unchanged config
- Agent wastes time on distractor files (`backup_config.sh`, `rotate_logs.sh`) and includes irrelevant analysis
- Agent suggests `openclaw gateway start` without recognizing systemd is available (sub-optimal recovery path)
- Agent fails to link `maxConcurrent: 5` in `gateway.yaml` to the 512MB memory limit breach

## Grading Criteria

- [ ] `openclaw-diagnosis.md` exists and is non-empty
- [ ] Correctly identifies openclaw as NOT running (based on `proc/ps_output.txt` — process absent from list)
- [ ] Identifies OOM killer / memory exceeded 512MB as the root cause of at least one crash (from `gateway-error.log`)
- [ ] Reconstructs crash timeline with at least 3 crash events and correct PID progression (14823 → 15102 → 15387 → down)
- [ ] Correctly distinguishes the first crash (SIGTERM) from the subsequent OOM crashes
- [ ] Links `sessions.maxConcurrent: 5` in `gateway.yaml` to the memory pressure issue
- [ ] Warns that restarting without config change will likely cause another OOM crash
- [ ] Provides the correct restart command (`systemctl start openclaw` or equivalent per service file)
- [ ] Ignores distractor scripts (backup_config.sh, rotate_logs.sh) — no spurious analysis of these

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os, re

    scores = {
        "diagnosis_file_exists": 0.0,
        "process_not_running_identified": 0.0,
        "oom_root_cause_identified": 0.0,
        "crash_timeline_accurate": 0.0,
        "config_fix_recommended": 0.0,
        "start_command_correct": 0.0,
        "distractor_not_analyzed": 1.0,
    }

    diag_path = os.path.join(workspace_path, "openclaw-diagnosis.md")
    if not os.path.exists(diag_path):
        return scores

    with open(diag_path, "r", encoding="utf-8") as f:
        content = f.read()
    cl = content.lower()

    scores["diagnosis_file_exists"] = 1.0

    # Current status: not running
    not_running_kws = ["not running", "not found", "no openclaw", "process is down", "stopped", "crashed", "is down", "absent"]
    if any(kw in cl for kw in not_running_kws):
        scores["process_not_running_identified"] = 1.0

    # OOM root cause — must also show link to config (maxConcurrent)
    oom_present = any(kw in cl for kw in ["oom", "out of memory", "oom killer"])
    config_linked = bool(re.search(r'maxconcurrent|max.{0,5}concurrent|session.{0,10}limit', cl))
    if oom_present and config_linked:
        scores["oom_root_cause_identified"] = 1.0
    elif oom_present:
        scores["oom_root_cause_identified"] = 0.6

    # Crash timeline accuracy:
    # Require structured evidence: all 3 PIDs must be present AND at least 2 timestamps AND
    # the correct crash count (3 crashes) — not just scattered tokens
    has_all_pids = all(pid in content for pid in ["14823", "15102", "15387"])
    has_timestamps = sum(1 for ts in ["03:20", "03:40", "03:48"] if ts in content)
    has_crash_count = bool(re.search(r'(3\s*crash|three\s*crash|crashed\s*3|3\s*times)', cl))
    has_sigterm = "sigterm" in cl
    if has_all_pids and has_timestamps >= 2 and has_crash_count:
        scores["crash_timeline_accurate"] = 1.0
    elif has_all_pids and has_timestamps >= 2:
        scores["crash_timeline_accurate"] = 0.7
    elif has_all_pids or (has_timestamps >= 2 and has_crash_count):
        scores["crash_timeline_accurate"] = 0.4
    elif has_sigterm and has_timestamps >= 1:
        scores["crash_timeline_accurate"] = 0.2

    # Config fix recommendation: maxConcurrent must be present with a recommended value (2 or 3)
    has_max_concurrent = bool(re.search(r'maxconcurrent|max.{0,5}concurrent', cl))
    has_lower_value = bool(re.search(r'(reduce|lower|decrease|set.{0,20}to).{0,30}[23]\b|[23]\b.{0,30}(or fewer|or less|max)', cl))
    if has_max_concurrent and has_lower_value:
        scores["config_fix_recommended"] = 1.0
    elif has_max_concurrent:
        scores["config_fix_recommended"] = 0.5

    # Start command: systemctl or correct binary path
    start_kws = ["systemctl start openclaw", "openclaw gateway start --foreground", "openclaw gateway start"]
    if any(kw in cl for kw in start_kws):
        scores["start_command_correct"] = 1.0
    elif "systemctl" in cl and "openclaw" in cl:
        scores["start_command_correct"] = 0.5

    # Distractor check: penalize if backup_config.sh or rotate_logs.sh are analyzed
    if bool(re.search(r'(backup_config|rotate_logs).{0,80}(analyz|found|check|review|examin|inspect)', cl)):
        scores["distractor_not_analyzed"] = 0.0
    elif bool(re.search(r'(backup_config|rotate_logs)', cl)) and \
            bool(re.search(r'(not relevant|unrelated|distractor|skip|ignor|excluded)', cl)):
        # Mentioned but correctly dismissed
        scores["distractor_not_analyzed"] = 1.0
    elif bool(re.search(r'(backup_config|rotate_logs)', cl)):
        # Appeared in the report without explicit dismissal — uncertain
        scores["distractor_not_analyzed"] = 0.5

    return scores
```

## LLM Judge Rubric

### Process Status Investigation and Evidence Quality (Weight: 20%)
Evaluate whether the agent correctly read `proc/ps_output.txt` to confirm openclaw is absent, and grounded all status claims in the actual file contents rather than guessing.

- **1.0**: Agent explicitly reads and cites `proc/ps_output.txt`; correctly concludes openclaw is NOT running with reference to the process list; no hallucinated PIDs or status.
- **0.75**: Agent correctly identifies openclaw is not running with reasonable evidence; minor omission in citing exact source.
- **0.5**: Agent states openclaw is not running but does not ground the claim in `ps_output.txt`, or conflates it with log data.
- **0.25**: Agent makes uncertain or partially correct claims about process status without clear evidence.
- **0.0**: Agent fails to check process status, or incorrectly reports openclaw as running. No deliverable or completely fabricated information.

### Crash Timeline Reconstruction (Weight: 25%)
Evaluate whether the agent correctly reads `var/log/openclaw-monitor.log` and `var/log/gateway.log` to reconstruct the full crash history including all 3 crash events and PID progression (14823 → 15102 → 15387 → dead).

- **1.0**: Agent accurately reconstructs all 3 crash events with correct timestamps (03:20, 03:40, post-03:48), PID progression, and notes the third crash is inferred from log ending at 03:48 with no further monitor entries.
- **0.75**: Agent identifies at least 2 crash events with timestamps and PID changes; minor error or omission in the third crash.
- **0.5**: Agent identifies that the process crashed and was restarted multiple times but lacks specific timestamps, PIDs, or misses the third crash entirely.
- **0.25**: Agent mentions crashes occurred but without timeline accuracy or PID details.
- **0.0**: Agent ignores crash history entirely or produces fabricated timeline data.

### Root Cause Analysis — OOM Identification and Config Link (Weight: 35%)
Evaluate whether the agent correctly identifies the OOM killer as the recurring root cause from `var/log/gateway-error.log`, distinguishes it from the SIGTERM first crash, and links `sessions.maxConcurrent: 5` in `gateway.yaml` to the memory pressure. This is the core analytical challenge.

- **1.0**: Agent correctly identifies OOM killer + 512MB limit breach as root cause from `gateway-error.log`; correctly notes the first crash was SIGTERM (different cause); explicitly links `maxConcurrent: 5` in `gateway.yaml` to the memory issue; warns that restarting without reducing `maxConcurrent` will likely cause another OOM crash.
- **0.75**: Agent identifies OOM root cause and mentions `maxConcurrent` but does not distinguish first SIGTERM crash, or misses the forward-looking restart warning.
- **0.5**: Agent identifies OOM/memory issue as the cause but does not read or reference `gateway.yaml`; no concrete config recommendation.
- **0.25**: Agent notes "memory issue" or "crash" in passing without specific evidence from error log or config file.
- **0.0**: Agent attributes all crashes to SIGTERM or ignores root cause entirely; recommends immediate restart without any analysis. No deliverable.

### Engineering Focus and Distractor Avoidance (Weight: 5%)
Evaluate whether the agent correctly focuses on the core gateway process files (monitor log, error log, gateway log, config, service) and does NOT produce analysis of irrelevant scripts (`backup_config.sh`, `rotate_logs.sh`).

- **1.0**: Agent analyzes only the relevant files; explicitly or implicitly ignores distractor scripts; no spurious findings about backup or rotation scripts.
- **0.5**: Agent briefly mentions distractor scripts but correctly concludes they are irrelevant.
- **0.0**: Agent produces substantive analysis of `backup_config.sh` or `rotate_logs.sh` and presents findings as relevant to the diagnosis.


Evaluate whether `openclaw-diagnosis.md` is complete, well-structured, and provides an actionable recovery plan with correct start command.

- **1.0**: `openclaw-diagnosis.md` contains: confirmed status (not running), crash timeline, OOM root cause, explicit config change recommendation (reduce `maxConcurrent`) with specific value or direction, and correct restart command (`systemctl start openclaw` or per service file). Distractor scripts not mentioned or correctly identified as irrelevant.
- **0.75**: Diagnosis file is mostly complete; one minor element missing (e.g., no specific config value, or restart command slightly off).
- **0.5**: Diagnosis file exists and covers status + root cause, but lacks config fix recommendation or restart command.
- **0.25**: Diagnosis file exists but is superficial — e.g., only says "not running, restart it" without root cause or config analysis.
- **0.0**: `openclaw-diagnosis.md` does not exist, or contains only a placeholder with no meaningful analysis.
