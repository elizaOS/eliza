#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/check_process_14a_effects.py"
SPEC = ROOT / "docs/spec-db/process-14a-effects.yaml"

spec = importlib.util.spec_from_file_location("check_process_14a_effects", SCRIPT)
if spec is None or spec.loader is None:
    raise RuntimeError(f"could not import {SCRIPT}")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def load_spec() -> dict[str, object]:
    data = yaml.safe_load(SPEC.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise AssertionError("process 14A spec must be a mapping")
    return data


def test_process_14a_spec_is_fail_closed() -> None:
    data = load_spec()
    flags = {key: value for key, value in data.items() if key.endswith("_claim_allowed")}
    if not flags or any(value is not False for value in flags.values()):
        raise AssertionError(flags)
    errors: list[str] = []
    checker.check_node_target(data, errors)
    checker.check_sources(data, errors)
    checker.check_effects(data, errors)
    checker.check_variant_requirements(data, errors)
    checker.check_library_variant_binding(data, errors)
    checker.check_reliability_derate_sources(data, errors)
    checker.check_sram_vmin_ecc_repair_plan(data, errors)
    checker.check_thermal_capture_phases(data, errors)
    checker.check_packaging_default(data, errors)
    checker.check_release_gate(data, errors)
    if errors:
        raise AssertionError("\n".join(errors))


def test_process_14a_spec_rejects_missing_required_effect() -> None:
    data = load_spec()
    mutated = copy.deepcopy(data)
    effects = mutated["required_effects"]
    assert isinstance(effects, list)
    mutated["required_effects"] = [
        effect
        for effect in effects
        if not (isinstance(effect, dict) and effect.get("id") == "self_heating_and_power_density")
    ]
    errors: list[str] = []
    checker.check_effects(mutated, errors)
    if not any("self_heating_and_power_density" in error for error in errors):
        raise AssertionError("\n".join(errors))


def test_process_14a_spec_rejects_release_gate_drift() -> None:
    data = load_spec()
    mutated = copy.deepcopy(data)
    release_gate = mutated["release_gate"]
    assert isinstance(release_gate, dict)
    checks = release_gate["must_pass_before_release_claim"]
    assert isinstance(checks, list)
    release_gate["must_pass_before_release_claim"] = [
        check for check in checks if check != "aosp_simulator_completion_gate"
    ]
    errors: list[str] = []
    checker.check_release_gate(mutated, errors)
    if not any("aosp_simulator_completion_gate" in error for error in errors):
        raise AssertionError("\n".join(errors))


def test_process_14a_spec_rejects_public_sources_as_signoff() -> None:
    data = load_spec()
    mutated = copy.deepcopy(data)
    source_policy = mutated["source_policy"]
    assert isinstance(source_policy, dict)
    source_policy["use"] = "signoff_data"
    errors: list[str] = []
    checker.check_sources(mutated, errors)
    if not any("public sources out of signoff evidence" in error for error in errors):
        raise AssertionError("\n".join(errors))


def test_process_14a_spec_rejects_missing_variant_pdn_artifact() -> None:
    data = load_spec()
    mutated = copy.deepcopy(data)
    variants = mutated["variant_requirements"]
    assert isinstance(variants, dict)
    artifacts = variants["per_variant_artifacts_required"]
    assert isinstance(artifacts, list)
    variants["per_variant_artifacts_required"] = [
        artifact for artifact in artifacts if artifact != "pdn_ir_drop_report"
    ]
    errors: list[str] = []
    checker.check_variant_requirements(mutated, errors)
    if not any("pdn_ir_drop_report" in error for error in errors):
        raise AssertionError("\n".join(errors))


def test_process_14a_spec_rejects_missing_sram_repair_policy() -> None:
    data = load_spec()
    mutated = copy.deepcopy(data)
    plan = mutated["sram_vmin_ecc_repair_plan"]
    assert isinstance(plan, dict)
    policy = plan["required_policy"]
    assert isinstance(policy, list)
    plan["required_policy"] = [item for item in policy if item != "repair_fuse_and_BIST_coverage"]
    errors: list[str] = []
    checker.check_sram_vmin_ecc_repair_plan(mutated, errors)
    if not any("repair_fuse_and_BIST_coverage" in error for error in errors):
        raise AssertionError("\n".join(errors))


def test_process_14a_spec_rejects_transient_as_sustained_metric() -> None:
    data = load_spec()
    mutated = copy.deepcopy(data)
    capture = mutated["thermal_capture_phases"]
    assert isinstance(capture, dict)
    phases = capture["phases"]
    assert isinstance(phases, list)
    for phase in phases:
        if isinstance(phase, dict) and phase.get("id") == "vapor_chamber_transient":
            phase["sustained_metric_allowed"] = True
    errors: list[str] = []
    checker.check_thermal_capture_phases(mutated, errors)
    if not any("vapor_chamber_transient.sustained_metric_allowed" in error for error in errors):
        raise AssertionError("\n".join(errors))


def test_process_14a_spec_rejects_desktop_packaging_escape() -> None:
    data = load_spec()
    mutated = copy.deepcopy(data)
    packaging = mutated["packaging_default"]
    assert isinstance(packaging, dict)
    forbidden = packaging["forbidden_in_e1_envelope"]
    assert isinstance(forbidden, list)
    packaging["forbidden_in_e1_envelope"] = [
        item for item in forbidden if item != "CoWoS_silicon_interposer"
    ]
    errors: list[str] = []
    checker.check_packaging_default(mutated, errors)
    if not any("CoWoS_silicon_interposer" in error for error in errors):
        raise AssertionError("\n".join(errors))


def main() -> int:
    for test in (
        test_process_14a_spec_is_fail_closed,
        test_process_14a_spec_rejects_missing_required_effect,
        test_process_14a_spec_rejects_release_gate_drift,
        test_process_14a_spec_rejects_public_sources_as_signoff,
        test_process_14a_spec_rejects_missing_variant_pdn_artifact,
        test_process_14a_spec_rejects_missing_sram_repair_policy,
        test_process_14a_spec_rejects_transient_as_sustained_metric,
        test_process_14a_spec_rejects_desktop_packaging_escape,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
