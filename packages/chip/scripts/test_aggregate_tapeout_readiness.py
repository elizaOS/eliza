#!/usr/bin/env python3
"""Tests for ``scripts/aggregate_tapeout_readiness.py``.

Covers the prefix-based classifier, the report builder, the exit-code policy,
and the static gate inventory.
"""

from __future__ import annotations

import json
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


if __name__ == "__main__":
    unittest.main()
