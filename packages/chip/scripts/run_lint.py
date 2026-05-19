#!/usr/bin/env python3
"""Run repo-wide lint checks with clear local/external tool boundaries."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED_DIRS = {".git", ".venv", "build", "external", "tools", ".claude", "__pycache__"}


def repo_files(*suffixes: str) -> list[Path]:
    files: list[Path] = []
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if any(part in EXCLUDED_DIRS for part in path.relative_to(ROOT).parts):
            continue
        if path.suffix in suffixes:
            files.append(path)
    return sorted(files)


def shell_files() -> list[Path]:
    files = repo_files(".sh")
    for path in repo_files():
        if path.name.startswith("check_") or path.name.startswith("run_"):
            try:
                first = path.read_text(errors="ignore").splitlines()[0]
            except IndexError:
                continue
            if "sh" in first and path not in files:
                files.append(path)
    return sorted(set(files))


def run(name: str, cmd: list[str], *, optional: bool = False) -> bool:
    env = os.environ.copy()
    local_paths = [ROOT / "tools/bin", ROOT / ".venv/bin", ROOT / "external/oss-cad-suite/bin"]
    env["PATH"] = os.pathsep.join(
        [str(path) for path in local_paths if path.is_dir()] + [env.get("PATH", "")]
    )
    if shutil.which(cmd[0], path=env["PATH"]) is None:
        status = "BLOCK" if optional else "FAIL"
        print(f"{status}: {name}: missing tool {cmd[0]}")
        return optional
    print(f"RUN: {name}: {' '.join(cmd)}")
    if cmd[0] == "ruff":
        cache_dir = ROOT / "build" / "cache" / "ruff"
        cache_dir.mkdir(parents=True, exist_ok=True)
        env.setdefault("RUFF_CACHE_DIR", str(cache_dir))
    result = subprocess.run(cmd, cwd=ROOT, env=env)
    if result.returncode == 0:
        print(f"PASS: {name}")
        return True
    print(f"FAIL: {name}: exit {result.returncode}")
    return False


def validate_json() -> bool:
    ok = True
    for path in repo_files(".json"):
        try:
            json.loads(path.read_text())
        except Exception as exc:  # noqa: BLE001
            print(f"FAIL: json: {path.relative_to(ROOT)}: {exc}")
            ok = False
    if ok:
        print("PASS: json syntax")
    return ok


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fix", action="store_true", help="apply auto-fixes where supported")
    args = parser.parse_args()

    ok = True
    ruff_cmd = ["ruff", "check", "."]
    if args.fix:
        ruff_cmd.append("--fix")
    ok &= run("python ruff lint", ruff_cmd)
    ok &= run(
        "python ruff format",
        ["ruff", "format", "."] if args.fix else ["ruff", "format", "--check", "."],
    )

    sh_files = [str(path.relative_to(ROOT)) for path in shell_files()]
    if sh_files:
        ok &= run("shell shellcheck", ["shellcheck", *sh_files], optional=True)

    ok &= run("yaml yamllint", ["yamllint", "."], optional=True)
    ok &= validate_json()
    # `git diff --check` requires a real working tree; the docker-regression
    # CI mounts only `packages/chip` so the .git tree isn't visible. Skip
    # cleanly when git can't see a repo here — the host-side `git` hooks
    # and the repo-wide lint job catch the same whitespace defects.
    rev_parse = subprocess.run(
        ["git", "-c", f"safe.directory={ROOT}", "rev-parse", "--git-dir"],
        cwd=ROOT,
        capture_output=True,
    )
    if rev_parse.returncode == 0:
        ok &= run(
            "git whitespace",
            ["git", "-c", f"safe.directory={ROOT}", "diff", "--check", "--", "."],
        )
    else:
        print("SKIP: git whitespace: not in a git checkout (no .git visible)")

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
