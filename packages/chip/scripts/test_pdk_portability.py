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


def test_open_pdk_library_manifests_cross_reference_macros() -> None:
    """Every open-PDK library manifest in PDKS_WITH_MACROS must declare an
    sram_macros section whose `macros` list matches the PD-agent macro
    manifest exactly. This is the contract the portability checker enforces.
    """
    macros_path = ROOT / "pd/macros/manifest.yaml"
    macros = yaml.safe_load(macros_path.read_text(encoding="utf-8"))
    if not isinstance(macros, dict):
        raise AssertionError("pd/macros/manifest.yaml must be a YAML mapping")
    pdks_section = macros.get("pdks")
    if not isinstance(pdks_section, dict):
        raise AssertionError("pd/macros/manifest.yaml must define pdks mapping")

    data = load_index()
    configs = data.get("configs")
    assert isinstance(configs, list)
    for entry in configs:
        if not isinstance(entry, dict):
            continue
        pdk_name = entry.get("pdk_name", "")
        macro_key = checker.PDKS_WITH_MACROS.get(pdk_name)
        if macro_key is None:
            continue
        declared = pdks_section.get(macro_key)
        if not isinstance(declared, dict):
            raise AssertionError(f"pd/macros/manifest.yaml missing pdk: {macro_key}")
        declared_macros = declared.get("target_macros", [])
        if not isinstance(declared_macros, list) or not declared_macros:
            raise AssertionError(f"{macro_key}: target_macros must be a non-empty list")
        lm_path = ROOT / entry["library_manifest"]
        lm = yaml.safe_load(lm_path.read_text(encoding="utf-8"))
        if not isinstance(lm, dict):
            raise AssertionError(f"{lm_path}: must be a YAML mapping")
        sram_macros = lm.get("sram_macros")
        if not isinstance(sram_macros, dict):
            raise AssertionError(f"{lm_path}: must declare sram_macros section")
        if sram_macros.get("source_of_truth") != "pd/macros/manifest.yaml":
            raise AssertionError(
                f"{lm_path}: sram_macros.source_of_truth must be pd/macros/manifest.yaml"
            )
        declared_names: set[str] = set()
        for m in declared_macros:
            if isinstance(m, dict):
                name = m.get("name")
                if isinstance(name, str):
                    declared_names.add(name)
        library_macros = sram_macros.get("macros", [])
        library_names: set[str] = set()
        for m in library_macros:
            if isinstance(m, dict):
                name = m.get("name")
                if isinstance(name, str):
                    library_names.add(name)
        if declared_names != library_names:
            raise AssertionError(
                f"{lm_path}: macro set drift; declared={sorted(declared_names)} "
                f"library={sorted(library_names)}"
            )


def test_advanced_node_corners_have_bspdn_planning() -> None:
    """BSPDN-aware corner planning is required on TSMC A14 and Intel 14A.

    Both manifests must document the thermal uplift and pdn topology so the
    Power / PD agents can budget against the same numbers.
    """
    for corner in ("tsmc-a14.yaml", "intel-14a.yaml"):
        path = ROOT / "pd/corner-manifests" / corner
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise AssertionError(f"{path}: must be a YAML mapping")
        notes = data.get("bspdn_planning_notes")
        if not isinstance(notes, dict):
            raise AssertionError(f"{path}: must declare bspdn_planning_notes section")


def test_pdk_access_gate_has_per_foundry_checklist() -> None:
    """Every advanced-node target in docs/evidence/process/pdk-access-gate.yaml
    must publish a next_action_checklist with concrete owner + evidence fields.
    """
    gate = yaml.safe_load(
        (ROOT / "docs/evidence/process/pdk-access-gate.yaml").read_text(encoding="utf-8")
    )
    if not isinstance(gate, dict):
        raise AssertionError("pdk-access-gate.yaml must be a YAML mapping")
    targets = gate.get("advanced_node_targets")
    if not isinstance(targets, dict):
        raise AssertionError("advanced_node_targets must be a mapping")
    for tier_name, tier in targets.items():
        if not isinstance(tier, dict):
            raise AssertionError(f"{tier_name}: must be a mapping")
        checklist = tier.get("next_action_checklist")
        if not isinstance(checklist, list) or not checklist:
            raise AssertionError(f"{tier_name}: next_action_checklist must be a non-empty list")
        for item in checklist:
            if not isinstance(item, dict):
                raise AssertionError(f"{tier_name}: checklist entries must be mappings")
            for field in ("id", "action", "status", "owner", "evidence_required"):
                if not item.get(field):
                    raise AssertionError(f"{tier_name}: checklist entry missing {field}")
            if item.get("status") not in {"not_started", "in_progress", "complete"}:
                raise AssertionError(
                    f"{tier_name}: checklist entry status must be one of "
                    f"not_started/in_progress/complete"
                )


def main() -> int:
    for test in (
        test_portability_index_has_all_required_lanes,
        test_advanced_nodes_are_blocked,
        test_open_pdk_lanes_are_open,
        test_rejects_unblocked_advanced_node,
        test_each_entry_has_matching_manifests,
        test_open_pdk_library_manifests_cross_reference_macros,
        test_advanced_node_corners_have_bspdn_planning,
        test_pdk_access_gate_has_per_foundry_checklist,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
