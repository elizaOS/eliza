#!/usr/bin/env python3
"""Tests for scripts/check_pdk_portability.py."""

from __future__ import annotations

import copy
import importlib.util
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/check_pdk_portability.py"
INDEX = ROOT / "pd/openlane/portability-index.yaml"

spec = importlib.util.spec_from_file_location("check_pdk_portability", SCRIPT)
if spec is None or spec.loader is None:
    raise RuntimeError(f"could not import {SCRIPT}")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def load_index() -> dict[str, object]:
    data = yaml.safe_load(INDEX.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise AssertionError("portability index must be a mapping")
    return data


def test_portability_index_has_all_required_lanes() -> None:
    data = load_index()
    configs = data.get("configs")
    assert isinstance(configs, list)
    ids = {c.get("id") for c in configs if isinstance(c, dict)}
    required = {
        "sky130A_release",
        "gf180mcu_release",
        "ihp_sg13g2_release",
        "asap7_predictive",
        "tsmc_n2p_stub",
        "tsmc_a14_stub",
        "intel_14a_stub",
        "samsung_sf2p_stub",
    }
    missing = required - ids
    if missing:
        raise AssertionError(f"missing lanes: {sorted(missing)}")


def test_advanced_nodes_are_blocked() -> None:
    data = load_index()
    configs = data.get("configs")
    assert isinstance(configs, list)
    advanced = [
        c for c in configs if isinstance(c, dict) and c.get("node_class") in checker.ADVANCED_NODES
    ]
    if len(advanced) < 3:
        raise AssertionError("must include at least 3 advanced-node lanes")
    for entry in advanced:
        if entry.get("access_gate") != "blocked_until_foundry_agreement":
            raise AssertionError(f"{entry.get('id')}: advanced node must be blocked")
        if entry.get("fabricable") is not False:
            raise AssertionError(f"{entry.get('id')}: advanced node must not be fabricable")


def test_open_pdk_lanes_are_open() -> None:
    data = load_index()
    configs = data.get("configs")
    assert isinstance(configs, list)
    open_lanes = [
        c for c in configs if isinstance(c, dict) and c.get("node_class") in checker.OPEN_PDK_NODES
    ]
    if len(open_lanes) < 2:
        raise AssertionError("must include at least 2 open-PDK lanes")
    for entry in open_lanes:
        if entry.get("access_gate") != "open_no_gate":
            raise AssertionError(f"{entry.get('id')}: open PDK must have access_gate=open_no_gate")


def test_rejects_unblocked_advanced_node() -> None:
    data = load_index()
    mutated = copy.deepcopy(data)
    configs = mutated["configs"]
    assert isinstance(configs, list)
    for entry in configs:
        if isinstance(entry, dict) and entry.get("id") == "tsmc_n2p_stub":
            entry["access_gate"] = "open_no_gate"
            break
    errors: list[str] = []
    for entry in configs:
        if isinstance(entry, dict):
            checker.check_entry_access_gate(entry, errors)
    if not any("blocked_until_foundry_agreement" in e for e in errors):
        raise AssertionError("must reject unblocked advanced-node access gate")


def test_each_entry_has_matching_manifests() -> None:
    data = load_index()
    configs = data.get("configs")
    assert isinstance(configs, list)
    for entry in configs:
        if not isinstance(entry, dict):
            continue
        eid = entry.get("id", "")
        for key in ("library_manifest", "corner_manifest"):
            path = entry.get(key)
            if not isinstance(path, str):
                raise AssertionError(f"{eid}: missing {key}")
            if not (ROOT / path).exists():
                raise AssertionError(f"{eid}: {key} path does not exist: {path}")


def main() -> int:
    for test in (
        test_portability_index_has_all_required_lanes,
        test_advanced_nodes_are_blocked,
        test_open_pdk_lanes_are_open,
        test_rejects_unblocked_advanced_node,
        test_each_entry_has_matching_manifests,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
