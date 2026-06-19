---
id: task_00012_a_stock_fetcher_system_audit_bug_identification_and_data_integrity_check
name: A-Stock Fetcher System Audit — Bug Identification and Data Integrity Check
category: Workflow and Agent Orchestration
subcategory: Workflow and Task Scheduling
grading_type: hybrid
grading_weights:
  automated: 0.5
  llm_judge: 0.5
timeout_seconds: 1800
input_modality: text-only
external_dependency: none
workspace_files:
- source: a_stock_announcements/fetch_state.json
  dest: a_stock_announcements/fetch_state.json
- source: a_stock_announcements/run_scheduled_fetch.py
  dest: a_stock_announcements/run_scheduled_fetch.py
- source: a_stock_announcements/config.yaml
  dest: a_stock_announcements/config.yaml
- source: a_stock_announcements/requirements.txt
  dest: a_stock_announcements/requirements.txt
- source: a_stock_announcements/output/announcements_2026-02-09.json
  dest: a_stock_announcements/output/announcements_2026-02-09.json
---

## Prompt

The A-stock announcements fetcher has been running for a while and I want to do a quick audit before the Feb 10 market session opens. Can you look at `a_stock_announcements/fetch_state.json`, the output data in `a_stock_announcements/output/`, the script `run_scheduled_fetch.py`, and the config, then write up a `fetch-audit.md` inside `a_stock_announcements/` covering: any bugs you find in the code, gaps in the output data vs state, and a breakdown of flagged announcements from the last fetch run?

## Expected Behavior

The agent should read all five workspace files and cross-reference them to produce `a_stock_announcements/fetch-audit.md` containing the following findings:

### 1. State vs Output Consistency Check

- `fetch_state.json` contains 35 `seen_ids` and `last_fetch_ts: "2026-02-09T17:16:02.384192"`.
- The only output file in `output/` is `announcements_2026-02-09.json`, which contains **11 announcement records**.
- Comparison reveals a discrepancy: **24 `seen_ids`** (IDs `1256789401` through `1256789515`) appear in the state file but have no corresponding announcement records in any output file in the workspace. These 24 IDs were apparently tracked in earlier fetch runs whose output files (`announcements_YYYY-MM-DD.json` for prior dates) are absent. The agent should flag this gap and note it may indicate output file purging (consistent with `output.retention_days: 30` in config), migration, or data loss.

### 2. Missing CSV Output

- `config.yaml` sets `output.csv_summary: true`. The script's `save_announcements()` function calls `save_csv_summary()` only when this config flag is true. Therefore, every successful fetch run should produce a `summary_YYYY-MM-DD.csv` alongside the JSON.
- **No CSV file exists** in `a_stock_announcements/output/` — specifically `summary_2026-02-09.csv` is absent despite the JSON being present. The agent must flag this as a missing expected output.

### 3. Deduplication Bug in `run_scheduled_fetch.py`

The agent must identify this specific bug in `deduplicate()`:

```python
state["seen_ids"] = list(seen)[-5000:]
```

- `seen` is a Python `set`. Converting a `set` to `list` yields **non-deterministic ordering** (CPython implementation detail; ordering is not guaranteed). The `[-5000:]` slice is intended to retain the 5000 most recently seen IDs to prevent unbounded state growth, but since the list order is arbitrary, it may drop recently-added IDs and retain old ones — defeating the purpose of the cap and potentially causing previously-seen announcements to be re-fetched in future runs.
- The correct fix is to sort the IDs before slicing: `state["seen_ids"] = sorted(seen, key=int)[-5000:]` — this retains the 5000 numerically largest IDs, which (because cninfo announcement IDs increase monotonically) correspond to the most recently published announcements.

### 4. Important Announcements Breakdown

From `output/announcements_2026-02-09.json`, the agent must filter all records where `"important": true` and list them. There are exactly **5 important announcements**:

| announcementId | secCode | secName | announcementTitle |
|---|---|---|---|
| 1256789520 | 000001 | Ping An Bank | 2025 Annual Results Pre-announcement |
| 1256789535 | 601318 | Ping An Insurance | January 2026 Premium Income Announcement |
| 1256789540 | 300750 | CATL | Announcement on Signing Major Contract for Energy Storage Project |
| 1256789550 | 601899 | Zijin Mining | Announcement on Progress of Overseas Acquisition Project |
| 1256789565 | 600036 | China Merchants Bank | Announcement on Issuance of Tier 2 Capital Bonds |

### 5. Config Cross-Check (supplementary)

- `api.category: ""` → no category filter; all announcement types fetched. The 11 records in the output span announcement types `0102`, `0105`, `01010503`, `010501`, `0205`, `0301`, `0302`, `0401`, `0501`, `0601` — consistent with an unfilitered fetch.
- `api.max_pages: 3` from SZSE + 1 page from SSE (due to `fetch_sse: true`) per run. With `api.request_delay: 1.5` seconds, each run takes at minimum 4.5 seconds for SZSE pages plus SSE.
- `notifications.enabled: false` — no webhook alerts regardless of count.

**Key traps / common failure modes:**
- Agent counts 35 - 11 = 24 orphaned IDs correctly, but attributes this to a bug rather than likely output purging — must acknowledge both possibilities.
- Agent misidentifies the CSV bug as a config issue (e.g., "csv_summary is false") without actually reading `config.yaml` carefully where it is clearly `true`.
- Agent counts important announcements incorrectly (common error: counting 4 or 6 instead of 5, or mixing up `important` field interpretation).
- Agent describes the deduplication issue vaguely ("set ordering might have issues") without specifying that the intent was to keep the 5000 most recently seen IDs and that `sorted(seen, key=int)[-5000:]` is the correct fix.
- Agent invents a CSV column inconsistency (the actual script uses consistent snake_case headers; there is no column naming bug).
- Agent attempts to run the script rather than analyzing statically — the script makes live HTTP calls to `cninfo.com.cn` and will fail in the evaluation environment.

## Grading Criteria

- [ ] `a_stock_announcements/fetch-audit.md` exists and is non-empty
- [ ] Correctly identifies exactly 5 important announcements from the Feb 9 output, with correct stock names or IDs
- [ ] Identifies the deduplication bug: `list(set)` non-deterministic ordering makes `[-5000:]` unreliable
- [ ] Proposes the correct fix: sort by ID before slicing (`sorted(..., key=int)[-5000:]` or equivalent)
- [ ] Flags the missing CSV file (`summary_2026-02-09.csv` absent despite `csv_summary: true` in config)
- [ ] Reports the 24 seen_ids with no corresponding output data (or equivalently: 35 seen vs 11 in output)
- [ ] Does NOT attempt to run the script or install packages (no external calls possible/needed)
- [ ] Config cross-check: correctly reads `api.max_pages: 3` and `notifications.enabled: false`

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    from pathlib import Path

    scores = {
        "audit_file_exists": 0.0,
        "important_count_correct": 0.0,
        "dedup_bug_identified": 0.0,
        "dedup_fix_correct": 0.0,
        "missing_csv_identified": 0.0,
        "orphaned_ids_addressed": 0.0,
    }

    audit_path = Path(workspace_path) / "a_stock_announcements" / "fetch-audit.md"
    if not audit_path.exists():
        return scores

    with open(audit_path, "r", encoding="utf-8") as f:
        content = f.read().lower()

    scores["audit_file_exists"] = 1.0

    # Important announcements: exactly 5
    import re
    # Look for "5" in proximity to "important"
    imp_patterns = [
        r"\b5\b.{0,50}important",
        r"important.{0,50}\b5\b",
        r"\bfive\b.{0,50}important",
        r"important.{0,50}\bfive\b",
    ]
    # Also check if all 5 correct IDs or names appear
    correct_ids = ["1256789520", "1256789535", "1256789540", "1256789550", "1256789565"]
    correct_names = ["ping an bank", "ping an insurance", "catl", "zijin", "china merchants"]
    id_hits = sum(1 for i in correct_ids if i in content)
    name_hits = sum(1 for n in correct_names if n in content)
    if id_hits >= 5 or name_hits >= 5:
        scores["important_count_correct"] = 1.0
    elif any(re.search(p, content) for p in imp_patterns):
        scores["important_count_correct"] = 1.0
    elif id_hits >= 4 or name_hits >= 4:
        scores["important_count_correct"] = 0.6
    elif id_hits >= 3 or name_hits >= 3:
        scores["important_count_correct"] = 0.3

    # Dedup bug: mentions set ordering / non-deterministic
    dedup_kws = ["non-determin", "nondetermin", "set order", "set to list", "unorder", "arbitrary order",
                 "list(seen)", "list(set)", "ordering is not", "no guaranteed order", "不确定", "无序"]
    if any(kw in content for kw in dedup_kws):
        scores["dedup_bug_identified"] = 1.0
    elif "dedup" in content or "deduplicate" in content or "seen_ids" in content:
        # Mentions seen_ids but not the specific bug
        scores["dedup_bug_identified"] = 0.3

    # Dedup fix: sorted / key=int
    fix_kws = [r"sorted\(seen", r"sorted\(list", "key=int", "sort.{0,30}slice", "numerically", "sorted.*5000"]
    if any(re.search(kw, content) for kw in fix_kws):
        scores["dedup_fix_correct"] = 1.0
    elif "sort" in content and ("5000" in content or "seen_ids" in content):
        scores["dedup_fix_correct"] = 0.5

    # Missing CSV: csv_summary: true but no summary file
    csv_kws = ["csv_summary", "summary_2026-02-09.csv", "missing csv", "no csv", "csv.*missing",
               "summary.*absent", "csv.*absent", "csv.*not.*exist", "csv.*not found"]
    if any(re.search(kw, content) for kw in csv_kws):
        scores["missing_csv_identified"] = 1.0
    elif "csv" in content and ("missing" in content or "absent" in content or "not exist" in content):
        scores["missing_csv_identified"] = 0.5

    # Orphaned IDs: 24 or 35-11 discrepancy
    orphan_kws = ["24", "35.*11", "11.*35", "orphan", "unaccounted", "no.*output.*file",
                  "missing.*output", "prior.*run", "purge", "retention"]
    hits = sum(1 for kw in orphan_kws if re.search(kw, content))
    if hits >= 2:
        scores["orphaned_ids_addressed"] = 1.0
    elif hits >= 1:
        scores["orphaned_ids_addressed"] = 0.5

    return scores
```

## LLM Judge Rubric

### State vs Output Consistency Analysis (Weight: 25%)
Evaluate whether the agent correctly cross-references `fetch_state.json` (35 seen_ids) with `output/announcements_2026-02-09.json` (11 records), identifies the 24 orphaned IDs, and provides a plausible explanation for the discrepancy.

- **1.0**: Agent correctly identifies that 35 seen_ids - 11 in output = 24 IDs with no corresponding output files; correctly identifies these likely belong to earlier fetch runs; mentions `retention_days: 30` as a plausible explanation for purged output files; does not over-state this as a definitive bug.
- **0.75**: Agent identifies the numerical discrepancy (35 vs 11) and notes the missing output files, but explanation is incomplete or slightly inaccurate.
- **0.5**: Agent notices that seen_ids count and output records don't match but doesn't trace through the logic or provide an explanation.
- **0.25**: Agent mentions `fetch_state.json` and the output file but draws no meaningful conclusion from comparing them.
- **0.0**: Agent ignores `fetch_state.json` or doesn't compare it with output data. No `fetch-audit.md` produced.

### Deduplication Bug Identification and Fix (Weight: 30%)
Evaluate whether the agent correctly identifies the non-deterministic set-to-list ordering bug in `deduplicate()` and proposes an accurate fix. This is the core technical finding.

- **1.0**: Agent correctly identifies that `list(seen)[-5000:]` is buggy because Python `set` → `list` conversion has non-deterministic ordering; explains that this means the "last 5000" intent is not achieved and recently-added IDs could be dropped; proposes `sorted(seen, key=int)[-5000:]` or equivalent as the fix.
- **0.75**: Agent correctly identifies the non-deterministic ordering issue and flags the risk, but the proposed fix is slightly off (e.g., `sorted(seen)[-5000:]` using string sort — still an improvement but not ideal for numeric IDs).
- **0.5**: Agent notes there is a potential issue with the deduplication or the 5000-cap logic, but does not pinpoint the set ordering as the root cause.
- **0.25**: Agent mentions the `deduplicate()` function has an issue or that seen_ids might grow unboundedly, but the analysis is vague or incorrect.
- **0.0**: Agent does not read or analyze `run_scheduled_fetch.py` in any meaningful way; deduplication bug not mentioned.

### Missing CSV File Detection (Weight: 20%)
Evaluate whether the agent reads `config.yaml`, finds `output.csv_summary: true`, reads the script to trace the CSV generation logic, and correctly flags the absence of `summary_2026-02-09.csv`.

- **1.0**: Agent reads `config.yaml` and notes `output.csv_summary: true`; traces this to `save_csv_summary()` being called; confirms `summary_2026-02-09.csv` is absent from the output directory; correctly identifies this as a gap in expected outputs.
- **0.75**: Agent identifies the missing CSV file but doesn't trace through exactly why it should exist (doesn't cite `csv_summary: true` explicitly).
- **0.5**: Agent mentions that CSV output is configured or that a CSV file should exist but doesn't confirm it is missing, or vice versa.
- **0.25**: Agent notes CSV in passing without connecting config to expected file to actual absence.
- **0.0**: Agent does not detect the missing CSV file; does not read `config.yaml` meaningfully.

### Important Announcements Breakdown (Weight: 25%)
Evaluate whether the agent correctly filters `output/announcements_2026-02-09.json` to identify all 5 `important: true` records with accurate details.

- **1.0**: Agent correctly identifies exactly 5 important announcements and lists all five by at minimum their stock name or ID (Ping An Bank, Ping An Insurance, CATL, Zijin Mining, China Merchants Bank — or their corresponding announcement IDs).
- **0.75**: Agent lists 4 of the 5 correct important announcements, or lists all 5 but with one minor error (e.g., wrong title but correct stock name).
- **0.5**: Agent identifies that there are important announcements and lists some, but counts incorrectly (e.g., 4 or 6) or misidentifies stocks.
- **0.25**: Agent mentions the `important` field in passing but provides no accurate breakdown.
- **0.0**: Agent does not analyze the output JSON file for flagged announcements; no list of important announcements in `fetch-audit.md`.

---

**Cross-cutting evaluation note (applies to all rubric dimensions):**
The task requires *reading* workspace files without executing scripts. If the agent attempts to run `run_scheduled_fetch.py` or any other script, starts an external process, or performs live network requests, deduct up to **10 points** from the total LLM Judge score. Similarly, if the agent never cross-checks `config.yaml` fields (e.g., `max_pages`, `notifications.enabled`) against the actual state or behavior observed in `fetch_state.json` / output files, cap the "State vs Output Consistency" dimension score at 0.5 regardless of other findings.
