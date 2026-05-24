#!/usr/bin/env python3
"""Tests for qemu_virt_boot_arm64.py helpers."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().with_name("qemu_virt_boot_arm64.py")
SPEC = importlib.util.spec_from_file_location("qemu_virt_boot_arm64", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
arm64 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(arm64)


class Arm64QemuVirtBootTests(unittest.TestCase):
    def test_marker_state_requires_login_firstboot_health_and_tui(self) -> None:
        transcript = "\n".join(arm64.REQUIRED_MARKERS)
        found, missing, forbidden, completed = arm64.marker_state(transcript)
        self.assertEqual(found, list(arm64.REQUIRED_MARKERS))
        self.assertEqual(missing, [])
        self.assertEqual(forbidden, [])
        self.assertTrue(completed)

    def test_marker_state_blocks_for_forbidden_marker(self) -> None:
        transcript = "\n".join([*arm64.REQUIRED_MARKERS, "Kernel panic"])
        _, missing, forbidden, completed = arm64.marker_state(transcript)
        self.assertEqual(missing, [])
        self.assertEqual(forbidden, ["Kernel panic"])
        self.assertFalse(completed)

    def test_inspect_iso_boot_artifacts_matches_arm64_paths(self) -> None:
        paths = [
            "/EFI/boot/bootaa64.efi",
            "/boot/grub/grub.cfg",
            "/live/vmlinuz-6.12.90+deb13-arm64",
            "/live/initrd.img-6.12.90+deb13-arm64",
        ]
        with mock.patch.object(arm64, "list_iso_paths", return_value=paths):
            report = arm64.inspect_iso_boot_artifacts(Path("fake.iso"))
        self.assertEqual(report["missing"], [])
        self.assertEqual(
            set(report["found"]),
            {
                "arm64_removable_uefi_loader",
                "grub_config",
                "arm64_live_kernel",
                "arm64_live_initrd",
            },
        )

    def test_latest_iso_prefers_newest_arm64_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            out = root / "out"
            out.mkdir()
            older = out / "elizaos-linux-arm64-default-20260524T010000Z.iso"
            newer = out / "elizaos-linux-arm64-default-20260524T020000Z.iso"
            older.write_text("old\n", encoding="utf-8")
            newer.write_text("new\n", encoding="utf-8")
            with mock.patch.object(arm64, "VARIANT_DIR", root):
                self.assertEqual(arm64.latest_iso(), newer)


if __name__ == "__main__":
    unittest.main()
