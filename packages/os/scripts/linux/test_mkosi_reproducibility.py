#!/usr/bin/env python3
"""Tests for the isolated mkosi root reproducibility qualifier."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "mkosi-reproducibility-qualify.py"
ROOT_OFFSET = 2048 * 512
ROOT_SIZE = 4096 * 512


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def make_image(
    path: Path,
    root_byte: int,
    *,
    partition_type: str = "4f68bce3-e8cd-4db1-96e7-fbcaf984b709",
    partition_name: str | None = "elizaos-root",
) -> None:
    with path.open("wb") as stream:
        stream.truncate(8 * 1024 * 1024)
    disk_id = (
        "11111111-1111-4111-8111-111111111111"
        if path.name.startswith("a")
        else "22222222-2222-4222-8222-222222222222"
    )
    name = f', name="{partition_name}"' if partition_name is not None else ""
    layout = f"""label: gpt
label-id: {disk_id}
unit: sectors
first-lba: 2048

start=2048, size=4096, type={partition_type}{name}
"""
    result = subprocess.run(
        ["sfdisk", str(path)],
        input=layout,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr)
    with path.open("r+b", buffering=0) as stream:
        stream.seek(ROOT_OFFSET)
        stream.write(bytes([root_byte]) * ROOT_SIZE)
        stream.flush()
        os.fsync(stream.fileno())


def compress(image: Path, output: Path) -> None:
    subprocess.run(
        ["zstd", "--quiet", "--force", str(image), "-o", str(output)],
        check=True,
    )


def build_evidence(
    path: Path,
    compressed: Path,
    *,
    architecture: str = "amd64",
    configuration: str = "c",
) -> None:
    desktop_inputs = [
        {"path": name, "size": index + 1, "sha256": str(index + 1) * 64}
        for index, name in enumerate(
            (
                "desktop-artifact-manifest.json",
                "desktop-artifact-manifest.json.sig",
                "desktop.tar.zst",
                "desktop.tar.zst.sig",
                "desktop-signing-public.key",
            )
        )
    ]
    document = {
        "schema": "ai.elizaos.mkosi-build-evidence.v1",
        "claimBoundary": "mkosi_disk_assembly_only_no_boot_or_hardware_claim",
        "success": True,
        "errors": [],
        "returnCode": 0,
        "preflightOnly": False,
        "buildMode": "release",
        "sourceDirty": False,
        "architecture": architecture,
        "profile": "default",
        "sourceCommit": "a" * 40,
        "configurationSha256": configuration * 64,
        "sourceDateEpoch": "1700000000",
        "debianSnapshotUrl": "https://snapshot.debian.org/archive/debian/20260817T000000Z/",
        "mkosiVersion": "mkosi 25.3",
        "desktopArtifactInputs": desktop_inputs,
        "artifacts": [
            {
                "path": f"/isolated/{compressed.name}",
                "size": compressed.stat().st_size,
                "sha256": sha256(compressed),
            }
        ],
    }
    path.write_text(json.dumps(document), encoding="utf-8")


def run_qualifier(root: Path, *, diffoscope: str = "diffoscope") -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--build-a-evidence", str(root / "build-a.json"),
            "--build-b-evidence", str(root / "build-b.json"),
            "--compressed-a", str(root / "a.raw.zst"),
            "--compressed-b", str(root / "b.raw.zst"),
            "--image-a", str(root / "a.raw"),
            "--image-b", str(root / "b.raw"),
            "--evidence", str(root / "reproducibility.json"),
            "--diffoscope-report", str(root / "diffoscope.txt"),
            "--diffoscope", diffoscope,
        ],
        text=True,
        capture_output=True,
        check=False,
    )


def fixture(root: Path, a_byte: int, b_byte: int) -> None:
    make_image(root / "a.raw", a_byte)
    make_image(root / "b.raw", b_byte)
    compress(root / "a.raw", root / "a.raw.zst")
    compress(root / "b.raw", root / "b.raw.zst")
    build_evidence(root / "build-a.json", root / "a.raw.zst")
    build_evidence(root / "build-b.json", root / "b.raw.zst")


@unittest.skipUnless(sys.platform == "linux", "GPT qualification requires Linux")
class ReproducibilityQualificationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        missing = [tool for tool in ("sfdisk", "zstd") if not shutil.which(tool)]
        if missing:
            raise RuntimeError(
                "Linux reproducibility tests require tools on PATH: " + ", ".join(missing)
            )

    def test_identical_root_partitions_pass_with_independent_whole_disks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture(root, 7, 7)
            result = run_qualifier(root)
            document = json.loads((root / "reproducibility.json").read_text())
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(document["success"])
            self.assertTrue(document["reproducible"])
            self.assertEqual(
                document["rootPartitions"]["buildA"]["sha256"],
                document["rootPartitions"]["buildB"]["sha256"],
            )
            self.assertNotEqual(
                document["inputs"]["buildA"]["expanded"]["sha256"],
                document["inputs"]["buildB"]["expanded"]["sha256"],
            )
            self.assertFalse((root / "diffoscope.txt").exists())

    def test_root_drift_fails_and_retains_diffoscope_report(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture(root, 7, 8)
            fake = root / "fake-diffoscope"
            fake.write_text(
                """#!/bin/sh
set -eu
report=
while [ "$#" -gt 0 ]; do
    if [ "$1" = --text ]; then report=$2; shift 2; else shift; fi
done
printf '%s\n' 'root partition bytes differ' > "$report"
exit 1
""",
                encoding="utf-8",
            )
            fake.chmod(0o755)
            result = run_qualifier(root, diffoscope=str(fake))
            document = json.loads((root / "reproducibility.json").read_text())
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(document["success"])
            self.assertFalse(document["reproducible"])
            self.assertTrue(document["diffoscope"]["completed"])
            self.assertRegex(document["diffoscope"]["report"]["sha256"], r"^[0-9a-f]{64}$")
            self.assertIn("not byte-reproducible", " ".join(document["errors"]))

    def test_mismatched_build_inputs_fail_before_comparison(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture(root, 7, 7)
            build_evidence(root / "build-b.json", root / "b.raw.zst", configuration="d")
            result = run_qualifier(root)
            document = json.loads((root / "reproducibility.json").read_text())
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(document["success"])
            self.assertNotIn("rootPartitions", document)
            self.assertIn("identical reproducibility inputs", " ".join(document["errors"]))

    def test_expanded_bytes_must_match_the_bound_compressed_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture(root, 7, 7)
            with (root / "b.raw").open("r+b") as stream:
                stream.seek(ROOT_OFFSET)
                stream.write(b"changed")
            result = run_qualifier(root)
            document = json.loads((root / "reproducibility.json").read_text())
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("does not match its compressed", " ".join(document["errors"]))

    def test_unlabelled_discoverable_root_partition_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            make_image(root / "a.raw", 7, partition_name=None)
            make_image(root / "b.raw", 7, partition_name=None)
            compress(root / "a.raw", root / "a.raw.zst")
            compress(root / "b.raw", root / "b.raw.zst")
            build_evidence(root / "build-a.json", root / "a.raw.zst")
            build_evidence(root / "build-b.json", root / "b.raw.zst")
            result = run_qualifier(root)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_wrong_partition_type_is_not_accepted_as_root(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture(root, 7, 7)
            make_image(
                root / "b.raw",
                7,
                partition_type="0fc63daf-8483-4772-8e79-3d69d8477de4",
            )
            compress(root / "b.raw", root / "b.raw.zst")
            build_evidence(root / "build-b.json", root / "b.raw.zst")
            result = run_qualifier(root)
            document = json.loads((root / "reproducibility.json").read_text())
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("discoverable root partition", " ".join(document["errors"]))

    def test_copied_build_evidence_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture(root, 7, 7)
            (root / "build-b.json").write_bytes((root / "build-a.json").read_bytes())
            result = run_qualifier(root)
            document = json.loads((root / "reproducibility.json").read_text())
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("distinct build evidence records", " ".join(document["errors"]))

    def test_output_alias_is_rejected_without_overwriting_input(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture(root, 7, 7)
            original = (root / "a.raw").read_bytes()
            command = [
                sys.executable,
                str(SCRIPT),
                "--build-a-evidence", str(root / "build-a.json"),
                "--build-b-evidence", str(root / "build-b.json"),
                "--compressed-a", str(root / "a.raw.zst"),
                "--compressed-b", str(root / "b.raw.zst"),
                "--image-a", str(root / "a.raw"),
                "--image-b", str(root / "b.raw"),
                "--evidence", str(root / "a.raw"),
                "--diffoscope-report", str(root / "diffoscope.txt"),
            ]
            result = subprocess.run(command, text=True, capture_output=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((root / "a.raw").read_bytes(), original)

    def test_predictable_temporary_hardlink_cannot_clobber_input(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture(root, 7, 7)
            original = (root / "build-a.json").read_bytes()
            os.link(root / "build-a.json", root / "reproducibility.json.tmp")
            result = run_qualifier(root)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / "build-a.json").read_bytes(), original)
            self.assertEqual((root / "reproducibility.json.tmp").read_bytes(), original)

    def test_contradictory_successful_build_evidence_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture(root, 7, 7)
            for name in ("build-a.json", "build-b.json"):
                path = root / name
                document = json.loads(path.read_text())
                document["returnCode"] = 99
                document["errors"] = ["mkosi build exited with status 99"]
                path.write_text(json.dumps(document), encoding="utf-8")
            result = run_qualifier(root)
            document = json.loads((root / "reproducibility.json").read_text())
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("not a successful clean release build", " ".join(document["errors"]))

    def test_each_architecture_uses_its_discoverable_root_type(self) -> None:
        types = {
            "arm64": "b921b045-1df0-41c3-af44-4c6f280d3fae",
            "riscv64": "72ec70a6-cf74-40e6-bd49-4bda08e8f224",
        }
        for architecture, partition_type in types.items():
            with self.subTest(architecture=architecture), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                make_image(root / "a.raw", 7, partition_type=partition_type)
                make_image(root / "b.raw", 7, partition_type=partition_type)
                compress(root / "a.raw", root / "a.raw.zst")
                compress(root / "b.raw", root / "b.raw.zst")
                build_evidence(
                    root / "build-a.json", root / "a.raw.zst", architecture=architecture
                )
                build_evidence(
                    root / "build-b.json", root / "b.raw.zst", architecture=architecture
                )
                result = run_qualifier(root)
                self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
