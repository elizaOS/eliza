#!/usr/bin/env python3
from __future__ import annotations

import json
from collections import Counter
from datetime import UTC, datetime
from hashlib import blake2s, sha256
from math import ceil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_full_payload_manifest.json"

PLACEMENT = ROOT / "benchmarks/results/e1x-real-graph-model-load.placement.json"
MODEL_LOAD_STREAM = ROOT / "build/reports/e1x_model_load_stream.json"
LAYER_SHARD_SWEEP = ROOT / "build/reports/e1x_layer_shard_sweep_executor.json"
WINDOW_SHARD_LINKAGE = ROOT / "build/reports/e1x_window_shard_linkage.json"

WORD_BYTES = 4
MASK64 = (1 << 64) - 1
FNV64_OFFSET = 0xCBF29CE484222325
FNV64_PRIME = 0x100000001B3


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def canonical_sha256(data: object) -> str:
    encoded = json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
    return sha256(encoded).hexdigest()


def mix64(checksum: int, value: int) -> int:
    return ((checksum ^ (value & MASK64)) * FNV64_PRIME) & MASK64


def packed_w4_layer_word(
    model: str, layer_index: int, logical_core_index: int, word_addr: int
) -> int:
    seed = f"{model}|layer={layer_index}|core={logical_core_index}|w4|{word_addr}"
    value = int.from_bytes(blake2s(seed.encode(), digest_size=4).digest(), "big")
    word = 0
    for lane in range(8):
        word |= ((value >> (lane * 4)) & 0xF) << (lane * 4)
    return word


def layer_records(layer: dict) -> tuple[list[dict[str, int | str]], int]:
    rows = int(layer["rows"])
    cols = int(layer["cols"])
    weight_bits = int(layer["weight_bits"])
    rows_per_core = int(layer["rows_per_core"])
    assigned_cores = int(layer["assigned_cores"])
    bytes_per_row = ceil(cols * weight_bits / 8)
    records: list[dict[str, int | str]] = []
    covered_rows = 0
    for ordinal in range(assigned_cores):
        row_start = ordinal * rows_per_core
        if row_start >= rows:
            break
        row_count = min(rows_per_core, rows - row_start)
        shard_bytes = row_count * bytes_per_row
        records.append(
            {
                "layer_index": int(layer["index"]),
                "layer_name": str(layer["name"]),
                "kind": str(layer["kind"]),
                "logical_core_index": int(layer["core_index_start"]) + ordinal,
                "row_start": row_start,
                "row_count": row_count,
                "shard_bytes": shard_bytes,
                "loader_words": ceil(shard_bytes / WORD_BYTES),
            }
        )
        covered_rows += row_count
    return records, covered_rows


def probe_word_addrs(loader_words: int) -> list[int]:
    return sorted({0, loader_words // 2, loader_words - 1})


def main() -> int:
    checks: list[dict[str, str]] = []
    input_paths = (PLACEMENT, MODEL_LOAD_STREAM, LAYER_SHARD_SWEEP, WINDOW_SHARD_LINKAGE)
    missing = [str(path.relative_to(ROOT)) for path in input_paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "full-payload manifest inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append(
        {"id": "e1x_full_payload_manifest_inputs_present", "status": status, "detail": detail}
    )

    placement = load_json(PLACEMENT) if PLACEMENT.is_file() else {}
    model_load = load_json(MODEL_LOAD_STREAM) if MODEL_LOAD_STREAM.is_file() else {}
    sweep = load_json(LAYER_SHARD_SWEEP) if LAYER_SHARD_SWEEP.is_file() else {}
    window_shard = load_json(WINDOW_SHARD_LINKAGE) if WINDOW_SHARD_LINKAGE.is_file() else {}

    deps_ok = (
        placement.get("schema") == "eliza.e1x.graph_mesh_placement.v1"
        and model_load.get("status") == "PASS"
        and int(model_load.get("summary", {}).get("stream_loader_word_transactions", 0))
        == 1_627_034_880
        and sweep.get("status") == "PASS"
        and int(sweep.get("summary", {}).get("covered_layer_count", 0)) == 283
        and window_shard.get("status") == "PASS"
        and int(window_shard.get("summary", {}).get("window_touched_shard_records", 0)) == 151_367
    )
    status, detail = pass_fail(
        deps_ok,
        "placement, model-load stream, layer sweep, and window-shard linkage are PASS",
        "dependency report missing, stale, or failing",
    )
    checks.append(
        {"id": "e1x_full_payload_manifest_dependencies_pass", "status": status, "detail": detail}
    )

    layers = placement.get("layers", [])
    model_name = str(placement.get("model", "e1x_llm_13b_w4a8_static_graph"))
    layer_count = int(placement.get("layer_count", 0))
    total_records = 0
    total_loader_words = 0
    total_stream_bytes = 0
    max_loader_words = 0
    committed_probe_words = 0
    payload_checksum = FNV64_OFFSET
    row_coverage_failures: list[str] = []
    logical_cores: set[int] = set()
    kind_counts: Counter[str] = Counter()
    layer_commitments: list[dict[str, int | str]] = []
    sampled_records: list[dict[str, int | str | list[int]]] = []

    if isinstance(layers, list):
        for layer in layers:
            records, covered_rows = layer_records(layer)
            if covered_rows != int(layer.get("rows", -1)):
                row_coverage_failures.append(str(layer.get("index")))
            layer_checksum = FNV64_OFFSET
            layer_probe_words = 0
            layer_loader_words = 0
            kind_counts[str(layer.get("kind", ""))] += 1
            for record in records:
                loader_words = int(record["loader_words"])
                probe_addrs = probe_word_addrs(loader_words)
                probe_words = [
                    packed_w4_layer_word(
                        model_name,
                        int(record["layer_index"]),
                        int(record["logical_core_index"]),
                        word_addr,
                    )
                    for word_addr in probe_addrs
                ]
                record_checksum = FNV64_OFFSET
                for value in (
                    int(record["layer_index"]),
                    int(record["logical_core_index"]),
                    int(record["row_start"]),
                    int(record["row_count"]),
                    int(record["shard_bytes"]),
                    loader_words,
                ):
                    record_checksum = mix64(record_checksum, value)
                for word_addr, word in zip(probe_addrs, probe_words, strict=True):
                    record_checksum = mix64(record_checksum, word_addr)
                    record_checksum = mix64(record_checksum, word)
                for value in (int(record["logical_core_index"]), loader_words, record_checksum):
                    layer_checksum = mix64(layer_checksum, value)
                    payload_checksum = mix64(payload_checksum, value)
                total_records += 1
                total_loader_words += loader_words
                total_stream_bytes += int(record["shard_bytes"])
                max_loader_words = max(max_loader_words, loader_words)
                committed_probe_words += len(probe_addrs)
                layer_probe_words += len(probe_addrs)
                layer_loader_words += loader_words
                logical_cores.add(int(record["logical_core_index"]))
                if len(sampled_records) < 8:
                    sampled_records.append(
                        {
                            "layer_index": int(record["layer_index"]),
                            "kind": str(record["kind"]),
                            "logical_core_index": int(record["logical_core_index"]),
                            "loader_words": loader_words,
                            "probe_addrs": probe_addrs,
                            "probe_words": probe_words,
                            "record_checksum": record_checksum,
                        }
                    )
            layer_commitments.append(
                {
                    "layer_index": int(layer["index"]),
                    "kind": str(layer["kind"]),
                    "record_count": len(records),
                    "loader_words": layer_loader_words,
                    "probe_word_count": layer_probe_words,
                    "layer_payload_checksum": layer_checksum,
                }
            )

    expected_stream_words = int(
        model_load.get("summary", {}).get("stream_loader_word_transactions", 0)
    )
    expected_stream_bytes = int(model_load.get("summary", {}).get("total_stream_bytes", 0))
    coverage_ok = (
        layer_count == 283
        and len(layer_commitments) == 283
        and not row_coverage_failures
        and total_records == 151_367
        and len(logical_cores) == 151_367
        and total_loader_words == expected_stream_words == 1_627_034_880
        and total_stream_bytes == expected_stream_bytes == 6_508_139_520
        and max_loader_words == 10_880
    )
    status, detail = pass_fail(
        coverage_ok,
        f"full payload manifest enumerates {total_records} shard records and {total_loader_words} loader words",
        "full payload manifest coverage/accounting mismatch",
    )
    checks.append(
        {
            "id": "e1x_full_payload_manifest_enumerates_all_shards",
            "status": status,
            "detail": detail,
        }
    )

    commitment_ok = (
        committed_probe_words == 454_101
        and len(kind_counts) == 8
        and payload_checksum != FNV64_OFFSET
        and len(sampled_records) == 8
    )
    status, detail = pass_fail(
        commitment_ok,
        f"payload manifest commits {committed_probe_words} deterministic first/mid/last W4 probe words",
        "payload manifest deterministic probe-word commitment mismatch",
    )
    checks.append(
        {"id": "e1x_full_payload_manifest_commits_probe_words", "status": status, "detail": detail}
    )

    residual_ok = (
        sweep.get("summary", {}).get("residual_blocker")
        == "full_quantized_weight_payload_executor_missing"
        and model_load.get("summary", {}).get("residual_blocker")
        == "cycle_accurate_full_tensor_executor_missing"
    )
    status, detail = pass_fail(
        residual_ok,
        "manifest commits every shard identity while preserving full payload execution blocker",
        "full-payload manifest residual boundary mismatch",
    )
    checks.append(
        {
            "id": "e1x_full_payload_manifest_preserves_execution_blocker",
            "status": status,
            "detail": detail,
        }
    )

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "layer_count": layer_count,
        "committed_layer_count": len(layer_commitments),
        "committed_shard_record_count": total_records,
        "committed_logical_core_count": len(logical_cores),
        "committed_loader_word_count": total_loader_words,
        "committed_stream_bytes": total_stream_bytes,
        "committed_probe_word_count": committed_probe_words,
        "probe_word_fraction_of_loader_stream": committed_probe_words / total_loader_words
        if total_loader_words
        else 0.0,
        "max_loader_words_per_shard": max_loader_words,
        "kind_counts": dict(sorted(kind_counts.items())),
        "payload_manifest_checksum": payload_checksum,
        "layer_commitment_sha256": canonical_sha256(layer_commitments),
        "sampled_record_sha256": canonical_sha256(sampled_records),
        "sampled_records": sampled_records,
        "residual_blocker": "full_quantized_weight_payload_executor_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-full-payload-manifest",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Enumerates every placed real-graph model shard and commits deterministic "
            "W4 payload identity with first/mid/last probe words per shard. This is a "
            "whole-graph compact payload commitment tied to load-stream and layer-sweep "
            "execution evidence; it is not full execution of every 6.5GB payload word "
            "and not a full-output real-weight checksum."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-model-load.placement.json",
            "build/reports/e1x_model_load_stream.json",
            "build/reports/e1x_layer_shard_sweep_executor.json",
            "build/reports/e1x_window_shard_linkage.json",
            "scripts/check_e1x_full_payload_manifest.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X full payload manifest failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X full payload manifest; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
