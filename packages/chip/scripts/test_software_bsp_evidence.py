#!/usr/bin/env python3
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import check_software_bsp  # noqa: E402


class SoftwareBspEvidenceTest(unittest.TestCase):
    def test_manifest_enumerates_all_checker_evidence_paths(self) -> None:
        manifest = json.loads(check_software_bsp.EVIDENCE_MANIFEST.read_text())
        self.assertEqual(manifest["claim_boundary"], "external_transcripts_only")

        for target, spec in check_software_bsp.TARGETS.items():
            with self.subTest(target=target):
                manifest_paths = {item["path"] for item in manifest["targets"][target]["evidence"]}
                self.assertEqual(set(spec["evidence"]), manifest_paths)

    def test_android_manifest_does_not_claim_compatibility(self) -> None:
        manifest = json.loads(check_software_bsp.AOSP_EVIDENCE_MANIFEST.read_text())
        self.assertEqual(
            manifest["claim_boundary"],
            "android_external_logs_only_not_boot_or_compatibility_evidence",
        )
        self.assertEqual(
            manifest["compatibility_claim"],
            "none_without_full_external_compatibility_evidence",
        )

        paths = {item["path"] for item in manifest["evidence"]}
        self.assertIn("docs/evidence/android/eliza_ai_soc_cts_vts_plan.log", paths)
        self.assertIn("docs/evidence/android/cuttlefish_riscv64_smoke.log", paths)
        self.assertIn("docs/evidence/android/qemu_riscv64_smoke.log", paths)
        self.assertIn("docs/evidence/android/renode_e1_soc_smoke.log", paths)
        claims = "\n".join(item["claim"] for item in manifest["evidence"])
        self.assertNotIn("CDD compliant", claims)
        self.assertNotIn("full CTS pass", claims)
        self.assertNotIn("full VTS pass", claims)

        by_path = {item["path"]: item for item in manifest["evidence"]}
        for path in check_software_bsp.AOSP_REFERENCE_ONLY_PATHS:
            self.assertEqual(
                by_path[path]["claim_boundary"],
                check_software_bsp.AOSP_VIRTUAL_DEVICE_BOUNDARY,
            )
            self.assertIn("reference", by_path[path]["claim"].lower())

    def test_nnapi_proof_template_matches_fail_closed_harness_contract(self) -> None:
        template = json.loads(check_software_bsp.NNAPI_PROOF_TEMPLATE.read_text())
        self.assertEqual(template["schema"], "eliza.e1_npu_nnapi_capability.v1")
        self.assertIn("trace_bytes", template["dma"])

        transcripts = template["transcripts"]
        self.assertEqual(set(transcripts), check_software_bsp.REQUIRED_NNAPI_TRANSCRIPTS)
        for name, entry in transcripts.items():
            with self.subTest(transcript=name):
                self.assertIsInstance(entry, dict)
                self.assertFalse(Path(entry["path"]).is_absolute())
                self.assertTrue(entry["path"].startswith("docs/evidence/android/e1-npu/"))
                self.assertIn("64-character lowercase sha256", entry["sha256"])
                self.assertIsInstance(entry["bytes"], int)

    def test_android_proof_manifest_template_is_blocked_and_path_pinned(self) -> None:
        template = json.loads(check_software_bsp.ANDROID_PROOF_TEMPLATE.read_text())
        self.assertEqual(
            template["claim_boundary"],
            check_software_bsp.ANDROID_PROOF_TEMPLATE_BOUNDARY,
        )
        self.assertEqual(template["status"], "blocked")
        self.assertEqual(template["proof_gate"]["android_boot_claim"], "none")
        self.assertEqual(template["proof_gate"]["compatibility_claim"], "none")
        self.assertEqual(
            template["proof_gate"]["nnapi_acceleration_claim"],
            "none_without_all_required_artifacts_passed",
        )

        self.assertEqual(
            set(template["required_statuses"]),
            check_software_bsp.REQUIRED_ANDROID_PROOF_STATUSES,
        )
        self.assertTrue(
            all(status == "blocked" for status in template["required_statuses"].values())
        )
        for name, expected_path in check_software_bsp.REQUIRED_ANDROID_PROOF_ARTIFACTS.items():
            with self.subTest(artifact=name):
                artifact = template["artifacts"][name]
                self.assertEqual(artifact["path"], expected_path)
                self.assertIn("64-character lowercase sha256", artifact["sha256"])

    def test_scaffold_only_passes_while_listing_missing_external_logs(self) -> None:
        result = subprocess.run(
            [sys.executable, "scripts/check_software_bsp.py", "all", "--scaffold-only"],
            cwd=ROOT,
            text=True,
            capture_output=True,
        )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        # Scaffold pass declaration is emitted per-target.
        self.assertIn(
            "aosp BSP scaffold check passed; external evidence remains BLOCKED.",
            result.stdout,
        )
        # Scaffold-only mode does not fail on external logs, but it still
        # surfaces the pending evidence contracts with capture/validate
        # commands for targets that are not release-ready.
        self.assertIn("aosp BSP external evidence pending", result.stdout)
        self.assertNotIn("u-boot BSP external evidence pending", result.stdout)
        self.assertNotIn("missing docs/evidence/linux/u_boot_eliza_build.log", result.stdout)
        self.assertNotIn("BSP check failed", result.stdout)

    def test_require_evidence_fails_closed_on_missing_external_logs(self) -> None:
        result = subprocess.run(
            [sys.executable, "scripts/check_software_bsp.py", "all", "--require-evidence"],
            cwd=ROOT,
            text=True,
            capture_output=True,
        )

        # With --require-evidence, targets with captured PASS logs may pass,
        # while targets with missing or invalid external evidence must fail
        # closed.
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("buildroot BSP scaffold and evidence checks passed.", result.stdout)
        self.assertIn("linux BSP scaffold and evidence checks passed.", result.stdout)
        self.assertIn("opensbi BSP scaffold and evidence checks passed.", result.stdout)
        self.assertIn("aosp BSP check failed", result.stdout)
        self.assertNotIn("u-boot BSP BLOCKED: missing evidence", result.stdout)
        self.assertIn("aosp BSP BLOCKED: external evidence", result.stdout)

    def test_status_helper_reports_missing_external_logs(self) -> None:
        result = subprocess.run(
            [sys.executable, "scripts/check_software_bsp.py", "status", "u-boot"],
            cwd=ROOT,
            text=True,
            capture_output=True,
        )

        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("[MISSING] U-Boot Eliza build transcript", result.stdout)
        self.assertIn("capture:", result.stdout)
        self.assertIn("validate:", result.stdout)

    def test_capture_plan_renders_exact_buildroot_commands(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                "scripts/check_software_bsp.py",
                "capture-plan",
                "buildroot",
                "--buildroot",
                "/external/buildroot",
                "--target-host",
                "root@eliza-target",
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
        )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(
            "sw/buildroot/scripts/capture-buildroot-evidence.sh /external/buildroot defconfig",
            result.stdout,
        )
        self.assertIn(
            "E1_SMOKE_CMD='ssh root@eliza-target /usr/bin/e1-mmio-smoke'",
            result.stdout,
        )

    def test_capture_plan_renders_exact_opensbi_commands(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                "scripts/check_software_bsp.py",
                "capture-plan",
                "opensbi",
                "--opensbi",
                "/external/opensbi",
                "--opensbi-handoff-cmd",
                "qemu-system-riscv64 -bios fw_dynamic.bin",
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
        )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(
            "sw/opensbi/scripts/import-opensbi-platform.sh --check /external/opensbi",
            result.stdout,
        )
        self.assertIn(
            "ELIZA_OPENSBI_HANDOFF_CMD='qemu-system-riscv64 -bios fw_dynamic.bin'",
            result.stdout,
        )

    def test_capture_plan_renders_exact_uboot_commands(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                "scripts/check_software_bsp.py",
                "capture-plan",
                "u-boot",
                "--u-boot",
                "/external/u-boot",
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
        )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(
            "docs/sw/u-boot/capture-u-boot-evidence.sh /external/u-boot build",
            result.stdout,
        )
        self.assertIn(
            "docs/sw/u-boot/capture-u-boot-evidence.sh /external/u-boot boot-chain",
            result.stdout,
        )

    def test_external_preflight_output_sanitizes_host_local_paths(self) -> None:
        raw = {
            "host": {"cwd": str(check_software_bsp.ROOT), "tmp": "/tmp/e1-mmio-smoke"},
            "targets": [
                {
                    "tree": str(check_software_bsp.ROOT / "external/linux"),
                    "blockers": [f"missing {check_software_bsp.ROOT / 'external/linux/Kconfig'}"],
                    "commands": [
                        f"run {check_software_bsp.ROOT / 'external/linux'} /var/tmp/evidence"
                    ],
                }
            ],
        }

        sanitized = check_software_bsp.provenance_safe_value(raw)
        encoded = json.dumps(sanitized, sort_keys=True)

        self.assertNotIn(str(check_software_bsp.ROOT), encoded)
        self.assertNotIn("/tmp/", encoded)
        self.assertNotIn("/var/tmp/", encoded)
        self.assertIn("<repo>/external/linux", encoded)
        self.assertIn("<tmp>/e1-mmio-smoke", encoded)
        self.assertIn("<var-tmp>/evidence", encoded)

    def test_placeholder_or_failed_log_cannot_pass_validation(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            evidence = temp_root / "docs/evidence/linux/fake.log"
            evidence.parent.mkdir(parents=True)
            evidence.write_text(
                "\n".join(
                    [
                        "eliza-evidence: target=linux artifact=eliza_e1_kernel_build",
                        "eliza-evidence: command=make ARCH=riscv Image",
                        "eliza-evidence: started_utc=2026-05-17T00:00:00Z",
                        "CONFIG_ELIZA_E1=y",
                        "placeholder output",
                        "eliza-evidence: status=FAIL rc=1",
                        "eliza-evidence: ended_utc=2026-05-17T00:00:01Z",
                    ]
                )
            )
            item = {
                "path": "docs/evidence/linux/fake.log",
                "min_bytes": 80,
                "capture_command": "fake",
                "required_strings": [
                    "eliza-evidence: target=linux artifact=eliza_e1_kernel_build",
                    "CONFIG_ELIZA_E1",
                    "eliza-evidence: status=PASS",
                ],
            }

            with mock.patch.object(check_software_bsp, "ROOT", temp_root):
                problems = check_software_bsp.validate_evidence_file(item)

        joined = "\n".join(problems)
        self.assertIn("reports non-PASS evidence status: FAIL", joined)
        self.assertIn("contains forbidden placeholder/failure markers", joined)
        self.assertIn("missing required transcript markers", joined)

    def test_reference_only_android_logs_require_explicit_boundary_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            evidence = temp_root / "docs/evidence/android/cuttlefish_riscv64_boot.log"
            evidence.parent.mkdir(parents=True)
            evidence.write_text(
                "\n".join(
                    [
                        "eliza-evidence: target=aosp artifact=cuttlefish_riscv64_boot",
                        "eliza-evidence: command=launch_cvd",
                        "eliza-evidence: started_utc=2026-05-17T00:00:00Z",
                        "launch_cvd",
                        "adb shell",
                        "ro.product.cpu.abi=riscv64",
                        "sys.boot_completed=1",
                        "eliza-evidence: ended_utc=2026-05-17T00:00:01Z",
                        "eliza-evidence: status=PASS",
                    ]
                )
            )
            item = {
                "path": "docs/evidence/android/cuttlefish_riscv64_boot.log",
                "claim_boundary": check_software_bsp.AOSP_REFERENCE_ONLY_BOUNDARY,
                "min_bytes": 80,
                "capture_command": "fake",
                "required_strings": [
                    "eliza-evidence: target=aosp artifact=cuttlefish_riscv64_boot",
                    "launch_cvd",
                    "adb shell",
                    "ro.product.cpu.abi=riscv64",
                    "sys.boot_completed=1",
                    "eliza-evidence: status=PASS",
                ],
            }

            with mock.patch.object(check_software_bsp, "ROOT", temp_root):
                problems = check_software_bsp.validate_evidence_file(item)

        self.assertIn("missing reference-only claim boundary marker", "\n".join(problems))


if __name__ == "__main__":
    unittest.main()
