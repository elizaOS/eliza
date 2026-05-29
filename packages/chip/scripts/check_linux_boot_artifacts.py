#!/usr/bin/env python3
"""Fail-closed checker for external Linux/OpenSBI boot evidence artifacts."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs/evidence/linux/eliza-linux-boot-artifacts.json"
LOCATOR = ROOT / "scripts/locate_chipyard_linux_payload.py"
REPORT = ROOT / "build/reports/linux_boot_artifacts.json"
SERIAL_ARTIFACT_ID = "serial_boot_log"
SERIAL_BOOT_MARKERS = [
    "OpenSBI",
    "Linux version",
    "Kernel command line:",
]
SERIAL_BOOT_INIT_MARKERS = [
    "Run /init as init process",
    "Freeing unused kernel memory",
    "Welcome to",
    "login:",
]
SERIAL_EVIDENCE_MARKERS = [
    "eliza-evidence: target=linux artifact=eliza_e1_serial_boot",
    "eliza-evidence: claim_boundary=generated_chipyard_ap_serial_boot_transcript_only_not_silicon_or_board_evidence",
    "eliza-evidence: status=PASS",
]
DEFAULT_EXTERNAL_PATHS = {
    "ELIZA_LINUX_TREE": (
        ROOT / "external/chipyard/software/firemarshal/boards/firechip/linux",
    ),
    "ELIZA_BUILDROOT_TREE": (
        ROOT / "external/chipyard/software/firemarshal/boards/firechip/distros/br/buildroot",
    ),
    "ELIZA_OPENSBI_TREE": (
        ROOT / "external/chipyard/software/firemarshal/boards/firechip/firmware/opensbi",
    ),
}


def rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_manifest() -> dict[str, Any]:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def env_path(name: str) -> Path | None:
    value = os.environ.get(name, "").strip()
    if value:
        return Path(value).expanduser()
    for candidate in DEFAULT_EXTERNAL_PATHS.get(name, ()):
        if candidate.exists():
            return candidate
    return None


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


def artifact_specs_with_located_payload(
    artifact_specs: list[dict[str, Any]], payload_locator: dict[str, Any]
) -> list[dict[str, Any]]:
    selected_payload = str(payload_locator.get("selected_payload") or "").strip()
    if not selected_payload:
        return artifact_specs
    exact_command = (
        "python3 scripts/locate_chipyard_linux_payload.py --require-preferred && "
        f"CHIPYARD_LINUX_BINARY={selected_payload} scripts/run_chipyard_eliza_linux_smoke.sh"
    )
    updated: list[dict[str, Any]] = []
    for spec in artifact_specs:
        if spec.get("id") == SERIAL_ARTIFACT_ID:
            spec = {**spec, "producer": exact_command, "unblock_command": exact_command}
        updated.append(spec)
    return updated


def local_serial_candidate_transcripts() -> list[dict[str, Any]]:
    """Report nearby real boot transcripts without letting them substitute evidence.

    The Linux boot-artifact gate requires a generated-AP serial evidence wrapper.
    Other local OpenSBI/Linux transcripts are useful debugging context, but they
    cannot close that artifact unless they carry the exact provenance markers.
    """

    paths = [
        *sorted((ROOT / "docs/evidence/cpu_ap").glob("*.transcript")),
        *sorted((ROOT / "build/reports").glob("linux_boot_cva6*.sim.log")),
        *sorted((ROOT / "build/reports").glob("opensbi_cva6_boot*.sim.log")),
    ]
    seen: set[Path] = set()
    candidates: list[dict[str, Any]] = []
    for path in paths:
        resolved = path.resolve()
        if resolved in seen or not path.is_file():
            continue
        seen.add(resolved)
        text = path.read_text(encoding="utf-8", errors="replace")
        has_boot_markers = all(marker in text for marker in SERIAL_BOOT_MARKERS)
        has_init_marker = any(marker in text for marker in SERIAL_BOOT_INIT_MARKERS)
        has_evidence_wrapper = all(marker in text for marker in SERIAL_EVIDENCE_MARKERS)
        if not (has_boot_markers or "OpenSBI" in text):
            continue
        digest = hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()
        candidates.append(
            {
                "path": rel(path),
                "bytes": path.stat().st_size,
                "sha256": digest,
                "has_opensbi": "OpenSBI" in text,
                "has_linux_version": "Linux version" in text,
                "has_kernel_command_line": "Kernel command line:" in text,
                "has_init_or_login_marker": has_init_marker,
                "has_generated_ap_serial_evidence_wrapper": has_evidence_wrapper,
                "satisfies_serial_boot_artifact": has_boot_markers
                and has_init_marker
                and has_evidence_wrapper,
                "non_substitution_reason": (
                    ""
                    if has_boot_markers and has_init_marker and has_evidence_wrapper
                    else "local transcript is debugging evidence only; it lacks the exact generated-AP serial evidence provenance required by docs/evidence/linux/eliza-linux-boot-artifacts.json"
                ),
            }
        )
    candidates.sort(
        key=lambda item: (
            not bool(item["satisfies_serial_boot_artifact"]),
            not bool(item["has_linux_version"]),
            not bool(item["has_init_or_login_marker"]),
            str(item["path"]),
        )
    )
    return candidates[:8]


def code_from_text(text: str, fallback: str) -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "_" for char in text)
    parts = [part for part in cleaned.split("_") if part]
    return "_".join(parts[:10]) or fallback


def preflight_next_command(ident: str) -> str:
    commands = {
        "external_linux_tree": "export ELIZA_LINUX_TREE=/path/to/linux",
        "external_buildroot_tree": "export ELIZA_BUILDROOT_TREE=/path/to/buildroot",
        "external_opensbi_tree": "export ELIZA_OPENSBI_TREE=/path/to/opensbi",
    }
    return commands.get(ident, "make linux-boot-artifacts-check")


def preflight_is_release_blocking(
    preflight: list[dict[str, Any]], artifacts: list[dict[str, Any]]
) -> bool:
    del artifacts
    return any(item.get("state") == "blocked" for item in preflight)


def payload_locator_is_release_blocking(
    payload_locator: dict[str, Any], artifacts: list[dict[str, Any]]
) -> bool:
    if payload_locator.get("state") != "blocked":
        return False
    return any(
        item.get("id") == SERIAL_ARTIFACT_ID and item.get("state") != "pass"
        for item in artifacts
    )


def structured_findings(
    preflight: list[dict[str, Any]],
    payload_locator: dict[str, Any],
    artifacts: list[dict[str, Any]],
    local_serial_candidates: list[dict[str, Any]] | None = None,
) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    selected_payload = str(payload_locator.get("selected_payload") or "").strip()
    serial_unblock_command = (
        "python3 scripts/locate_chipyard_linux_payload.py --require-preferred && "
        f"CHIPYARD_LINUX_BINARY={selected_payload} scripts/run_chipyard_eliza_linux_smoke.sh"
        if selected_payload
        else ""
    )
    if preflight_is_release_blocking(preflight, artifacts):
        for item in preflight:
            if item.get("state") == "pass":
                continue
            for problem in item.get("problems", []):
                text = str(problem)
                ident = str(item.get("id", "preflight"))
                findings.append(
                    {
                        "code": f"linux_boot_preflight_{code_from_text(ident + '_' + text, 'blocked')}",
                        "severity": "blocker",
                        "message": text,
                        "evidence": ident,
                        "next_step": "Install the required tool or set the required external checkout path before collecting Linux boot artifacts.",
                        "next_command": preflight_next_command(ident),
                    }
                )
    if payload_locator_is_release_blocking(payload_locator, artifacts):
        for problem in payload_locator.get("problems", []):
            text = str(problem)
            findings.append(
                {
                    "code": f"linux_boot_payload_{code_from_text(text, 'blocked')}",
                    "severity": "blocker",
                    "message": text,
                    "evidence": str(payload_locator.get("report", "")),
                    "next_step": "Run python3 scripts/locate_chipyard_linux_payload.py --require-preferred and use the selected payload for the generated-AP Linux smoke.",
                    "next_command": "python3 scripts/locate_chipyard_linux_payload.py --require-preferred",
                }
            )
    for item in artifacts:
        state = str(item.get("state", ""))
        if state == "pass":
            continue
        ident = str(item.get("id", "artifact"))
        if state == "missing":
            candidate_note = ""
            if ident == SERIAL_ARTIFACT_ID and local_serial_candidates:
                candidate_paths = ", ".join(
                    str(item.get("path", "")) for item in local_serial_candidates[:4]
                )
                candidate_note = (
                    f"; local non-substitutable boot transcript candidates: {candidate_paths}"
                )
            unblock_command = str(item.get("unblock_command") or item.get("producer") or "")
            if ident == SERIAL_ARTIFACT_ID and serial_unblock_command:
                unblock_command = serial_unblock_command
            findings.append(
                {
                    "code": f"linux_boot_artifact_missing_{code_from_text(ident, 'artifact')}",
                    "severity": "blocker",
                    "message": f"required Linux boot artifact {ident} is missing{candidate_note}",
                    "evidence": str(item.get("path", "")),
                    "next_step": unblock_command,
                    "next_command": unblock_command,
                }
            )
        for problem in item.get("problems", []):
            text = str(problem)
            findings.append(
                {
                    "code": f"linux_boot_artifact_invalid_{code_from_text(ident + '_' + text, 'artifact')}",
                    "severity": "blocker" if state == "blocked" else "fail",
                    "message": text,
                    "evidence": str(item.get("path", "")),
                    "next_step": str(item.get("unblock_command") or item.get("producer") or ""),
                    "next_command": str(item.get("unblock_command") or item.get("producer") or ""),
                }
            )
    return findings


def build_report() -> dict[str, Any]:
    manifest = load_manifest()
    forbidden = [str(item) for item in manifest.get("forbidden_strings", [])]
    preflight = [
        preflight_status(spec) for spec in manifest.get("preflight", []) if isinstance(spec, dict)
    ]
    payload_locator = payload_locator_status()
    local_serial_candidates = local_serial_candidate_transcripts()
    artifact_specs = [
        spec
        for spec in manifest.get("artifacts", [])
        if isinstance(spec, dict) and "id" in spec and "path" in spec
    ]
    artifacts = [
        artifact_status(spec, forbidden)
        for spec in artifact_specs_with_located_payload(artifact_specs, payload_locator)
    ]
    if any(item["state"] == "invalid" for item in artifacts):
        state = "FAIL"
    elif (
        any(item["state"] == "missing" for item in artifacts)
        or preflight_is_release_blocking(preflight, artifacts)
        or payload_locator_is_release_blocking(payload_locator, artifacts)
    ):
        state = "BLOCKED"
    else:
        state = "PASS"
    findings = structured_findings(preflight, payload_locator, artifacts, local_serial_candidates)
    return {
        "schema": "eliza.linux_boot_artifacts.status.v1",
        "generated_utc": utc_now(),
        "manifest": rel(MANIFEST),
        "claim_boundary": manifest.get("claim_boundary"),
        "status": state,
        "findings": findings,
        "preflight": preflight,
        "payload_locator": payload_locator,
        "local_serial_candidate_transcripts": local_serial_candidates,
        "command_plan": manifest.get("command_plan", []),
        "artifacts": artifacts,
    }


def print_text(report: dict[str, Any]) -> None:
    print(f"STATUS: {report['status']} linux.boot_artifacts")
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
    if report.get("local_serial_candidate_transcripts"):
        print("  local_serial_candidate_transcripts:")
        for item in report["local_serial_candidate_transcripts"]:
            print(
                "    - "
                + str(item["path"])
                + " "
                + (
                    "[serial-artifact-ok]"
                    if item["satisfies_serial_boot_artifact"]
                    else "[debug-only]"
                )
            )
            if item.get("non_substitution_reason"):
                print(f"      reason: {item['non_substitution_reason']}")
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
