#!/usr/bin/env python3
"""Static host tests for the explicit Apple Silicon Lima harness."""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("mkosi-macos-lima.sh")


class MacLimaHarnessTest(unittest.TestCase):
    @staticmethod
    def write_fake_uname(root: Path) -> None:
        fake_uname = root / "uname"
        fake_uname.write_text(
            '#!/bin/sh\ncase "$1" in -s) printf "Darwin\\n" ;; -m) printf "arm64\\n" ;; *) exit 1 ;; esac\n'
        )
        fake_uname.chmod(0o755)

    def run_harness(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(SCRIPT), *arguments],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_commands_are_explicit_and_non_destructive(self) -> None:
        result = self.run_harness("commands")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("brew install lima", result.stdout)
        self.assertIn("preflight-arm64", result.stdout)
        self.assertNotIn("delete", result.stdout)
        self.assertNotIn("rm ", result.stdout)

    def test_unknown_command_fails(self) -> None:
        result = self.run_harness("destroy")
        self.assertEqual(result.returncode, 64)
        self.assertIn("unknown command", result.stderr)

    def test_export_rejects_nonempty_destination_before_lima(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary)
            (destination / "keep").write_text("user data")
            result = self.run_harness("export", str(destination))
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((destination / "keep").read_text(), "user data")

    def test_start_uses_native_vz_read_only_source_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            capture = root / "capture"
            fake = root / "limactl"
            fake.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >>"$CAPTURE"\n')
            fake.chmod(0o755)
            fake_df = root / "df"
            fake_df.write_text(
                '#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n"\n'
                'printf "test 209715200 1 209715199 1%% /\\n"\n'
            )
            fake_df.chmod(0o755)
            self.write_fake_uname(root)
            environment = os.environ.copy()
            environment["PATH"] = f"{root}:{environment['PATH']}"
            environment["CAPTURE"] = str(capture)
            result = subprocess.run(
                [str(SCRIPT), "start"],
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            command = capture.read_text()
            self.assertIn("--vm-type=vz", command)
            self.assertIn("--arch=aarch64", command)
            self.assertIn("--containerd=none", command)
            self.assertIn("--mount-type=virtiofs", command)
            repository = subprocess.run(
                ["git", "-C", str(SCRIPT.parent), "rev-parse", "--show-toplevel"],
                text=True,
                capture_output=True,
                check=True,
            ).stdout.strip()
            self.assertIn(f"--mount-only={repository}", command)
            self.assertIn("template:debian-13", command)

    def test_qemu_hvf_fallback_uses_9p(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            capture = root / "capture"
            fake = root / "limactl"
            fake.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >>"$CAPTURE"\n')
            fake.chmod(0o755)
            fake_df = root / "df"
            fake_df.write_text(
                '#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n"\n'
                'printf "test 209715200 1 209715199 1%% /\\n"\n'
            )
            fake_df.chmod(0o755)
            self.write_fake_uname(root)
            environment = os.environ.copy()
            environment["PATH"] = f"{root}:{environment['PATH']}"
            environment["CAPTURE"] = str(capture)
            environment["ELIZAOS_LIMA_VM_TYPE"] = "qemu"
            result = subprocess.run(
                [str(SCRIPT), "start"], env=environment, text=True,
                capture_output=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            command = capture.read_text()
            self.assertIn("--vm-type=qemu", command)
            self.assertIn("--mount-type=9p", command)

    def test_provision_does_not_request_x86_bios_package_on_arm64(self) -> None:
        self.assertNotIn("grub-pc-bin", SCRIPT.read_text())

    def test_start_refuses_a_differently_named_existing_vm(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake = root / "limactl"
            fake.write_text(
                '#!/bin/sh\nif [ "$1" = list ]; then printf "%s\\n" existing-vm; fi\n'
            )
            fake.chmod(0o755)
            self.write_fake_uname(root)
            environment = os.environ.copy()
            environment["PATH"] = f"{root}:{environment['PATH']}"
            result = subprocess.run(
                [str(SCRIPT), "start"],
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("refusing a second VM", result.stderr)


if __name__ == "__main__":
    unittest.main()
