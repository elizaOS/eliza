---
id: task_00094_exam_monitor_system_audit_cron_sync_bug_rate_limit_gap_and_site
name: Exam Monitor System Audit — Cron Sync Bug, Rate Limit Gap, and Site Inventory
category: Research and Information Retrieval
subcategory: Information Retrieval and Verification
difficulty: hard
grading_type: hybrid
grading_weights: {automated: 0.6, llm_judge: 0.4}
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
  - source: pta_monitor.py
    dest: pta_monitor.py
  - source: config/sites.json
    dest: config/sites.json
  - source: config/feishu.json
    dest: config/feishu.json
  - source: config/cron_schedule.conf
    dest: config/cron_schedule.conf
skill_creation: false
---

## Prompt

I haven't touched the exam monitoring system in a while and want to review the current setup before re-enabling it. Can you go through my workspace files and write up a status report in `monitoring-status.md`? I need to know: how many sites are actually verified and enabled, whether the cron and script working hours are properly in sync, and any configuration gaps I should fix before turning it back on.

## Expected Behavior

The agent should read all four workspace files and cross-reference them to produce `monitoring-status.md` containing the following findings:

### 1. Verified and Enabled Site Count

The agent must read `config/sites.json` and count all entries where both `"verified": true` and `"enabled": true`. The correct answer is **9 sites**:

1. China Personnel Examination Network (National) — `http://www.cpta.com.cn`
2. Beijing Personnel Examination — `https://rsj.beijing.gov.cn`
3. Shanghai Professional Exam — `https://www.spta.gov.cn`
4. Guangdong Personnel Examination — `https://rsks.gd.gov.cn`
5. Jiangsu Human Resources Examination — `https://jshrss.jiangsu.gov.cn`
6. Zhejiang Personnel Examination — `https://zjks.rlsbt.zj.gov.cn`
7. Shandong Personnel Examination — `https://hrss.shandong.gov.cn/rsks`
8. Sichuan Personnel Examination — `https://www.scpta.com.cn`
9. Fujian Personnel Examination — `https://www.fjpta.com`

Total sites in config: 22. Not yet verified/enabled: 13 (including Hubei, Hunan, Henan, Anhui, Liaoning, Shaanxi, Chongqing, Tianjin, Hebei, Jiangxi, Yunnan, Guizhou, Gansu). The agent should NOT claim 6 as the original incorrect system prompt implied.

### 2. Critical Bug: Cron/Script Working Hours Mismatch (Off-by-One)

The agent must compare `config/cron_schedule.conf` with the working hours check in `pta_monitor.py`:

- **Cron schedule**: `*/15 9-19 * * *` — this fires at minutes 0, 15, 30, 45 of **hours 9 through 19 inclusive**, meaning the last 4 invocations of the day occur at 19:00, 19:15, 19:30, and 19:45.
- **Script check**: `if not (9 <= now.hour < 19)` — the `< 19` condition causes the script to **immediately return** whenever `now.hour == 19` (i.e., at 7:00 PM and after). The script logs "Outside working hours (19:00). Skipping." and exits.
- **Result**: All 4 cron invocations at 19:00–19:45 are wasted every day. The intent (per `cron_schedule.conf` comment "9:00 AM - 7:00 PM") is for the monitor to run during the 7:00 PM hour.
- **Fix options**:
  - Option A: Change the script condition to `if not (9 <= now.hour <= 19):` (or equivalently `now.hour < 20`) to include the 19:xx window.
  - Option B: Change the cron to `*/15 9-18 * * *` to stop triggering at 19:00 and only fire through 18:45.
  - The agent should recommend one of these options, clearly explaining the trade-off.

### 3. Feishu Rate Limit Configuration Gap

The agent must compare `config/feishu.json` with `pta_monitor.py`:

- `config/feishu.json` defines `"notification_settings": {"max_per_hour": 20, "batch_delay_seconds": 5, ...}`.
- The script's `send_feishu_notification()` function calls `load_feishu_config()` only to extract `webhook_url` and `notify_user_id`. It does **not** read or enforce `max_per_hour` or `batch_delay_seconds`.
- If a large batch of new announcements appears simultaneously (e.g., after a period of downtime), all will trigger notifications without any per-hour cap, potentially flooding the Feishu channel.
- The agent should flag this as a gap and note the fix: implement a per-run or per-hour notification counter that checks against `max_per_hour` from the config.

### 4. Sites Needing Attention

From `config/sites.json`, two sites have explicit failure notes:
- **Hubei** (`http://www.hbrsks.com`): `verified: false`, `notes: "URL needs re-verification, returned 502 on last check"` — the site may have moved or gone down.
- **Henan** (`http://www.hnrsks.com`): `verified: false`, `notes: "Reported 404 intermittently, URL may have changed"` — requires URL research.

The agent should list these as priority re-verification targets.

### 5. Other Observations

- Sichuan site uses `"encoding": "gb2312"` — the script correctly applies `resp.encoding = encoding` per site, so this is handled.
- `time.sleep(2)` between 9 sites = minimum ~18 seconds per monitoring pass; well within the 15-minute interval.
- `feishu.json` `app_secret` is set to `"PLACEHOLDER_DO_NOT_COMMIT_REAL_SECRET"` — confirms this is not a production credential file; agent should note this requires replacement before going live.

**Key traps / common failure modes:**
- Agent reports 6 verified sites (based on outdated inline script in the original task) instead of counting from `config/sites.json` where there are 9 verified+enabled entries.
- Agent misidentifies the cron issue — e.g., saying "the cron fires every 15 minutes outside working hours" instead of correctly diagnosing the off-by-one at hour 19.
- Agent reads the Feishu webhook URL and user ID correctly but misses the `max_per_hour` gap because `load_feishu_config()` is called in the script but only partially used.
- Agent notes the working hours check as correct (or only slightly off) without precisely identifying that hour 19 is the problem.
- Agent attempts to modify any file rather than just producing a `monitoring-status.md` report (the prompt asks only for a status report, not changes).

## Grading Criteria

- [ ] `monitoring-status.md` exists and is non-empty
- [ ] Correctly reports 9 verified+enabled sites (not 6 or other incorrect count)
- [ ] Correctly identifies and explains the cron/script working hours off-by-one bug at hour 19
- [ ] Proposes a concrete fix for the cron/script mismatch (specific code or schedule change)
- [ ] Identifies that `feishu.json` `max_per_hour` is not implemented in the script
- [ ] Mentions Hubei (502) and Henan (404) as sites requiring re-verification
- [ ] Correctly identifies total site count (22) and unverified count (13)
- [ ] Does NOT make unauthorized file changes (prompt only asks for a report)

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os, re
    from pathlib import Path

    scores = {
        "status_file_exists": 0.0,
        "verified_count_correct": 0.0,
        "cron_mismatch_identified": 0.0,
        "rate_limit_gap_identified": 0.0,
        "sites_needing_attention": 0.0,
        "fix_proposed": 0.0,
    }

    status_path = Path(workspace_path) / "monitoring-status.md"
    if not status_path.exists():
        return scores

    with open(status_path, "r", encoding="utf-8") as f:
        content = f.read().lower()

    scores["status_file_exists"] = 1.0

    # Verified count: must say "9" in context of verified/enabled/active sites,
    # AND ideally reference a source file
    count_patterns = [
        r"\b9\b.{0,60}(verified|enabled|active|running)",
        r"(verified|enabled|active|running).{0,60}\b9\b",
        r"\bnine\b.{0,60}(verified|enabled|active)",
    ]
    has_count_match = any(re.search(p, content) for p in count_patterns)
    has_source_ref = any(kw in content for kw in ["sites.json", "feishu.json", "pta_monitor.py"])
    if has_count_match and has_source_ref:
        scores["verified_count_correct"] = 1.0
    elif has_count_match:
        scores["verified_count_correct"] = 0.6
    elif "9" in content and ("verified" in content or "enabled" in content) and has_source_ref:
        scores["verified_count_correct"] = 0.4
    elif "9" in content and ("verified" in content or "enabled" in content):
        scores["verified_count_correct"] = 0.3

    # Cron mismatch: hour 19 / off-by-one issue
    cron_kws = [
        "hour.*19.*skip", "skip.*hour.*19", "< 19", "<19",
        "hour 19", "19:00.*skip", "skip.*19:00",
        "off.by.one", "off by one", "wasted", "discrepancy.*19",
        "9-19.*script", "not.*run.*19", "exits.*19",
    ]
    if any(re.search(kw, content) for kw in cron_kws):
        scores["cron_mismatch_identified"] = 1.0
    elif "19" in content and ("cron" in content or "schedule" in content) and ("script" in content or "check" in content):
        scores["cron_mismatch_identified"] = 0.5

    # Rate limit gap: max_per_hour not enforced
    # Require the specific config field AND evidence that the script doesn't enforce it
    rate_kws_specific = [
        "max_per_hour", "batch_delay",
    ]
    rate_kws_gap = [
        "not enforced", "not implemented", "not used", "unused",
        "ignored", "missing", "gap", "does not enforce", "not read",
    ]
    has_specific = any(kw in content for kw in rate_kws_specific)
    has_gap_lang = any(kw in content for kw in rate_kws_gap)
    has_notification_limit = bool(re.search(r"notification.{0,20}limit", content)) or bool(re.search(r"limit.{0,20}notification", content))
    if has_specific and has_gap_lang:
        scores["rate_limit_gap_identified"] = 1.0
    elif has_specific or has_notification_limit:
        scores["rate_limit_gap_identified"] = 0.5
    elif "feishu" in content and ("config" in content or "setting" in content) and ("gap" in content or "missing" in content or "not" in content):
        scores["rate_limit_gap_identified"] = 0.3

    # Sites needing attention: hubei (502) and henan (404)
    hubei_hit = "hubei" in content and ("502" in content or "verify" in content or "re-verif" in content)
    henan_hit = "henan" in content and ("404" in content or "verify" in content or "re-verif" in content)
    if hubei_hit and henan_hit:
        scores["sites_needing_attention"] = 1.0
    elif hubei_hit or henan_hit:
        scores["sites_needing_attention"] = 0.5

    # Fix proposed: concrete change to cron or script
    fix_kws = [
        r"now\.hour\s*[<>]=?\s*20",
        r"now\.hour\s*<=\s*19",
        r"\*/15\s+9-18",
        r"9-18\s+\*\s+\*\s+\*",
        r"change.*cron.*9-18",
        r"change.*script.*<\s*20",
        r"< 20", r"<= 19", r"<=19", r"< 20\b",
    ]
    if any(re.search(kw, content) for kw in fix_kws):
        scores["fix_proposed"] = 1.0
    elif "fix" in content and ("cron" in content or "script" in content) and "19" in content:
        scores["fix_proposed"] = 0.5

    return scores
```

## LLM Judge Rubric

### Site Inventory Accuracy (Weight: 20%)
Evaluate whether the agent correctly reads `config/sites.json` (22 entries) and reports the exact count of verified+enabled sites as 9, including naming them correctly.

- **1.0**: Agent correctly identifies 9 verified+enabled sites by reading `config/sites.json`; lists them by name (national, Beijing, Shanghai, Guangdong, Jiangsu, Zhejiang, Shandong, Sichuan, Fujian); correctly states 13 unverified and total of 22. Does NOT report 6.
- **0.75**: Agent correctly reports 9 verified sites but is imprecise on unverified count or total; or misses 1 site from the list.
- **0.5**: Agent reports a count close to 9 (e.g., 8) or correctly identifies the majority but misses Shandong or Fujian (less obvious entries).
- **0.25**: Agent reports 6 (old incorrect count) or another clearly wrong number without reading `config/sites.json`.
- **0.0**: Agent does not count verified sites at all, or completely ignores `config/sites.json`.

### Cron / Script Working Hours Mismatch (Weight: 35%)
Evaluate whether the agent correctly identifies the off-by-one bug: cron fires at hour 19 but script condition `now.hour < 19` causes immediate exit. This is the core technical finding.

- **1.0**: Agent precisely diagnoses the issue: cron `9-19` fires at 19:00/15/30/45; script condition `< 19` causes all hour-19 runs to exit immediately; states 4 wasted invocations per day; proposes either changing the script to `< 20` (or `<= 19`) OR the cron to `9-18`, with clear reasoning.
- **0.75**: Agent identifies the mismatch between cron and script working hours check but is imprecise about which specific hours are affected, or proposes a fix without full explanation.
- **0.5**: Agent notes that the cron schedule and script working hours might not align but doesn't specifically pinpoint hour 19 as the problematic boundary.
- **0.25**: Agent mentions the cron or script in passing but doesn't compare them or draw a conclusion about the working hours alignment.
- **0.0**: Agent does not read or compare `cron_schedule.conf` with `pta_monitor.py`; no mention of working hours inconsistency.

### Feishu Rate Limit Configuration Gap (Weight: 25%)
Evaluate whether the agent cross-references `config/feishu.json` with `pta_monitor.py` and identifies that `max_per_hour: 20` is defined but not enforced.

- **1.0**: Agent reads `feishu.json`, notes `notification_settings.max_per_hour: 20` and `batch_delay_seconds: 5`; traces to `send_feishu_notification()` in the script; confirms these fields are loaded only for `webhook_url` and `notify_user_id`, leaving the rate cap unenforced; explains the risk (notification flood on restart after downtime) and suggests implementing a counter or queue.
- **0.75**: Agent identifies the `max_per_hour` gap and notes it's not implemented, but doesn't fully explain the risk or suggest a fix.
- **0.5**: Agent reads `feishu.json` and mentions it has notification settings, but doesn't verify whether the script actually implements them.
- **0.25**: Agent mentions Feishu configuration in passing but draws no useful conclusion about the gap.
- **0.0**: Agent ignores `feishu.json` or the Feishu notification logic in the script entirely.

### Report Quality and Actionability (Weight: 20%)
Evaluate whether `monitoring-status.md` is comprehensive, well-structured, and provides actionable next steps including sites needing re-verification (Hubei 502, Henan 404).

- **1.0**: Report covers all four key areas (site inventory, cron/script sync, Feishu gaps, priority re-verification targets), flags Hubei and Henan by name with their failure modes (502 and 404 respectively), notes the `app_secret` placeholder, and provides concrete recommended actions before re-enabling the system.
- **0.75**: Report covers most key areas with specific details; one area missing or incomplete; mentions at least one of Hubei/Henan.
- **0.5**: Report exists with some relevant information but is superficial — mentions a few issues without specifics or actionable steps.
- **0.25**: Report exists but is largely generic or misses the main findings (e.g., focuses on adding new sites rather than auditing existing ones).
- **0.0**: `monitoring-status.md` does not exist, or contains only a placeholder with no substantive analysis.
