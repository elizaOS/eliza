#!/usr/bin/env python3
"""Portable fail-closed tests for mkosi qualification entrypoints."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent


class QualificationPreflightTest(unittest.TestCase):
    def test_build_preflight_writes_bounded_failure_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / "build.json"
            result = subprocess.run(
                [
                    sys.executable,
                    str(HERE / "mkosi-linux-build.py"),
                    "--architecture", "amd64",
                    "--output-dir", str(root / "out"),
                    "--evidence", str(evidence),
                    "--preflight-only",
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            document = json.loads(evidence.read_text())
            self.assertEqual(document["schema"], "ai.elizaos.mkosi-build-evidence.v1")
            self.assertEqual(
                document["claimBoundary"],
                "mkosi_disk_assembly_only_no_boot_or_hardware_claim",
            )
            if sys.platform != "linux":
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(document["success"])
                self.assertIn("only on a Linux host", " ".join(document["errors"]))

    def test_release_build_preflight_requires_reproducible_external_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / "release-build.json"
            result = subprocess.run(
                [
                    sys.executable,
                    str(HERE / "mkosi-linux-build.py"),
                    "--architecture", "riscv64",
                    "--build-mode", "release",
                    "--output-dir", str(root / "out"),
                    "--evidence", str(evidence),
                    "--preflight-only",
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            document = json.loads(evidence.read_text())
            joined = " ".join(document["errors"])
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(document["buildMode"], "release")
            self.assertFalse(document["success"])
            self.assertIn("dated snapshot.debian.org", joined)
            self.assertIn("SOURCE_DATE_EPOCH", joined)
            self.assertIn("DESKTOP_SIGNING_PUBLIC_KEY", joined)
            self.assertIn("desktop-artifact-dir", joined)

    def test_release_staging_hashes_both_signatures_and_exact_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifact_dir = root / "artifact"
            artifact_dir.mkdir()
            manifest = {
                "archive": "desktop.tar.zst",
                "signature": "desktop.tar.zst.sig",
                "manifestSignature": "desktop-artifact-manifest.json.sig",
            }
            (artifact_dir / "desktop-artifact-manifest.json").write_text(
                json.dumps(manifest)
            )
            for name in (
                "desktop.tar.zst",
                "desktop.tar.zst.sig",
                "desktop-artifact-manifest.json.sig",
                "desktop-signing-public.key",
            ):
                (artifact_dir / name).write_bytes(name.encode())
            evidence = root / "release-build.json"
            environment = os.environ.copy()
            environment.update(
                {
                    "SOURCE_DATE_EPOCH": "1700000000",
                    "ELIZAOS_DESKTOP_SIGNING_PUBLIC_KEY": "/opt/elizaos/share/desktop-signing-public.key",
                    "ELIZAOS_DESKTOP_SIGNING_PUBLIC_KEY_SPKI_SHA256": "0" * 64,
                }
            )
            subprocess.run(
                [
                    sys.executable,
                    str(HERE / "mkosi-linux-build.py"),
                    "--architecture", "amd64",
                    "--build-mode", "release",
                    "--debian-snapshot-url", "https://snapshot.debian.org/archive/debian/20260817T000000Z/",
                    "--desktop-artifact-dir", str(artifact_dir),
                    "--output-dir", str(root / "out"),
                    "--evidence", str(evidence),
                    "--preflight-only",
                ],
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )
            document = json.loads(evidence.read_text())
            names = {item["path"] for item in document["desktopArtifactInputs"]}
            self.assertEqual(
                names,
                {
                    "desktop-artifact-manifest.json",
                    "desktop-artifact-manifest.json.sig",
                    "desktop.tar.zst",
                    "desktop.tar.zst.sig",
                    "desktop-signing-public.key",
                },
            )

    def test_qemu_preflight_never_invents_boot_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / "qemu.json"
            result = subprocess.run(
                [
                    sys.executable,
                    str(HERE / "mkosi-qemu-qualify.py"),
                    "--architecture", "arm64",
                    "--image", str(root / "missing.raw"),
                    "--firmware-code", str(root / "missing-code.fd"),
                    "--firmware-vars", str(root / "missing-vars.fd"),
                    "--transcript", str(root / "transcript.log"),
                    "--evidence", str(evidence),
                    "--preflight-only",
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            document = json.loads(evidence.read_text())
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(document["success"])
            self.assertEqual(document["firmwareMode"], "pflash")
            self.assertEqual(document["markersFound"], [])
            self.assertNotIn("inputs", document)
            self.assertIn("no_login_agent_computer_control_or_hardware_claim", document["claimBoundary"])

    def test_qemu_evidence_publication_never_clobbers_an_existing_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / "qemu.json"
            original = b"existing evidence must survive\n"
            evidence.write_bytes(original)
            result = subprocess.run(
                [
                    sys.executable,
                    str(HERE / "mkosi-qemu-qualify.py"),
                    "--architecture", "amd64",
                    "--image", str(root / "missing.raw"),
                    "--firmware-code", str(root / "missing-code.fd"),
                    "--firmware-vars", str(root / "missing-vars.fd"),
                    "--transcript", str(root / "transcript.log"),
                    "--evidence", str(evidence),
                    "--preflight-only",
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(evidence.read_bytes(), original)
            self.assertIn("evidence publication failed", result.stderr)

    def test_qemu_rejects_double_firmware_topology(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / "qemu.json"
            result = subprocess.run(
                [
                    sys.executable,
                    str(HERE / "mkosi-qemu-qualify.py"),
                    "--architecture", "riscv64",
                    "--image", str(root / "disk.raw"),
                    "--firmware-code", str(root / "code.fd"),
                    "--firmware-vars", str(root / "vars.fd"),
                    "--bios", str(root / "opensbi.bin"),
                    "--transcript", str(root / "transcript.log"),
                    "--evidence", str(evidence),
                    "--preflight-only",
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            document = json.loads(evidence.read_text())
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(
                "--bios cannot be combined with pflash firmware mode",
                document["errors"],
            )

    def test_qemu_preflight_requires_the_promotion_graphical_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / "qemu.json"
            subprocess.run(
                [
                    sys.executable,
                    str(HERE / "mkosi-qemu-qualify.py"),
                    "--architecture", "amd64",
                    "--image", str(root / "missing.raw"),
                    "--firmware-code", str(root / "missing-code.fd"),
                    "--firmware-vars", str(root / "missing-vars.fd"),
                    "--transcript", str(root / "transcript.log"),
                    "--evidence", str(evidence),
                    "--preflight-only",
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            document = json.loads(evidence.read_text())
            self.assertIn(
                "Started gdm.service - GNOME Display Manager",
                document["requiredMarkers"],
            )
            self.assertIn(
                "Reached target Graphical Interface", document["requiredMarkers"]
            )

    def test_qemu_recovery_mode_selects_hotkey_and_requires_boundary_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            emulator = fake_bin / "qemu-system-x86_64"
            emulator.write_text(
                "#!/usr/bin/env python3\n"
                "import socket, sys, time\n"
                "if '--version' in sys.argv:\n"
                "    print('QEMU emulator version 9.2.2')\n"
                "    raise SystemExit(0)\n"
                "monitor = sys.argv[sys.argv.index('-monitor') + 1]\n"
                "path = monitor.removeprefix('unix:').split(',', 1)[0]\n"
                "with socket.socket(socket.AF_UNIX) as server:\n"
                "    server.bind(path)\n"
                "    server.listen(1)\n"
                "    connection, _ = server.accept()\n"
                "    with connection:\n"
                "        command = connection.recv(1024)\n"
                "if command != b'sendkey r\\n':\n"
                "    raise SystemExit(2)\n"
                "print('Linux version 6.12 fixture', flush=True)\n"
                "print('elizaOS recovery boundary verified: Eliza agent and privileged "
                "broker unavailable', flush=True)\n"
                "time.sleep(10)\n"
            )
            emulator.chmod(0o755)
            image = root / "disk.raw"
            bios = root / "bios.fd"
            image.write_bytes(b"immutable image fixture")
            bios.write_bytes(b"firmware fixture")
            evidence = root / "recovery.json"
            environment = os.environ.copy()
            environment["PATH"] = f"{fake_bin}{os.pathsep}{environment['PATH']}"
            result = subprocess.run(
                [
                    sys.executable,
                    str(HERE / "mkosi-qemu-qualify.py"),
                    "--architecture", "amd64",
                    "--boot-mode", "recovery",
                    "--image", str(image),
                    "--firmware-mode", "bios",
                    "--bios", str(bios),
                    "--transcript", str(root / "recovery.log"),
                    "--evidence", str(evidence),
                    "--timeout", "30",
                    "--memory-mib", "1024",
                    "--cpus", "1",
                ],
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )
            document = json.loads(evidence.read_text())
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(document["success"])
            self.assertEqual(document["bootMode"], "recovery")
            self.assertEqual(document["selectionMethod"], "grub-hotkey-r")
            self.assertGreater(document["selectionAttempts"], 0)
            self.assertIn("service_unavailability", document["claimBoundary"])

    def test_qemu_recovery_mode_requires_an_accepted_hotkey(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            emulator = fake_bin / "qemu-system-x86_64"
            emulator.write_text(
                "#!/bin/sh\n"
                "if [ \"${1:-}\" = --version ]; then "
                "printf '%s\\n' 'QEMU emulator version 9.2.2'; exit 0; fi\n"
                "printf '%s\\n' 'Linux version 6.12 fixture' "
                "'elizaOS recovery boundary verified: Eliza agent and privileged "
                "broker unavailable'\n"
                "sleep 10\n"
            )
            emulator.chmod(0o755)
            image = root / "disk.raw"
            bios = root / "bios.fd"
            image.write_bytes(b"immutable image fixture")
            bios.write_bytes(b"firmware fixture")
            evidence = root / "recovery.json"
            environment = os.environ.copy()
            environment["PATH"] = f"{fake_bin}{os.pathsep}{environment['PATH']}"
            result = subprocess.run(
                [
                    sys.executable,
                    str(HERE / "mkosi-qemu-qualify.py"),
                    "--architecture", "amd64",
                    "--boot-mode", "recovery",
                    "--image", str(image),
                    "--firmware-mode", "bios",
                    "--bios", str(bios),
                    "--transcript", str(root / "recovery.log"),
                    "--evidence", str(evidence),
                    "--timeout", "30",
                    "--memory-mib", "1024",
                    "--cpus", "1",
                ],
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )
            document = json.loads(evidence.read_text())
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(document["success"])
            self.assertEqual(document["selectionAttempts"], 0)
            self.assertIn("hotkey was never accepted", " ".join(document["errors"]))

    def test_persistence_preflight_never_invents_write_or_reboot_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / "persistence.json"
            result = subprocess.run(
                [
                    sys.executable,
                    str(HERE / "mkosi-persistence-qualify.py"),
                    "--architecture", "amd64",
                    "--source-image", str(root / "missing.raw"),
                    "--work-image", str(root / "work.raw"),
                    "--firmware-code", str(root / "missing-code.fd"),
                    "--firmware-vars", str(root / "missing-vars.fd"),
                    "--transcript-directory", str(root / "transcripts"),
                    "--evidence", str(evidence),
                    "--preflight-only",
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            document = json.loads(evidence.read_text())
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(document["success"])
            self.assertIn("two_boot_home_persistence", document["claimBoundary"])
            self.assertNotIn("virtualUsbReadback", document)
            self.assertNotIn("home", document)
            self.assertNotIn("boots", document)

    def test_persistence_preflight_refuses_an_existing_work_image(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.raw"
            work = root / "work.raw"
            firmware = root / "firmware.fd"
            for path in (source, work, firmware):
                path.write_bytes(b"fixture")
            evidence = root / "persistence.json"
            subprocess.run(
                [
                    sys.executable,
                    str(HERE / "mkosi-persistence-qualify.py"),
                    "--architecture", "riscv64",
                    "--source-image", str(source),
                    "--work-image", str(work),
                    "--firmware-mode", "bios",
                    "--bios", str(firmware),
                    "--transcript-directory", str(root / "transcripts"),
                    "--evidence", str(evidence),
                    "--preflight-only",
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            document = json.loads(evidence.read_text())
            self.assertIn("work image must not already exist", document["errors"])


if __name__ == "__main__":
    unittest.main()
