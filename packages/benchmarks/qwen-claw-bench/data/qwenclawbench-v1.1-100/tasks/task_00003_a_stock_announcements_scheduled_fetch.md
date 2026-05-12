---
id: task_00003_a_stock_announcements_scheduled_fetch
name: A-Stock Announcements Scheduled Fetch
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
- source: a_stock_announcements/run_scheduled_fetch.py
  dest: a_stock_announcements/run_scheduled_fetch.py
- source: a_stock_announcements/config.json
  dest: a_stock_announcements/config.json
- source: a_stock_announcements/fetcher/__init__.py
  dest: a_stock_announcements/fetcher/__init__.py
- source: a_stock_announcements/fetcher/cninfo_client.py
  dest: a_stock_announcements/fetcher/cninfo_client.py
- source: a_stock_announcements/fetcher/eastmoney_client.py
  dest: a_stock_announcements/fetcher/eastmoney_client.py
- source: a_stock_announcements/fetcher/dedup.py
  dest: a_stock_announcements/fetcher/dedup.py
---

## Prompt

[cron:3b1326e2-60a4-49ec-8dc5-95338ea709ae a_stock_announcements_fetch_15min] cd /root/.openclaw/workspace/a_stock_announcements && python3 run_scheduled_fetch.py

## Expected Behavior

This is a cron-triggered task. The agent should:

1. **Locate the workspace and script**: Find the `a_stock_announcements` directory and the `run_scheduled_fetch.py` script. The path in the cron command (`/root/.openclaw/workspace/a_stock_announcements`) may not match the actual workspace location, so the agent should adapt. The script uses `Path(__file__).resolve().parent` for `PROJECT_ROOT`, loads `config.json`, auto-creates `logs/`, `output/`, and `cache/` subdirectories, and supports CLI arguments (`--hours`, `--date`, `--dry-run`).

2. **Resolve missing dependencies**: The script depends on the `requests` Python library. If it is not installed, the agent should install it (e.g., `pip install requests`). The other custom modules (`cninfo_client`, `eastmoney_client`, `dedup`) are already present in the workspace under `fetcher/`.

3. **Diagnose all blocking issues by reading run_scheduled_fetch.py carefully**: The agent must read the script to discover every issue before attempting to run it. There are at least two distinct blocking problems beyond the missing `requests` library:
   - The `fetcher/formatter.py` module is entirely missing. The import line at the top of `run_scheduled_fetch.py` lists all functions that must be implemented — the agent must read that line to determine the complete required set. Key signatures to match:
     - `format_announcement(ann: dict) -> dict` — takes a raw announcement dict and returns a formatted version
     - `save_announcements(formatted: list, output_dir: Path, timestamp: datetime) -> Path` — saves the list as a JSON file and returns the path
     - `generate_markdown_report(formatted: list, output_dir: Path, timestamp: datetime) -> Path` — generates a Markdown summary; called when `config["output"]["also_markdown"]` is `true`
     - `filter_announcements(announcements: list, categories: list) -> list` — filters announcements to those whose `category` field is in `categories`; returns all if `categories` is empty
   - `config.json` is missing a required field that `load_config()` validates at startup. The agent must read `load_config()` in the script to identify which field is missing and then add it to `config.json` with an appropriate value.

4. **Run the fetch script**: Execute `run_scheduled_fetch.py` successfully. The script fetches announcements from cninfo and eastmoney APIs. Since these are external Chinese stock market APIs, they may return network errors or empty results — that is acceptable. The script should log errors gracefully and complete without crashing.

5. **Produce a log file**: A log file should be created at `a_stock_announcements/logs/fetch_YYYYMMDD.log` (where YYYYMMDD is today's date), containing log entries from the fetch run. If no announcements are found (common due to network limitations), the log should still show the script started and handled the result gracefully, with the "Fetching announcements from … to …" line and at minimum the "After category filter" and "No new announcements found" lines.

The key deliverables are: (a) a working `fetcher/formatter.py` with all four correct function signatures, (b) an updated `config.json` with all required fields, and (c) a log file at `a_stock_announcements/logs/` showing the script executed successfully through the fetch and filter steps.

## Grading Criteria

- [ ] formatter.py exists at `a_stock_announcements/fetcher/formatter.py` and defines `format_announcement(ann)` with a non-empty body that returns a value
- [ ] formatter.py defines `save_announcements(formatted, output_dir, timestamp)` with exactly 3 parameters and includes a `return` statement (must return the output Path)
- [ ] formatter.py defines `generate_markdown_report(formatted, output_dir, timestamp)` with exactly 3 parameters and includes a `return` statement
- [ ] formatter.py defines `filter_announcements(announcements, categories)` with correct 2-parameter signature AND explicitly handles the empty-categories case (returns all announcements when `categories` is empty — as called in run_scheduled_fetch.py line 170)
- [ ] config.json updated with `max_announcements_per_run` as a positive integer at the top level (identified by reading `load_config()` in the script, not just from the error message)
- [ ] Log file exists at `a_stock_announcements/logs/fetch_YYYYMMDD.log` with correct date-based naming
- [ ] Log file contains at least 2 of the exact log phrases from the script: "Fetching announcements from", "After category filter:", "No new announcements found.", "After dedup:", "cninfo fetch failed", "eastmoney fetch failed", "cninfo returned", "eastmoney returned" — proving the script ran past config validation into the fetch and filter steps

## Automated Checks

```python
def grade(transcript: list, workspace_path: str) -> dict:
    import os
    import re
    import json
    from pathlib import Path

    scores = {
        "formatter_exists": 0.0,
        "formatter_has_format_announcement": 0.0,
        "formatter_has_save_announcements": 0.0,
        "formatter_has_generate_markdown_report": 0.0,
        "formatter_has_filter_announcements": 0.0,
        "config_has_required_field": 0.0,
        "log_file_exists": 0.0,
        "log_file_has_content": 0.0,
    }

    # Look for formatter.py in multiple possible locations
    formatter_path = None
    candidates = [
        os.path.join(workspace_path, "a_stock_announcements", "fetcher", "formatter.py"),
        os.path.join(workspace_path, "fetcher", "formatter.py"),
    ]
    for c in candidates:
        if os.path.isfile(c):
            formatter_path = c
            break

    if formatter_path:
        scores["formatter_exists"] = 1.0
        try:
            content = Path(formatter_path).read_text(encoding="utf-8", errors="replace")

            def _func_body(func_name, text):
                """Extract the body of a named function up to the next top-level def/class."""
                m = re.search(
                    rf"(def\s+{func_name}\s*\(.*?$)(.*?)(?=^def\s|^class\s|\Z)",
                    text,
                    re.MULTILINE | re.DOTALL,
                )
                return m.group(0) if m else ""

            # format_announcement: must accept at least one param and have a return statement
            fa_match = re.search(r"def\s+format_announcement\s*\(([^)]*)\)", content)
            if fa_match:
                params = [p.strip() for p in fa_match.group(1).split(",") if p.strip()]
                body = _func_body("format_announcement", content)
                has_return = bool(re.search(r"\breturn\b", body)) if body else bool(re.search(r"\breturn\b", content))
                if params and has_return:
                    scores["formatter_has_format_announcement"] = 1.0
                elif params:
                    scores["formatter_has_format_announcement"] = 0.5  # stub with pass
                else:
                    scores["formatter_has_format_announcement"] = 0.2

            # save_announcements: must have exactly 3 params AND a return statement (returns output Path)
            sa_match = re.search(r"def\s+save_announcements\s*\(([^)]*)\)", content)
            if sa_match:
                params = [p.strip() for p in sa_match.group(1).split(",") if p.strip()]
                body = _func_body("save_announcements", content)
                has_return = bool(re.search(r"\breturn\b", body)) if body else bool(re.search(r"\breturn\b", content))
                if len(params) >= 3 and has_return:
                    scores["formatter_has_save_announcements"] = 1.0
                elif len(params) >= 3:
                    scores["formatter_has_save_announcements"] = 0.5  # right arity but no return
                elif len(params) >= 2 and has_return:
                    scores["formatter_has_save_announcements"] = 0.3  # wrong arity

            # generate_markdown_report: must have 3 params AND a return statement (returns report Path)
            gmr_match = re.search(r"def\s+generate_markdown_report\s*\(([^)]*)\)", content)
            if gmr_match:
                params = [p.strip() for p in gmr_match.group(1).split(",") if p.strip()]
                body = _func_body("generate_markdown_report", content)
                has_return = bool(re.search(r"\breturn\b", body)) if body else bool(re.search(r"\breturn\b", content))
                if len(params) >= 3 and has_return:
                    scores["formatter_has_generate_markdown_report"] = 1.0
                elif len(params) >= 2 and has_return:
                    scores["formatter_has_generate_markdown_report"] = 0.6  # missing one param
                elif re.search(r"def\s+generate_markdown_report\s*\(", content):
                    scores["formatter_has_generate_markdown_report"] = 0.3

            # filter_announcements: must have 2 params, handle empty categories (return all if empty),
            # and include a return statement — this is a critical logic requirement per the script
            fa2_match = re.search(r"def\s+filter_announcements\s*\(([^)]*)\)", content)
            if fa2_match:
                params = [p.strip() for p in fa2_match.group(1).split(",") if p.strip()]
                body = _func_body("filter_announcements", content)
                # The script calls: filter_announcements(announcements, categories)
                # Expected Behavior: "returns all if categories is empty"
                handles_empty = bool(re.search(
                    r"if\s+not\s+categories|not\s+categories|"
                    r"len\s*\(\s*categories\s*\)\s*==\s*0|"
                    r"if\s+categories\s*==\s*\[\]|"
                    r"categories\s+is\s+None",
                    body,
                )) if body else bool(re.search(r"if\s+not\s+categories|not\s+categories", content))
                has_return = bool(re.search(r"\breturn\b", body)) if body else bool(re.search(r"\breturn\b", content))
                if len(params) >= 2 and handles_empty and has_return:
                    scores["formatter_has_filter_announcements"] = 1.0
                elif len(params) >= 2 and has_return:
                    # Correct arity and returns, but missing empty-categories guard
                    scores["formatter_has_filter_announcements"] = 0.6
                elif re.search(r"def\s+filter_announcements\s*\(", content):
                    scores["formatter_has_filter_announcements"] = 0.3
        except Exception:
            pass

    # Check config.json for required field at top level
    config_candidates = [
        os.path.join(workspace_path, "a_stock_announcements", "config.json"),
        os.path.join(workspace_path, "config.json"),
    ]
    for cfg_path in config_candidates:
        if os.path.isfile(cfg_path):
            try:
                with open(cfg_path, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
                # Must be a top-level key (load_config validates top-level only)
                if "max_announcements_per_run" in cfg:
                    val = cfg["max_announcements_per_run"]
                    if isinstance(val, int) and val > 0:
                        scores["config_has_required_field"] = 1.0
                    elif isinstance(val, (int, float)) and val is not None:
                        scores["config_has_required_field"] = 0.4  # wrong type or non-positive
            except Exception:
                pass
            break

    # Look for log files
    log_dirs = [
        os.path.join(workspace_path, "a_stock_announcements", "logs"),
        os.path.join(workspace_path, "logs"),
    ]
    log_file_found = None
    newest_mtime = -1
    for log_dir in log_dirs:
        if os.path.isdir(log_dir):
            for fname in os.listdir(log_dir):
                if re.match(r"fetch_\d{8}\.log$", fname):
                    candidate = os.path.join(log_dir, fname)
                    try:
                        mtime = os.path.getmtime(candidate)
                    except Exception:
                        mtime = 0
                    if mtime >= newest_mtime:
                        newest_mtime = mtime
                        log_file_found = candidate

    # Early return if no deliverables exist at all
    if formatter_path is None and log_file_found is None:
        return scores

    if log_file_found:
        scores["log_file_exists"] = 1.0
        try:
            log_content = Path(log_file_found).read_text(encoding="utf-8", errors="replace")
            log_lower = log_content.lower()
            # Exact log phrases from run_scheduled_fetch.py logger.info()/logger.warning() calls
            strong_indicators = [
                "fetching announcements from",   # main() line 163 — proves past config validation
                "after category filter:",        # filter step line 171 — proves filter_announcements called
                "no new announcements found",    # graceful empty result line 184
                "after dedup:",                  # dedup step line 197
                "cninfo fetch failed",           # graceful error line 119
                "eastmoney fetch failed",        # graceful error line 136
                "cninfo returned",               # successful cninfo fetch line 116
                "eastmoney returned",            # successful eastmoney fetch line 133
            ]
            matched = sum(1 for kw in strong_indicators if kw in log_lower)
            if matched >= 2:
                scores["log_file_has_content"] = 1.0
            elif matched == 1:
                scores["log_file_has_content"] = 0.5
            elif len(log_content.strip()) > 50:
                scores["log_file_has_content"] = 0.15
        except Exception:
            pass

    return scores
```

## LLM Judge Rubric

### Problem Diagnosis and Full Issue Discovery (Weight: 30%)
Evaluates whether the agent found ALL blocking issues by reading the source code proactively, not reactively from error messages.

- **1.0**: Agent read `run_scheduled_fetch.py` before attempting execution and identified all three distinct blocking issues upfront: (1) `fetcher/formatter.py` is entirely absent, (2) the import statement at lines 34–39 requires exactly four functions — `format_announcement`, `save_announcements`, `generate_markdown_report`, `filter_announcements` — all of which must be implemented; and (3) `load_config()` at line 81 validates `max_announcements_per_run` as a required top-level field, which is absent from `config.json`. All three issues were resolved before the first successful script run.
- **0.75**: Agent resolved all three issues (4-function formatter.py + config.json fix), but discovered them reactively through sequential failed runs rather than upfront code analysis.
- **0.5**: Agent resolved formatter.py with 3 or fewer functions and/or did not fix config.json, meaning the script still crashed before reaching the fetch step on the final run.
- **0.25**: Agent identified at least one blocking issue but left the script unable to run past startup or module import.
- **0.0**: Agent failed to diagnose the issues or gave up without meaningful progress.

### Formatter Module Implementation Quality (Weight: 25%)
Evaluates whether formatter.py correctly implements all four required functions with proper signatures and bodies.

- **1.0**: All four functions implemented with correct signatures and non-stub bodies: `format_announcement(ann)` returns a dict; `save_announcements(formatted, output_dir, timestamp)` takes 3 params and returns a Path; `generate_markdown_report(formatted, output_dir, timestamp)` takes 3 params and returns a Path; `filter_announcements(announcements, categories)` takes 2 params, explicitly handles the empty-categories case by returning all announcements (as required by the call at line 170), and returns a list.
- **0.75**: All four functions present with correct signatures, but at least one has a stub body (`pass` or `return None`) without real implementation, or `filter_announcements` is missing the empty-categories guard.
- **0.5**: Three of the four functions correctly implemented; the fourth is missing entirely or has a completely wrong signature causing a `TypeError` at runtime.
- **0.25**: Only one or two functions implemented with correct signatures; the others are missing or have wrong arity.
- **0.0**: No formatter.py created, or file is empty / all functions are stubs with no return statements.

### Config Field Identification and Repair (Weight: 15%)
Evaluates whether the agent correctly identified and added the missing required field to config.json.

- **1.0**: Agent read `load_config()` in `run_scheduled_fetch.py`, identified that `max_announcements_per_run` is validated as a required top-level field, and added it to `config.json` with a positive integer value (e.g., 100 or 200) before running the script. Field is at the top level of the JSON object, not nested.
- **0.75**: Agent added `max_announcements_per_run` to `config.json` but only after a failed run exposed the error message rather than proactively from code reading; value is valid.
- **0.5**: Agent added the field but with an invalid value (0, negative, or non-integer), or placed it in a nested dict rather than the top level.
- **0.25**: Agent acknowledged the config error but used a wrong field name or made no change to config.json.
- **0.0**: `config.json` was never updated; the script always exits at startup before reaching the fetch step.

### Successful Script Execution and Log Evidence (Weight: 20%)
Evaluates whether the script actually ran to completion and produced a valid log with specific evidence.

- **1.0**: Script executed successfully and produced `logs/fetch_YYYYMMDD.log` containing both `"Fetching announcements from"` (line 163 in script) and `"After category filter:"` (line 171), demonstrating execution past config validation and through the filter step. API errors are gracefully logged without crashing.
- **0.75**: Log file exists with `"Fetching announcements from"` but missing `"After category filter:"`, indicating `filter_announcements` was not called or caused an unhandled exception before line 171.
- **0.5**: Log file exists but only contains early-stage output (e.g., logging setup messages) without evidence the script reached the fetch step — likely a remaining `ImportError` or config validation failure.
- **0.25**: Script was attempted but exited before producing any log content (no log file, or log file is empty).
- **0.0**: Script was never executed; no log file produced.

### Workspace Grounding and Deliverable Completeness (Weight: 10%)
Evaluates whether all deliverables are correctly placed and decisions are based on actual file content.

- **1.0**: All three deliverables exist at the correct paths: `a_stock_announcements/fetcher/formatter.py`, updated `a_stock_announcements/config.json` with `max_announcements_per_run`, and `a_stock_announcements/logs/fetch_YYYYMMDD.log`. Agent demonstrably read the import statement (lines 34–39) and `load_config()` (lines 74–89) in run_scheduled_fetch.py to drive all decisions.
- **0.75**: All deliverables exist but formatter.py is placed outside `fetcher/` (e.g., at workspace root), or agent relied on runtime errors rather than code reading for at least one fix.
- **0.5**: One deliverable is missing (e.g., no log file, or config.json not updated), or formatter.py is empty.
- **0.25**: Minimal artifacts; agent described what should be done but created incomplete or placeholder files.
- **0.0**: No required output files exist; agent hallucinated completion.
