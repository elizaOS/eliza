#!/usr/bin/env python3
"""Run type and schema-adjacent checks for source files."""

from __future__ import annotations

import ast
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SYNTAX_ROOTS = ("benchmarks", "compiler", "package", "scripts", "sw", "verify", "fw")


def run(name: str, cmd: list[str], *, optional: bool = False) -> bool:
    if shutil.which(cmd[0]) is None:
        status = "BLOCK" if optional else "FAIL"
        print(f"{status}: {name}: missing tool {cmd[0]}")
        return optional
    print(f"RUN: {name}: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=ROOT)
    if result.returncode == 0:
        print(f"PASS: {name}")
        return True
    print(f"FAIL: {name}: exit {result.returncode}")
    return False


def check_python_syntax() -> bool:
    ok = True
    excluded = {".git", ".venv", "build", "external", "tools", "__pycache__"}
    for root_name in SYNTAX_ROOTS:
        for path in sorted((ROOT / root_name).rglob("*.py")):
            rel = path.relative_to(ROOT)
            if any(part in excluded for part in rel.parts):
                continue
            try:
                ast.parse(path.read_text(encoding="utf-8"), filename=str(rel))
            except SyntaxError as exc:
                print(f"FAIL: python syntax: {rel}: {exc}")
                ok = False
    if ok:
        print("PASS: python syntax")
    return ok


def main() -> int:
    ok = True
    ok &= run("python mypy", ["mypy", "--config-file", "pyproject.toml"], optional=True)
    ok &= check_python_syntax()
    ok &= run("platform contract schema", ["python3", "scripts/check_platform_contract.py"])
    ok &= run("project plan schema", ["python3", "scripts/check_project_plan.py"])
    ok &= run("software BSP schema", ["python3", "scripts/check_software_bsp.py", "all"])
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
