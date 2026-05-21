#!/usr/bin/env python3
"""Convert public Macro Placement Challenge 2026 metadata into records."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
PAYLOAD = ROOT / "external/repos/macro-place-challenge-2026/payload"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/macro_place_challenge_2026"
CLAIM_BOUNDARY = "macro_place_challenge_2026_conversion_training_only_no_e1_signoff_or_release_claim"
LABEL_STATUS = "public_macro_place_challenge_2026_proxy_and_baseline_training_only_not_e1_signoff"


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_record(path: Path) -> dict[str, Any]:
    return {
        "path": rel(path),
        "exists": path.is_file(),
        "bytes": path.stat().st_size if path.is_file() else 0,
        "sha256": sha256_file(path) if path.is_file() else None,
    }


def safe_id(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-").lower()


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected JSON object")
    return data


def load_ppa_baselines(path: Path) -> dict[str, list[dict[str, Any]]]:
    if not path.is_file():
        return {}
    by_design: dict[str, list[dict[str, Any]]] = {}
    with path.open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            design = row.get("design")
            if not design:
                continue
            cleaned: dict[str, Any] = {}
            for key, value in row.items():
                if value is None:
                    continue
                if key in {"design", "method", "source"}:
                    cleaned[key] = value
                    continue
                try:
                    cleaned[key] = float(value)
                except ValueError:
                    cleaned[key] = value
            by_design.setdefault(design, []).append(cleaned)
    return by_design


def source_files(payload: Path, design: str) -> dict[str, Path]:
    processed = payload / "benchmarks/processed/public" / f"{design}_ng45.pt"
    if not processed.is_file():
        processed = payload / "benchmarks/processed/public" / f"{design}.pt"
    return {
        "processed_tensor": processed,
        "baseline_scores": payload / "benchmarks/metadata/baseline_scores.json",
        "ppa_baselines": payload / "baselines/ng45_baselines.csv",
        "readme": payload / "README.md",
        "scoring": payload / "SCORING.md",
    }


def write_json(out_dir: Path, record: dict[str, Any]) -> Path:
    path = out_dir / f"{record['id']}.json"
    path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def convert_design(
    design: str,
    metadata: dict[str, Any],
    ppa_baselines: dict[str, list[dict[str, Any]]],
    payload: Path,
    out_dir: Path,
) -> list[dict[str, Any]]:
    files = source_files(payload, design)
    source_records = [file_record(path) for path in files.values() if path.is_file()]
    design_id = f"macro-place-challenge-2026-{safe_id(design)}"
    initial = metadata.get("initial_placement") if isinstance(metadata.get("initial_placement"), dict) else {}
    num_macros = int(metadata.get("num_macros", 0))
    num_nets = int(metadata.get("num_nets", 0))
    canvas_width = float(metadata.get("canvas_width", 0.0))
    canvas_height = float(metadata.get("canvas_height", 0.0))
    proxy_cost = float(initial.get("proxy_cost", 0.0))
    ppa = ppa_baselines.get(design, [])

    design_bundle = {
        "schema": "eda.design_bundle.v1",
        "id": f"{design_id}-design-bundle",
        "claim_boundary": CLAIM_BOUNDARY,
        "design": {
            "name": design,
            "revision": "macro_place_challenge_2026_public_payload",
            "top_module": design,
        },
        "sources": {
            "rtl": [],
            "manifests": ["external/repos/macro-place-challenge-2026/manifest.yaml"],
            "benchmark_tensors": [file_record(files["processed_tensor"])],
            "metadata": [file_record(files["baseline_scores"]), file_record(files["ppa_baselines"])],
            "docs": [file_record(files["readme"]), file_record(files["scoring"])],
        },
        "constraints": {"clocks": [], "resets": []},
        "technology": {
            "node": "ng45_public_challenge_proxy",
            "pdk": "public_challenge_tensor_no_foundry_collateral",
            "flow": "Partcl/HRT Macro Placement Challenge 2026",
        },
    }
    graph_sample = {
        "schema": "eda.graph_sample.v1",
        "id": f"{design_id}-benchmark-summary-graph",
        "design_bundle_id": design_bundle["id"],
        "claim_boundary": CLAIM_BOUNDARY,
        "graph": {
            "coordinate_system": "challenge_canvas_um_metadata_only_no_tensor_payload_export",
            "node_features": [
                {"id": "macros", "node_type": "benchmark_count", "value": num_macros},
                {"id": "nets", "node_type": "benchmark_count", "value": num_nets},
                {"id": "canvas", "node_type": "floorplan_canvas", "width_um": canvas_width, "height_um": canvas_height},
                {"id": "initial_proxy", "node_type": "baseline_proxy_cost", "value": proxy_cost},
            ],
            "edge_features": [
                {
                    "src": "macros",
                    "dst": "nets",
                    "edge_type": "macro_net_complexity_summary",
                    "nets_per_macro": (num_nets / num_macros) if num_macros else 0.0,
                },
                {
                    "src": "canvas",
                    "dst": "initial_proxy",
                    "edge_type": "proxy_cost_context",
                    "canvas_area_um2": canvas_width * canvas_height,
                },
            ],
        },
        "labels": {
            "label_status": LABEL_STATUS,
            "label_sources": source_records,
            "values": {
                "initial_placement": initial,
                "ppa_baselines": ppa,
            },
        },
        "provenance": {
            "generated_by": "scripts/ai_eda/convert_macro_place_challenge_2026_to_internal_records.py",
            "source_records": source_records,
        },
    }
    flow_run = {
        "schema": "eda.flow_run.v1",
        "id": f"{design_id}-baseline-flow-run",
        "design_bundle_id": design_bundle["id"],
        "claim_boundary": CLAIM_BOUNDARY,
        "toolchain": {
            "tools": ["Partcl/HRT Macro Placement Challenge 2026 metadata", "TILOS MacroPlacement proxy evaluator"],
            "version_capture": "external/repos/macro-place-challenge-2026/manifest.yaml",
        },
        "command": "python3 scripts/ai_eda/convert_macro_place_challenge_2026_to_internal_records.py --run-id <run-id>",
        "inputs": {
            "processed_tensor": file_record(files["processed_tensor"]),
            "baseline_scores": file_record(files["baseline_scores"]),
            "ppa_baselines": file_record(files["ppa_baselines"]),
        },
        "outputs": {"reports": [], "artifacts": source_records},
        "metrics": {
            "label_status": LABEL_STATUS,
            "num_macros": num_macros,
            "num_nets": num_nets,
            "canvas_width_um": canvas_width,
            "canvas_height_um": canvas_height,
            "initial_proxy_cost": proxy_cost,
            "ppa_baseline_count": len(ppa),
            "ppa_baselines": ppa,
        },
        "status": {
            "result": "CONVERTED_METADATA_ONLY_BLOCKED_FOR_E1_SIGNOFF",
            "blockers": [
                "challenge tensor payload is not committed to CUDA payload tarball",
                "benchmark terms and hidden split review required before model selection claims",
                "E1 improvement claims require deterministic OpenLane/OpenROAD replay",
            ],
        },
    }
    records = (design_bundle, graph_sample, flow_run)
    paths = [write_json(out_dir, record) for record in records]
    return [
        {
            "id": record["id"],
            "schema": record["schema"],
            "json": rel(path),
            "design": design,
            "num_macros": num_macros,
            "num_nets": num_nets,
            "initial_proxy_cost": proxy_cost,
        }
        for record, path in zip(records, paths)
    ]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--payload", type=Path, default=PAYLOAD)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--sample-limit", type=int, default=4)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.sample_limit <= 0:
        raise SystemExit("--sample-limit must be positive")
    baseline_path = args.payload / "benchmarks/metadata/baseline_scores.json"
    if not baseline_path.is_file():
        print(f"STATUS: BLOCKED ai_eda.macro_place_challenge_2026_conversion missing_baseline_scores {baseline_path}")
        return 2
    baselines = load_json(baseline_path)
    ppa_baselines = load_ppa_baselines(args.payload / "baselines/ng45_baselines.csv")
    selected = sorted(baselines)[: args.sample_limit]
    out_dir = args.out_root / args.run_id / "records"
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("macro-place-challenge-2026-*.json"):
        stale.unlink()
    converted: list[dict[str, Any]] = []
    for design in selected:
        metadata = baselines.get(design)
        if not isinstance(metadata, dict):
            continue
        converted.extend(convert_design(design, metadata, ppa_baselines, args.payload, out_dir))
    report = {
        "schema": "eliza.ai_eda.macro_place_challenge_2026_conversion_report.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "payload": rel(args.payload),
        "available_benchmark_count": len(baselines),
        "converted_benchmark_count": len(selected),
        "converted_record_count": len(converted),
        "converted_records": converted,
        "policy": {
            "contains_tensor_payload": False,
            "contains_hidden_benchmarks": False,
            "release_use_allowed": False,
            "e1_signoff_evidence": False,
            "deterministic_replay_required_for_ppa_claims": True,
        },
    }
    report_path = args.out_root / args.run_id / "conversion_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.macro_place_challenge_2026_conversion "
        f"benchmarks={len(selected)} records={len(converted)} report={rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
