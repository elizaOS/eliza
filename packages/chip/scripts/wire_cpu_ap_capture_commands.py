#!/usr/bin/env python3
"""Derive CPU/AP evidence capture commands from real generated-AP runners."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path
from typing import cast

from capture_cpu_ap_evidence import MODE_ENV, MODE_TO_TRANSCRIPT
from cpu_ap_evidence_lib import GENERATED_MANIFEST, ROOT, rel

SMOKE_LOG = Path("build/chipyard/eliza_rocket/verilator-linux-smoke.log")
SMOKE_RUNNER = Path("scripts/run_chipyard_eliza_linux_smoke.sh")
PAYLOAD_LOCATOR = Path("scripts/locate_chipyard_linux_payload.py")
DERIVED_SMOKE_MODES = ("opensbi-boot", "linux-boot")
UNWIRED_MODES = ("trap-timer-irq", "isa-cache-mmu", "ap-benchmarks")


def quote(value: str) -> str:
    return shlex.quote(value)


def locate_payload() -> tuple[str | None, str | None]:
    locator = ROOT / PAYLOAD_LOCATOR
    if not locator.is_file():
        return None, f"missing payload locator: {PAYLOAD_LOCATOR}"
    proc = subprocess.run(
        [sys.executable, str(locator), "--export-env"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        return None, (proc.stderr or proc.stdout).strip() or "payload locator failed"
    line = proc.stdout.strip()
    prefix = "export CHIPYARD_LINUX_BINARY="
    if not line.startswith(prefix):
        return None, line or "payload locator did not emit CHIPYARD_LINUX_BINARY"
    payload = line[len(prefix) :]
    payload_path = Path(payload)
    if not payload_path.is_file():
        return None, f"payload does not exist: {payload}"
    return str(payload_path), None


def smoke_command(payload: str, *, use_docker: str) -> str:
    return (
        f"CHIPYARD_LINUX_BINARY={quote(payload)} "
        f"CHIPYARD_LINUX_SMOKE_USE_DOCKER={quote(use_docker)} "
        f"{SMOKE_RUNNER.as_posix()}; "
        "status=$?; "
        f"if [ -f {quote(SMOKE_LOG.as_posix())} ]; then "
        f"cat {quote(SMOKE_LOG.as_posix())}; "
        "fi; "
        "exit $status"
    )


def build_entries(args: argparse.Namespace) -> list[dict[str, object]]:
    manifest_ok = GENERATED_MANIFEST.is_file()
    payload, payload_problem = locate_payload()
    runner = ROOT / SMOKE_RUNNER
    runner_ok = runner.is_file() and os.access(runner, os.X_OK)

    entries: list[dict[str, object]] = []
    for mode in sorted(MODE_TO_TRANSCRIPT):
        env_name = MODE_ENV[mode]
        existing = os.environ.get(env_name, "")
        problems: list[str] = []
        entry: dict[str, object] = {
            "mode": mode,
            "command_env": env_name,
            "status": "blocked",
            "source": "unwired",
            "command": existing,
            "problems": problems,
        }

        if existing:
            entry["status"] = "ready"
            entry["source"] = "environment"
        elif mode in DERIVED_SMOKE_MODES:
            if not manifest_ok:
                problems.append(f"missing generated manifest: {rel(GENERATED_MANIFEST)}")
            if not runner_ok:
                problems.append(f"missing executable smoke runner: {SMOKE_RUNNER}")
            if payload_problem:
                problems.append(payload_problem)
            if not problems and payload:
                entry["status"] = "ready"
                entry["source"] = "generated_ap_linux_smoke"
                entry["command"] = smoke_command(payload, use_docker=args.use_docker)
        elif mode in UNWIRED_MODES:
            problems.append(
                "no checked-in generated-AP test runner is available for this lane; "
                f"set {env_name} to a real command that emits the required markers"
            )
        entries.append(entry)
    return entries


def print_shell(entries: list[dict[str, object]]) -> None:
    print("# Source this on the Linux host before scripts/capture_chipyard_linux_evidence.sh.")
    print("# Only real generated-AP runner commands are exported; missing lanes stay blocked.")
    print(f"export ELIZA_GENERATED_MANIFEST={quote(rel(GENERATED_MANIFEST))}")
    for entry in entries:
        env_name = str(entry["command_env"])
        command = str(entry.get("command") or "")
        if command and entry["status"] == "ready":
            print(f"export {env_name}={quote(command)}")
        else:
            problem_items = cast(list[str], entry.get("problems", []))
            problems = "; ".join(str(item).replace("\n", " | ") for item in problem_items)
            print(f"# BLOCKED {entry['mode']}: {env_name} unset. {problems}")


def print_text(entries: list[dict[str, object]]) -> None:
    print("CPU/AP capture command wiring")
    print(f"Generated manifest: {rel(GENERATED_MANIFEST)}")
    print("Claim boundary: command wiring only; no evidence is created")
    for entry in entries:
        print(f"- {entry['mode']}: {entry['status']} ({entry['source']})")
        print(f"  command env: {entry['command_env']}")
        for problem in cast(list[str], entry.get("problems", [])):
            print(f"  - {problem}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--format", choices=["text", "json", "shell"], default="text")
    parser.add_argument(
        "--use-docker",
        choices=["0", "1", "auto"],
        default="0",
        help="Value embedded in derived CHIPYARD_LINUX_SMOKE_USE_DOCKER commands.",
    )
    parser.add_argument("--require-all", action="store_true")
    args = parser.parse_args(argv)

    entries = build_entries(args)
    if args.format == "json":
        print(
            json.dumps(
                {
                    "schema": "eliza.cpu_ap_capture_command_wiring.v1",
                    "generated_manifest": rel(GENERATED_MANIFEST),
                    "claim_boundary": "command_wiring_only_no_evidence_created",
                    "entries": entries,
                },
                indent=2,
                sort_keys=True,
            )
        )
    elif args.format == "shell":
        print_shell(entries)
    else:
        print_text(entries)

    blocked = [entry for entry in entries if entry["status"] != "ready"]
    return 2 if args.require_all and blocked else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
