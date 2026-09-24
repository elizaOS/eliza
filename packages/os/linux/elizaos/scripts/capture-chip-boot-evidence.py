#!/usr/bin/env python3
"""Create chip/AP Linux boot evidence JSONs from real transcripts.

This tool intentionally does not run an emulator or synthesize transcript
content. It fails closed unless the supplied transcript already contains the
markers required by the chip-side OS bring-up gate.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

VARIANT = Path(__file__).resolve().parents[1]
DEFAULT_BOOT_OUTPUT = VARIANT / "evidence/generated_eliza_ap_boot.json"
DEFAULT_AGENT_OUTPUT = VARIANT / "evidence/generated_eliza_ap_agent_live.json"

BOOT_MARKER_GROUPS = (
    ("OpenSBI", "SBI specification", "SBI implementation ID=", "Domain0 Next Address"),
    ("Linux version",),
    ("elizaos-firstboot-ready",),
)
AGENT_MARKER_GROUPS = (
    (
        "elizaos-agent-ready",
        "systemctl is-active elizaos-agent.service: active",
        "systemctl is-active elizaos-agent.service\nactive",
        "systemctl_is_active=active",
    ),
    ("process.pid > 0", "process.pid=", "PID="),
    ("/opt/elizaos/bin/elizaos", "process.command=", "process.executable="),
    (
        "GET /api/health HTTP 200",
        "GET /api/health 200",
        "/api/health 200",
        "elizaos-curl-health-ready",
    ),
    ('"agentId"', "agentId="),
    ("full-agent", '"agent":"full"', '"mode":"full-agent"'),
    ("fallback_payload_used=false",),
)
QEMU_REFERENCE_MARKERS = (
    "qemu_virt_boot_transcript_evidence_only_no_silicon_or_physical_board_claim",
    "qemu-system-riscv64 -M virt",
    "provenance=qemu_virt",
)


def rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(VARIANT).as_posix()
    except ValueError:
        return str(path)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def missing_marker_groups(text: str, groups: tuple[tuple[str, ...], ...]) -> list[str]:
    missing: list[str] = []
    for group in groups:
        if not any(marker in text for marker in group):
            missing.append(" one of ".join(group))
    return missing


def reject_qemu_reference(text: str) -> list[str]:
    return [marker for marker in QEMU_REFERENCE_MARKERS if marker in text]


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def first_match(text: str, patterns: tuple[str, ...]) -> str | None:
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.MULTILINE)
        if match:
            return match.group(1).strip()
    return None


def parse_agent_pid(text: str) -> int:
    value = first_match(
        text,
        (
            r"process\.pid\s*[=:]\s*(\d+)",
            r"\bPID\s*[=:]\s*(\d+)",
            r'"pid"\s*:\s*(\d+)',
        ),
    )
    return int(value) if value else 0


def parse_agent_command(text: str) -> tuple[str, str]:
    command = first_match(
        text,
        (
            r"process\.command\s*[=:]\s*(.+)",
            r"COMMAND\s*[=:]\s*(.+)",
        ),
    )
    executable = first_match(
        text,
        (
            r"process\.executable\s*[=:]\s*(\S+)",
            r"EXE\s*[=:]\s*(\S+)",
        ),
    )
    if not executable and "/opt/elizaos/bin/elizaos" in text:
        executable = "/opt/elizaos/bin/elizaos"
    if not command and executable:
        command = executable
    return command or "", executable or ""


def parse_health_response(text: str) -> dict[str, Any]:
    for match in re.finditer(r"\{[^{}\n]*\"agentId\"[^{}\n]*\}", text):
        try:
            payload = json.loads(match.group(0))
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            return payload
    agent_id = first_match(text, (r"agentId\s*[=:]\s*([A-Za-z0-9_.:-]+)",))
    return {"agentId": agent_id or ""}


def structured_agent_payload(transcript: Path, text: str, provenance: str) -> dict[str, Any]:
    command, executable = parse_agent_command(text)
    health_ready = (
        "GET /api/health HTTP 200" in text
        or "GET /api/health 200" in text
        or "/api/health 200" in text
        or "elizaos-curl-health-ready" in text
    )
    return {
        **evidence_payload(
            schema="eliza.os.linux.agent_live.v1",
            provenance=provenance,
            claim_boundary=f"{provenance}_chip_emulator_agent_live_evidence",
            transcript=transcript,
        ),
        "fallback_payload_used": False,
        "full_agent_bundle": True,
        "service": {
            "name": "elizaos-agent.service",
            "active": True,
            "systemctl_is_active": "active",
        },
        "process": {
            "pid": parse_agent_pid(text),
            "command": command,
            "executable": executable,
        },
        "health": {
            "url": "http://127.0.0.1:31337/api/health",
            "http_status": 200,
            "ready": health_ready,
            "status": "ready" if health_ready else "unknown",
            "response": parse_health_response(text),
        },
    }


def evidence_payload(
    *,
    schema: str,
    provenance: str,
    claim_boundary: str,
    transcript: Path,
    boot_completed: bool | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "schema": schema,
        "generated_utc": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "provenance": provenance,
        "claim_boundary": claim_boundary,
        "transcript_path": rel(transcript),
    }
    if boot_completed is not None:
        payload["boot_completed"] = boot_completed
    return payload


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--boot-transcript",
        type=Path,
        required=True,
        help="generated Eliza AP/chip-emulator serial transcript with OpenSBI and Linux markers",
    )
    parser.add_argument(
        "--agent-transcript",
        type=Path,
        help="agent-live transcript; defaults to --boot-transcript",
    )
    parser.add_argument("--boot-output", type=Path, default=DEFAULT_BOOT_OUTPUT)
    parser.add_argument("--agent-output", type=Path, default=DEFAULT_AGENT_OUTPUT)
    parser.add_argument(
        "--provenance",
        default="generated_eliza_ap",
        choices=("generated_eliza_ap", "chip_emulator", "eliza_chip"),
    )
    parser.add_argument(
        "--skip-agent",
        action="store_true",
        help="only write boot evidence; agent-live evidence remains blocked",
    )
    parser.add_argument(
        "--update-manifest",
        action="store_true",
        help="mark generated AP evidence rows collected after validated JSONs are written",
    )
    parser.add_argument(
        "--write-blocked",
        action="store_true",
        help=(
            "write diagnostic blocked evidence JSONs from the supplied real transcripts even "
            "when required markers are missing; does not update the manifest"
        ),
    )
    return parser.parse_args(argv)


def update_manifest_rows(*, wrote_boot: bool, wrote_agent: bool) -> None:
    manifest_path = VARIANT / "chip-boot-manifest.json"
    if not manifest_path.is_file():
        return
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    validation = manifest.get("validation")
    rows = validation.get("evidence") if isinstance(validation, dict) else None
    if not isinstance(rows, list):
        return
    for row in rows:
        if not isinstance(row, dict):
            continue
        if wrote_boot and row.get("id") == "generated-eliza-ap-boot":
            row["status"] = "collected"
            row["path"] = "evidence/generated_eliza_ap_boot.json"
        if wrote_agent and row.get("id") == "elizaos-agent-live":
            row["status"] = "collected"
            row["path"] = "evidence/generated_eliza_ap_agent_live.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def blocked_boot_payload(
    *,
    transcript: Path,
    provenance: str,
    problems: list[str],
) -> dict[str, Any]:
    payload = evidence_payload(
        schema="eliza.os.linux.chip_boot.v1",
        provenance=provenance,
        claim_boundary=f"{provenance}_chip_emulator_boot_evidence_blocked",
        transcript=transcript,
        boot_completed=False,
    )
    payload.update(
        {
            "status": "blocked",
            "validation": {
                "required_marker_groups": [" one of ".join(group) for group in BOOT_MARKER_GROUPS],
                "problems": problems,
            },
        }
    )
    return payload


def blocked_agent_payload(
    *,
    transcript: Path,
    provenance: str,
    problems: list[str],
) -> dict[str, Any]:
    payload = evidence_payload(
        schema="eliza.os.linux.agent_live.v1",
        provenance=provenance,
        claim_boundary=f"{provenance}_chip_emulator_agent_live_evidence_blocked",
        transcript=transcript,
    )
    payload.update(
        {
            "status": "blocked",
            "fallback_payload_used": None,
            "full_agent_bundle": False,
            "service": {
                "name": "elizaos-agent.service",
                "active": False,
                "systemctl_is_active": "unknown",
            },
            "process": {
                "pid": parse_agent_pid(read(transcript)) if transcript.is_file() else 0,
                "command": "",
                "executable": "",
            },
            "health": {
                "url": "http://127.0.0.1:31337/api/health",
                "http_status": 0,
                "ready": False,
                "status": "blocked",
                "response": {},
            },
            "validation": {
                "required_marker_groups": [
                    " one of ".join(group) for group in AGENT_MARKER_GROUPS
                ],
                "problems": problems,
            },
        }
    )
    return payload


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    boot_transcript = args.boot_transcript.expanduser().resolve()
    agent_transcript = (args.agent_transcript or args.boot_transcript).expanduser().resolve()
    problems: list[str] = []
    boot_problems: list[str] = []
    agent_problems: list[str] = []

    if not boot_transcript.is_file():
        boot_problems.append(f"missing boot transcript: {boot_transcript}")
        boot_text = ""
    else:
        boot_text = read(boot_transcript)
        boot_problems.extend(
            f"boot transcript missing marker group: {group}"
            for group in missing_marker_groups(boot_text, BOOT_MARKER_GROUPS)
        )
        boot_problems.extend(
            f"boot transcript is qemu-virt reference evidence: {marker}"
            for marker in reject_qemu_reference(boot_text)
        )
    problems.extend(boot_problems)

    agent_text = ""
    if not args.skip_agent:
        if not agent_transcript.is_file():
            agent_problems.append(f"missing agent transcript: {agent_transcript}")
        else:
            agent_text = read(agent_transcript)
            agent_problems.extend(
                f"agent transcript missing marker group: {group}"
                for group in missing_marker_groups(agent_text, AGENT_MARKER_GROUPS)
            )
            agent_problems.extend(
                f"agent transcript is qemu-virt reference evidence: {marker}"
                for marker in reject_qemu_reference(agent_text)
            )
    problems.extend(agent_problems)

    if problems:
        if args.write_blocked:
            boot_output = args.boot_output.expanduser()
            agent_output = args.agent_output.expanduser()
            if boot_transcript.is_file():
                write_json(
                    boot_output,
                    blocked_boot_payload(
                        transcript=boot_transcript,
                        provenance=args.provenance,
                        problems=boot_problems,
                    ),
                )
                print(f"STATUS: BLOCKED os_rv64.chip_boot_evidence {rel(boot_output)}")
            if not args.skip_agent and agent_transcript.is_file():
                write_json(
                    agent_output,
                    blocked_agent_payload(
                        transcript=agent_transcript,
                        provenance=args.provenance,
                        problems=agent_problems,
                    ),
                )
                print(f"STATUS: BLOCKED os_rv64.agent_live_evidence {rel(agent_output)}")
        print("STATUS: BLOCKED os_rv64.chip_boot_evidence_capture", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 2

    boot_output = args.boot_output.expanduser()
    agent_output = args.agent_output.expanduser()
    write_json(
        boot_output,
        evidence_payload(
            schema="eliza.os.linux.chip_boot.v1",
            provenance=args.provenance,
            claim_boundary=f"{args.provenance}_chip_emulator_boot_evidence",
            transcript=boot_transcript,
            boot_completed=True,
        ),
    )
    print(f"STATUS: PASS os_rv64.chip_boot_evidence {rel(boot_output)}")

    if not args.skip_agent:
        write_json(
            agent_output,
            structured_agent_payload(agent_transcript, agent_text, args.provenance),
        )
        print(f"STATUS: PASS os_rv64.agent_live_evidence {rel(agent_output)}")

    if args.update_manifest:
        update_manifest_rows(wrote_boot=True, wrote_agent=not args.skip_agent)

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
