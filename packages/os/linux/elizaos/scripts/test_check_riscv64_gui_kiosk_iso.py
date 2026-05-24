#!/usr/bin/env python3
"""Tests for check-riscv64-gui-kiosk-iso.py."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "check-riscv64-gui-kiosk-iso.py"
spec = importlib.util.spec_from_file_location("check_riscv64_gui_kiosk_iso", MODULE_PATH)
assert spec is not None and spec.loader is not None
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def listing_for(paths: list[str]) -> list[str]:
    return [f"-rwxr-xr-x root/root 1 2026-05-24 00:00 {path}" for path in paths]


class Riscv64GuiKioskIsoTests(unittest.TestCase):
    def test_path_present_accepts_files_and_symlinks(self) -> None:
        listing = [
            "-rwxr-xr-x root/root 1 2026-05-24 00:00 squashfs-root/usr/bin/cage",
            "lrwxrwxrwx root/root 1 2026-05-24 00:00 squashfs-root/usr/bin/nodejs -> node",
        ]
        self.assertTrue(checker.path_present(listing, "squashfs-root/usr/bin/cage"))
        self.assertTrue(checker.path_present(listing, "squashfs-root/usr/bin/nodejs"))
        self.assertFalse(checker.path_present(listing, "squashfs-root/usr/bin/grim"))

    def test_required_path_set_covers_kiosk_gui_runtime(self) -> None:
        required = checker.REQUIRED_SQUASHFS_PATHS
        for key in (
            "cage",
            "epiphany_browser",
            "grim",
            "xorg",
            "seatd_service",
            "kiosk_service",
            "kiosk_enabled",
            "seatd_enabled",
            "virtio_gpu_modules",
            "start_cage",
            "start_kiosk",
        ):
            self.assertIn(key, required)
        self.assertIn("node", checker.required_paths_for_arch("riscv64"))
        self.assertIn("bun", checker.required_paths_for_arch("arm64"))
        self.assertIn("node", checker.required_paths_for_arch("arm64"))
        self.assertIn("agent_bundle", checker.required_paths_for_arch("arm64"))

    def test_missing_paths_are_detected_from_listing(self) -> None:
        paths = [
            path
            for key, path in checker.required_paths_for_arch("riscv64").items()
            if key not in {"grim", "virtio_gpu_modules"}
        ]
        listing = listing_for(paths)
        missing = [
            key
            for key, path in checker.required_paths_for_arch("riscv64").items()
            if not checker.path_present(listing, path)
        ]
        self.assertEqual(missing, ["grim", "virtio_gpu_modules"])

    def test_default_iso_lookup_is_arch_specific(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            matrix = Path(tmp) / "multiarch_boot_matrix.json"
            matrix.write_text(
                json.dumps(
                    {
                        "architectures": [
                            {"arch": "riscv64", "iso": "out/riscv64.iso"},
                            {"arch": "arm64", "iso": "out/arm64.iso"},
                        ]
                    }
                ),
                encoding="utf-8",
            )
            original = checker.MATRIX
            checker.MATRIX = matrix
            try:
                self.assertEqual(
                    checker.default_iso_from_matrix("arm64"),
                    checker.ROOT / "out/arm64.iso",
                )
                self.assertEqual(
                    checker.default_iso_from_matrix("riscv64"),
                    checker.ROOT / "out/riscv64.iso",
                )
            finally:
                checker.MATRIX = original

    def test_default_iso_lookup_falls_back_to_latest_out_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            matrix = root / "evidence/multiarch_boot_matrix.json"
            out_dir = root / "out"
            matrix.parent.mkdir(parents=True)
            out_dir.mkdir()
            older = out_dir / "elizaos-linux-arm64-default-20260524T010000Z.iso"
            newer = out_dir / "elizaos-linux-arm64-default-20260524T020000Z.iso"
            older.write_text("old\n", encoding="utf-8")
            newer.write_text("new\n", encoding="utf-8")
            matrix.write_text(json.dumps({"architectures": []}), encoding="utf-8")
            original_matrix = checker.MATRIX
            original_root = checker.ROOT
            checker.MATRIX = matrix
            checker.ROOT = root
            try:
                self.assertEqual(checker.default_iso_from_matrix("arm64"), newer)
            finally:
                checker.MATRIX = original_matrix
                checker.ROOT = original_root

    def test_blocked_report_written_when_arch_has_no_iso_row(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            matrix = Path(tmp) / "multiarch_boot_matrix.json"
            out = Path(tmp) / "arm64_gui.json"
            matrix.write_text(json.dumps({"architectures": []}), encoding="utf-8")
            original = checker.MATRIX
            original_root = checker.ROOT
            checker.MATRIX = matrix
            checker.ROOT = Path(tmp)
            try:
                rc = checker.main(["--arch", "arm64", "--out", str(out)])
            finally:
                checker.MATRIX = original
                checker.ROOT = original_root
            self.assertEqual(rc, 2)
            report = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(report["schema"], "eliza.os.linux.gui_kiosk_iso_check.v1")
            self.assertEqual(report["arch"], "arm64")
            self.assertEqual(report["status"], "blocked")


if __name__ == "__main__":
    unittest.main()
