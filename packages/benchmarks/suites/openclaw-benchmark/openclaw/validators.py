"""
Validators for OpenClaw benchmark execution results.

These validators check that code actually works, not just that concepts
were mentioned in the response.
"""

import json
import re
import subprocess
from pathlib import Path
from typing import Any, Optional


def validate_file_exists(workspace: Path, filepath: str) -> tuple[bool, str]:
    """
    Validate that a file exists in the workspace.

    Returns:
        (passed, detail) tuple
    """
    full_path = workspace / filepath
    exists = full_path.exists()
    detail = f"'{filepath}' → {'exists' if exists else 'NOT FOUND'}"
    return exists, detail


def validate_file_contains(
    workspace: Path,
    filepath: str,
    pattern: str,
    case_insensitive: bool = True,
) -> tuple[bool, str]:
    """
    Validate that a file contains content matching a pattern.

    Returns:
        (passed, detail) tuple
    """
    full_path = workspace / filepath

    if not full_path.exists():
        return False, f"'{filepath}' does not exist"

    try:
        content = full_path.read_text()
        flags = re.IGNORECASE if case_insensitive else 0
        match = re.search(pattern, content, flags | re.DOTALL)
        passed = match is not None
        detail = f"'{pattern[:40]}' in '{filepath}' → {'found' if match else 'NOT FOUND'}"
        return passed, detail
    except Exception as e:
        return False, f"Error reading '{filepath}': {e}"


def validate_json_schema(
    workspace: Path,
    filepath: str,
    required_keys: Optional[list[str]] = None,
) -> tuple[bool, str]:
    """
    Validate that a file is valid JSON with optional required keys.

    Returns:
        (passed, detail) tuple
    """
    full_path = workspace / filepath

    if not full_path.exists():
        return False, f"'{filepath}' does not exist"

    try:
        with open(full_path) as f:
            data = json.load(f)

        if required_keys:
            missing = [k for k in required_keys if k not in data]
            if missing:
                return False, f"'{filepath}' missing required keys: {missing}"

        return True, f"'{filepath}' is valid JSON"
    except json.JSONDecodeError as e:
        return False, f"'{filepath}' invalid JSON: {e}"
    except Exception as e:
        return False, f"Error reading '{filepath}': {e}"


def validate_code_runs(
    workspace: Path,
    filepath: str,
    command: Optional[str] = None,
    expected_exit: int = 0,
    timeout: int = 30,
) -> tuple[bool, str]:
    """
    Validate that code executes successfully.

    Returns:
        (passed, detail) tuple
    """
    full_path = workspace / filepath

    if not full_path.exists():
        return False, f"'{filepath}' does not exist"

    try:
        if command:
            cmd = command.replace("{file}", str(full_path))
        else:
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
            cwd=workspace,
        )

        passed = proc.returncode == expected_exit
        if passed:
            detail = f"'{filepath}' executed successfully (exit {proc.returncode})"
        else:
            stderr_snippet = proc.stderr.decode()[:100] if proc.stderr else ""
            detail = f"'{filepath}' failed (exit {proc.returncode}): {stderr_snippet}"

        return passed, detail

    except subprocess.TimeoutExpired:
        return False, f"'{filepath}' timed out after {timeout}s"
    except Exception as e:
        return False, f"Error executing '{filepath}': {e}"


def validate_tests_pass(
    workspace: Path,
    command: str = "npm test",
    timeout: int = 120,
) -> tuple[bool, str]:
    """
    Validate that tests pass.

    Returns:
        (passed, detail) tuple
    """
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
            detail = f"Tests passed"
        else:
            stderr_snippet = proc.stderr.decode()[:200] if proc.stderr else ""
            detail = f"Tests failed: {stderr_snippet}"

        return passed, detail

    except subprocess.TimeoutExpired:
        return False, f"Tests timed out after {timeout}s"
    except Exception as e:
        return False, f"Error running tests: {e}"


def validate_typescript_compiles(
    workspace: Path,
    timeout: int = 60,
) -> tuple[bool, str]:
    """
    Validate that TypeScript compiles without errors.

    Returns:
        (passed, detail) tuple
    """
    try:
        proc = subprocess.run(
            "npx tsc --noEmit",
            shell=True,
            capture_output=True,
            timeout=timeout,
            cwd=workspace,
        )

        passed = proc.returncode == 0
        if passed:
            detail = "TypeScript compiles without errors"
        else:
            stderr_snippet = proc.stderr.decode()[:200] if proc.stderr else ""
            stdout_snippet = proc.stdout.decode()[:200] if proc.stdout else ""
            detail = f"TypeScript errors: {stdout_snippet or stderr_snippet}"

        return passed, detail

    except subprocess.TimeoutExpired:
        return False, f"TypeScript compilation timed out after {timeout}s"
    except Exception as e:
        return False, f"Error compiling TypeScript: {e}"


def validate_npm_install(
    workspace: Path,
    timeout: int = 120,
) -> tuple[bool, str]:
    """
    Validate that npm install succeeds.

    Returns:
        (passed, detail) tuple
    """
    try:
        proc = subprocess.run(
            "npm install",
            shell=True,
            capture_output=True,
            timeout=timeout,
            cwd=workspace,
        )

        passed = proc.returncode == 0
        if passed:
            detail = "npm install succeeded"
        else:
            stderr_snippet = proc.stderr.decode()[:200] if proc.stderr else ""
            detail = f"npm install failed: {stderr_snippet}"

        return passed, detail

    except subprocess.TimeoutExpired:
        return False, f"npm install timed out after {timeout}s"
    except Exception as e:
        return False, f"Error running npm install: {e}"


def validate_directory_structure(
    workspace: Path,
    required_dirs: list[str],
) -> tuple[bool, str]:
    """
    Validate that required directories exist.

    Returns:
        (passed, detail) tuple
    """
    missing = []
    for d in required_dirs:
        dir_path = workspace / d
        if not dir_path.is_dir():
            missing.append(d)

    if missing:
        return False, f"Missing directories: {missing}"
    return True, f"All required directories exist: {required_dirs}"


def validate_git_initialized(workspace: Path) -> tuple[bool, str]:
    """
    Validate that git was initialized.

    Returns:
        (passed, detail) tuple
    """
    git_dir = workspace / ".git"
    if git_dir.is_dir():
        return True, "Git repository initialized"
    return False, ".git directory not found"


class WorkspaceValidator:
    """Comprehensive workspace validator for code tasks."""

    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.results: list[dict] = []

    def check_file_exists(self, filepath: str, points: int = 1, category: str = "files") -> bool:
        """Check if a file exists."""
        passed, detail = validate_file_exists(self.workspace, filepath)
        self.results.append({
            "id": f"file_exists_{filepath}",
            "type": "file_exists",
            "passed": passed,
            "points": points if passed else 0,
            "max_points": points,
            "category": category,
            "description": f"File '{filepath}' exists",
            "detail": detail,
        })
        return passed

    def check_file_contains(
        self,
        filepath: str,
        pattern: str,
        points: int = 1,
        category: str = "correctness",
        description: Optional[str] = None,
    ) -> bool:
        """Check if a file contains expected content."""
        passed, detail = validate_file_contains(self.workspace, filepath, pattern)
        self.results.append({
            "id": f"file_contains_{filepath}_{pattern[:20]}",
            "type": "file_contains",
            "passed": passed,
            "points": points if passed else 0,
            "max_points": points,
            "category": category,
            "description": description or f"File '{filepath}' contains expected content",
            "detail": detail,
        })
        return passed

    def check_json_valid(
        self,
        filepath: str,
        required_keys: Optional[list[str]] = None,
        points: int = 1,
        category: str = "files",
    ) -> bool:
        """Check if a JSON file is valid."""
        passed, detail = validate_json_schema(self.workspace, filepath, required_keys)
        self.results.append({
            "id": f"json_valid_{filepath}",
            "type": "file_valid_json",
            "passed": passed,
            "points": points if passed else 0,
            "max_points": points,
            "category": category,
            "description": f"File '{filepath}' is valid JSON",
            "detail": detail,
        })
        return passed

    def check_code_runs(
        self,
        filepath: str,
        command: Optional[str] = None,
        points: int = 2,
        category: str = "execution",
    ) -> bool:
        """Check if code executes successfully."""
        passed, detail = validate_code_runs(self.workspace, filepath, command)
        self.results.append({
            "id": f"code_runs_{filepath}",
            "type": "code_executes",
            "passed": passed,
            "points": points if passed else 0,
            "max_points": points,
            "category": category,
            "description": f"Code '{filepath}' executes without errors",
            "detail": detail,
        })
        return passed

    def check_tests_pass(
        self,
        command: str = "npm test",
        points: int = 3,
        category: str = "execution",
    ) -> bool:
        """Check if tests pass."""
        passed, detail = validate_tests_pass(self.workspace, command)
        self.results.append({
            "id": "tests_pass",
            "type": "tests_pass",
            "passed": passed,
            "points": points if passed else 0,
            "max_points": points,
            "category": category,
            "description": "Test suite passes",
            "detail": detail,
        })
        return passed

    def check_typescript_compiles(
        self,
        points: int = 2,
        category: str = "execution",
    ) -> bool:
        """Check if TypeScript compiles."""
        passed, detail = validate_typescript_compiles(self.workspace)
        self.results.append({
            "id": "typescript_compiles",
            "type": "typescript_compiles",
            "passed": passed,
            "points": points if passed else 0,
            "max_points": points,
            "category": category,
            "description": "TypeScript compiles without errors",
            "detail": detail,
        })
        return passed

    def get_score(self) -> dict:
        """Get the overall score from all checks."""
        total_earned = sum(r["points"] for r in self.results)
        total_possible = sum(r["max_points"] for r in self.results)
        passed_count = sum(1 for r in self.results if r["passed"])
        failed_count = sum(1 for r in self.results if not r["passed"])

        # Per-category breakdown
        categories: dict[str, dict[str, Any]] = {}
        for r in self.results:
            cat = r["category"]
            if cat not in categories:
                categories[cat] = {"earned": 0, "possible": 0, "passed": 0, "failed": 0}
            categories[cat]["earned"] += r["points"]
            categories[cat]["possible"] += r["max_points"]
            categories[cat]["passed" if r["passed"] else "failed"] += 1

        for info in categories.values():
            info["score"] = info["earned"] / info["possible"] if info["possible"] > 0 else 0.0

        return {
            "score": round(total_earned / total_possible, 4) if total_possible > 0 else 0.0,
            "points_earned": total_earned,
            "points_possible": total_possible,
            "passed": passed_count,
            "failed": failed_count,
            "total_checks": len(self.results),
            "checks": self.results,
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
