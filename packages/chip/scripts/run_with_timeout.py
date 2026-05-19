#!/usr/bin/env python3
"""Run a command with a wall-clock timeout and clear failure metadata."""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
from contextlib import suppress
from datetime import UTC, datetime


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout-seconds", type=int, required=True)
    parser.add_argument("--label", default="command")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    command = args.command
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        parser.error("missing command after --")
    if args.timeout_seconds <= 0:
        parser.error("--timeout-seconds must be positive")

    started_at = datetime.now(UTC).isoformat()
    print(
        f"[timeout-wrapper] label={args.label} timeout_seconds={args.timeout_seconds} "
        f"started_at={started_at}",
        flush=True,
    )
    proc = subprocess.Popen(command, start_new_session=True)
    try:
        proc.wait(timeout=args.timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        ended_at = datetime.now(UTC).isoformat()
        with suppress(ProcessLookupError):
            os.killpg(proc.pid, signal.SIGTERM)
        print(
            f"[timeout-wrapper] label={args.label} status=timeout "
            f"timeout_seconds={args.timeout_seconds} ended_at={ended_at}",
            file=sys.stderr,
            flush=True,
        )
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            with suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
        return 124 if exc.timeout else 1

    ended_at = datetime.now(UTC).isoformat()
    print(
        f"[timeout-wrapper] label={args.label} status=exit "
        f"exit_code={proc.returncode} ended_at={ended_at}",
        flush=True,
    )
    return int(proc.returncode)


if __name__ == "__main__":
    raise SystemExit(main())
