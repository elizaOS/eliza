#!/usr/bin/env python3
"""Per-check unit tests for ``scripts/check_cpu_2028_target.py``.

Synthesizes a minimal valid ``docs/spec-db/cpu-2028-target.yaml`` inside a
``tempfile.TemporaryDirectory()`` and monkey-patches the script's
``SPEC`` / ``ROOT`` / ``ROCKET_MANIFEST`` module-level constants so the
validator runs against the synthetic spec. Then mutates the synthetic
spec to drive every fail-closed branch and asserts the validator exits
with a non-zero status and a FAIL message that matches the assertion.

Run:

    cd packages/chip && python3 -m unittest scripts.test_check_cpu_2028_target

or via the opt-in Make target:

    make spec-check-tests
"""

from __future__ import annotations

import contextlib
import copy
import importlib
import io
import sys
import tempfile
import unittest
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest import mock

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

check_cpu_2028_target = importlib.import_module("check_cpu_2028_target")

try:
    from hypothesis import HealthCheck, given, settings
    from hypothesis import strategies as st

    HYPOTHESIS_AVAILABLE = True
except ImportError:  # pragma: no cover - skip when hypothesis is absent
    HYPOTHESIS_AVAILABLE = False


def minimal_valid_spec() -> dict[str, Any]:
    return {
        "schema": "eliza.cpu_2028_target.v1",
        "as_of": "2026-05-19",
        "target_year": 2028,
        "target_class": "performance_heavy_android_phone_ap",
        "positioning": "synthetic positioning blurb",
        "claim_boundary": "synthetic claim boundary blurb",
        "source_anchors": {"research_inventory": "research/example.yaml"},
        "selected_ap_path": {
            "manifest_path": "generators/chipyard/eliza-rocket-manifest.json",
            "selected_for_2028_phone_class_big_core": False,
        },
        "phase_a_isa": {"profile": "RV64GC", "core_selection": "rocket_chip"},
        "phase_b_isa": {"profile": "RVA22U64+V", "core_selection": "boom"},
        "phase_c_isa": {"profile": "RVA23", "core_selection": "xiangshan_kunminghu"},
        "vector": {
            "required": "RVV_1_0",
            "forbidden": ["RVV_0_7_1", "Hwacha"],
        },
        "mmu": {"minimum": "Sv39"},
        "coherence_protocol": {"required": "TileLink-C"},
        "interrupt_controller": {"required": "PLIC"},
        "timer": {"required": "CLINT"},
        "cache_maintenance": {
            "required": ["Zicbom", "Zicbop", "Zicboz"],
            "forbidden_vendor_csrs": True,
        },
        "management_security_hart": {"selection": "ibex"},
        "forbidden_paths": [
            "RVV_0_7_1",
            "Hwacha_pre_RVV_1_0",
            "vendor_specific_cache_CSRs",
        ],
        "android_profile_target": {"required": "RVA22U64+V"},
        "verification": {
            "required": [
                {"id": "spike_isa_sim"},
                {"id": "sail_riscv"},
                {"id": "rie_riscof"},
                {"id": "rvfi"},
                {"id": "riscv_dv"},
            ]
        },
        "phase_gates": {
            "phase_a": {
                "name": "linux_bringup_smoke",
                "required_evidence": ["build/evidence/cpu_ap/foo.log"],
            }
        },
        "forbidden_claims_until_complete": ["Phone-class AP"],
    }


@contextlib.contextmanager
def patched_validator(
    spec: dict[str, Any], *, write_rocket_manifest: bool = True
) -> Iterator[Path]:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        spec_path = root / "docs/spec-db/cpu-2028-target.yaml"
        spec_path.parent.mkdir(parents=True, exist_ok=True)
        spec_path.write_text(yaml.safe_dump(spec, sort_keys=True), encoding="utf-8")
        rocket_manifest = root / "generators/chipyard/eliza-rocket-manifest.json"
        if write_rocket_manifest:
            rocket_manifest.parent.mkdir(parents=True, exist_ok=True)
            rocket_manifest.write_text("{}\n", encoding="utf-8")
        selected = spec.get("selected_ap_path") or {}
        if isinstance(selected, dict):
            for value in selected.values():
                if isinstance(value, str) and "/" in value:
                    candidate = root / value
                    if not candidate.exists() and candidate != rocket_manifest:
                        candidate.parent.mkdir(parents=True, exist_ok=True)
                        candidate.write_text("{}\n", encoding="utf-8")
        with (
            mock.patch.object(check_cpu_2028_target, "ROOT", root),
            mock.patch.object(check_cpu_2028_target, "SPEC", spec_path),
            mock.patch.object(check_cpu_2028_target, "ROCKET_MANIFEST", rocket_manifest),
        ):
            yield root


def run_validator() -> tuple[int, str, str]:
    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    rc = 0
    with contextlib.redirect_stdout(stdout_buf), contextlib.redirect_stderr(stderr_buf):
        try:
            check_cpu_2028_target.main()
        except SystemExit as exc:
            rc = int(exc.code) if isinstance(exc.code, int) else 1
    return rc, stdout_buf.getvalue(), stderr_buf.getvalue()


class CheckCpu2028TargetTests(unittest.TestCase):
    def test_synthetic_spec_passes(self) -> None:
        spec = minimal_valid_spec()
        with patched_validator(spec):
            rc, stdout, _ = run_validator()
        self.assertEqual(rc, 0)
        self.assertIn("cpu 2028 target check passed", stdout)

    def test_missing_spec_file_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            spec_path = root / "docs/spec-db/cpu-2028-target.yaml"
            rocket_manifest = root / "generators/chipyard/eliza-rocket-manifest.json"
            with (
                mock.patch.object(check_cpu_2028_target, "ROOT", root),
                mock.patch.object(check_cpu_2028_target, "SPEC", spec_path),
                mock.patch.object(check_cpu_2028_target, "ROCKET_MANIFEST", rocket_manifest),
            ):
                rc, _, stderr = run_validator()
        self.assertEqual(rc, 1)
        self.assertIn("spec missing", stderr)

    def test_non_mapping_spec_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            spec_path = root / "docs/spec-db/cpu-2028-target.yaml"
            spec_path.parent.mkdir(parents=True, exist_ok=True)
            spec_path.write_text("- not\n- a\n- mapping\n", encoding="utf-8")
            rocket_manifest = root / "generators/chipyard/eliza-rocket-manifest.json"
            rocket_manifest.parent.mkdir(parents=True, exist_ok=True)
            rocket_manifest.write_text("{}\n", encoding="utf-8")
            with (
                mock.patch.object(check_cpu_2028_target, "ROOT", root),
                mock.patch.object(check_cpu_2028_target, "SPEC", spec_path),
                mock.patch.object(check_cpu_2028_target, "ROCKET_MANIFEST", rocket_manifest),
            ):
                rc, _, stderr = run_validator()
        self.assertEqual(rc, 1)
        self.assertIn("spec is not a mapping", stderr)

    def test_wrong_schema_fails(self) -> None:
        spec = minimal_valid_spec()
        spec["schema"] = "eliza.cpu_2028_target.v0"
        with patched_validator(spec):
            rc, _, stderr = run_validator()
        self.assertEqual(rc, 1)
        self.assertIn("schema must be 'eliza.cpu_2028_target.v1'", stderr)

    def test_missing_top_level_field_fails(self) -> None:
        for key in check_cpu_2028_target.REQUIRED_TOP_LEVEL:
            spec = minimal_valid_spec()
            spec.pop(key, None)
            with self.subTest(field=key):
                with patched_validator(spec):
                    rc, _, stderr = run_validator()
                self.assertEqual(rc, 1, f"missing {key} should fail")
                if key == "schema":
                    self.assertIn("schema must be", stderr)
                else:
                    self.assertIn(f"missing required field: {key}", stderr)

    def test_wrong_target_year_fails(self) -> None:
        spec = minimal_valid_spec()
        spec["target_year"] = 2029
        with patched_validator(spec):
            rc, _, stderr = run_validator()
        self.assertEqual(rc, 1)
        self.assertIn("target_year must be 2028", stderr)

    def test_vector_required_not_rvv1_fails(self) -> None:
        spec = minimal_valid_spec()
        spec["vector"]["required"] = "RVV_0_7_1"
        with patched_validator(spec):
            rc, _, stderr = run_validator()
        self.assertEqual(rc, 1)
        self.assertIn("vector.required must be 'RVV_1_0'", stderr)

    def test_vector_forbidden_missing_rvv_0_7_1_fails(self) -> None:
        spec = minimal_valid_spec()
        spec["vector"]["forbidden"] = ["Hwacha"]
        with patched_validator(spec):
            rc, _, stderr = run_validator()
        self.assertEqual(rc, 1)
        self.assertIn("vector.forbidden must include RVV_0_7_1", stderr)

    def test_vector_forbidden_missing_hwacha_fails(self) -> None:
        spec = minimal_valid_spec()
        spec["vector"]["forbidden"] = ["RVV_0_7_1"]
        with patched_validator(spec):
            rc, _, stderr = run_validator()
        self.assertEqual(rc, 1)
        self.assertIn("vector.forbidden must include a Hwacha variant", stderr)

    def test_cache_maintenance_missing_zicbo_extension_fails(self) -> None:
        for missing in ("Zicbom", "Zicbop", "Zicboz"):
            spec = minimal_valid_spec()
            spec["cache_maintenance"]["required"] = [
                ext for ext in spec["cache_maintenance"]["required"] if ext != missing
            ]
            with self.subTest(missing=missing):
                with patched_validator(spec):
                    rc, _, stderr = run_validator()
                self.assertEqual(rc, 1)
                self.assertIn(f"cache_maintenance.required must include {missing}", stderr)

    def test_cache_maintenance_forbidden_vendor_csrs_false_fails(self) -> None:
        spec = minimal_valid_spec()
        spec["cache_maintenance"]["forbidden_vendor_csrs"] = False
        with patched_validator(spec):
            rc, _, stderr = run_validator()
        self.assertEqual(rc, 1)
        self.assertIn("cache_maintenance.forbidden_vendor_csrs must be true", stderr)

    def test_management_security_hart_wrong_selection_fails(self) -> None:
        spec = minimal_valid_spec()
        spec["management_security_hart"]["selection"] = "rocket"
        with patched_validator(spec):
            rc, _, stderr = run_validator()
        self.assertEqual(rc, 1)
        self.assertIn("management_security_hart.selection must be 'ibex'", stderr)

    def test_management_security_hart_accepts_uppercase_ibex(self) -> None:
        spec = minimal_valid_spec()
        spec["management_security_hart"]["selection"] = "IBEX"
        with patched_validator(spec):
            rc, stdout, _ = run_validator()
        self.assertEqual(rc, 0)
        self.assertIn("cpu 2028 target check passed", stdout)

    def test_android_profile_wrong_required_fails(self) -> None:
        spec = minimal_valid_spec()
        spec["android_profile_target"]["required"] = "RVA20U64"
        with patched_validator(spec):
            rc, _, stderr = run_validator()
        self.assertEqual(rc, 1)
        self.assertIn("android_profile_target.required must be 'RVA22U64+V'", stderr)

    def test_forbidden_paths_missing_entry_fails(self) -> None:
        for missing in ("RVV_0_7_1", "Hwacha_pre_RVV_1_0", "vendor_specific_cache_CSRs"):
            spec = minimal_valid_spec()
            spec["forbidden_paths"] = [path for path in spec["forbidden_paths"] if path != missing]
            with self.subTest(missing=missing):
                with patched_validator(spec):
                    rc, _, stderr = run_validator()
                self.assertEqual(rc, 1)
                self.assertIn(f"forbidden_paths must include {missing}", stderr)

    def test_selected_ap_path_missing_file_fails(self) -> None:
        spec = minimal_valid_spec()
        spec["selected_ap_path"] = "nonexistent/path/to/manifest.json"
        with patched_validator(spec):
            rc, _, stderr = run_validator()
        self.assertEqual(rc, 1)
        self.assertIn("selected_ap_path points at missing file", stderr)

    def test_missing_rocket_manifest_fails(self) -> None:
        spec = minimal_valid_spec()
        with patched_validator(spec, write_rocket_manifest=False):
            rc, _, stderr = run_validator()
        self.assertEqual(rc, 1)
        self.assertIn("chipyard manifest missing", stderr)

    def test_phase_gates_empty_mapping_fails(self) -> None:
        spec = minimal_valid_spec()
        spec["phase_gates"] = {}
        with patched_validator(spec):
            rc, _, stderr = run_validator()
        self.assertEqual(rc, 1)
        self.assertIn("phase_gates must be a non-empty mapping", stderr)

    def test_phase_gates_wrong_type_fails(self) -> None:
        spec = minimal_valid_spec()
        spec["phase_gates"] = ["phase_a", "phase_b"]
        with patched_validator(spec):
            rc, _, stderr = run_validator()
        self.assertEqual(rc, 1)
        self.assertIn("phase_gates must be a non-empty mapping", stderr)

    def test_forbidden_claims_empty_fails(self) -> None:
        spec = minimal_valid_spec()
        spec["forbidden_claims_until_complete"] = []
        with patched_validator(spec):
            rc, _, stderr = run_validator()
        self.assertEqual(rc, 1)
        self.assertIn("forbidden_claims_until_complete must be a non-empty list", stderr)

    def test_verification_missing_required_tool_fails(self) -> None:
        for drop in ("spike", "sail", "riscof", "rvfi", "riscv_dv"):
            spec = minimal_valid_spec()
            spec["verification"] = {
                "required": [
                    {"id": tool}
                    for tool in ("spike_isa_sim", "sail_riscv", "rie_riscof", "rvfi", "riscv_dv")
                    if drop not in tool
                ]
            }
            with self.subTest(missing=drop):
                with patched_validator(spec):
                    rc, _, stderr = run_validator()
                self.assertEqual(rc, 1)
                self.assertIn("verification block must reference", stderr)


@unittest.skipUnless(HYPOTHESIS_AVAILABLE, "hypothesis is not installed")
class CheckCpu2028TargetHypothesisTests(unittest.TestCase):
    @settings(
        max_examples=25,
        deadline=None,
        suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture],
    )
    @given(
        bad_year=st.integers(min_value=1900, max_value=2100).filter(lambda y: y != 2028),
    )
    def test_target_year_other_than_2028_always_fails(self, bad_year: int) -> None:
        spec = minimal_valid_spec()
        spec["target_year"] = bad_year
        with patched_validator(spec):
            rc, _, stderr = run_validator()
        self.assertEqual(rc, 1)
        self.assertIn(f"target_year must be 2028, got {bad_year}", stderr)

    @settings(
        max_examples=15,
        deadline=None,
        suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture],
    )
    @given(
        bogus_schema=st.text(
            st.characters(exclude_categories=["Cs"], exclude_characters=["\n", "\r"]),
            min_size=1,
            max_size=60,
        ).filter(lambda s: s != check_cpu_2028_target.EXPECTED_SCHEMA),
    )
    def test_any_schema_other_than_expected_fails(self, bogus_schema: str) -> None:
        spec = minimal_valid_spec()
        spec["schema"] = bogus_schema
        with patched_validator(spec):
            rc, _, stderr = run_validator()
        self.assertEqual(rc, 1)
        self.assertIn("schema must be 'eliza.cpu_2028_target.v1'", stderr)

    @settings(
        max_examples=15,
        deadline=None,
        suppress_health_check=[HealthCheck.too_slow, HealthCheck.function_scoped_fixture],
    )
    @given(
        wrong_hart=st.text(
            st.characters(exclude_categories=["Cs"], exclude_characters=["\n", "\r"]),
            min_size=1,
            max_size=40,
        ).filter(lambda s: s.lower() != "ibex"),
    )
    def test_management_security_hart_other_than_ibex_fails(self, wrong_hart: str) -> None:
        spec = minimal_valid_spec()
        spec["management_security_hart"]["selection"] = wrong_hart
        with patched_validator(spec):
            rc, _, stderr = run_validator()
        self.assertEqual(rc, 1)
        self.assertIn("management_security_hart.selection must be 'ibex'", stderr)


def test_module_smoke() -> None:
    """Quick smoke test that exercises a copy of the spec end-to-end."""
    spec = copy.deepcopy(minimal_valid_spec())
    with patched_validator(spec):
        rc, _, _ = run_validator()
    assert rc == 0


if __name__ == "__main__":
    unittest.main()
