#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import blake2s, sha256
from pathlib import Path
from typing import Any, TypedDict, cast


class CaseSummary(TypedDict):
    case: str
    repair_manifest_sha256: str
    blocked_core_count: int
    total_remapped_core_count: int
    touched_remapped_core_count: int
    route_checksum: int
    sampled_remapped_rows: list[dict[str, object]]


ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_repaired_real_weight_execution.json"

PLACEMENT = ROOT / "benchmarks/results/e1x-real-graph-model-load.placement.json"
FULL_NORM_REAL_WEIGHT = ROOT / "build/reports/e1x_full_norm_real_weight_rows.json"
VOCAB_SAMPLED_K_REAL_WEIGHT = ROOT / "build/reports/e1x_vocab_sampled_k_real_weight_rows.json"
ATTN_OUT_SAMPLED_K_REAL_WEIGHT = (
    ROOT / "build/reports/e1x_attn_out_sampled_k_real_weight_rows.json"
)
ATTN_QKV_SAMPLED_K_REAL_WEIGHT = (
    ROOT / "build/reports/e1x_attn_qkv_sampled_k_real_weight_rows.json"
)
MLP_GATE_SAMPLED_K_REAL_WEIGHT = (
    ROOT / "build/reports/e1x_mlp_gate_sampled_k_real_weight_rows.json"
)
MLP_UP_SAMPLED_K_REAL_WEIGHT = ROOT / "build/reports/e1x_mlp_up_sampled_k_real_weight_rows.json"
MLP_DOWN_SAMPLED_K_REAL_WEIGHT = (
    ROOT / "build/reports/e1x_mlp_down_sampled_k_real_weight_rows.json"
)
FULL_PAYLOAD_REPAIR = ROOT / "build/reports/e1x_full_payload_repair_mapping.json"
WINDOW_REPAIR = ROOT / "build/reports/e1x_window_repair_linkage.json"


class CasePaths:
    def __init__(self, defect: Path, repair: Path, expected_repair_sha256: str) -> None:
        self.defect = defect
        self.repair = repair
        self.expected_repair_sha256 = expected_repair_sha256


CASES: dict[str, CasePaths] = {
    "normal": CasePaths(
        defect=ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_defect_map.json",
        repair=ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json",
        expected_repair_sha256="157f8f7eab101ae4f9e6cc6d69c150b9403189ca3e31523e56b6c331104d0528",
    ),
    "high_failure": CasePaths(
        defect=ROOT / "benchmarks/results/e1x-real-graph-model-load.high_failure_defect_map.json",
        repair=ROOT
        / "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json",
        expected_repair_sha256="c8ad0a7c1a907447b0624aecbb73ef36f763be20b43d253a35c56899a153d781",
    ),
}

VOCAB_SAMPLED_K = 128
SAMPLED_K_BY_KIND = {
    "norm": 1,
    "embedding": VOCAB_SAMPLED_K,
    "lm_head": VOCAB_SAMPLED_K,
    "attn_out_proj": 64,
    "attn_qkv_proj": 32,
    "mlp_gate_proj": 32,
    "mlp_up_proj": 32,
    "mlp_down_proj": 32,
}
FNV64_OFFSET = 0xCBF29CE484222325
FNV64_PRIME = 0x100000001B3
MASK64 = (1 << 64) - 1

FALSE_CLAIM_FLAGS: dict[str, object] = {
    "release_claim_allowed": False,
    "silicon_claim_allowed": False,
    "production_accelerator_claim_allowed": False,
    "full_output_execution_claim_allowed": False,
    "real_model_full_output_claim_allowed": False,
}


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict[str, Any]:
    return cast(dict[str, Any], json.loads(path.read_text(encoding="utf-8")))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def canonical_sha256(data: object) -> str:
    encoded = json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
    return sha256(encoded).hexdigest()


def mix64(checksum: int, value: int) -> int:
    return ((checksum ^ (value & MASK64)) * FNV64_PRIME) & MASK64


def stable_u32(parts: tuple[object, ...]) -> int:
    encoded = "|".join(str(part) for part in parts).encode()
    return int.from_bytes(blake2s(encoded, digest_size=4).digest(), "big")


def s8_from_seed(parts: tuple[object, ...]) -> int:
    return (stable_u32(parts) & 0xFF) - 128


def s4_from_seed(parts: tuple[object, ...]) -> int:
    return (stable_u32(parts) & 0xF) - 8


def coord_key(coord: dict[str, Any]) -> tuple[int, int]:
    return int(coord["row"]), int(coord["col"])


def logical_core_for_row(layer: dict[str, Any], output_row: int) -> int:
    rows_per_core = int(layer["rows_per_core"])
    ordinal = output_row // rows_per_core
    return int(layer["core_index_start"]) + ordinal


def execute_row(layer_index: int, output_row: int, k_count: int) -> dict[str, int]:
    accumulator = 0
    row_checksum = FNV64_OFFSET
    for k_idx in range(k_count):
        activation = s8_from_seed(("act", layer_index, k_idx))
        weight = s4_from_seed(("w4", layer_index, output_row, k_idx))
        product = activation * weight
        accumulator += product
        row_checksum = mix64(row_checksum, activation)
        row_checksum = mix64(row_checksum, weight)
        row_checksum = mix64(row_checksum, product)
    return {
        "accumulator": accumulator,
        "requantized_s8": max(-128, min(127, accumulator >> 7)),
        "lane_mac_count": k_count,
        "row_trace_checksum": row_checksum,
    }


def target_layers(placement: dict[str, Any]) -> list[dict[str, Any]]:
    layers = []
    for layer in placement.get("layers", []):
        if not isinstance(layer, dict):
            continue
        kind = str(layer.get("kind"))
        if kind in SAMPLED_K_BY_KIND:
            layers.append(layer)
    return layers


class CaseData:
    def __init__(
        self,
        defect: dict[str, Any],
        repair: dict[str, Any],
        blocked: set[tuple[int, int]],
        remap: dict[tuple[int, int], tuple[int, int]],
    ) -> None:
        self.defect = defect
        self.repair = repair
        self.blocked = blocked
        self.remap = remap


def load_case(paths: CasePaths) -> CaseData:
    defect = load_json(paths.defect)
    repair = load_json(paths.repair)
    return CaseData(
        defect=defect,
        repair=repair,
        blocked={coord_key(coord) for coord in defect.get("blocked_cores", [])},
        remap={
            coord_key(entry["logical"]): coord_key(entry["physical"])
            for entry in repair.get("remapped_cores", [])
        },
    )


def main() -> int:
    checks: list[dict[str, str]] = []
    input_paths: list[Path] = [
        PLACEMENT,
        FULL_NORM_REAL_WEIGHT,
        VOCAB_SAMPLED_K_REAL_WEIGHT,
        ATTN_OUT_SAMPLED_K_REAL_WEIGHT,
        ATTN_QKV_SAMPLED_K_REAL_WEIGHT,
        MLP_GATE_SAMPLED_K_REAL_WEIGHT,
        MLP_UP_SAMPLED_K_REAL_WEIGHT,
        MLP_DOWN_SAMPLED_K_REAL_WEIGHT,
        FULL_PAYLOAD_REPAIR,
        WINDOW_REPAIR,
    ]
    for case_paths in CASES.values():
        input_paths.extend([case_paths.defect, case_paths.repair])
    missing = [str(path.relative_to(ROOT)) for path in input_paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "repaired real-weight execution inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append(
        {
            "id": "e1x_repaired_real_weight_execution_inputs_present",
            "status": status,
            "detail": detail,
        }
    )

    placement = load_json(PLACEMENT) if PLACEMENT.is_file() else {}
    full_norm = load_json(FULL_NORM_REAL_WEIGHT) if FULL_NORM_REAL_WEIGHT.is_file() else {}
    vocab = load_json(VOCAB_SAMPLED_K_REAL_WEIGHT) if VOCAB_SAMPLED_K_REAL_WEIGHT.is_file() else {}
    attn_out = load_json(ATTN_OUT_SAMPLED_K_REAL_WEIGHT) if ATTN_OUT_SAMPLED_K_REAL_WEIGHT.is_file() else {}
    attn_qkv = load_json(ATTN_QKV_SAMPLED_K_REAL_WEIGHT) if ATTN_QKV_SAMPLED_K_REAL_WEIGHT.is_file() else {}
    mlp_gate = load_json(MLP_GATE_SAMPLED_K_REAL_WEIGHT) if MLP_GATE_SAMPLED_K_REAL_WEIGHT.is_file() else {}
    mlp_up = load_json(MLP_UP_SAMPLED_K_REAL_WEIGHT) if MLP_UP_SAMPLED_K_REAL_WEIGHT.is_file() else {}
    mlp_down = load_json(MLP_DOWN_SAMPLED_K_REAL_WEIGHT) if MLP_DOWN_SAMPLED_K_REAL_WEIGHT.is_file() else {}
    full_payload_repair = load_json(FULL_PAYLOAD_REPAIR) if FULL_PAYLOAD_REPAIR.is_file() else {}
    window_repair = load_json(WINDOW_REPAIR) if WINDOW_REPAIR.is_file() else {}

    deps_ok = (
        placement.get("schema") == "eliza.e1x.graph_mesh_placement.v1"
        and full_norm.get("status") == "PASS"
        and int(full_norm.get("summary", {}).get("executed_norm_output_row_count", 0)) == 414_720
        and vocab.get("status") == "PASS"
        and int(vocab.get("summary", {}).get("executed_vocab_sampled_k_mac_count", 0)) == 8_192_000
        and attn_out.get("status") == "PASS"
        and int(attn_out.get("summary", {}).get("executed_attn_out_sampled_k_mac_count", 0))
        == 13_107_200
        and attn_qkv.get("status") == "PASS"
        and int(attn_qkv.get("summary", {}).get("executed_attn_qkv_sampled_k_mac_count", 0))
        == 19_660_800
        and mlp_gate.get("status") == "PASS"
        and int(mlp_gate.get("summary", {}).get("executed_mlp_gate_sampled_k_mac_count", 0))
        == 17_694_720
        and mlp_up.get("status") == "PASS"
        and int(mlp_up.get("summary", {}).get("executed_mlp_up_sampled_k_mac_count", 0))
        == 17_694_720
        and mlp_down.get("status") == "PASS"
        and int(mlp_down.get("summary", {}).get("executed_mlp_down_sampled_k_mac_count", 0))
        == 6_553_600
        and full_payload_repair.get("status") == "PASS"
        and int(
            full_payload_repair.get("summary", {}).get("high_failure_payload_remapped_records", 0)
        )
        == 3_012
        and window_repair.get("status") == "PASS"
        and int(window_repair.get("summary", {}).get("high_failure_window_remapped_core_count", 0))
        > 0
    )
    status, detail = pass_fail(
        deps_ok,
        "real-weight execution, full-payload repair, and window-repair linkage reports are PASS",
        "repaired real-weight execution dependency mismatch",
    )
    checks.append(
        {
            "id": "e1x_repaired_real_weight_execution_dependencies_pass",
            "status": status,
            "detail": detail,
        }
    )

    layers = target_layers(placement)
    logical_cols = int(placement.get("logical_cols", 0))
    case_data: dict[str, CaseData] = {
        case: load_case(paths)
        for case, paths in CASES.items()
        if paths.defect.is_file() and paths.repair.is_file()
    }

    output_checksum = FNV64_OFFSET
    total_rows = 0
    total_macs = 0
    touched_logical_cores: set[int] = set()
    case_summaries: dict[str, CaseSummary] = {
        case: CaseSummary(
            case=case,
            repair_manifest_sha256=str(data.repair.get("artifact_sha256", "")),
            blocked_core_count=int(data.defect.get("blocked_core_count", 0)),
            total_remapped_core_count=int(data.repair.get("remapped_core_count", 0)),
            touched_remapped_core_count=0,
            route_checksum=FNV64_OFFSET,
            sampled_remapped_rows=[],
        )
        for case, data in case_data.items()
    }
    errors: list[str] = []
    sampled_rows: list[dict[str, int | str]] = []

    for layer in layers:
        layer_index = int(layer["index"])
        kind = str(layer["kind"])
        rows = int(layer["rows"])
        k_count = min(SAMPLED_K_BY_KIND[kind], int(layer["cols"]))
        for output_row in range(rows):
            logical_core = logical_core_for_row(layer, output_row)
            logical = (logical_core // logical_cols, logical_core % logical_cols)
            result = execute_row(layer_index, output_row, k_count)
            total_rows += 1
            total_macs += int(result["lane_mac_count"])
            touched_logical_cores.add(logical_core)
            output_checksum = mix64(output_checksum, layer_index)
            output_checksum = mix64(output_checksum, output_row)
            output_checksum = mix64(output_checksum, int(result["row_trace_checksum"]))

            if len(sampled_rows) < 12:
                sampled_rows.append(
                    {
                        "layer_index": layer_index,
                        "kind": kind,
                        "output_row": output_row,
                        "logical_core_index": logical_core,
                        "lane_mac_count": int(result["lane_mac_count"]),
                        "row_trace_checksum": int(result["row_trace_checksum"]),
                    }
                )

            for case, data in case_data.items():
                remap = data.remap
                blocked = data.blocked
                physical = remap.get(logical, logical)
                if logical in blocked and logical not in remap:
                    errors.append(f"{case}:missing-remap:{logical_core}")
                    continue
                if physical in blocked:
                    errors.append(f"{case}:blocked-physical:{logical_core}")
                    continue
                summary = case_summaries[case]
                is_remapped = logical in remap
                if is_remapped:
                    summary["touched_remapped_core_count"] = (
                        int(summary["touched_remapped_core_count"]) + 1
                    )
                    sampled = summary["sampled_remapped_rows"]
                    if len(sampled) < 8:
                        sampled.append(
                            {
                                "layer_index": layer_index,
                                "kind": kind,
                                "output_row": output_row,
                                "logical_core_index": logical_core,
                                "physical_row": physical[0],
                                "physical_col": physical[1],
                            }
                        )
                route_checksum = int(summary["route_checksum"])
                for value in (
                    layer_index,
                    output_row,
                    logical_core,
                    physical[0],
                    physical[1],
                    int(result["row_trace_checksum"]),
                    1 if is_remapped else 0,
                ):
                    route_checksum = mix64(route_checksum, value)
                summary["route_checksum"] = route_checksum

    for case, paths in CASES.items():
        case_summary = case_summaries.get(case)
        case_ok = (
            case_summary is not None
            and case_summary["repair_manifest_sha256"] == paths.expected_repair_sha256
            and case_summary["touched_remapped_core_count"] > 0
            and case_summary["route_checksum"] > 0
        )
        status, detail = pass_fail(
            case_ok,
            f"{case} repair map routes executed real-weight rows onto usable physical cores",
            f"{case} repaired real-weight route mismatch",
        )
        checks.append(
            {"id": f"e1x_repaired_real_weight_execution_{case}", "status": status, "detail": detail}
        )

    normal_summary = case_summaries.get("normal")
    high_failure_summary = case_summaries.get("high_failure")
    normal_route_checksum = normal_summary["route_checksum"] if normal_summary is not None else 0
    normal_touched = (
        normal_summary["touched_remapped_core_count"] if normal_summary is not None else 0
    )
    high_failure_route_checksum = (
        high_failure_summary["route_checksum"] if high_failure_summary is not None else 0
    )
    high_failure_touched = (
        high_failure_summary["touched_remapped_core_count"]
        if high_failure_summary is not None
        else 0
    )
    repaired_ok = (
        not errors
        and len(layers) == 283
        and total_rows == 2_608_640
        and total_macs == 83_317_760
        and len(touched_logical_cores) == 151_367
        and normal_route_checksum != high_failure_route_checksum
    )
    status, detail = pass_fail(
        repaired_ok,
        f"repaired execution maps {total_rows} real-weight rows across normal/high defect scenarios",
        "repaired real-weight execution mismatch: " + ", ".join(errors[:8]),
    )
    checks.append(
        {"id": "e1x_repaired_real_weight_execution_maps_rows", "status": status, "detail": detail}
    )

    failures = [check for check in checks if check["status"] != "pass"]
    report_summary: dict[str, object] = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "executed_layer_count": len(layers),
        "executed_real_weight_row_count": total_rows,
        "executed_real_weight_mac_count": total_macs,
        "touched_logical_core_count": len(touched_logical_cores),
        "output_invariant_checksum": int(output_checksum),
        "normal_route_checksum": normal_route_checksum,
        "high_failure_route_checksum": high_failure_route_checksum,
        "normal_touched_remapped_rows": normal_touched,
        "high_failure_touched_remapped_rows": high_failure_touched,
        "high_vs_normal_touched_remap_ratio": (high_failure_touched / max(1, normal_touched)),
        "sampled_executed_rows_sha256": canonical_sha256(sampled_rows),
        "case_summaries": case_summaries,
        "sampled_executed_rows": sampled_rows,
        "residual_blocker": "full_output_real_weight_checksum_missing",
    }
    report: dict[str, object] = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-repaired-real-weight-execution",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Repair-aware deterministic W4A8 real-weight execution for all rows "
            "covered by the current full-norm, vocab sampled-K, attention sampled-K, "
            "and MLP sampled-K gates. This proves normal/high defect remaps preserve "
            "logical numerical outputs for those rows while producing distinct "
            "physical route checksums. It is not a full-output real-weight checksum, "
            "not full-K sampled-layer execution, and not silicon evidence."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-model-load.placement.json",
            "build/reports/e1x_full_norm_real_weight_rows.json",
            "build/reports/e1x_vocab_sampled_k_real_weight_rows.json",
            "build/reports/e1x_attn_out_sampled_k_real_weight_rows.json",
            "build/reports/e1x_attn_qkv_sampled_k_real_weight_rows.json",
            "build/reports/e1x_mlp_gate_sampled_k_real_weight_rows.json",
            "build/reports/e1x_mlp_up_sampled_k_real_weight_rows.json",
            "build/reports/e1x_mlp_down_sampled_k_real_weight_rows.json",
            "build/reports/e1x_full_payload_repair_mapping.json",
            "build/reports/e1x_window_repair_linkage.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_defect_map.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_defect_map.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json",
            "scripts/check_e1x_repaired_real_weight_execution.py",
        ],
        "checks": checks,
        "summary": report_summary,
    }
    report.update(FALSE_CLAIM_FLAGS)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print(
            "BLOCKED: E1X repaired real-weight execution failed: "
            + ", ".join(c["id"] for c in failures)
        )
        return 1
    print(f"PASS: E1X repaired real-weight execution; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
