#!/usr/bin/env python3
"""Project open-PDK / ASAP7 PPA shape to advanced-node envelopes.

Targets:
  - TSMC N2P (primary 2028 production target)
  - TSMC A14 (stretch 2028 target)
  - Intel 14A (strategic 2nd source 2028)
  - Samsung SF2P (backup 2028)

Inputs:
  - open-PDK PPA shapes (Sky130A OpenLane release metrics).
  - ASAP7 predictive PPA shapes per block (docs/evidence/process/asap7/*.json).
  - Published vendor scaling factors + uncertainty bands from
    docs/evidence/process/ppa-projection.yaml.

Output:
  - docs/evidence/process/ppa-projection.json
  - Every numeric field tagged projection_only_never_signoff.
  - Monte Carlo over public-disclosure uncertainty bands produces p10 / p50 /
    p90 area/perf/power per target node.

Discipline:
  This is PROJECTION ONLY, never signoff. The output file's evidence_class is
  fixed to `projection_only_never_signoff`. Downstream readers must respect
  that marker and must never cite the projection as silicon evidence.
"""

from __future__ import annotations

import json
import math
import random
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

# Monte Carlo sample count. Deterministic seed so the projection report is
# reproducible across runs unless the scaling spec or input shapes change.
MONTE_CARLO_SAMPLES = 4096
MONTE_CARLO_SEED = 20260519

# Density-scaling edge composition per target node. Composed left-to-right.
DENSITY_PATHS: dict[tuple[str, str], list[str]] = {
    ("sky130", "n2"): ["sky130_to_n5", "n5_to_n3e", "n3e_to_n2"],
    ("sky130", "n2p"): ["sky130_to_n5", "n5_to_n3e", "n3e_to_n2", "n2_to_n2p"],
    ("sky130", "a14"): ["sky130_to_n5", "n5_to_n3e", "n3e_to_n2", "n2_to_a14"],
    ("sky130", "intel_14a"): ["sky130_to_n5", "n5_to_n3e", "n3e_to_intel_14a"],
    ("sky130", "samsung_sf2p"): ["sky130_to_n5", "n5_to_n3e", "n3e_to_samsung_sf2p"],
    ("asap7", "n2"): ["n3e_to_n2"],
    ("asap7", "n2p"): ["n3e_to_n2", "n2_to_n2p"],
    ("asap7", "a14"): ["n3e_to_n2", "n2_to_a14"],
    ("asap7", "intel_14a"): ["n3e_to_intel_14a"],
    ("asap7", "samsung_sf2p"): ["n3e_to_samsung_sf2p"],
    ("n3p", "n2"): ["n3e_to_n2"],
    ("n3p", "n2p"): ["n3e_to_n2", "n2_to_n2p"],
    ("n3p", "a14"): ["n3e_to_n2", "n2_to_a14"],
}

# Perf / power scaling edge composition. ASAP7 ≈ N3E baseline.
PERF_POWER_EDGES: dict[str, list[str]] = {
    "n2": ["n3e_to_n2"],
    "n2p": ["n3e_to_n2", "n2_to_n2p"],
    "a14": ["n3e_to_n2", "n2_to_a14"],
    "intel_14a": ["n3e_to_intel_14a_perf"],
    "samsung_sf2p": ["n3e_to_samsung_sf2p_perf"],
}
POWER_PERF_EDGES: dict[str, list[str]] = {
    "n2": ["n3e_to_n2"],
    "n2p": ["n3e_to_n2", "n2_to_n2p"],
    "a14": ["n3e_to_n2", "n2_to_a14"],
    "intel_14a": ["n3e_to_intel_14a_power"],
    "samsung_sf2p": ["n3e_to_samsung_sf2p_power"],
}

ADVANCED_TARGETS = ("n2p", "a14", "intel_14a", "samsung_sf2p")


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


def _edge_factor(table: dict[str, Any], edge: str) -> float:
    value = table.get(edge)
    if not isinstance(value, int | float):
        raise ValueError(f"edge {edge!r} missing or non-numeric in scaling table")
    return float(value)


def density_chain(scaling: dict[str, Any], from_node: str, to_node: str) -> float:
    density = scaling.get("density")
    if not isinstance(density, dict):
        raise ValueError("scaling.density missing")
    path = DENSITY_PATHS.get((from_node, to_node))
    if path is None:
        raise ValueError(f"no density-scaling path from {from_node} to {to_node}")
    cumulative = 1.0
    for edge in path:
        cumulative *= _edge_factor(density, edge)
    return cumulative


def perf_chain(scaling: dict[str, Any], to_node: str) -> float:
    perf = scaling.get("perf_iso_power")
    if not isinstance(perf, dict):
        raise ValueError("scaling.perf_iso_power missing")
    edges = PERF_POWER_EDGES.get(to_node, [])
    if not edges:
        raise ValueError(f"no perf-scaling path to {to_node}")
    cumulative = 1.0
    for edge in edges:
        cumulative *= _edge_factor(perf, edge)
    return cumulative


def power_chain(scaling: dict[str, Any], to_node: str) -> float:
    power = scaling.get("power_iso_perf")
    if not isinstance(power, dict):
        raise ValueError("scaling.power_iso_perf missing")
    edges = POWER_PERF_EDGES.get(to_node, [])
    if not edges:
        raise ValueError(f"no power-scaling path to {to_node}")
    cumulative = 1.0
    for edge in edges:
        cumulative *= _edge_factor(power, edge)
    return cumulative


def _sample_lognormal(rng: random.Random, mean: float, sigma: float) -> float:
    """Sample a multiplicative perturbation centered on `mean` with relative
    1-sigma `sigma`. Lognormal so the perturbation is strictly positive."""
    if sigma <= 0 or mean <= 0:
        return mean
    mu_ln = math.log(mean) - 0.5 * sigma * sigma
    return math.exp(rng.gauss(mu_ln, sigma))


def _percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    sorted_values = sorted(values)
    if len(sorted_values) == 1:
        return sorted_values[0]
    k = (len(sorted_values) - 1) * pct
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return sorted_values[int(k)]
    return sorted_values[f] + (sorted_values[c] - sorted_values[f]) * (k - f)


def monte_carlo_chain(
    table: dict[str, Any],
    uncertainty: dict[str, Any] | None,
    edges: list[str],
    samples: int,
    rng: random.Random,
) -> list[float]:
    """Return `samples` Monte-Carlo cumulative factors over `edges`."""
    out: list[float] = []
    for _ in range(samples):
        cumulative = 1.0
        for edge in edges:
            mean = _edge_factor(table, edge)
            sigma = 0.0
            if isinstance(uncertainty, dict):
                sigma = float(uncertainty.get(edge, 0.0))
            cumulative *= _sample_lognormal(rng, mean, sigma)
        out.append(cumulative)
    return out


def _band(values: list[float]) -> dict[str, float | None]:
    if not values:
        return {"p10": None, "p50": None, "p90": None}
    return {
        "p10": _percentile(values, 0.10),
        "p50": _percentile(values, 0.50),
        "p90": _percentile(values, 0.90),
    }


def project_open_pdk(scaling: dict[str, Any]) -> dict[str, Any]:
    """Project Sky130 PPA shape across every advanced-node target."""
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

    sky130_mm2 = (
        (float(die_area_um2) / 1_000_000.0) if isinstance(die_area_um2, int | float) else None
    )
    projections: dict[str, dict[str, Any]] = {}
    for target in ADVANCED_TARGETS:
        ratio = density_chain(scaling, "sky130", target)
        projected_mm2 = (sky130_mm2 / ratio) if sky130_mm2 is not None else None
        projections[target] = {
            "density_scaling_sky130_to_target": ratio,
            "projected_logic_area_mm2": projected_mm2,
        }
    return {
        "input_source": rel(SKY130_RUN_METRICS),
        "sky130_instances": instances,
        "sky130_die_area_um2": die_area_um2,
        "projections_per_target": projections,
        "envelope_total_mm2_min": 100,
        "envelope_total_mm2_max": 130,
        "envelope_status": "current_open_pdk_closure_does_not_yet_contain_flagship_class_logic",
        "projection_marker": OUTPUT_MARKER,
        "claim_boundary": "Sky130 logic area scaled by published density chain "
        "yields a single-point projection of advanced-node logic area. This is "
        "not signoff and must not be cited as measured silicon. The projected "
        "number is small because the current Sky130 e1 release contains the "
        "chip-top stub only and does not include real big-core OoO RTL, SRAM "
        "macros, NPU tile, NoC, IOMMU, or any flagship-class IP. The 100-130 "
        "mm² envelope lives in docs/evidence/process/die-area-budget.yaml and "
        "is sized by die-shot calibration, not by this open-PDK closure.",
    }


def _project_asap7_block(
    scaling: dict[str, Any],
    uncertainty: dict[str, Any] | None,
    shape: dict[str, Any],
    shape_path: Path,
    rng: random.Random,
) -> dict[str, Any]:
    block_id = shape.get("block_id") or shape_path.stem
    area_mm2 = shape.get("std_cell_area_mm2")
    power_mw_per_mhz = shape.get("dyn_power_mw_per_mhz")
    leakage_mw = shape.get("leakage_mw")
    max_freq_mhz = shape.get("max_freq_mhz")

    per_target: dict[str, Any] = {}
    for target in ADVANCED_TARGETS:
        density_ratio = density_chain(scaling, "asap7", target)
        perf_ratio = perf_chain(scaling, target)
        power_ratio = power_chain(scaling, target)
        # Point projection.
        projected_area = None if not isinstance(area_mm2, int | float) else area_mm2 / density_ratio
        projected_power = (
            None
            if not isinstance(power_mw_per_mhz, int | float)
            else power_mw_per_mhz * power_ratio
        )
        projected_freq = (
            None if not isinstance(max_freq_mhz, int | float) else max_freq_mhz * perf_ratio
        )
        projected_leakage = (
            None if not isinstance(leakage_mw, int | float) else leakage_mw * power_ratio
        )
        # Monte Carlo bands.
        density = scaling["density"]
        perf = scaling["perf_iso_power"]
        power = scaling["power_iso_perf"]
        density_unc = (uncertainty or {}).get("density")
        perf_unc = (uncertainty or {}).get("perf_iso_power")
        power_unc = (uncertainty or {}).get("power_iso_perf")
        density_samples = monte_carlo_chain(
            density, density_unc, DENSITY_PATHS[("asap7", target)], MONTE_CARLO_SAMPLES, rng
        )
        perf_samples = monte_carlo_chain(
            perf, perf_unc, PERF_POWER_EDGES[target], MONTE_CARLO_SAMPLES, rng
        )
        power_samples = monte_carlo_chain(
            power, power_unc, POWER_PERF_EDGES[target], MONTE_CARLO_SAMPLES, rng
        )
        area_band = (
            _band([area_mm2 / r for r in density_samples])
            if isinstance(area_mm2, int | float)
            else _band([])
        )
        power_band = (
            _band([power_mw_per_mhz * r for r in power_samples])
            if isinstance(power_mw_per_mhz, int | float)
            else _band([])
        )
        freq_band = (
            _band([max_freq_mhz * r for r in perf_samples])
            if isinstance(max_freq_mhz, int | float)
            else _band([])
        )
        per_target[target] = {
            "point": {
                "std_cell_area_mm2": projected_area,
                "dyn_power_mw_per_mhz": projected_power,
                "leakage_mw": projected_leakage,
                "max_freq_mhz_iso_power": projected_freq,
            },
            "monte_carlo": {
                "samples": MONTE_CARLO_SAMPLES,
                "seed": MONTE_CARLO_SEED,
                "std_cell_area_mm2": area_band,
                "dyn_power_mw_per_mhz": power_band,
                "max_freq_mhz_iso_power": freq_band,
            },
            "scaling_factors_used": {
                "density": density_ratio,
                "perf_iso_power": perf_ratio,
                "power_iso_perf": power_ratio,
            },
        }
    return {
        "block_id": block_id,
        "input_source": rel(shape_path),
        "asap7": {
            "std_cell_area_mm2": area_mm2,
            "dyn_power_mw_per_mhz": power_mw_per_mhz,
            "leakage_mw": leakage_mw,
            "max_freq_mhz": max_freq_mhz,
        },
        "projections": per_target,
        "projection_marker": OUTPUT_MARKER,
    }


def project_asap7_shapes(
    scaling: dict[str, Any],
    uncertainty: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    if not ASAP7_SHAPES_DIR.is_dir():
        return [
            {
                "status": "blocked_no_asap7_shapes",
                "expected_dir": rel(ASAP7_SHAPES_DIR),
                "next_step": "cd pd/asap7 && make all",
            }
        ]
    out: list[dict[str, Any]] = []
    rng = random.Random(MONTE_CARLO_SEED)
    for shape_path in sorted(ASAP7_SHAPES_DIR.glob("*.json")):
        shape = load_json_mapping(shape_path)
        if shape is None:
            continue
        if shape.get("evidence_class") != "predictive_finfet_shape_only_not_signoff":
            out.append(
                {
                    "status": "blocked_bad_evidence_class",
                    "input_source": rel(shape_path),
                    "evidence_class": shape.get("evidence_class"),
                    "expected": "predictive_finfet_shape_only_not_signoff",
                }
            )
            continue
        out.append(_project_asap7_block(scaling, uncertainty, shape, shape_path, rng))
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
    uncertainty = spec.get("uncertainty_bands")

    open_pdk_projection = project_open_pdk(scaling)
    asap7_projection = project_asap7_shapes(
        scaling, uncertainty if isinstance(uncertainty, dict) else None
    )

    report = {
        "schema": "eliza.process_ppa_projection_report.v1",
        "evidence_class": OUTPUT_MARKER,
        "claim_boundary": "These numbers are projections built by applying "
        "documented vendor scaling factors to open-PDK and ASAP7 shapes. They "
        "are NOT signoff, NOT measured silicon, and must not be cited as such.",
        "scaling_spec": rel(SCALING_SPEC),
        "advanced_targets": list(ADVANCED_TARGETS),
        "monte_carlo": {
            "samples": MONTE_CARLO_SAMPLES,
            "seed": MONTE_CARLO_SEED,
            "uncertainty_basis": "public-disclosure 1-sigma bands from "
            "ppa-projection.yaml.uncertainty_bands, sampled lognormal so the "
            "perturbation is strictly positive",
        },
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
    # Also emit a per-block projection JSON next to each input shape, so the
    # downstream Monte Carlo bands are co-located with the shape that drove
    # them. The per-block schema is `eliza.pd_asap7_per_block_projection.v1`.
    per_block_written: list[Path] = []
    for blk in asap7_projection:
        block_id = blk.get("block_id")
        input_src = blk.get("input_source")
        if not (isinstance(block_id, str) and isinstance(input_src, str)):
            continue
        per_block = {
            "schema": "eliza.pd_asap7_per_block_projection.v1",
            "block_id": block_id,
            "evidence_class": OUTPUT_MARKER,
            "source_shape": input_src,
            "advanced_targets": list(ADVANCED_TARGETS),
            "monte_carlo": report["monte_carlo"],
            "asap7_baseline": blk.get("asap7"),
            "projections": blk.get("projections"),
            "claim_boundary": (
                "ASAP7 predictive shape scaled to advanced-node envelope via "
                "published vendor scaling factors. Projection only, never "
                "signoff. Per-block bands are co-located with the shape that "
                "drove them so reviewers can audit one block at a time."
            ),
            "forbidden_uses": report["forbidden_uses"],
        }
        per_block_path = ASAP7_SHAPES_DIR / f"{block_id}_projection_n2p.json"
        per_block_path.write_text(json.dumps(per_block, indent=2) + "\n", encoding="utf-8")
        per_block_written.append(per_block_path)
    print(
        f"PPA projection emitted: {rel(OUT)} (projection_only, "
        f"{len(ADVANCED_TARGETS)} targets, monte_carlo={MONTE_CARLO_SAMPLES})"
    )
    if per_block_written:
        print("per-block projections:")
        for p in per_block_written:
            print(f"  {rel(p)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
