#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
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


def main() -> int:
    for test in (
        test_text_marker_helper_accepts_clean_pass_transcript,
        test_text_marker_helper_rejects_conflicting_fail_status,
        test_text_marker_helper_rejects_nonzero_result_even_with_pass_status,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
