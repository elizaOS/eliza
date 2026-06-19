#!/usr/bin/env python3
"""Tests for scripts/check_aosp_linux_handoff_contract.py."""

from __future__ import annotations

import os
import re
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import check_aosp_linux_handoff_contract as gate  # noqa: E402


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def preflight(status: str) -> dict:
    blocked = status != "pass"
    return {
        "status": status,
        "blockers": ["AOSP_DIR is not set"] if blocked else [],
        "aosp_dir": "" if blocked else "/aosp",
        "execution_tracks": {
            track: {
                "status": "blocked" if blocked else "ready",
                "blockers": ["AOSP_DIR is not set"] if blocked else [],
            }
            for track in ("import", "build", "cuttlefish", "compatibility_intake", "qemu", "renode")
        },
        "handoff_commands": list(gate.REQUIRED_HANDOFF_COMMANDS),
    }


def assert_no_production_claims(report: dict) -> None:
    assert re.match(r"^\d{4}-\d{2}-\d{2}T", report["generated_utc"])
    for flag in gate.FALSE_CLAIM_FLAGS:
        assert report[flag] is False, f"{flag} must remain false"


class AospLinuxHandoffContractTests(unittest.TestCase):
    def _patch_tree(self, tmp: Path):
        boot = write(
            tmp / "scripts/boot_android_simulator.sh",
            "qemu-system-riscv64 AOSP riscv64 smoke requires kernel/system image wiring\n"
            "qemu-system-riscv64 --version\n"
            "renode Android-capable firmware/kernel handoff smoke requires a real Renode e1 SoC Android boot script\n"
            "renode --version\n",
        )
        handoff = write(
            tmp / "scripts/run_aosp_linux_handoff.sh",
            "python3 scripts/check_aosp_linux_preflight.py\n"
            "scripts/boot_android_simulator.sh\n"
            "python3 scripts/check_android_sim_boot.py\n",
        )
        sim_check = write(
            tmp / "scripts/check_android_sim_boot.py",
            "boundary = 'not e1-chip hardware ABI proof'\n",
        )
        return [
            mock.patch.object(gate, "ROOT", tmp),
            mock.patch.object(gate, "BOOT_SCRIPT", boot),
            mock.patch.object(gate, "HANDOFF_SCRIPT", handoff),
            mock.patch.object(gate, "ANDROID_SIM_CHECK", sim_check),
        ]

    def test_blocked_preflight_and_placeholder_stages_block(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches = self._patch_tree(Path(tmpdir))
            with (
                PatchStack(patches),
                mock.patch.object(gate, "preflight_payload", return_value=preflight("blocked")),
                mock.patch.dict(os.environ, {}, clear=True),
            ):
                report = gate.run_check(Namespace(aosp_dir=None))
        self.assertEqual(report["status"], "blocked")
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("aosp_linux_preflight_blocked", codes)
        self.assertIn("aosp_import_track_blocked", codes)
        self.assertIn("aosp_qemu_smoke_command_unset", codes)
        self.assertIn("aosp_renode_smoke_command_unset", codes)
        self.assertIn("aosp_qemu_stage_is_version_placeholder", codes)
        self.assertIn("aosp_renode_stage_is_version_placeholder", codes)
        assert_no_production_claims(report)

    def test_ready_preflight_and_real_stages_pass(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            patches = self._patch_tree(tmp)
            with (
                PatchStack(patches),
                mock.patch.object(gate, "preflight_payload", return_value=preflight("pass")),
                mock.patch.dict(
                    os.environ,
                    {
                        "AOSP_QEMU_SMOKE_COMMAND": "qemu-system-riscv64 -kernel Image",
                        "AOSP_RENODE_SMOKE_COMMAND": "renode --execute boot.resc",
                    },
                    clear=True,
                ),
            ):
                gate.BOOT_SCRIPT.write_text(
                    "AOSP_QEMU_SMOKE_COMMAND boots Android artifacts\n"
                    "AOSP_RENODE_SMOKE_COMMAND boots Android artifacts\n",
                    encoding="utf-8",
                )
                report = gate.run_check(Namespace(aosp_dir="/aosp"))
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["findings"], [])
        assert_no_production_claims(report)


class PatchStack:
    def __init__(self, patches):
        self._patches = patches
        self._entered = []

    def __enter__(self):
        for patch in self._patches:
            self._entered.append(patch)
            patch.__enter__()
        return self

    def __exit__(self, exc_type, exc, tb):
        while self._entered:
            self._entered.pop().__exit__(exc_type, exc, tb)


if __name__ == "__main__":
    unittest.main()
