#!/usr/bin/env python3
"""Project open-PDK / ASAP7 PPA shape to N2P / A14 envelope.

Inputs:
  - open-PDK PPA shapes (e.g., Sky130A OpenLane release metrics).
  - ASAP7 predictive PPA shapes (per-block JSON).
  - Published vendor scaling factors from
    docs/evidence/process/ppa-projection.yaml.

Output:
  - docs/evidence/process/ppa-projection.json with `projection_only` marker on
    every numeric field.

Discipline:
  This is PROJECTION ONLY, never signoff. The output file's evidence_class is
  fixed to `projection_only_never_signoff`. Downstream readers must respect
  that marker and must never cite the projection as silicon evidence.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
SCALING_SPEC = ROOT / "docs/evidence/process/ppa-projection.yaml"
SKY130_RUN_METRICS = ROOT / "pd/openlane/runs/RUN_2026-05-19_05-08-54/final/metrics.json"
ASAP7_SHAPES_DIR = ROOT / "docs/evidence/process/asap7"
OUT = ROOT / "docs/evidence/process/ppa-projection.json"

OUTPUT_MARKER = "projection_only_never_signoff"


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def load_yaml_mapping(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(f"missing scaling spec: {rel(path)}")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)} must be a YAML mapping")
    return data


def load_json_mapping(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{rel(path)} is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)} must be a JSON object")
    return data


def density_chain(scaling: dict[str, Any], from_node: str, to_node: str) -> float:
    """Return the cumulative density multiplier from from_node to to_node.

    Uses the documented per-edge density scaling factors in the spec. Edges are
    composed left-to-right.
    """
    density = scaling.get("density")
    if not isinstance(density, dict):
        raise ValueError("scaling.density missing")
    path = {
        ("sky130", "n2"): ["sky130_to_n5", "n5_to_n3e", "n3e_to_n2"],
        ("sky130", "n2p"): ["sky130_to_n5", "n5_to_n3e", "n3e_to_n2", "n2_to_n2p"],
        ("sky130", "a14"): ["sky130_to_n5", "n5_to_n3e", "n3e_to_n2", "n2_to_a14"],
        ("asap7", "n2"): ["n3e_to_n2"],
        ("asap7", "n2p"): ["n3e_to_n2", "n2_to_n2p"],
        ("asap7", "a14"): ["n3e_to_n2", "n2_to_a14"],
        ("n3p", "n2"): ["n3e_to_n2"],
        ("n3p", "n2p"): ["n3e_to_n2", "n2_to_n2p"],
        ("n3p", "a14"): ["n3e_to_n2", "n2_to_a14"],
    }.get((from_node, to_node))
    if path is None:
        raise ValueError(f"no density-scaling path from {from_node} to {to_node}")
    cumulative = 1.0
    for edge in path:
        factor = density.get(edge)
        if not isinstance(factor, int | float):
            raise ValueError(f"density edge {edge} missing or non-numeric")
        cumulative *= float(factor)
    return cumulative


def power_chain(scaling: dict[str, Any], to_node: str) -> float:
    """Return cumulative iso-perf power multiplier from N3E to target."""
    power = scaling.get("power_iso_perf")
    if not isinstance(power, dict):
        raise ValueError("scaling.power_iso_perf missing")
    edges = {
        "n2": ["n3e_to_n2"],
        "n2p": ["n3e_to_n2", "n2_to_n2p"],
        "a14": ["n3e_to_n2", "n2_to_a14"],
    }.get(to_node, [])
    if not edges:
        raise ValueError(f"no power-scaling path to {to_node}")
    cumulative = 1.0
    for edge in edges:
        factor = power.get(edge)
        if not isinstance(factor, int | float):
            raise ValueError(f"power edge {edge} missing or non-numeric")
        cumulative *= float(factor)
    return cumulative


def perf_chain(scaling: dict[str, Any], to_node: str) -> float:
    """Return cumulative iso-power perf multiplier from N3E to target."""
    perf = scaling.get("perf_iso_power")
    if not isinstance(perf, dict):
        raise ValueError("scaling.perf_iso_power missing")
    edges = {
        "n2": ["n3e_to_n2"],
        "n2p": ["n3e_to_n2", "n2_to_n2p"],
        "a14": ["n3e_to_n2", "n2_to_a14"],
    }.get(to_node, [])
    if not edges:
        raise ValueError(f"no perf-scaling path to {to_node}")
    cumulative = 1.0
    for edge in edges:
        factor = perf.get(edge)
        if not isinstance(factor, int | float):
            raise ValueError(f"perf edge {edge} missing or non-numeric")
        cumulative *= float(factor)
    return cumulative


def project_open_pdk(scaling: dict[str, Any]) -> dict[str, Any]:
    """Project Sky130 PPA shape to N2P + A14 envelope."""
    metrics = load_json_mapping(SKY130_RUN_METRICS)
    if metrics is None:
        return {
            "status": "blocked_no_sky130_metrics",
            "missing_input": rel(SKY130_RUN_METRICS),
        }
    instances = metrics.get("design__instance__count")
    if not isinstance(instances, int | float):
        instances = metrics.get("instances")
    die_area_um2: float | None = None
    for key in ("design__die__area", "die__area", "die_area__um^2"):
        value = metrics.get(key)
        if isinstance(value, int | float):
            die_area_um2 = float(value)
            break
    density_to_n2p = density_chain(scaling, "sky130", "n2p")
    density_to_a14 = density_chain(scaling, "sky130", "a14")
    n2p_area_mm2 = None
    a14_area_mm2 = None
    if isinstance(die_area_um2, int | float) and die_area_um2 > 0:
        # Sky130 metrics are in um^2; convert to mm^2 and scale by 1/density_ratio.
        sky130_mm2 = float(die_area_um2) / 1_000_000.0
        n2p_area_mm2 = sky130_mm2 / density_to_n2p
        a14_area_mm2 = sky130_mm2 / density_to_a14
    # The 142K-instance Sky130 e1 run is methodology evidence, not a flagship-
    # complexity design. Reporting the density-scaled area is honest and the
    # tiny projected number (0.04 mm² class) tells the truth: the open-PDK
    # closure does not yet contain flagship-class logic. Flagship envelope
    # (100-130 mm²) is dominated by SRAM, NPU, GPU, PHY content not present in
    # the current Sky130 release.
    return {
        "input_source": rel(SKY130_RUN_METRICS),
        "sky130_instances": instances,
        "sky130_die_area_um2": die_area_um2,
        "density_scaling_sky130_to_n2p": density_to_n2p,
        "density_scaling_sky130_to_a14": density_to_a14,
        "projection_n2p_logic_area_mm2": n2p_area_mm2,
        "projection_a14_logic_area_mm2": a14_area_mm2,
        "envelope_total_mm2_min": 100,
        "envelope_total_mm2_max": 130,
        "envelope_status": "current_open_pdk_closure_does_not_yet_contain_flagship_class_logic",
        "projection_marker": OUTPUT_MARKER,
        "claim_boundary": "Sky130 logic area scaled by published density chain "
        "yields a single-point projection of N2P / A14 logic area. This is not "
        "signoff and must not be cited as measured silicon. The projected number "
        "is small because the current Sky130 e1 release contains the chip-top "
        "stub only and does not include real big-core OoO RTL, SRAM macros, NPU "
        "tile, NoC, IOMMU, or any flagship-class IP. The 100-130 mm² envelope "
        "lives in docs/evidence/process/die-area-budget.yaml and is sized by "
        "die-shot calibration, not by this open-PDK closure.",
    }


def project_asap7_shapes(scaling: dict[str, Any]) -> list[dict[str, Any]]:
    if not ASAP7_SHAPES_DIR.is_dir():
        return [
            {
                "status": "blocked_no_asap7_shapes",
                "expected_dir": rel(ASAP7_SHAPES_DIR),
                "next_step": "cd pd/asap7 && make all",
            }
        ]
    out: list[dict[str, Any]] = []
    for shape_path in sorted(ASAP7_SHAPES_DIR.glob("*.json")):
        shape = load_json_mapping(shape_path)
        if shape is None:
            continue
        block_id = shape.get("block_id") or shape_path.stem
        area_mm2 = shape.get("std_cell_area_mm2")
        power_mw_per_mhz = shape.get("dyn_power_mw_per_mhz")
        leakage_mw = shape.get("leakage_mw")
        max_freq_mhz = shape.get("max_freq_mhz")
        density_to_n2p = density_chain(scaling, "asap7", "n2p")
        density_to_a14 = density_chain(scaling, "asap7", "a14")
        power_to_n2p = power_chain(scaling, "n2p")
        power_to_a14 = power_chain(scaling, "a14")
        perf_to_n2p = perf_chain(scaling, "n2p")
        perf_to_a14 = perf_chain(scaling, "a14")
        out.append(
            {
                "block_id": block_id,
                "input_source": rel(shape_path),
                "asap7": {
                    "std_cell_area_mm2": area_mm2,
                    "dyn_power_mw_per_mhz": power_mw_per_mhz,
                    "leakage_mw": leakage_mw,
                    "max_freq_mhz": max_freq_mhz,
                },
                "projection_n2p": {
                    "std_cell_area_mm2": (
                        None if not isinstance(area_mm2, int | float) else area_mm2 / density_to_n2p
                    ),
                    "dyn_power_mw_per_mhz": (
                        None
                        if not isinstance(power_mw_per_mhz, int | float)
                        else power_mw_per_mhz * power_to_n2p
                    ),
                    "max_freq_mhz_iso_power": (
                        None
                        if not isinstance(max_freq_mhz, int | float)
                        else max_freq_mhz * perf_to_n2p
                    ),
                },
                "projection_a14": {
                    "std_cell_area_mm2": (
                        None if not isinstance(area_mm2, int | float) else area_mm2 / density_to_a14
                    ),
                    "dyn_power_mw_per_mhz": (
                        None
                        if not isinstance(power_mw_per_mhz, int | float)
                        else power_mw_per_mhz * power_to_a14
                    ),
                    "max_freq_mhz_iso_power": (
                        None
                        if not isinstance(max_freq_mhz, int | float)
                        else max_freq_mhz * perf_to_a14
                    ),
                },
                "projection_marker": OUTPUT_MARKER,
            }
        )
    return out


def main() -> int:
    try:
        spec = load_yaml_mapping(SCALING_SPEC)
    except Exception as exc:
        print(f"FAIL: {exc}")
        return 1
    if spec.get("status") != "projection_only_never_signoff":
        print("FAIL: ppa-projection.yaml must set status=projection_only_never_signoff")
        return 1
    scaling = spec.get("scaling_factors")
    if not isinstance(scaling, dict):
        print("FAIL: ppa-projection.yaml must define scaling_factors mapping")
        return 1

    open_pdk_projection = project_open_pdk(scaling)
    asap7_projection = project_asap7_shapes(scaling)

    report = {
        "schema": "eliza.process_ppa_projection_report.v1",
        "evidence_class": OUTPUT_MARKER,
        "claim_boundary": "These numbers are projections built by applying "
        "documented vendor scaling factors to open-PDK and ASAP7 shapes. They "
        "are NOT signoff, NOT measured silicon, and must not be cited as such.",
        "scaling_spec": rel(SCALING_SPEC),
        "open_pdk_projection": open_pdk_projection,
        "asap7_projection": asap7_projection,
        "forbidden_uses": [
            "cite_as_tsmc_n2p_signoff",
            "cite_as_tsmc_a14_signoff",
            "cite_as_intel_14a_signoff",
            "cite_as_samsung_sf2p_signoff",
            "cite_as_measured_silicon_evidence",
        ],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"PPA projection emitted: {rel(OUT)} (projection_only)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
