"""
Scoring engine for OpenClaw benchmark episodes.

Extends ClawBench-style scoring with execution-specific checks:
  - file_exists: verify file was created
  - file_contains: file content matches pattern
  - file_valid_json: file is valid JSON
  - file_valid_yaml: file is valid YAML
  - code_executes: code runs without error
  - tests_pass: test suite passes
  - command_executed: shell command was run
  - command_output_contains: command output matches pattern

Standard ClawBench checks also supported:
  - tool_called, tool_not_called
  - tool_arg_contains, tool_arg_excludes
  - tool_count_max, tool_count_min
  - tool_called_before
  - response_contains, response_excludes
"""

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Optional

import yaml


def evaluate_check(check: dict, result: dict, workspace: Optional[Path] = None) -> dict:
    """Evaluate one scoring check against an episode result."""
    check_type = check["type"]
    passed = False
    detail = ""

    tool_calls_raw = result.get("tool_calls_raw", [])
    tool_counts = result.get("tool_calls_by_type", {})
    response = result.get("response", "")
    total_tools = result.get("tool_calls_total", 0)
    executed_commands = result.get("executed_commands", [])
    files_created = result.get("files_created", {})

    # =========================================================================
    # EXECUTION-BASED CHECKS (new for OpenClaw)
    # =========================================================================

    # --- file_exists: verify file was created --------------------------------
    if check_type == "file_exists":
        filepath = check["path"]
        if workspace:
            full_path = workspace / filepath
        else:
            full_path = Path(filepath)

        exists = full_path.exists()
        passed = exists
        detail = f"'{filepath}' → {'exists' if exists else 'NOT FOUND'}"

    # --- file_contains: file content matches pattern -------------------------
    elif check_type == "file_contains":
        filepath = check["path"]
        pattern = check["pattern"]
        flags = re.DOTALL
        if check.get("case_insensitive", True):
            flags |= re.IGNORECASE

        if workspace:
            full_path = workspace / filepath
        else:
            full_path = Path(filepath)

        if not full_path.exists():
            passed = False
            detail = f"'{filepath}' does not exist"
        else:
            try:
                content = full_path.read_text()
                match = re.search(pattern, content, flags)
                passed = match is not None
                detail = f"'{pattern[:40]}' in '{filepath}' → {'found' if match else 'NOT FOUND'}"
            except Exception as e:
                passed = False
                detail = f"Error reading '{filepath}': {e}"

    # --- file_excludes: file content must NOT match pattern ------------------
    elif check_type == "file_excludes":
        filepath = check["path"]
        pattern = check["pattern"]
        flags = re.DOTALL
        if check.get("case_insensitive", True):
            flags |= re.IGNORECASE

        if workspace:
            full_path = workspace / filepath
        else:
            full_path = Path(filepath)

        if not full_path.exists():
            # File doesn't exist, so pattern can't be in it
            passed = True
            detail = f"'{filepath}' does not exist (pattern cannot be present)"
        else:
            try:
                content = full_path.read_text()
                match = re.search(pattern, content, flags)
                passed = match is None
                detail = f"'{pattern[:40]}' in '{filepath}' → {'FOUND (bad)' if match else 'not found (good)'}"
            except Exception as e:
                passed = False
                detail = f"Error reading '{filepath}': {e}"

    # --- file_valid_json: file is valid JSON ---------------------------------
    elif check_type == "file_valid_json":
        filepath = check["path"]
        schema = check.get("schema")  # Optional JSON schema

        if workspace:
            full_path = workspace / filepath
        else:
            full_path = Path(filepath)

        if not full_path.exists():
            passed = False
            detail = f"'{filepath}' does not exist"
        else:
            try:
                with open(full_path) as f:
                    data = json.load(f)

                if schema:
                    # Validate required keys
                    missing = [k for k in schema.get("required", []) if k not in data]
                    if missing:
                        passed = False
                        detail = f"'{filepath}' missing required keys: {missing}"
                    else:
                        passed = True
                        detail = f"'{filepath}' is valid JSON with required keys"
                else:
                    passed = True
                    detail = f"'{filepath}' is valid JSON"
            except json.JSONDecodeError as e:
                passed = False
                detail = f"'{filepath}' invalid JSON: {e}"
            except Exception as e:
                passed = False
                detail = f"Error reading '{filepath}': {e}"

    # --- code_executes: code runs without error ------------------------------
    elif check_type == "code_executes":
        filepath = check["path"]
        command = check.get("command")  # Optional custom command
        timeout = check.get("timeout", 30)
        expected_exit = check.get("exit_code", 0)

        if workspace:
            full_path = workspace / filepath
        else:
            full_path = Path(filepath)

        if not full_path.exists():
            passed = False
            detail = f"'{filepath}' does not exist"
        else:
            try:
                if command:
                    cmd = command.replace("{file}", str(full_path))
                else:
                    # Auto-detect based on extension
                    ext = full_path.suffix.lower()
                    if ext in (".js", ".mjs"):
                        cmd = f"node {full_path}"
                    elif ext == ".ts":
                        cmd = f"npx ts-node {full_path}"
                    elif ext == ".py":
                        cmd = f"python3 {full_path}"
                    else:
                        cmd = f"bash {full_path}"

                proc = subprocess.run(
                    cmd,
                    shell=True,
                    capture_output=True,
                    timeout=timeout,
                    cwd=workspace or full_path.parent,
                )

                passed = proc.returncode == expected_exit
                if passed:
                    detail = f"'{filepath}' executed successfully (exit {proc.returncode})"
                else:
                    stderr_snippet = proc.stderr.decode()[:100] if proc.stderr else ""
                    detail = f"'{filepath}' failed (exit {proc.returncode}): {stderr_snippet}"
            except subprocess.TimeoutExpired:
                passed = False
                detail = f"'{filepath}' timed out after {timeout}s"
            except Exception as e:
                passed = False
                detail = f"Error executing '{filepath}': {e}"

    # --- tests_pass: test suite passes ---------------------------------------
    elif check_type == "tests_pass":
        command = check.get("command", "npm test")
        timeout = check.get("timeout", 120)
        min_coverage = check.get("min_coverage")

        try:
            proc = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                timeout=timeout,
                cwd=workspace,
            )

            passed = proc.returncode == 0
            if passed:
                detail = f"Tests passed (exit {proc.returncode})"
            else:
                stderr_snippet = proc.stderr.decode()[:200] if proc.stderr else ""
                detail = f"Tests failed (exit {proc.returncode}): {stderr_snippet}"
        except subprocess.TimeoutExpired:
            passed = False
            detail = f"Tests timed out after {timeout}s"
        except Exception as e:
            passed = False
            detail = f"Error running tests: {e}"

    # --- command_executed: specific command was run --------------------------
    elif check_type == "command_executed":
        pattern = check["pattern"]
        flags = re.DOTALL
        if check.get("case_insensitive", True):
            flags |= re.IGNORECASE

        matched = False
        for cmd in executed_commands:
            cmd_str = cmd.get("command", "") if isinstance(cmd, dict) else str(cmd)
            if re.search(pattern, cmd_str, flags):
                matched = True
                break

        passed = matched
        detail = f"'{pattern[:40]}' → {'executed' if matched else 'NOT EXECUTED'}"

    # --- command_not_executed: specific command was NOT run ------------------
    elif check_type == "command_not_executed":
        pattern = check["pattern"]
        flags = re.DOTALL
        if check.get("case_insensitive", True):
            flags |= re.IGNORECASE

        violated = None
        for cmd in executed_commands:
            cmd_str = cmd.get("command", "") if isinstance(cmd, dict) else str(cmd)
            if re.search(pattern, cmd_str, flags):
                violated = cmd_str
                break

        passed = violated is None
        if violated:
            detail = f"'{pattern[:40]}' → FOUND: {violated[:50]}"
        else:
            detail = f"'{pattern[:40]}' → not executed (good)"

    # =========================================================================
    # STANDARD CLAWBENCH CHECKS
    # =========================================================================

    # --- tool_called: specific tool(s) called at least once ------------------
    elif check_type == "tool_called":
        tools = _as_list(check, "tool", "tools")
        called = [t for t in tools if t in tool_counts]
        passed = len(called) == len(tools)
        missing = [t for t in tools if t not in tool_counts]
        detail = f"called={called}" if passed else f"missing={missing}"

    # --- tool_not_called: specific tool(s) were NOT called -------------------
    elif check_type == "tool_not_called":
        tools = _as_list(check, "tool", "tools")
        violated = [t for t in tools if t in tool_counts]
        passed = len(violated) == 0
        detail = f"forbidden tools called: {violated}" if violated else "none called"

    # --- tool_arg_contains: a tool call with matching args exists ------------
    elif check_type == "tool_arg_contains":
        tool = check.get("tool")
        pattern = check["pattern"]
        flags = re.DOTALL
        if check.get("case_insensitive", True):
            flags |= re.IGNORECASE
        matched = False
        for tc in tool_calls_raw:
            if tool and tc.get("tool") != tool:
                continue
            args_str = _tool_call_args_str(tc)
            if re.search(pattern, args_str, flags):
                matched = True
                break
        passed = matched
        scope = f"tool={tool}" if tool else "any tool"
        detail = f"'{pattern[:60]}' in {scope} → {'found' if matched else 'NOT FOUND'}"

    # --- tool_arg_excludes: NO tool call has matching args -------------------
    elif check_type == "tool_arg_excludes":
        tool = check.get("tool")
        pattern = check["pattern"]
        flags = re.DOTALL
        if check.get("case_insensitive", True):
            flags |= re.IGNORECASE
        violated_tc = None
        for tc in tool_calls_raw:
            if tool and tc.get("tool") != tool:
                continue
            args_str = _tool_call_args_str(tc)
            if re.search(pattern, args_str, flags):
                violated_tc = tc
                break
        passed = violated_tc is None
        scope = f"tool={tool}" if tool else "any tool"
        if violated_tc:
            detail = f"'{pattern[:60]}' in {scope} → FOUND in {violated_tc.get('tool', '?')}"
        else:
            detail = f"'{pattern[:60]}' in {scope} → not found (good)"

    # --- tool_count_max: call count ≤ max ------------------------------------
    elif check_type == "tool_count_max":
        tool = check.get("tool")
        max_val = check["max"]
        actual = tool_counts.get(tool, 0) if tool else total_tools
        passed = actual <= max_val
        label = tool or "total"
        detail = f"{label}={actual} (max {max_val})"

    # --- tool_count_min: call count ≥ min ------------------------------------
    elif check_type == "tool_count_min":
        tool = check.get("tool")
        min_val = check["min"]
        actual = tool_counts.get(tool, 0) if tool else total_tools
        passed = actual >= min_val
        label = tool or "total"
        detail = f"{label}={actual} (min {min_val})"

    # --- tool_called_before: tool A before tool B in timeline ----------------
    elif check_type == "tool_called_before":
        before_tool = check["before"]
        after_tool = check["after"]
        tool_names = [tc["tool"] for tc in tool_calls_raw]
        idx_before = _first_index(tool_names, before_tool)
        idx_after = _first_index(tool_names, after_tool)

        if idx_after is None:
            passed = True
            detail = f"{after_tool} never called"
        elif idx_before is None:
            passed = False
            detail = f"{before_tool} never called but {after_tool} was"
        else:
            passed = idx_before < idx_after
            detail = f"{before_tool}@{idx_before} {'<' if passed else '>='} {after_tool}@{idx_after}"

    # --- response_contains: regex found in response text ---------------------
    elif check_type == "response_contains":
        pattern = check["pattern"]
        flags = re.DOTALL
        if check.get("case_insensitive", True):
            flags |= re.IGNORECASE
        match = re.search(pattern, response, flags)
        passed = match is not None
        detail = f"'{pattern[:60]}' → {'found' if match else 'NOT FOUND'}"

    # --- response_excludes: regex must NOT match -----------------------------
    elif check_type == "response_excludes":
        pattern = check["pattern"]
        flags = re.DOTALL
        if check.get("case_insensitive", True):
            flags |= re.IGNORECASE
        match = re.search(pattern, response, flags)
        passed = match is None
        snippet = response[match.start():match.start()+50] if match else ""
        detail = f"'{pattern[:60]}' → {'not found (good)' if not match else f'FOUND: ...{snippet}...'}"

    else:
        detail = f"unknown check type: {check_type}"
        passed = False

    return {
        "id": check["id"],
        "type": check_type,
        "passed": passed,
        "points": check.get("points", 1) if passed else 0,
        "max_points": check.get("points", 1),
        "category": check.get("category", "other"),
        "description": check.get("description", ""),
        "detail": detail,
    }


def score_episode(result: dict, scoring_config: dict, workspace: Optional[Path] = None) -> dict:
    """
    Score an episode result against a scoring rubric.

    Args:
        result: Episode result dict with tool_calls_raw, response, etc.
        scoring_config: The 'scoring' section from the scenario YAML
        workspace: Optional workspace path for file validation

    Returns:
        Score dict with normalized score, per-check results, category breakdown
    """
    checks = scoring_config.get("checks", [])
    if not checks:
        return {"score": None, "reason": "no scoring checks defined"}

    evaluated = [evaluate_check(check, result, workspace) for check in checks]

    total_earned = sum(e["points"] for e in evaluated)
    total_possible = sum(e["max_points"] for e in evaluated)

    # Per-category breakdown
    categories: dict[str, dict[str, Any]] = {}
    for e in evaluated:
        cat = e["category"]
        if cat not in categories:
            categories[cat] = {"earned": 0, "possible": 0, "passed": 0, "failed": 0}
        categories[cat]["earned"] += e["points"]
        categories[cat]["possible"] += e["max_points"]
        categories[cat]["passed" if e["passed"] else "failed"] += 1

    for info in categories.values():
        info["score"] = info["earned"] / info["possible"] if info["possible"] > 0 else 0.0

    passed_count = sum(1 for e in evaluated if e["passed"])
    failed_count = sum(1 for e in evaluated if not e["passed"])

    return {
        "score": round(total_earned / total_possible, 4) if total_possible > 0 else 0.0,
        "points_earned": total_earned,
        "points_possible": total_possible,
        "passed": passed_count,
        "failed": failed_count,
        "total_checks": len(evaluated),
        "checks": evaluated,
        "by_category": {
            cat: {
                "earned": info["earned"],
                "possible": info["possible"],
                "score": round(info["score"], 4),
                "passed": info["passed"],
                "failed": info["failed"],
            }
            for cat, info in categories.items()
        },
    }


def format_score_summary(score: dict) -> str:
    """Format a score dict as a human-readable summary."""
    if score.get("score") is None:
        return "  (no scoring rubric)"

    lines = []
    pct = score["score"] * 100
    lines.append(f"  Score: {pct:.0f}% ({score['points_earned']}/{score['points_possible']} points, "
                 f"{score['passed']}/{score['total_checks']} checks passed)")

    # Category bars
    cat_order = ["execution", "files", "safety", "correctness", "efficiency", "structure"]
    for cat in cat_order:
        info = score["by_category"].get(cat)
        if not info:
            continue
        cat_pct = info["score"] * 100
        bar_filled = int(info["score"] * 10)
        bar = "#" * bar_filled + "-" * (10 - bar_filled)
        lines.append(f"    {cat:<14s} {info['earned']:>2}/{info['possible']:<2} ({cat_pct:>3.0f}%) [{bar}]")

    # Failed checks
    failed = [c for c in score.get("checks", []) if not c["passed"]]
    if failed:
        lines.append("  Failed:")
        for c in failed:
            lines.append(f"    X {c['id']}: {c['description']} [{c['detail']}]")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _as_list(d: dict, singular_key: str, plural_key: str) -> list:
    """Get a list from either a singular or plural key."""
    if plural_key in d:
        return d[plural_key]
    if singular_key in d:
        val = d[singular_key]
        return val if isinstance(val, list) else [val]
    return []


def _tool_call_args_str(tc: dict) -> str:
    """Flatten a tool call's args dict into a searchable string."""
    args = tc.get("args", {})
    if isinstance(args, str):
        return args
    if isinstance(args, dict):
        return json.dumps(args, default=str)
    return str(args)


def _first_index(lst: list, value: str) -> int | None:
    """Return index of first occurrence, or None."""
    try:
        return lst.index(value)
    except ValueError:
        return None
