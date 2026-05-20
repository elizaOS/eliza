#!/usr/bin/env python3
"""Fail-closed checker for external Linux/OpenSBI boot evidence artifacts."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs/evidence/linux/eliza-linux-boot-artifacts.json"
LOCATOR = ROOT / "scripts/locate_chipyard_linux_payload.py"
REPORT = ROOT / "build/reports/linux_boot_artifacts.json"


def rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def load_manifest() -> dict[str, Any]:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def env_path(name: str) -> Path | None:
    value = os.environ.get(name, "").strip()
    return Path(value).expanduser() if value else None


def preflight_status(spec: dict[str, Any]) -> dict[str, Any]:
    problems: list[str] = []
    for tool in spec.get("required_tools", []):
        if not shutil.which(str(tool)):
            problems.append(f"missing tool on PATH: {tool}")

    for item in spec.get("external_paths", []):
        name = str(item.get("env", ""))
        kind = str(item.get("kind", "directory"))
        path = env_path(name)
        if path is None:
            problems.append(f"{name} is unset ({item.get('description', 'external path')})")
        elif kind == "file" and not path.is_file():
            problems.append(f"{name} does not point to a file: {path}")
        elif kind != "file" and not path.is_dir():
            problems.append(f"{name} does not point to a directory: {path}")

    return {
        "id": spec.get("id", "preflight"),
        "state": "blocked" if problems else "pass",
        "problems": problems,
    }


def payload_locator_status() -> dict[str, Any]:
    status: dict[str, Any] = {
        "id": "chipyard_linux_payload_locator",
        "state": "blocked",
        "selected_payload": "",
        "report": "build/chipyard/eliza_rocket/chipyard-linux-payload.json",
        "problems": [],
        "candidates": [],
    }
    spec = importlib.util.spec_from_file_location("locate_chipyard_linux_payload", LOCATOR)
    if spec is None or spec.loader is None:
        status["problems"].append(f"cannot import payload locator: {rel(LOCATOR)}")
        return status
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)

    selected = None
    candidates: list[dict[str, Any]] = []
    for path in module.candidate_paths([], defaults=True):
        info, error = module.read_elf_info(path)
        record: dict[str, Any] = {"path": module.rel(path)}
        if info is None:
            record.update({"state": "blocked", "reason": error})
        else:
            record.update(
                {
                    "state": "pass" if info.runnable else "blocked",
                    "role": module.payload_role(info.path),
                    "preferred_for_linux_smoke": module.preferred_for_linux_smoke(info.path),
                    "entry": f"0x{info.entry:x}",
                    "size_bytes": info.size,
                    "contains_opensbi": info.contains_opensbi,
                    "contains_linux_version": info.contains_linux_version,
                }
            )
            if info.runnable and selected is None:
                selected = info
        candidates.append(record)

    status["candidates"] = candidates
    if selected is None:
        status["problems"].append(
            "no runnable RISC-V ELF payload with OpenSBI and Linux version markers found; run "
            "python3 scripts/locate_chipyard_linux_payload.py --require"
        )
        return status

    selected_is_preferred = module.preferred_for_linux_smoke(selected.path)
    if not selected_is_preferred:
        status["problems"].append(
            "preferred linux-poweroff nodisk smoke payload is unavailable; run "
            "python3 scripts/locate_chipyard_linux_payload.py --require-preferred"
        )

    status.update(
        {
            "state": "pass" if selected_is_preferred else "blocked",
            "selected_payload": module.rel(selected.path),
            "selected_payload_role": module.payload_role(selected.path),
            "selected_payload_preferred_for_linux_smoke": selected_is_preferred,
            "sha256": selected.sha256,
            "entry": f"0x{selected.entry:x}",
        }
    )
    return status


def artifact_status(spec: dict[str, Any], forbidden: list[str]) -> dict[str, Any]:
    path = ROOT / str(spec["path"])
    status: dict[str, Any] = {
        "id": spec["id"],
        "path": spec["path"],
        "artifact_type": spec.get("artifact_type", ""),
        "producer": spec.get("producer", ""),
        "unblock_command": spec.get("unblock_command", spec.get("producer", "")),
        "state": "missing",
        "problems": [],
    }
    blocked = path.with_name(path.name + ".BLOCKED")
    if not path.is_file():
        if blocked.is_file():
            status["blocked_note"] = rel(blocked)
        return status

    text = path.read_text(encoding="utf-8", errors="replace")
    missing = [term for term in spec.get("required_strings", []) if term not in text]
    if missing:
        status["problems"].append("missing required markers: " + ", ".join(missing))
    for group in spec.get("at_least_one", []):
        if not any(term in text for term in group):
            status["problems"].append("missing at least one marker from: " + ", ".join(group))
    lower = text.lower()
    forbidden_hits = [term for term in forbidden if term.lower() in lower]
    if forbidden_hits:
        status["problems"].append("contains forbidden markers: " + ", ".join(forbidden_hits))
    status["state"] = "invalid" if status["problems"] else "pass"
    status["bytes"] = path.stat().st_size
    return status


def build_report() -> dict[str, Any]:
    manifest = load_manifest()
    forbidden = [str(item) for item in manifest.get("forbidden_strings", [])]
    preflight = [
        preflight_status(spec) for spec in manifest.get("preflight", []) if isinstance(spec, dict)
    ]
    payload_locator = payload_locator_status()
    artifacts = [
        artifact_status(spec, forbidden)
        for spec in manifest.get("artifacts", [])
        if isinstance(spec, dict) and "id" in spec and "path" in spec
    ]
    if any(item["state"] == "invalid" for item in artifacts):
        state = "FAIL"
    elif (
        any(item["state"] == "missing" for item in artifacts)
        or any(item["state"] == "blocked" for item in preflight)
        or payload_locator["state"] == "blocked"
    ):
        state = "BLOCKED"
    else:
        state = "PASS"
    return {
        "schema": "eliza.linux_boot_artifacts.status.v1",
        "manifest": rel(MANIFEST),
        "claim_boundary": manifest.get("claim_boundary"),
        "status": state,
        "preflight": preflight,
        "payload_locator": payload_locator,
        "command_plan": manifest.get("command_plan", []),
        "artifacts": artifacts,
    }


def print_text(report: dict[str, Any]) -> None:
    print(f"linux boot artifacts: {report['status']}")
    print(f"  manifest: {report['manifest']}")
    print(f"  claim_boundary: {report['claim_boundary']}")
    print("  preflight:")
    for item in report["preflight"]:
        print(f"    [{item['state'].upper()}] {item['id']}")
        for problem in item["problems"]:
            print(f"      problem: {problem}")
    payload = report["payload_locator"]
    print(f"  payload_locator: [{payload['state'].upper()}]")
    if payload.get("selected_payload"):
        print(f"    selected_payload: {payload['selected_payload']}")
    for problem in payload.get("problems", []):
        print(f"    problem: {problem}")
    if report.get("command_plan"):
        print("  command_plan:")
        for command in report["command_plan"]:
            print(f"    - {command}")
    for item in report["artifacts"]:
        print(f"  [{item['state'].upper()}] {item['id']}")
        print(f"    path: {item['path']}")
        if item.get("artifact_type"):
            print(f"    type: {item['artifact_type']}")
        if item.get("blocked_note"):
            print(f"    blocked_note: {item['blocked_note']}")
        if item["state"] == "missing":
            print(f"    producer: {item['producer']}")
            print(f"    unblock: {item['unblock_command']}")
        for problem in item["problems"]:
            print(f"    problem: {problem}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--require-pass", action="store_true")
    args = parser.parse_args(argv)

    report = build_report()
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print_text(report)
    if report["status"] == "PASS":
        return 0
    if report["status"] == "FAIL":
        return 1
    return 2 if args.require_pass else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
