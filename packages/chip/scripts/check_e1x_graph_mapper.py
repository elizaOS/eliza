#!/usr/bin/env python3
"""Fail-closed gate for the E1X quantized-graph -> logical-mesh placement pass.

This gate closes the "Compiler/runtime mapping from real quantized model graphs
to logical mesh coordinates" completion gate (docs/arch/e1x-wafer-mesh.md). It
exercises ``compiler/runtime/e1x_graph_mapper.py`` against the checked
Llama-13B-style W4A8 manifest and validates every property the wafer model
relies on, writing ``build/reports/e1x_graph_mapper.json`` in the
``eliza.gate_status.v1`` shape.

PASS requires ALL of:
  * manifest_schema     — the manifest parses under the v1 schema with all
    layer kinds/shapes valid.
  * deterministic       — re-running the mapper yields a byte-identical
    placement (same ``artifact_sha256``), no RNG / wall-clock.
  * every_layer_placed  — placement layer count == manifest layer count and
    every layer has a non-empty assigned core span.
  * sram_fit            — aggregate weight bytes and the peak per-core shard fit
    the usable SRAM budget; cores_used <= logical_cores.
  * routing_colors      — every layer's routing color is in
    [0, E1X_ROUTING_COLORS).
  * params_match        — placement total_parameters equals the manifest's
    summed rows*cols.
  * wafer_consistency   — the wafer model's independent shard accounting agrees
    with the mapper on fit (placement_consistent_with_wafer_accounting).
  * high_failure_run    — the same real-graph placement loads and runs under
    the high-failure repair-stress defect map.

CLAIM BOUNDARY. This proves architecture-level placement, sharding, and
capacity for a real quantized graph. It is not a kernel-generating backend: it
does not emit per-core instruction streams, schedule MACs, split the K
(contraction) dimension into compute waves, or prove quantized numerics. Those
remain BLOCKED follow-ons.
"""

from __future__ import annotations

import datetime as _dt
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from compiler.runtime.e1x_graph_mapper import (  # noqa: E402
    ManifestError,
    map_graph,
    parse_manifest,
    placement_to_model_spec,
)
from compiler.runtime.e1x_wafer_model import (  # noqa: E402
    E1XConfig,
    build_real_graph_report,
    scaled_8gb_config,
)
from scripts.chip_utils import load_json_object  # noqa: E402

REPORT = ROOT / "build/reports/e1x_graph_mapper.json"
MANIFEST = ROOT / "benchmarks/models/llama13b-w4a8-manifest.json"


def _now() -> str:
    return _dt.datetime.now(_dt.UTC).isoformat()


def run_checks() -> list[dict[str, str]]:
    checks: list[dict[str, str]] = []
    if not MANIFEST.is_file():
        return [
            {
                "id": "manifest_schema",
                "status": "blocked",
                "detail": f"missing manifest {MANIFEST.relative_to(ROOT)}; "
                "run benchmarks/models/generate_llama13b_w4a8_manifest.py",
            }
        ]

    try:
        manifest = parse_manifest(load_json_object(MANIFEST))
    except (ManifestError, ValueError) as exc:
        return [{"id": "manifest_schema", "status": "fail", "detail": f"manifest invalid: {exc}"}]
    checks.append(
        {
            "id": "manifest_schema",
            "status": "pass",
            "detail": f"{len(manifest.layers)} layers parsed under v1 schema "
            f"({manifest.n_layers} decoder blocks, d_model={manifest.d_model})",
        }
    )

    config: E1XConfig = scaled_8gb_config()
    placement = map_graph(manifest, config)
    placement_again = map_graph(parse_manifest(load_json_object(MANIFEST)), config)
    if placement["artifact_sha256"] == placement_again["artifact_sha256"]:
        checks.append(
            {
                "id": "deterministic",
                "status": "pass",
                "detail": f"identical placement sha256 {str(placement['artifact_sha256'])[:16]}",
            }
        )
    else:
        checks.append(
            {"id": "deterministic", "status": "fail", "detail": "placement sha256 differs on rerun"}
        )

    layers = placement["layers"]
    assert isinstance(layers, list)
    empty = [str(layer["name"]) for layer in layers if int(layer["assigned_cores"]) < 1]
    if int(placement["layer_count"]) == len(manifest.layers) and not empty:
        checks.append(
            {
                "id": "every_layer_placed",
                "status": "pass",
                "detail": f"all {len(layers)} layers placed onto "
                f"{int(placement['cores_used'])} of {config.logical_cores} logical cores",
            }
        )
    else:
        checks.append(
            {
                "id": "every_layer_placed",
                "status": "fail",
                "detail": f"layer_count={placement['layer_count']} manifest={len(manifest.layers)} "
                f"empty_spans={empty[:4]}",
            }
        )

    fit = bool(placement["sram_fit"])
    cores_ok = int(placement["cores_used"]) <= config.logical_cores
    peak_ok = float(placement["peak_core_occupancy"]) <= 1.0
    if fit and cores_ok and peak_ok:
        checks.append(
            {
                "id": "sram_fit",
                "status": "pass",
                "detail": f"weights {int(placement['total_weight_bytes']) / 2**20:.1f} MiB fit; "
                f"peak core occupancy {float(placement['peak_core_occupancy']):.4f}",
            }
        )
    else:
        checks.append(
            {
                "id": "sram_fit",
                "status": "fail",
                "detail": f"sram_fit={fit} cores_ok={cores_ok} peak_occ_ok={peak_ok}",
            }
        )

    colors = config.routing_colors
    bad_colors = [
        str(layer["name"])
        for layer in layers
        if not (0 <= int(layer["routing_color"]) < colors)
    ]
    if not bad_colors:
        checks.append(
            {
                "id": "routing_colors",
                "status": "pass",
                "detail": f"all routing colors within [0, {colors}); "
                f"{len(placement['routing_colors_used'])} colors used",
            }
        )
    else:
        checks.append(
            {
                "id": "routing_colors",
                "status": "fail",
                "detail": f"layers with out-of-range color: {bad_colors[:4]}",
            }
        )

    placed_params = int(placement["total_parameters"])
    if placed_params == manifest.total_parameters:
        checks.append(
            {
                "id": "params_match",
                "status": "pass",
                "detail": f"{placed_params:,} params match manifest sum",
            }
        )
    else:
        checks.append(
            {
                "id": "params_match",
                "status": "fail",
                "detail": f"placement {placed_params} != manifest {manifest.total_parameters}",
            }
        )

    spec = placement_to_model_spec(
        manifest, placement, activation_mib=512, runtime_mib=256, metadata_mib=96
    )
    report = build_real_graph_report(placement, spec, config)
    if bool(report["placement_consistent_with_wafer_accounting"]):
        checks.append(
            {
                "id": "wafer_consistency",
                "status": "pass",
                "detail": "mapper fit agrees with wafer model_load_plan shard accounting "
                f"(both {bool(report['mapper_sram_fit'])})",
            }
        )
    else:
        checks.append(
            {
                "id": "wafer_consistency",
                "status": "fail",
                "detail": f"mapper_fit={report['mapper_sram_fit']} "
                f"wafer_fit={report['wafer_model_placement_successful']}",
            }
        )
    if (
        report.get("model_loaded_under_high_failure") == 1
        and report.get("high_failure_repaired_logical_mesh") == 1
        and report.get("high_failure_model_run_successful") == 1
        and int(report.get("high_failure_output_checksum", 0)) > 0
    ):
        checks.append(
            {
                "id": "high_failure_run",
                "status": "pass",
                "detail": "real graph loads and executes under high-failure repair stress "
                f"with checksum {report['high_failure_output_checksum']}",
            }
        )
    else:
        checks.append(
            {
                "id": "high_failure_run",
                "status": "fail",
                "detail": f"loaded={report.get('model_loaded_under_high_failure')} "
                f"repair={report.get('high_failure_repaired_logical_mesh')} "
                f"run={report.get('high_failure_model_run_successful')}",
            }
        )
    return checks


def main() -> int:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    checks = run_checks()
    has_fail = any(c["status"] == "fail" for c in checks)
    has_block = any(c["status"] == "blocked" for c in checks)
    if has_fail:
        status, blocker_id = "FAIL", "graph_mapper_check_failure"
        blocker_reason = "; ".join(f"{c['id']}: {c['detail']}" for c in checks if c["status"] == "fail")
    elif has_block:
        status, blocker_id = "BLOCKED", "graph_mapper_dependency_missing"
        blocker_reason = "; ".join(
            f"{c['id']}: {c['detail']}" for c in checks if c["status"] == "blocked"
        )
    else:
        status, blocker_id, blocker_reason = "PASS", None, None

    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x_graph_mapper",
        "status": status,
        "blocker_id": blocker_id,
        "blocker_reason": blocker_reason,
        "evidence_paths": [
            "compiler/runtime/e1x_graph_mapper.py",
            "benchmarks/models/llama13b-w4a8-manifest.json",
            "benchmarks/models/generate_llama13b_w4a8_manifest.py",
            "scripts/check_e1x_graph_mapper.py",
            "scripts/test_e1x_graph_mapper.py",
        ],
        "as_of": _now(),
        "subsystem": "compiler_runtime",
        "claim_boundary": (
            "Architecture-level placement/sharding/capacity compiler: it maps a "
            "real quantized transformer manifest to concrete logical-mesh "
            "coordinates, shards every weight matrix by output rows against the "
            "45 KiB usable per-core SRAM budget, assigns one static fabric "
            "routing color per layer within E1X_ROUTING_COLORS, checks aggregate "
            "and per-core SRAM fit, and feeds the wafer model's accounting. It is "
            "NOT a kernel-generating backend: no per-core instruction streams, "
            "no MAC scheduling, no K-dimension wave splitting, no quantized "
            "numerics proof. Those remain BLOCKED follow-ons."
        ),
        "summary": {
            "check_count": len(checks),
            "passing_check_count": sum(1 for c in checks if c["status"] == "pass"),
            "failures": [c["id"] for c in checks if c["status"] != "pass"],
        },
        "checks": checks,
    }
    REPORT.write_text(json.dumps(report, indent=2) + "\n")
    print(f"STATUS: {status} e1x_graph_mapper -> {REPORT.relative_to(ROOT)}")
    for c in checks:
        print(f"  [{c['status'].upper():7}] {c['id']}: {c['detail']}")
    if blocker_reason:
        print(f"  blocker: {blocker_reason}")
    return {"PASS": 0, "BLOCKED": 2, "FAIL": 1}[status]


if __name__ == "__main__":
    sys.exit(main())
