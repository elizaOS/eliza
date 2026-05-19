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
    errors: list[str] = []
    checker.check_node_target(data, errors)
    checker.check_sources(data, errors)
    checker.check_effects(data, errors)
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


def main() -> int:
    for test in (
        test_process_14a_spec_is_fail_closed,
        test_process_14a_spec_rejects_missing_required_effect,
        test_process_14a_spec_rejects_release_gate_drift,
        test_process_14a_spec_rejects_public_sources_as_signoff,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
