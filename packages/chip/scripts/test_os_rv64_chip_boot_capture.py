#!/usr/bin/env python3
"""Tests for generated-AP OS RV64 evidence capture plumbing."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VARIANT = ROOT.parent / "os/linux/elizaos"
CAPTURE = VARIANT / "scripts/capture-chip-boot-evidence.py"
WRAPPER = VARIANT / "scripts/capture-generated-ap-chip-evidence.sh"
CHIP_BOOT_MANIFEST = VARIANT / "chip-boot-manifest.json"


def assert_contains(text: str, expected: str) -> None:
    if expected not in text:
        raise AssertionError(f"missing {expected!r} in output:\n{text}")


def test_capture_helper_writes_structured_generated_ap_evidence() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        transcript = tmp / "generated-ap.log"
        transcript.write_text(
            "OpenSBI v1.4\n"
            "Linux version 6.12.0-eliza\n"
            "elizaos-firstboot-ready instance=fixture\n"
            "systemctl is-active elizaos-agent.service\nactive\n"
            "process.pid=31337\n"
            "process.command=/opt/elizaos/bin/elizaos serve --headless --port=31337\n"
            "elizaos-curl-health-ready url=http://127.0.0.1:31337/api/health\n"
            '{"agentId":"elizaos-chip-agent","status":"ready","mode":"full-agent"}\n'
            "fallback_payload_used=false\n"
            "elizaos-tui-ready\n",
            encoding="utf-8",
        )
        boot_json = tmp / "boot.json"
        agent_json = tmp / "agent.json"
        result = subprocess.run(
            [
                sys.executable,
                str(CAPTURE),
                "--boot-transcript",
                str(transcript),
                "--agent-transcript",
                str(transcript),
                "--boot-output",
                str(boot_json),
                "--agent-output",
                str(agent_json),
            ],
            cwd=VARIANT,
            text=True,
            capture_output=True,
        )
        if result.returncode != 0:
            raise AssertionError(result.stdout + result.stderr)
        assert_contains(result.stdout, "STATUS: PASS os_rv64.chip_boot_evidence")
        assert_contains(result.stdout, "STATUS: PASS os_rv64.agent_live_evidence")
        boot = json.loads(boot_json.read_text(encoding="utf-8"))
        agent = json.loads(agent_json.read_text(encoding="utf-8"))
        if boot["provenance"] != "generated_eliza_ap" or boot["boot_completed"] is not True:
            raise AssertionError(boot)
        if agent["health"]["url"] != "http://127.0.0.1:31337/api/health":
            raise AssertionError(agent)
        if agent["health"]["ready"] is not True:
            raise AssertionError(agent)
        if agent["process"]["pid"] != 31337:
            raise AssertionError(agent)
        if agent["fallback_payload_used"] is not False or agent["full_agent_bundle"] is not True:
            raise AssertionError(agent)


def test_capture_helper_rejects_qemu_reference_transcript_without_outputs() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        transcript = tmp / "qemu-reference.log"
        transcript.write_text(
            "OpenSBI\nLinux version\nqemu-system-riscv64 -M virt\nprovenance=qemu_virt\n",
            encoding="utf-8",
        )
        boot_json = tmp / "boot.json"
        agent_json = tmp / "agent.json"
        result = subprocess.run(
            [
                sys.executable,
                str(CAPTURE),
                "--boot-transcript",
                str(transcript),
                "--boot-output",
                str(boot_json),
                "--agent-output",
                str(agent_json),
            ],
            cwd=VARIANT,
            text=True,
            capture_output=True,
        )
        if result.returncode != 2:
            raise AssertionError(result.stdout + result.stderr)
        assert_contains(result.stderr, "STATUS: BLOCKED os_rv64.chip_boot_evidence_capture")
        assert_contains(result.stderr, "boot transcript is qemu-virt reference evidence")
        assert_contains(
            result.stderr, "boot transcript missing marker group: elizaos-firstboot-ready"
        )
        if boot_json.exists() or agent_json.exists():
            raise AssertionError("blocked qemu reference capture must not write evidence JSON")


def test_capture_helper_can_write_blocked_diagnostic_evidence() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        transcript = tmp / "generated-ap-incomplete.log"
        transcript.write_text(
            "OpenSBI v1.4\nLinux version 6.12.0-eliza\ninitramfs start\n",
            encoding="utf-8",
        )
        boot_json = tmp / "boot.json"
        agent_json = tmp / "agent.json"
        result = subprocess.run(
            [
                sys.executable,
                str(CAPTURE),
                "--boot-transcript",
                str(transcript),
                "--agent-transcript",
                str(transcript),
                "--boot-output",
                str(boot_json),
                "--agent-output",
                str(agent_json),
                "--write-blocked",
            ],
            cwd=VARIANT,
            text=True,
            capture_output=True,
        )
        if result.returncode != 2:
            raise AssertionError(result.stdout + result.stderr)
        assert_contains(result.stdout, "STATUS: BLOCKED os_rv64.chip_boot_evidence")
        assert_contains(result.stdout, "STATUS: BLOCKED os_rv64.agent_live_evidence")
        boot = json.loads(boot_json.read_text(encoding="utf-8"))
        agent = json.loads(agent_json.read_text(encoding="utf-8"))
        if boot["boot_completed"] is not False or boot["status"] != "blocked":
            raise AssertionError(boot)
        assert_contains(
            "\n".join(boot["validation"]["problems"]),
            "elizaos-firstboot-ready",
        )
        if agent["full_agent_bundle"] is not False or agent["status"] != "blocked":
            raise AssertionError(agent)
        assert_contains(
            "\n".join(agent["validation"]["problems"]),
            "fallback_payload_used=false",
        )


def test_capture_helper_skip_agent_writes_boot_only_evidence() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        transcript = tmp / "generated-ap-firstboot-only.log"
        transcript.write_text(
            "OpenSBI v1.4\nLinux version 6.12.0-eliza\nelizaos-firstboot-ready instance=fixture\n",
            encoding="utf-8",
        )
        boot_json = tmp / "boot.json"
        agent_json = tmp / "agent.json"
        result = subprocess.run(
            [
                sys.executable,
                str(CAPTURE),
                "--boot-transcript",
                str(transcript),
                "--boot-output",
                str(boot_json),
                "--agent-output",
                str(agent_json),
                "--skip-agent",
            ],
            cwd=VARIANT,
            text=True,
            capture_output=True,
        )
        if result.returncode != 0:
            raise AssertionError(result.stdout + result.stderr)
        assert_contains(result.stdout, "STATUS: PASS os_rv64.chip_boot_evidence")
        if "agent_live_evidence" in result.stdout:
            raise AssertionError(result.stdout)
        boot = json.loads(boot_json.read_text(encoding="utf-8"))
        if boot["boot_completed"] is not True:
            raise AssertionError(boot)
        if agent_json.exists():
            raise AssertionError("boot-only capture must not write agent-live evidence")


def test_current_linux_npu_smoke_pass_does_not_prove_elizaos_boot_or_agent() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        transcript = tmp / "generated-ap-npu-smoke-only.log"
        transcript.write_text(
            "OpenSBI v1.4\n"
            "Linux version 6.12.0-eliza\n"
            "eliza-evidence: target=generated_chipyard_ap artifact=eliza-e1-linux-smoke\n"
            "e1-npu-ml-smoke: PASS\n"
            "eliza-evidence: status=PASS\n",
            encoding="utf-8",
        )
        boot_json = tmp / "boot.json"
        agent_json = tmp / "agent.json"
        result = subprocess.run(
            [
                sys.executable,
                str(CAPTURE),
                "--boot-transcript",
                str(transcript),
                "--agent-transcript",
                str(transcript),
                "--boot-output",
                str(boot_json),
                "--agent-output",
                str(agent_json),
            ],
            cwd=VARIANT,
            text=True,
            capture_output=True,
        )
        if result.returncode != 2:
            raise AssertionError(result.stdout + result.stderr)
        assert_contains(
            result.stderr, "boot transcript missing marker group: elizaos-firstboot-ready"
        )
        assert_contains(result.stderr, "agent transcript missing marker group")
        if boot_json.exists() or agent_json.exists():
            raise AssertionError("NPU smoke-only transcript must not write OS evidence")


def test_generated_ap_wrapper_preflight_blocks_without_boot_command() -> None:
    env = {key: value for key, value in os.environ.items() if not key.startswith("ELIZA_")}
    blocked_report = VARIANT / "evidence/generated_eliza_ap_capture_blocked.json"
    blocked_report.unlink(missing_ok=True)
    result = subprocess.run(
        [str(WRAPPER), "preflight"],
        cwd=VARIANT,
        text=True,
        capture_output=True,
        env=env,
    )
    if result.returncode != 2:
        raise AssertionError(result.stdout + result.stderr)
    assert_contains(result.stdout, "STATUS: BLOCKED os_rv64.generated_ap_capture_preflight")
    assert_contains(result.stdout, "ELIZA_GENERATED_AP_CHIP_BOOT_CMD is unset")
    assert_contains(result.stdout, "generated_eliza_ap_capture_blocked.json")
    report = json.loads(blocked_report.read_text(encoding="utf-8"))
    if report["status"] != "blocked":
        raise AssertionError(report)
    if "qemu-virt reference transcripts" not in " ".join(report["blocked_reasons"]):
        raise AssertionError(report)
    if not any("stage-agent-artifacts ARCH=riscv64" in command for command in report["next_commands"]):
        raise AssertionError(report)


def test_generated_ap_wrapper_preflight_reports_skip_agent_mode() -> None:
    env = {key: value for key, value in os.environ.items() if not key.startswith("ELIZA_")}
    env["ELIZA_GENERATED_AP_CHIP_BOOT_CMD"] = (
        "printf '%s\\n' OpenSBI 'Linux version' elizaos-firstboot-ready"
    )
    env["ELIZA_GENERATED_AP_SKIP_AGENT"] = "1"
    result = subprocess.run(
        [str(WRAPPER), "preflight"],
        cwd=VARIANT,
        text=True,
        capture_output=True,
        env=env,
    )
    if result.returncode != 0:
        raise AssertionError(result.stdout + result.stderr)
    assert_contains(result.stdout, "STATUS: PASS os_rv64.generated_ap_capture_preflight")
    assert_contains(result.stdout, "ELIZA_GENERATED_AP_SKIP_AGENT=1")
    assert_contains(result.stdout, "leaving agent-live evidence unchanged")


def test_generated_ap_wrapper_plan_contains_required_markers_and_checker() -> None:
    result = subprocess.run(
        [str(WRAPPER), "plan"],
        cwd=VARIANT,
        text=True,
        capture_output=True,
    )
    if result.returncode != 0:
        raise AssertionError(result.stdout + result.stderr)
    for expected in (
        "ELIZA_GENERATED_AP_CHIP_BOOT_CMD",
        "ELIZA_GENERATED_AP_SKIP_AGENT",
        "ELIZA_GENERATED_AP_WRITE_BLOCKED",
        "OpenSBI",
        "Linux version",
        "elizaos-firstboot-ready",
        "fallback_payload_used=false",
        "elizaos-tui-ready",
        "check_os_rv64_chip_boot_contract.py",
    ):
        assert_contains(result.stdout, expected)


def test_chip_boot_manifest_declares_firstboot_marker() -> None:
    manifest = json.loads(CHIP_BOOT_MANIFEST.read_text(encoding="utf-8"))
    evidence_rows = manifest["validation"]["evidence"]
    boot_row = next(row for row in evidence_rows if row["id"] == "generated-eliza-ap-boot")
    required_markers = set(boot_row["requiredMarkers"])
    for expected in ("OpenSBI", "Linux version", "elizaos-firstboot-ready"):
        if expected not in required_markers:
            raise AssertionError(boot_row)


def main() -> int:
    test_capture_helper_writes_structured_generated_ap_evidence()
    test_capture_helper_rejects_qemu_reference_transcript_without_outputs()
    test_capture_helper_can_write_blocked_diagnostic_evidence()
    test_capture_helper_skip_agent_writes_boot_only_evidence()
    test_current_linux_npu_smoke_pass_does_not_prove_elizaos_boot_or_agent()
    test_generated_ap_wrapper_preflight_blocks_without_boot_command()
    test_generated_ap_wrapper_preflight_reports_skip_agent_mode()
    test_generated_ap_wrapper_plan_contains_required_markers_and_checker()
    test_chip_boot_manifest_declares_firstboot_marker()
    print("generated AP chip boot capture tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
