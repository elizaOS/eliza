#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/check_aosp_simulator_completion_gate.py"

spec = importlib.util.spec_from_file_location("check_aosp_simulator_completion_gate", SCRIPT)
if spec is None or spec.loader is None:
    raise RuntimeError(f"could not import {SCRIPT}")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def write_log(directory: Path, text: str) -> Path:
    path = directory / "evidence.log"
    path.write_text(text, encoding="utf-8")
    return path


def test_text_marker_helper_accepts_clean_pass_transcript() -> None:
    with tempfile.TemporaryDirectory() as td:
        blockers: list[str] = []
        path = write_log(
            Path(td),
            "\n".join(
                (
                    "eliza-evidence: target=aosp",
                    "sys.boot_completed=1",
                    "eliza-evidence: status=PASS",
                    "RESULT=0",
                )
            ),
        )
        checker.require_text_markers(path, ["sys.boot_completed=1"], blockers)
        if blockers:
            raise AssertionError("\n".join(blockers))


def test_text_marker_helper_rejects_conflicting_fail_status() -> None:
    with tempfile.TemporaryDirectory() as td:
        blockers: list[str] = []
        path = write_log(
            Path(td),
            "\n".join(
                (
                    "eliza-evidence: target=aosp",
                    "sys.boot_completed=1",
                    "eliza-evidence: status=PASS",
                    "eliza-evidence: status=FAIL",
                    "RESULT=0",
                )
            ),
        )
        checker.require_text_markers(path, ["sys.boot_completed=1"], blockers)
        if not any("status=FAIL" in blocker for blocker in blockers):
            raise AssertionError("\n".join(blockers))


def test_text_marker_helper_rejects_nonzero_result_even_with_pass_status() -> None:
    with tempfile.TemporaryDirectory() as td:
        blockers: list[str] = []
        path = write_log(
            Path(td),
            "\n".join(
                (
                    "eliza-evidence: target=aosp",
                    "sys.boot_completed=1",
                    "eliza-evidence: status=PASS",
                    "RESULT=2",
                )
            ),
        )
        checker.require_text_markers(path, ["sys.boot_completed=1"], blockers)
        if not any("RESULT=2" in blocker for blocker in blockers):
            raise AssertionError("\n".join(blockers))
        if not any("RESULT=0" in blocker for blocker in blockers):
            raise AssertionError("\n".join(blockers))


def test_json_marker_helper_accepts_nested_launcher_evidence() -> None:
    with tempfile.TemporaryDirectory() as td:
        blockers: list[str] = []
        path = Path(td) / "launcher.json"
        path.write_text(
            json.dumps(
                {
                    "schema": "eliza.android_launcher_runtime_evidence.v1",
                    "claim_boundary": "booted_android_launcher_agent_runtime_evidence_only",
                    "status": "PASS",
                    "result": 0,
                    "device": {"cpu_abi": "riscv64"},
                    "app": {
                        "package_name": "ai.elizaos.app",
                        "service_component": "ai.elizaos.app/.ElizaAgentService",
                    },
                    "agent": {
                        "health_url": "http://127.0.0.1:31337/api/health",
                        "health_http": 200,
                        "health_ready": True,
                    },
                    "logs": {
                        "fatal_crash_count": 0,
                        "avc_denial_count": 0,
                    },
                },
                indent=2,
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        checker.require_evidence_markers(
            path,
            [
                '"claim_boundary": "booted_android_launcher_agent_runtime_evidence_only"',
                '"cpu_abi": "riscv64"',
                '"package_name": "ai.elizaos.app"',
                '"health_http": 200',
            ],
            blockers,
        )
        if blockers:
            raise AssertionError("\n".join(blockers))


def test_json_marker_helper_rejects_blocked_launcher_evidence() -> None:
    with tempfile.TemporaryDirectory() as td:
        blockers: list[str] = []
        path = Path(td) / "launcher.json"
        path.write_text(
            json.dumps({"status": "BLOCKED", "result": 2}, indent=2),
            encoding="utf-8",
        )
        checker.require_evidence_markers(path, [], blockers)
        if not any("forbidden JSON status" in blocker for blocker in blockers):
            raise AssertionError("\n".join(blockers))
        if not any("result=0" in blocker for blocker in blockers):
            raise AssertionError("\n".join(blockers))


def main() -> int:
    for test in (
        test_text_marker_helper_accepts_clean_pass_transcript,
        test_text_marker_helper_rejects_conflicting_fail_status,
        test_text_marker_helper_rejects_nonzero_result_even_with_pass_status,
        test_json_marker_helper_accepts_nested_launcher_evidence,
        test_json_marker_helper_rejects_blocked_launcher_evidence,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
