#!/usr/bin/env python3
"""Tests for ``scripts/aggregate_tapeout_readiness.py``.

Covers the prefix-based classifier, the report builder, the exit-code policy,
and the static gate inventory.
"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import aggregate_tapeout_readiness as agg  # noqa: E402


class ClassifyTests(unittest.TestCase):
    def test_status_blocked_prefix_wins_over_zero_exit(self) -> None:
        self.assertEqual(
            agg._classify(0, "STATUS: BLOCKED foo - missing PDK"),
            "BLOCKED",
        )

    def test_status_blocked_prefix_wins_over_non_zero_exit(self) -> None:
        self.assertEqual(
            agg._classify(1, "STATUS: BLOCKED bar - missing tool"),
            "BLOCKED",
        )

    def test_non_zero_exit_without_blocked_is_fail(self) -> None:
        self.assertEqual(
            agg._classify(1, "FAIL: padframe pin missing\n"),
            "FAIL",
        )

    def test_zero_exit_is_pass(self) -> None:
        self.assertEqual(
            agg._classify(0, "cpu 2028 target check passed\n"),
            "PASS",
        )


class EvidenceLineTests(unittest.TestCase):
    def test_prefers_blocked_line(self) -> None:
        out = "starting check\nSTATUS: BLOCKED foo - missing\ndone\n"
        self.assertEqual(
            agg._first_evidence_line("foo", out, 0),
            "STATUS: BLOCKED foo - missing",
        )

    def test_blocked_wins_over_status_pass(self) -> None:
        out = (
            "STATUS: PASS cpu.core_selection\n"
            "STATUS: BLOCKED cpu.core_selection_big_core - license required\n"
        )
        self.assertEqual(
            agg._first_evidence_line("foo", out, 0),
            "STATUS: BLOCKED cpu.core_selection_big_core - license required",
        )

    def test_prefers_fail_line(self) -> None:
        out = "starting\nFAIL: something broke\n"
        self.assertEqual(
            agg._first_evidence_line("foo", out, 1),
            "FAIL: something broke",
        )

    def test_status_pass_line_picked_when_no_blocker(self) -> None:
        out = "preamble\nSTATUS: PASS rva23.llvm_pin_sha — abc\n"
        self.assertEqual(
            agg._first_evidence_line("foo", out, 0),
            "STATUS: PASS rva23.llvm_pin_sha — abc",
        )

    def test_falls_back_to_first_nonempty_line(self) -> None:
        out = "\n\ncheck passed: 42 items\n"
        self.assertEqual(
            agg._first_evidence_line("foo", out, 0),
            "check passed: 42 items",
        )

    def test_truncates_to_200_chars(self) -> None:
        out = "BLOCKED: " + ("x" * 500)
        self.assertEqual(len(agg._first_evidence_line("foo", out, 0)), 200)

    def test_empty_output_synthesises_evidence(self) -> None:
        self.assertEqual(
            agg._first_evidence_line("foo", "", 0),
            "foo: no output (exit=0)",
        )


class BuildReportTests(unittest.TestCase):
    def _result(self, status: agg.Status) -> agg.GateResult:
        return agg.GateResult(
            name="g",
            status=status,
            evidence="ev",
            subsystem="cpu",
            tier="spec",
        )

    def test_release_blocker_is_true_when_any_fail(self) -> None:
        report = agg.build_report(
            [self._result("PASS"), self._result("FAIL"), self._result("BLOCKED")]
        )
        self.assertTrue(report["release_blocker"])
        self.assertEqual(report["summary"], {"pass": 1, "fail": 1, "blocked": 1})

    def test_release_blocker_false_when_only_blocked(self) -> None:
        report = agg.build_report([self._result("PASS"), self._result("BLOCKED")])
        self.assertFalse(report["release_blocker"])

    def test_release_blocker_false_when_all_pass(self) -> None:
        report = agg.build_report([self._result("PASS"), self._result("PASS")])
        self.assertFalse(report["release_blocker"])

    def test_schema_and_claim_boundary_fields(self) -> None:
        report = agg.build_report([self._result("PASS")])
        self.assertEqual(report["schema"], "eliza.tapeout_readiness.v1")
        self.assertEqual(
            report["claim_boundary"],
            "tapeout_readiness_aggregator_view_only_no_silicon_or_release_claim",
        )


class GateInventoryTests(unittest.TestCase):
    def test_every_gate_script_exists(self) -> None:
        for spec in agg.GATES:
            with self.subTest(gate=spec.name):
                self.assertTrue(
                    (ROOT / spec.script).is_file(),
                    f"missing script for gate {spec.name}: {spec.script}",
                )

    def test_gate_names_are_unique(self) -> None:
        names = [spec.name for spec in agg.GATES]
        self.assertEqual(len(names), len(set(names)))

    def test_subsystems_and_tiers_are_allowed(self) -> None:
        allowed_subsystems = {
            "cpu",
            "memory",
            "security",
            "npu",
            "process",
            "pd",
            "platform",
            "bsp",
            "verify",
            "benchmarks",
            "os_rv64",
        }
        allowed_tiers = {"spec", "rtl", "pd", "silicon"}
        for spec in agg.GATES:
            with self.subTest(gate=spec.name):
                self.assertIn(spec.subsystem, allowed_subsystems)
                self.assertIn(spec.tier, allowed_tiers)

    def test_at_least_one_gate_per_subsystem(self) -> None:
        required = {
            "cpu",
            "memory",
            "security",
            "npu",
            "process",
            "pd",
            "platform",
            "bsp",
            "verify",
            "benchmarks",
            "os_rv64",
        }
        present = {spec.subsystem for spec in agg.GATES}
        missing = required - present
        self.assertFalse(missing, f"missing subsystem coverage: {missing}")

    def test_chipyard_generated_linux_contract_gate_requires_boot_evidence(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("chipyard-generated-linux-contract-check", specs)
        self.assertEqual(
            specs["chipyard-generated-linux-contract-check"].args,
            ("--require-boot-evidence",),
        )

    def test_pd_soc_input_contract_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("pd-soc-input-contract-check", specs)
        spec = specs["pd-soc-input-contract-check"]
        self.assertEqual(spec.script, "scripts/check_e1_soc_pd_input_contract.py")
        self.assertEqual(spec.subsystem, "pd")
        self.assertEqual(spec.tier, "pd")
        self.assertEqual(spec.args, ("--strict",))

    def test_e1_phone_board_package_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("e1-phone-board-package-check", specs)
        spec = specs["e1-phone-board-package-check"]
        self.assertEqual(spec.script, "scripts/check_e1_phone_board_package.py")
        self.assertEqual(spec.subsystem, "platform")
        self.assertEqual(spec.tier, "pd")

    def test_e1_phone_fabrication_release_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("e1-phone-fabrication-release-check", specs)
        spec = specs["e1-phone-fabrication-release-check"]
        self.assertEqual(spec.script, "scripts/check_e1_phone_fabrication_release.py")
        self.assertEqual(spec.subsystem, "platform")
        self.assertEqual(spec.tier, "pd")

    def test_e1_phone_release_evidence_regeneration_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("e1-phone-release-evidence-regeneration-check", specs)
        spec = specs["e1-phone-release-evidence-regeneration-check"]
        self.assertEqual(
            spec.script,
            "scripts/check_e1_phone_release_evidence_regeneration.py",
        )
        self.assertEqual(spec.subsystem, "platform")
        self.assertEqual(spec.tier, "pd")

    def test_e1_phone_release_approval_signature_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("e1-phone-release-approval-signature-check", specs)
        spec = specs["e1-phone-release-approval-signature-check"]
        self.assertEqual(
            spec.script,
            "scripts/check_e1_phone_release_approval_signatures.py",
        )
        self.assertEqual(spec.subsystem, "platform")
        self.assertEqual(spec.tier, "pd")

    def test_e1_phone_supplier_return_content_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("e1-phone-supplier-return-content-check", specs)
        spec = specs["e1-phone-supplier-return-content-check"]
        self.assertEqual(
            spec.script,
            "scripts/check_e1_phone_supplier_return_content.py",
        )
        self.assertEqual(spec.subsystem, "platform")
        self.assertEqual(spec.tier, "pd")

    def test_e1_phone_routed_output_content_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("e1-phone-routed-output-content-check", specs)
        spec = specs["e1-phone-routed-output-content-check"]
        self.assertEqual(
            spec.script,
            "scripts/check_e1_phone_routed_output_content.py",
        )
        self.assertEqual(spec.subsystem, "platform")
        self.assertEqual(spec.tier, "pd")

    def test_e1_phone_factory_output_content_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("e1-phone-factory-output-content-check", specs)
        spec = specs["e1-phone-factory-output-content-check"]
        self.assertEqual(
            spec.script,
            "scripts/check_e1_phone_factory_output_content.py",
        )
        self.assertEqual(spec.subsystem, "platform")
        self.assertEqual(spec.tier, "pd")

    def test_e1_phone_first_article_content_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("e1-phone-first-article-content-check", specs)
        spec = specs["e1-phone-first-article-content-check"]
        self.assertEqual(
            spec.script,
            "scripts/check_e1_phone_first_article_content.py",
        )
        self.assertEqual(spec.subsystem, "platform")
        self.assertEqual(spec.tier, "pd")

    def test_e1_phone_enclosure_mechanical_content_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("e1-phone-enclosure-mechanical-content-check", specs)
        spec = specs["e1-phone-enclosure-mechanical-content-check"]
        self.assertEqual(
            spec.script,
            "scripts/check_e1_phone_enclosure_mechanical_content.py",
        )
        self.assertEqual(spec.subsystem, "platform")
        self.assertEqual(spec.tier, "pd")

    def test_product_dependency_gates_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        expected = {
            "pinout-check": (
                "package/scripts/validate_pinout.py",
                "pd",
                "spec",
                ("package/e1-demo-pinout.yaml",),
            ),
            "e1-phone-manufacturing-artifacts-check": (
                "scripts/check_manufacturing_artifacts.py",
                "platform",
                "pd",
                ("--manifest", "board/kicad/e1-phone/artifact-manifest.yaml"),
            ),
            "pdk-access-gate": (
                "scripts/check_pdk_portability.py",
                "process",
                "pd",
                (),
            ),
            "io-cell-contract-check": (
                "scripts/check_io_cell_contract.py",
                "pd",
                "pd",
                (),
            ),
            "rail-plan-check": ("scripts/check_rail_plan.py", "pd", "pd", ()),
            "upf-check": ("scripts/check_upf_consistency.py", "pd", "pd", ()),
            "pdn-workload-signoff": (
                "scripts/check_pdn_workload_signoff.py",
                "pd",
                "pd",
                (),
            ),
            "pmic-procurement-gate": (
                "scripts/check_pdn_workload_signoff.py",
                "pd",
                "pd",
                ("--allow-blocked",),
            ),
        }
        for name, (script, subsystem, tier, args) in expected.items():
            with self.subTest(name=name):
                self.assertIn(name, specs)
                self.assertEqual(specs[name].script, script)
                self.assertEqual(specs[name].subsystem, subsystem)
                self.assertEqual(specs[name].tier, tier)
                self.assertEqual(specs[name].args, args)

    def test_release_mode_gates_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        expected = {
            "pd-signoff-check": ("scripts/check_pd_signoff.py", "pd", ()),
            "manufacturing-artifacts-release-check": (
                "scripts/check_manufacturing_artifacts.py",
                "platform",
                ("--release",),
            ),
            "fpga-release-check": (
                "scripts/check_fpga_release.py",
                "platform",
                ("--release",),
            ),
            "antenna-metadata-release-check": (
                "scripts/check_antenna_metadata.py",
                "pd",
                ("--release",),
            ),
        }
        for name, (script, subsystem, args) in expected.items():
            with self.subTest(name=name):
                self.assertIn(name, specs)
                self.assertEqual(specs[name].script, script)
                self.assertEqual(specs[name].subsystem, subsystem)
                self.assertEqual(specs[name].args, args)

    def test_os_rv64_subsystem_present(self) -> None:
        """The unified bring-up dashboard requires at least one os_rv64 gate.

        The chip aggregator spans the chip and OS RV64 variant so that a
        single ``make chip-os-bring-up-status`` view covers both halves of
        the promotion contract. If this assertion fails the unified
        dashboard has silently lost its OS side.
        """
        os_gates = [spec for spec in agg.GATES if spec.subsystem == "os_rv64"]
        self.assertTrue(os_gates, "no os_rv64 gates registered in GATES")
        names = {spec.name for spec in os_gates}
        self.assertIn("os-rv64-release-check", names)
        self.assertIn("os-rv64-qemu-virt-boot-test", names)

    def test_android_release_readiness_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("android-release-readiness-contract-check", names)

    def test_phone_runtime_readiness_contract_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("phone-runtime-readiness-contract-check", names)

    def test_chipyard_ap_abi_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("chipyard-ap-abi-contract-check", names)

    def test_chipyard_generated_linux_contract_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("chipyard-generated-linux-contract-check", specs)
        self.assertEqual(
            specs["chipyard-generated-linux-contract-check"].args,
            ("--require-boot-evidence",),
        )

    def test_boot_security_chain_contract_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("boot-security-chain-contract-check", names)

    def test_linux_bsp_contract_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("linux-bsp-contract-check", names)

    def test_linux_boot_artifacts_gate_registered(self) -> None:
        specs = {spec.name: spec for spec in agg.GATES}
        self.assertIn("linux-boot-artifacts-check", specs)
        self.assertEqual(specs["linux-boot-artifacts-check"].args, ("--require-pass",))

    def test_linux_firmware_boot_chain_contract_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("linux-firmware-boot-chain-contract-check", names)

    def test_linux_memory_platform_contract_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("linux-memory-platform-contract-check", names)

    def test_chipyard_verilator_linux_smoke_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("chipyard-verilator-linux-smoke-check", names)

    def test_aosp_hal_service_contract_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("aosp-hal-service-contract-check", names)

    def test_aosp_linux_handoff_contract_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("aosp-linux-handoff-contract-check", names)

    def test_android_evidence_capture_contract_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("android-evidence-capture-contract-check", names)

    def test_android_simulated_peripheral_evidence_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("android-simulated-peripheral-evidence-check", names)

    def test_cross_fork_agent_payload_contract_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("cross-fork-agent-payload-contract-check", names)

    def test_chip_os_bringup_workflow_contract_gate_registered(self) -> None:
        names = {spec.name for spec in agg.GATES}
        self.assertIn("chip-os-bringup-workflow-contract-check", names)

    def test_host_local_paths_are_not_hardcoded(self) -> None:
        for spec in agg.GATES:
            with self.subTest(gate=spec.name):
                self.assertNotIn("/home/shaw/", spec.script)


class MainExitCodeTests(unittest.TestCase):
    def test_main_returns_zero_when_no_fail(self) -> None:
        fake_results = [
            agg.GateResult(
                name="ok",
                status="PASS",
                evidence="ok",
                subsystem="cpu",
                tier="spec",
            ),
            agg.GateResult(
                name="ext-dep",
                status="BLOCKED",
                evidence="STATUS: BLOCKED ext",
                subsystem="pd",
                tier="pd",
            ),
        ]
        with (
            mock.patch.object(agg, "run_gate", side_effect=lambda spec: fake_results.pop(0)),
            mock.patch.object(agg, "GATES", agg.GATES[:2]),
            mock.patch.object(agg, "write_report"),
        ):
            rc = agg.main(["--json-only"])
        self.assertEqual(rc, 0)

    def test_main_returns_one_when_any_fail(self) -> None:
        fake_results = [
            agg.GateResult(
                name="ok",
                status="PASS",
                evidence="ok",
                subsystem="cpu",
                tier="spec",
            ),
            agg.GateResult(
                name="bad",
                status="FAIL",
                evidence="FAIL: broken",
                subsystem="pd",
                tier="pd",
            ),
        ]
        with (
            mock.patch.object(agg, "run_gate", side_effect=lambda spec: fake_results.pop(0)),
            mock.patch.object(agg, "GATES", agg.GATES[:2]),
            mock.patch.object(agg, "write_report"),
        ):
            rc = agg.main(["--json-only"])
        self.assertEqual(rc, 1)

    def test_strict_mode_returns_one_on_blocked(self) -> None:
        fake_results = [
            agg.GateResult(
                name="ok",
                status="PASS",
                evidence="ok",
                subsystem="cpu",
                tier="spec",
            ),
            agg.GateResult(
                name="ext-dep",
                status="BLOCKED",
                evidence="STATUS: BLOCKED ext",
                subsystem="pd",
                tier="pd",
            ),
        ]
        with (
            mock.patch.object(agg, "run_gate", side_effect=lambda spec: fake_results.pop(0)),
            mock.patch.object(agg, "GATES", agg.GATES[:2]),
            mock.patch.object(agg, "write_report"),
        ):
            rc = agg.main(["--strict", "--json-only"])
        self.assertEqual(rc, 1)

    def test_strict_mode_returns_zero_when_all_pass(self) -> None:
        fake_results = [
            agg.GateResult(
                name="ok-1",
                status="PASS",
                evidence="ok",
                subsystem="cpu",
                tier="spec",
            ),
            agg.GateResult(
                name="ok-2",
                status="PASS",
                evidence="ok",
                subsystem="npu",
                tier="spec",
            ),
        ]
        with (
            mock.patch.object(agg, "run_gate", side_effect=lambda spec: fake_results.pop(0)),
            mock.patch.object(agg, "GATES", agg.GATES[:2]),
            mock.patch.object(agg, "write_report"),
        ):
            rc = agg.main(["--strict", "--json-only"])
        self.assertEqual(rc, 0)


class PrintSummaryTests(unittest.TestCase):
    def test_strict_summary_marks_blocked_as_effective_release_blocker(self) -> None:
        report = agg.build_report(
            [
                agg.GateResult(
                    name="ext-dep",
                    status="BLOCKED",
                    evidence="STATUS: BLOCKED ext",
                    subsystem="pd",
                    tier="pd",
                )
            ]
        )
        with mock.patch("sys.stdout") as stdout:
            agg.print_summary(report, strict=True)
        printed = "".join(call.args[0] + "\n" for call in stdout.write.call_args_list)
        self.assertIn("release_blocker=False", printed)
        self.assertIn("effective_release_blocker=True", printed)
        self.assertIn("strict=True", printed)


class ReportFileTests(unittest.TestCase):
    def test_write_report_emits_valid_json_with_trailing_newline(self) -> None:
        import tempfile

        report = agg.build_report(
            [
                agg.GateResult(
                    name="x",
                    status="PASS",
                    evidence="ok",
                    subsystem="cpu",
                    tier="spec",
                )
            ]
        )
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "nested/dir/tapeout-readiness.json"
            with mock.patch.object(agg, "REPORT_PATH", target):
                agg.write_report(report)
            text = target.read_text()
        self.assertTrue(text.endswith("\n"))
        parsed = json.loads(text)
        self.assertEqual(parsed["schema"], "eliza.tapeout_readiness.v1")
        self.assertEqual(parsed["gates"][0]["name"], "x")


class AbsolutePathGateTests(unittest.TestCase):
    """The aggregator must accept absolute-path GateSpec entries so it can
    reach across packages (e.g. the OS RV64 variant's release-check).
    """

    def test_absolute_path_gate_runs_and_reports_pass(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "fake_gate.py"
            script.write_text(
                "#!/usr/bin/env python3\n"
                "import sys\n"
                "print('STATUS: PASS synthetic absolute-path gate')\n"
                "sys.exit(0)\n"
            )
            spec = agg.GateSpec(
                name="synthetic-abs-pass",
                script=str(script),
                subsystem="os_rv64",
                tier="spec",
            )
            result = agg.run_gate(spec)
        self.assertEqual(result.status, "PASS")
        self.assertEqual(result.name, "synthetic-abs-pass")
        self.assertIn("STATUS: PASS", result.evidence)

    def test_absolute_path_gate_classifies_blocked_marker(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "fake_blocked.py"
            script.write_text(
                "#!/usr/bin/env python3\n"
                "import sys\n"
                "print('STATUS: BLOCKED waiting on external dep')\n"
                "sys.exit(0)\n"
            )
            spec = agg.GateSpec(
                name="synthetic-abs-blocked",
                script=str(script),
                subsystem="os_rv64",
                tier="spec",
            )
            result = agg.run_gate(spec)
        self.assertEqual(result.status, "BLOCKED")

    def test_absolute_path_gate_missing_script_is_fail(self) -> None:
        spec = agg.GateSpec(
            name="synthetic-abs-missing",
            script="/definitely/not/here/missing_gate.py",
            subsystem="os_rv64",
            tier="spec",
        )
        result = agg.run_gate(spec)
        self.assertEqual(result.status, "FAIL")
        self.assertIn("script missing", result.evidence)


class E1PhoneBoardPackageGateTests(unittest.TestCase):
    def test_checker_exits_zero_but_reports_blocked_readiness(self) -> None:
        completed = subprocess.run(
            [sys.executable, "scripts/check_e1_phone_board_package.py"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=120,
            check=False,
        )
        combined = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 0, combined[-4000:])
        self.assertIn(
            "STATUS: BLOCKED E1 phone fabrication/enclosure/e2e release evidence "
            "is incomplete; structural package checks passed only",
            combined,
        )

    def test_aggregator_classifies_e1_phone_board_package_as_blocked(self) -> None:
        spec = next(gate for gate in agg.GATES if gate.name == "e1-phone-board-package-check")
        result = agg.run_gate(spec)
        self.assertEqual(result.status, "BLOCKED")
        self.assertIn("STATUS: BLOCKED E1 phone", result.evidence)


class E1PhoneFabricationReleaseGateTests(unittest.TestCase):
    def test_checker_exits_nonzero_and_reports_blocked_release(self) -> None:
        completed = subprocess.run(
            [sys.executable, "scripts/check_e1_phone_fabrication_release.py"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        combined = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 2, combined)
        self.assertIn(
            "STATUS: BLOCKED E1 phone fabrication/enclosure/e2e release gate",
            combined,
        )

    def test_aggregator_classifies_e1_phone_fabrication_release_as_blocked(
        self,
    ) -> None:
        spec = next(gate for gate in agg.GATES if gate.name == "e1-phone-fabrication-release-check")
        result = agg.run_gate(spec)
        self.assertEqual(result.status, "BLOCKED")
        self.assertIn("STATUS: BLOCKED E1 phone", result.evidence)


class E1PhoneReleaseEvidenceRegenerationGateTests(unittest.TestCase):
    def test_checker_reports_regeneration_drift_or_pass(self) -> None:
        completed = subprocess.run(
            [sys.executable, "scripts/check_e1_phone_release_evidence_regeneration.py"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=120,
            check=False,
        )
        combined = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 0, combined[-4000:])
        self.assertIn(
            "STATUS: PASS E1 phone release evidence regeneration",
            combined,
        )


class E1PhoneReleaseApprovalSignatureGateTests(unittest.TestCase):
    def test_checker_exits_nonzero_and_reports_blocked_approvals(self) -> None:
        completed = subprocess.run(
            [sys.executable, "scripts/check_e1_phone_release_approval_signatures.py"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        combined = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 2, combined[-4000:])
        self.assertIn(
            "STATUS: BLOCKED E1 phone release approval signatures",
            combined,
        )

    def test_aggregator_classifies_e1_phone_release_approvals_as_blocked(
        self,
    ) -> None:
        spec = next(
            gate for gate in agg.GATES if gate.name == "e1-phone-release-approval-signature-check"
        )
        result = agg.run_gate(spec)
        self.assertEqual(result.status, "BLOCKED")
        self.assertIn("STATUS: BLOCKED E1 phone release approval", result.evidence)


class E1PhoneSupplierReturnContentGateTests(unittest.TestCase):
    def test_checker_exits_nonzero_and_reports_blocked_supplier_content(self) -> None:
        completed = subprocess.run(
            [sys.executable, "scripts/check_e1_phone_supplier_return_content.py"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        combined = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 2, combined[-4000:])
        self.assertIn(
            "STATUS: BLOCKED E1 phone supplier-return content",
            combined,
        )

    def test_aggregator_classifies_e1_phone_supplier_content_as_blocked(
        self,
    ) -> None:
        spec = next(
            gate for gate in agg.GATES if gate.name == "e1-phone-supplier-return-content-check"
        )
        result = agg.run_gate(spec)
        self.assertEqual(result.status, "BLOCKED")
        self.assertIn("STATUS: BLOCKED E1 phone supplier-return", result.evidence)


class E1PhoneRoutedOutputContentGateTests(unittest.TestCase):
    def test_checker_exits_nonzero_and_reports_blocked_routed_content(self) -> None:
        completed = subprocess.run(
            [sys.executable, "scripts/check_e1_phone_routed_output_content.py"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        combined = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 2, combined[-4000:])
        self.assertIn(
            "STATUS: BLOCKED E1 phone routed-output content",
            combined,
        )

    def test_aggregator_classifies_e1_phone_routed_content_as_blocked(self) -> None:
        spec = next(
            gate for gate in agg.GATES if gate.name == "e1-phone-routed-output-content-check"
        )
        result = agg.run_gate(spec)
        self.assertEqual(result.status, "BLOCKED")
        self.assertIn("STATUS: BLOCKED E1 phone routed-output", result.evidence)


class E1PhoneFactoryOutputContentGateTests(unittest.TestCase):
    def test_checker_exits_nonzero_and_reports_blocked_factory_content(self) -> None:
        completed = subprocess.run(
            [sys.executable, "scripts/check_e1_phone_factory_output_content.py"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        combined = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 2, combined[-4000:])
        self.assertIn(
            "STATUS: BLOCKED E1 phone factory-output content",
            combined,
        )

    def test_aggregator_classifies_e1_phone_factory_content_as_blocked(self) -> None:
        spec = next(
            gate for gate in agg.GATES if gate.name == "e1-phone-factory-output-content-check"
        )
        result = agg.run_gate(spec)
        self.assertEqual(result.status, "BLOCKED")
        self.assertIn("STATUS: BLOCKED E1 phone factory-output", result.evidence)


class E1PhoneFirstArticleContentGateTests(unittest.TestCase):
    def test_checker_exits_nonzero_and_reports_blocked_first_article(self) -> None:
        completed = subprocess.run(
            [sys.executable, "scripts/check_e1_phone_first_article_content.py"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        combined = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 2, combined[-4000:])
        self.assertIn(
            "STATUS: BLOCKED E1 phone first-article content",
            combined,
        )

    def test_aggregator_classifies_e1_phone_first_article_as_blocked(self) -> None:
        spec = next(
            gate for gate in agg.GATES if gate.name == "e1-phone-first-article-content-check"
        )
        result = agg.run_gate(spec)
        self.assertEqual(result.status, "BLOCKED")
        self.assertIn("STATUS: BLOCKED E1 phone first-article", result.evidence)


class E1PhoneEnclosureMechanicalContentGateTests(unittest.TestCase):
    def test_checker_exits_nonzero_and_reports_blocked_enclosure(self) -> None:
        completed = subprocess.run(
            [sys.executable, "scripts/check_e1_phone_enclosure_mechanical_content.py"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
        combined = completed.stdout + completed.stderr
        self.assertEqual(completed.returncode, 2, combined[-4000:])
        self.assertIn(
            "STATUS: BLOCKED E1 phone enclosure mechanical content",
            combined,
        )

    def test_aggregator_classifies_e1_phone_enclosure_as_blocked(self) -> None:
        spec = next(
            gate for gate in agg.GATES if gate.name == "e1-phone-enclosure-mechanical-content-check"
        )
        result = agg.run_gate(spec)
        self.assertEqual(result.status, "BLOCKED")
        self.assertIn("STATUS: BLOCKED E1 phone enclosure", result.evidence)


if __name__ == "__main__":
    unittest.main()
