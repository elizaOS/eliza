#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit the pinned RLVR production lockfile.")
    parser.add_argument(
        "--requirements",
        default=str(Path(__file__).resolve().parents[1] / "requirements-prod.lock.txt"),
        help="Pinned requirements lock file to audit.",
    )
    parser.add_argument(
        "--output", default="", help="Optional path to write pip-audit JSON output."
    )
    args = parser.parse_args()

    requirements = Path(args.requirements).resolve()
    output_path = Path(args.output).resolve() if args.output else None
    if not requirements.exists():
        raise FileNotFoundError(f"Requirements lock file not found: {requirements}")

    cmd = [
        sys.executable,
        "-m",
        "pip_audit",
        "-r",
        str(requirements),
        "--format",
        "json",
        "--no-deps",
        "--disable-pip",
        "--strict",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if output_path is not None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(proc.stdout or proc.stderr, encoding="utf-8")

    if proc.returncode != 0:
        if proc.stdout:
            print(proc.stdout)
        if proc.stderr:
            print(proc.stderr, file=sys.stderr)
        return proc.returncode

    payload = json.loads(proc.stdout or "[]")
    if output_path is not None:
        output_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
