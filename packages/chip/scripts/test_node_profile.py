#!/usr/bin/env python3
"""Tests for scripts/build_node_profile.py and scripts/check_node_profile.py."""

from __future__ import annotations

import copy
import importlib.util
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
PROFILE_DIR = ROOT / "pd/node-profiles"


def _load(name: str, filename: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not import {filename}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


builder = _load("build_node_profile", "build_node_profile.py")
gate = _load("check_node_profile", "check_node_profile.py")


def _profile(node_id: str) -> dict[str, Any]:
    path = PROFILE_DIR / f"{node_id}.yaml"
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise AssertionError(f"{path} must be a mapping")
    return data


def test_all_canonical_profiles_present() -> None:
    found = {p.stem for p in PROFILE_DIR.glob("*.yaml")}
    missing = set(builder.NODE_TO_INDEX_ID) - found
    if missing:
        raise AssertionError(f"missing canonical node profiles: {sorted(missing)}")


def test_repo_profiles_have_no_drift() -> None:
    if builder.main([]) != 0:
        raise AssertionError("repo node profiles must validate clean with no drift")


def test_repo_profiles_pass_fail_closed_gate() -> None:
    if gate.main() != 0:
        raise AssertionError("repo node profiles must pass the fail-closed gate")


def test_open_node_has_real_adapter() -> None:
    profile = _profile("sky130")
    adapter = profile.get("pdk_adapter")
    if not isinstance(adapter, dict):
        raise AssertionError("open node must have a non-null pdk_adapter")
    if adapter.get("pdk_key") != "sky130A":
        raise AssertionError("sky130 adapter pdk_key must match config PDK sky130A")
    if adapter.get("std_cell_library") != "sky130_fd_sc_hd":
        raise AssertionError("sky130 adapter std_cell_library mismatch")


def test_advanced_nodes_have_null_adapter() -> None:
    for node_id in builder.ADVANCED_NODE_IDS:
        profile = _profile(node_id)
        if profile.get("pdk_adapter") is not None:
            raise AssertionError(f"{node_id}: advanced node must have null pdk_adapter")


def test_gate_rejects_advanced_flipped_to_fabricable() -> None:
    profile = copy.deepcopy(_profile("tsmc-n2p"))
    profile["fabricable"] = True
    errors = gate.reject_unblocked_advanced("tsmc-n2p", profile)
    if not any("fabricable" in e for e in errors):
        raise AssertionError("gate must reject advanced node flipped to fabricable=true")


def test_gate_rejects_advanced_flipped_to_open() -> None:
    profile = copy.deepcopy(_profile("tsmc-a14"))
    profile["status"] = builder.STATUS_OPEN
    errors = gate.reject_unblocked_advanced("tsmc-a14", profile)
    if not any(builder.STATUS_BLOCKED in e for e in errors):
        raise AssertionError("gate must reject advanced node with non-blocked status")


def test_gate_rejects_advanced_with_adapter() -> None:
    profile = copy.deepcopy(_profile("intel-14a"))
    profile["pdk_adapter"] = {"pdk_key": "Intel_14A"}
    errors = gate.reject_unblocked_advanced("intel-14a", profile)
    if not any("pdk_adapter" in e for e in errors):
        raise AssertionError("gate must reject advanced node with a non-null pdk_adapter")


def test_gate_ignores_open_node_with_adapter() -> None:
    profile = copy.deepcopy(_profile("sky130"))
    errors = gate.reject_unblocked_advanced("sky130", profile)
    if errors:
        raise AssertionError(f"open node must not be rejected by advanced gate: {errors}")


def test_builder_detects_foundry_drift() -> None:
    rows = builder.index_rows()
    profile = copy.deepcopy(_profile("gf180"))
    profile["foundry"] = "WrongFoundry"
    errors: list[str] = []
    builder.check_drift("gf180", profile, rows, errors)
    if not any("foundry drift" in e for e in errors):
        raise AssertionError("builder must detect foundry drift vs portability-index")


def test_builder_detects_corner_manifest_drift() -> None:
    rows = builder.index_rows()
    profile = copy.deepcopy(_profile("sky130"))
    profile["source_files"]["corner_manifest"] = "pd/corner-manifests/gf180.yaml"
    errors: list[str] = []
    builder.check_drift("sky130", profile, rows, errors)
    if not any("corner_manifest drift" in e for e in errors):
        raise AssertionError("builder must detect corner_manifest drift")


def test_builder_detects_adapter_pdk_mismatch() -> None:
    profile = copy.deepcopy(_profile("ihp-sg13g2"))
    adapter = profile["pdk_adapter"]
    adapter["pdk_key"] = "not-the-real-pdk"
    errors: list[str] = []
    builder._check_adapter_matches_config(adapter, errors)
    if not any("pdk_key" in e for e in errors):
        raise AssertionError("builder must detect adapter pdk_key mismatch vs config json")


def main() -> int:
    for test in (
        test_all_canonical_profiles_present,
        test_repo_profiles_have_no_drift,
        test_repo_profiles_pass_fail_closed_gate,
        test_open_node_has_real_adapter,
        test_advanced_nodes_have_null_adapter,
        test_gate_rejects_advanced_flipped_to_fabricable,
        test_gate_rejects_advanced_flipped_to_open,
        test_gate_rejects_advanced_with_adapter,
        test_gate_ignores_open_node_with_adapter,
        test_builder_detects_foundry_drift,
        test_builder_detects_corner_manifest_drift,
        test_builder_detects_adapter_pdk_mismatch,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
