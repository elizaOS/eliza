#!/usr/bin/env python3
"""Fail fast when another Eliza-1 model or benchmark process is resident."""

from __future__ import annotations

import argparse
import subprocess
import sys


BLOCKED_PATTERNS: tuple[str, ...] = (
    "llama-cli",
    "llama-server",
    "llama-speculative",
    "ollama runner",
    "kokoro_e2e",
    "eliza1_eval_suite",
    "lifeops-bench/src/server.ts",
    "benchmarks.realm.cli",
    "mtp_drafter_runtime_smoke",
    "elizaos_webshop",
    "elizaos_terminal_bench",
    "hermes_swe_env",
    "benchmarks.orchestrator.cli",
)


def find_blocked_processes(ps_output: str, *, current_pid: int) -> list[str]:
    blocked: list[str] = []
    for line in ps_output.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        parts = stripped.split(None, 4)
        if len(parts) < 5:
            continue
        try:
            pid = int(parts[0])
        except ValueError:
            continue
        if pid == current_pid:
            continue
        comm = parts[3]
        command = parts[4]
        if comm == "rg" or " rg " in command or "| rg" in command:
            continue
        if comm in {"zsh", "bash", "sh", "/bin/zsh", "/bin/bash", "/bin/sh"} and any(
            marker in command for marker in ("git diff", "git status", "ps -axo")
        ):
            continue
        if "release_process_guard.py" in command:
            continue
        if any(pattern in command for pattern in BLOCKED_PATTERNS):
            blocked.append(stripped)
    return blocked


def read_process_table() -> str:
    return subprocess.check_output(
        ["ps", "-axo", "pid,ppid,rss,comm,args"],
        text=True,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--json",
        action="store_true",
        help="reserved for future machine-readable output",
    )
    parser.parse_args(argv)

    blocked = find_blocked_processes(read_process_table(), current_pid=0)
    if not blocked:
        print("[release-process-guard] clear")
        return 0

    print(
        "[release-process-guard] blocked: resident model/benchmark process detected",
        file=sys.stderr,
    )
    for line in blocked:
        print(line, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
