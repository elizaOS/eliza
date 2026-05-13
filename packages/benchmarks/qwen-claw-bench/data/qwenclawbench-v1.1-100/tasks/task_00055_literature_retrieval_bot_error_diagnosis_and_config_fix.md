---
id: task_00055_literature_retrieval_bot_error_diagnosis_and_config_fix
name: Literature Retrieval Bot Error Diagnosis and Config Fix
category: Research and Information Retrieval
subcategory: Academic and Thematic Research
grading_type: hybrid
grading_weights:
  automated: 0.4
  llm_judge: 0.6
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: scripts/verified_rss_sources.py
  dest: scripts/verified_rss_sources.py
- source: scripts/real_rss_literature_retrieval.py
  dest: scripts/real_rss_literature_retrieval.py
- source: scripts/stable_literature_retrieval.py
  dest: scripts/stable_literature_retrieval.py
- source: literature_results/master_progress_tracker.json
  dest: literature_results/master_progress_tracker.json
- source: literature_results/run_history_summary.json
  dest: literature_results/run_history_summary.json
- source: cron_logs/cron_execution_20260210_145000.json
  dest: cron_logs/cron_execution_20260210_145000.json
- source: cron_logs/cron_execution_20260210_133000.json
  dest: cron_logs/cron_execution_20260210_133000.json
- source: cron_logs/cron_execution_20260209_220000.json
  dest: cron_logs/cron_execution_20260209_220000.json
- source: cron_config.json
  dest: cron_config.json
---

## Prompt

My literature bot has been accumulating errors — the progress tracker shows 57 errors and a "degraded" status, but I'm not sure where to start fixing things. Scripts are in `scripts/`, the cron logs are in `cron_logs/`, the main progress tracker is at `literature_results/master_progress_tracker.json`, there's an error summary at `literature_results/run_history_summary.json`, and the cron scheduler config is at `cron_config.json`. Can you go through everything and figure out what the root causes are? I need:

1. A `diagnostic_report.md` in the workspace root that explains the root causes with specific evidence.
2. A `bug_fixes.json` listing the bugs you found, ordered by priority.
3. Fix any obvious configuration mistake you find directly in the files.
4. Initialize a git repo so I can start tracking changes.

## Expected Behavior

The agent must read and cross-reference all 9 workspace files to surface three distinct bugs, fix the most critical one, and produce two structured deliverables.

**Bug 1 (Critical — root cause of 21/57 errors): cron_config.json overrides disabled source**

- `verified_rss_sources.py` has `medrxiv_infectious.enabled: False` with note "Rate limited since 2026-02-09, re-enable after cooldown"
- `cron_config.json` has `source_overrides.medrxiv_infectious.enabled: true` with comment "TODO: disable after testing — NEVER DONE"
- All 3 cron logs show `medrxiv_infectious` errors despite it being disabled in the source config
- The `run_history_summary.json` note explicitly states errors persist after the source was disabled
- Evidence: every log shows `sources_attempted: 6` but only 5 sources are enabled in `verified_rss_sources.py`
- Fix: remove or set `enabled: false` in `cron_config.json source_overrides.medrxiv_infectious`

**Bug 2 (Medium — schema mismatch between tracker versions):**

- `master_progress_tracker.json` uses fields: `total_papers_found`, `retrieval_runs`, `errors_encountered` (old schema)
- Both `real_rss_literature_retrieval.py` and `stable_literature_retrieval.py` write: `total_articles`, `runs` (new schema)
- When a script runs successfully, it appends to a non-existent `articles` key and sets `total_articles` while ignoring `total_papers_found` — the tracker accumulates both formats, making counts unreliable
- No fix required for the tracker itself; the report should identify this and recommend a migration

**Bug 3 (Low — Nature Microbiology RSS sometimes returns HTML):**

- `nature_micro` accounts for all 14 `ValueError_html_feed` errors in `run_history_summary.json`
- `stable_literature_retrieval.py` already handles this with a `ValueError` check, but it still counts as a failed source per run
- Root cause: Nature's CDN occasionally returns an error page in HTML; code could add retry-with-backoff logic

**Expected `diagnostic_report.md`:**
- Must identify Bug 1 as the top priority with specific evidence: cron_config.json override vs verified_rss_sources.py disabled state, 21 errors, `sources_attempted: 6` vs 5 enabled sources
- Must identify Bug 2 by naming the mismatched fields (`total_papers_found` vs `total_articles`, `retrieval_runs` vs `runs`)
- Must reference specific file names and numeric values from the workspace

**Expected `bug_fixes.json`:**
```json
{
  "bugs": [
    {
      "id": "BUG-001",
      "priority": "critical",
      "title": "cron_config.json overrides disabled medrxiv_infectious source",
      "root_cause": "source_overrides.medrxiv_infectious.enabled is true in cron_config.json, overriding the disabled flag in verified_rss_sources.py",
      "error_count": 21,
      "fix": "Remove or disable medrxiv_infectious entry in cron_config.json source_overrides"
    },
    {
      "id": "BUG-002",
      "priority": "medium",
      "title": "Schema mismatch between master_progress_tracker.json and retrieval scripts",
      "root_cause": "Tracker uses total_papers_found/retrieval_runs but scripts write total_articles/runs",
      "fix": "Migrate tracker to new schema or update scripts to preserve backward-compatible fields"
    },
    {
      "id": "BUG-003",
      "priority": "low",
      "title": "nature_micro RSS occasionally returns HTML instead of XML",
      "root_cause": "Nature CDN returns HTML error pages; code raises ValueError but no retry is attempted",
      "error_count": 14,
      "fix": "Add retry-with-backoff for ValueError in fetch_rss_urllib"
    }
  ]
}
```

**Expected cron_config.json fix:**
The agent should modify `cron_config.json` to either remove the `medrxiv_infectious` key from `source_overrides` or set it to `enabled: false`.

**Expected git initialization:**
Running `git init` so that `.git/HEAD` exists.

## Grading Criteria

- [ ] diagnostic_report.md exists and identifies medrxiv_infectious/cron_config override as the top root cause with specific evidence
- [ ] diagnostic_report.md identifies the schema mismatch between tracker fields and script output fields by name
- [ ] bug_fixes.json exists and contains at least 2 structured bug entries with priorities
- [ ] cron_config.json is fixed: medrxiv_infectious source_override removed or set to enabled:false
- [ ] git repository initialized (.git/HEAD exists)

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    import json
    import re

    scores = {
        "diagnostic_report_exists": 0.0,
        "medrxiv_root_cause_identified": 0.0,
        "schema_mismatch_identified": 0.0,
        "bug_fixes_json_quality": 0.0,
        "cron_config_fixed": 0.0,
        "git_initialized": 0.0,
    }

    diag_path = os.path.join(workspace_path, "diagnostic_report.md")
    if not os.path.isfile(diag_path):
        return scores

    scores["diagnostic_report_exists"] = 1.0

    try:
        with open(diag_path, "r", encoding="utf-8") as f:
            diag = f.read().lower()
    except Exception:
        return scores

    # medrxiv root cause: must connect cron_config override to the persistent errors
    medrxiv_ok = "medrxiv" in diag
    # Require specific file name or field, not just the generic word "override"
    cron_cfg_ok = "cron_config" in diag or "source_override" in diag
    rate_limit_ok = "rate limit" in diag or "429" in diag or "rate-limit" in diag
    # Also accept: "enabled: true" contradiction mentioned alongside cron_config
    enabled_contradiction = bool(
        re.search(r"enabled.*true.*cron_config|cron_config.*enabled.*true", diag)
        or ("enabled" in diag and cron_cfg_ok and medrxiv_ok)
    )
    if medrxiv_ok and cron_cfg_ok and (rate_limit_ok or enabled_contradiction):
        scores["medrxiv_root_cause_identified"] = 1.0
    elif medrxiv_ok and rate_limit_ok:
        scores["medrxiv_root_cause_identified"] = 0.5
    elif medrxiv_ok and cron_cfg_ok:
        scores["medrxiv_root_cause_identified"] = 0.4

    # Schema mismatch: must name at least two of the mismatched field names
    schema_keywords = ["total_papers_found", "total_articles", "retrieval_runs", "schema", "seen_ids"]
    hits = sum(1 for k in schema_keywords if k in diag)
    if hits >= 2:
        scores["schema_mismatch_identified"] = 1.0
    elif hits == 1:
        scores["schema_mismatch_identified"] = 0.4

    # bug_fixes.json quality
    bf_path = os.path.join(workspace_path, "bug_fixes.json")
    if os.path.isfile(bf_path):
        try:
            with open(bf_path, "r", encoding="utf-8") as f:
                bf_data = json.load(f)
            bugs = bf_data.get("bugs", bf_data) if isinstance(bf_data, dict) else bf_data
            if isinstance(bugs, list):
                bf_str = json.dumps(bugs).lower()
                has_medrxiv = "medrxiv" in bf_str
                has_schema = any(k in bf_str for k in ["schema", "total_articles", "total_papers_found"])
                has_priority = any("priority" in (str(b).lower() if not isinstance(b, dict) else " ".join(str(v).lower() for v in b.values())) for b in bugs)
                score = 0.0
                if len(bugs) >= 2:
                    score += 0.25
                if has_medrxiv:
                    score += 0.35
                if has_schema:
                    score += 0.20
                if has_priority:
                    score += 0.10
                # Bonus for structured bug entries with IDs
                has_ids = any(
                    isinstance(b, dict) and (
                        re.search(r'bug.{0,5}0{0,2}[0-9]', str(b.get("id", "")), re.IGNORECASE)
                    )
                    for b in bugs
                )
                if has_ids:
                    score += 0.10
                scores["bug_fixes_json_quality"] = min(score, 1.0)
            elif isinstance(bf_data, dict) and bf_data:
                scores["bug_fixes_json_quality"] = 0.2
        except Exception:
            scores["bug_fixes_json_quality"] = 0.05

    # cron_config.json fixed: medrxiv_infectious override removed or disabled
    cron_cfg_path = os.path.join(workspace_path, "cron_config.json")
    if os.path.isfile(cron_cfg_path):
        try:
            with open(cron_cfg_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            overrides = cfg.get("source_overrides", {})
            medrxiv_entry = overrides.get("medrxiv_infectious", None)
            if medrxiv_entry is None:
                scores["cron_config_fixed"] = 1.0
            elif isinstance(medrxiv_entry, dict) and not medrxiv_entry.get("enabled", True):
                scores["cron_config_fixed"] = 1.0
            else:
                scores["cron_config_fixed"] = 0.0
        except Exception:
            scores["cron_config_fixed"] = 0.0

    # git initialized
    git_head = os.path.join(workspace_path, ".git", "HEAD")
    if os.path.isfile(git_head):
        scores["git_initialized"] = 1.0

    return scores
```

## LLM Judge Rubric

### Root Cause Identification — cron_config Override (Weight: 30%)
- 1.0: Agent explicitly connects cron_config.json source_overrides.medrxiv_infectious (enabled:true) to the persistent errors despite the source being disabled in verified_rss_sources.py, cites the "TODO: disable after testing — NEVER DONE" evidence, and explains that this accounts for 21 of 57 errors and the sources_attempted:6 anomaly in the logs.
- 0.75: Agent identifies medrxiv_infectious as the top error source and references the cron_config override, but does not fully trace the contradiction between the two files.
- 0.5: Agent notes that medrxiv_infectious errors persist despite being marked disabled, but does not identify cron_config.json as the cause.
- 0.25: Agent mentions medrxiv_infectious errors without understanding why the disable setting has no effect.
- 0.0: Agent does not identify medrxiv_infectious as the primary root cause.

### Cross-file Evidence and Reasoning Quality (Weight: 25%)
- 1.0: All diagnostic claims cite specific values from actual workspace files — e.g., the sources_attempted:6 vs 5 enabled sources discrepancy across logs, the 21/57 error attribution, the exact field names from the schema mismatch, and the exact cron_config override text.
- 0.75: Most claims reference actual file contents with specific values; one or two conclusions are stated without explicit file evidence.
- 0.5: Report synthesizes findings from at least 5 files with some specific values cited, but several key connections are asserted without quoting evidence.
- 0.25: Report mostly paraphrases file contents rather than cross-referencing them; misses at least one of the three bugs.
- 0.0: Report is generic or does not demonstrate having read the specific workspace files.

### Schema Mismatch Analysis (Weight: 20%)
- 1.0: Agent correctly identifies the schema mismatch by naming the conflicting fields (e.g., total_papers_found vs total_articles, retrieval_runs vs runs), explains the consequence (double-counting, unreliable totals), and proposes a migration strategy.
- 0.75: Agent identifies the schema mismatch with at least one named field pair and explains the impact.
- 0.5: Agent notes that the tracker format is inconsistent with the scripts but does not name specific fields.
- 0.25: Agent vaguely mentions tracker data might be unreliable without pinpointing the mismatch.
- 0.0: Schema mismatch not identified.

### Fix Quality and Git Initialization (Weight: 15%)
- 1.0: cron_config.json is correctly modified (medrxiv_infectious override removed or set to enabled:false), and git repo is initialized.
- 0.75: One of the two tasks done correctly; the other has a minor flaw (e.g., git init run but cron_config partially edited).
- 0.5: cron_config.json is modified but incorrectly (e.g., wrong field changed, JSON broken); or git init not attempted.
- 0.25: Only git init completed with no cron_config change.
- 0.0: Neither task completed.

### Report Structure and Prioritization (Weight: 10%)
- 1.0: bug_fixes.json lists bugs in priority order with structured entries; diagnostic_report.md has clear sections separating root causes from recommendations; highest-impact bug (cron override) is explicitly marked as most critical.
- 0.75: Prioritization present but inconsistent (e.g., schema mismatch listed as higher priority than cron override); structure mostly clear.
- 0.5: Both deliverables exist and are readable but lack explicit prioritization or have structural gaps.
- 0.25: Only one deliverable produced or content is poorly organized.
- 0.0: Neither diagnostic_report.md nor bug_fixes.json written.
