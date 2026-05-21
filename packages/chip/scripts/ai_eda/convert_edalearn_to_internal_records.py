#!/usr/bin/env python3
"""Convert bounded EDALearn RTL/config designs into internal records."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DESIGN_ROOT = ROOT / "external/repos/edalearn/payload/designs"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/edalearn"
CLAIM_BOUNDARY = "edalearn_conversion_training_only_no_e1_signoff_or_release_claim"
PINNED_REVISION = "fc34c2e89fd1e49b5cb97e04441b100014435384"

CONFIG_RE = re.compile(r'^\s*set\s+([A-Za-z0-9_]+)\s+"?([^"\n]+?)"?\s*$')
VERILOG_MODULE_RE = re.compile(r"^\s*module\s+([A-Za-z_][A-Za-z0-9_$]*)\b", re.MULTILINE)
VHDL_ENTITY_RE = re.compile(
    r"^\s*entity\s+([A-Za-z_][A-Za-z0-9_]*)\s+is\b", re.IGNORECASE | re.MULTILINE
)


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


def safe_id(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value)


def parse_config(path: Path) -> dict[str, str]:
    config: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        match = CONFIG_RE.match(line)
        if match:
            key, value = match.groups()
            config[key] = value.strip()
    return config


def file_record(path: Path) -> dict[str, Any]:
    return {"path": rel(path), "bytes": path.stat().st_size, "sha256": sha256_file(path)}


def rtl_files(design_dir: Path) -> list[Path]:
    rtl_dir = design_dir / "rtl"
    if not rtl_dir.exists():
        return []
    suffixes = {".v", ".sv", ".vh", ".vhd", ".vhdl"}
    return [
        path
        for path in sorted(rtl_dir.rglob("*"))
        if path.is_file() and path.suffix.lower() in suffixes
    ]


def parse_rtl(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8", errors="replace")
    modules = VERILOG_MODULE_RE.findall(text)
    entities = VHDL_ENTITY_RE.findall(text)
    return {
        "path": path,
        "line_count": len(text.splitlines()),
        "module_names": modules,
        "entity_names": entities,
        "assign_count": len(re.findall(r"\bassign\b", text)),
        "always_count": len(re.findall(r"\balways(?:_ff|_comb|_latch)?\b", text)),
        "process_count": len(re.findall(r"\bprocess\b", text, flags=re.IGNORECASE)),
    }


def design_dirs(root: Path) -> list[Path]:
    return [
        path
        for path in sorted(root.iterdir())
        if path.is_dir() and (path / "config.tcl").exists() and rtl_files(path)
    ]


def convert_design(design_dir: Path, out_dir: Path) -> list[dict[str, Any]]:
    config_path = design_dir / "config.tcl"
    config = parse_config(config_path)
    rtl = rtl_files(design_dir)
    parsed = [parse_rtl(path) for path in rtl]
    design_name = design_dir.name
    record_prefix = f"edalearn-{safe_id(design_name)}"
    top = config.get("TOP_NAME", design_name)
    clock = config.get("CLOCK_NAME")
    clk_period = config.get("clk_period")
    language_histogram = Counter(path.suffix.lower().lstrip(".") for path in rtl)
    module_names = sorted({name for item in parsed for name in item["module_names"]})
    entity_names = sorted({name for item in parsed for name in item["entity_names"]})
    rtl_sources = [file_record(path) for path in rtl]
    config_source = file_record(config_path)

    nodes: list[dict[str, Any]] = [
        {
            "id": f"source:{rel(item['path'])}",
            "node_type": "rtl_source_file",
            "language": item["path"].suffix.lower().lstrip("."),
            "line_count": item["line_count"],
            "module_count": len(item["module_names"]),
            "entity_count": len(item["entity_names"]),
            "assign_count": item["assign_count"],
            "always_count": item["always_count"],
            "process_count": item["process_count"],
        }
        for item in parsed
    ]
    edges: list[dict[str, Any]] = []
    for item in parsed:
        source_id = f"source:{rel(item['path'])}"
        for name in item["module_names"]:
            module_id = f"module:{name}"
            nodes.append({"id": module_id, "node_type": "verilog_module", "name": name})
            edges.append({"src": source_id, "dst": module_id, "edge_type": "defines_module"})
        for name in item["entity_names"]:
            entity_id = f"entity:{name}"
            nodes.append({"id": entity_id, "node_type": "vhdl_entity", "name": name})
            edges.append({"src": source_id, "dst": entity_id, "edge_type": "defines_entity"})
    if not edges and len(nodes) > 1:
        for src, dst in zip(nodes, nodes[1:]):
            edges.append(
                {"src": src["id"], "dst": dst["id"], "edge_type": "source_sequence_fallback"}
            )

    metrics = {
        "rtl_file_count": len(rtl),
        "rtl_total_bytes": sum(source["bytes"] for source in rtl_sources),
        "rtl_total_lines": sum(item["line_count"] for item in parsed),
        "verilog_module_count": len(module_names),
        "vhdl_entity_count": len(entity_names),
        "assign_count": sum(item["assign_count"] for item in parsed),
        "always_count": sum(item["always_count"] for item in parsed),
        "process_count": sum(item["process_count"] for item in parsed),
        "graph_node_count": len(nodes),
        "graph_edge_count": len(edges),
        "language_histogram": dict(sorted(language_histogram.items())),
    }
    design_bundle = {
        "schema": "eda.design_bundle.v1",
        "id": f"{record_prefix}-design-bundle",
        "claim_boundary": CLAIM_BOUNDARY,
        "design": {"name": design_name, "revision": PINNED_REVISION, "top_module": top},
        "sources": {
            "rtl": rtl_sources,
            "manifests": ["external/repos/edalearn/manifest.yaml"],
            "configs": [config_source],
        },
        "constraints": {
            "clocks": (
                [{"name": clock, "period": clk_period, "source": rel(config_path)}] if clock else []
            ),
            "resets": [],
        },
        "technology": {
            "node": "edalearn_public_benchmark_config",
            "pdk": "external_edalearn_config_only_no_local_pdk_collateral",
            "flow": "EDALearn",
        },
    }
    graph_sample = {
        "schema": "eda.graph_sample.v1",
        "id": f"{record_prefix}-rtl-graph",
        "design_bundle_id": design_bundle["id"],
        "claim_boundary": CLAIM_BOUNDARY,
        "graph": {
            "node_features": nodes,
            "edge_features": edges,
            "coordinate_system": "edalearn_source_file_module_entity_graph_no_layout_coordinates",
        },
        "labels": {
            "label_status": "public_edalearn_rtl_config_training_only_not_e1_signoff",
            "label_sources": [config_source, *rtl_sources],
            "values": metrics,
        },
        "provenance": {
            "generated_by": "scripts/ai_eda/convert_edalearn_to_internal_records.py",
            "source_records": [config_source, *rtl_sources],
        },
    }
    flow_run = {
        "schema": "eda.flow_run.v1",
        "id": f"{record_prefix}-flow-run",
        "design_bundle_id": design_bundle["id"],
        "claim_boundary": CLAIM_BOUNDARY,
        "toolchain": {
            "tools": ["EDALearn public RTL/config export"],
            "version_capture": "external/repos/edalearn/manifest.yaml",
        },
        "command": "python3 scripts/ai_eda/convert_edalearn_to_internal_records.py --run-id <run-id>",
        "inputs": {"config": config_source, "rtl": rtl_sources},
        "outputs": {"reports": [], "artifacts": [config_source, *rtl_sources]},
        "metrics": metrics,
        "status": {
            "result": "CONVERTED_PUBLIC_EDALEARN_RTL_CONFIG_NOT_REPLAYED",
            "blockers": [
                "public EDALearn RTL/config is not local E1 OpenLane/OpenROAD evidence",
                "external design overlap and license review required before model release",
                "release use requires deterministic E1 replay and signoff checks",
            ],
        },
    }
    records = (design_bundle, graph_sample, flow_run)
    paths = []
    for record in records:
        path = out_dir / f"{record['id']}.json"
        path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        paths.append(path)
    return [
        {
            "design": design_name,
            "schema": record["schema"],
            "json": rel(path),
            "rtl_file_count": metrics["rtl_file_count"],
            "graph_node_count": metrics["graph_node_count"],
            "graph_edge_count": metrics["graph_edge_count"],
        }
        for record, path in zip(records, paths)
    ]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--design-root", type=Path, default=DEFAULT_DESIGN_ROOT)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--sample-limit", type=int, default=8)
    parser.add_argument(
        "--all-records",
        action="store_true",
        help="Convert every discovered design instead of the smoke sample limit.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.all_records and args.sample_limit <= 0:
        raise SystemExit("--sample-limit must be positive")
    if not args.design_root.exists():
        print(f"STATUS: BLOCKED ai_eda.edalearn_conversion missing_design_root {args.design_root}")
        return 2
    designs = design_dirs(args.design_root)
    if not designs:
        print(f"STATUS: BLOCKED ai_eda.edalearn_conversion no_designs {args.design_root}")
        return 2
    selected = designs if args.all_records else designs[: args.sample_limit]
    out_dir = args.out_root / args.run_id / "records"
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("edalearn-*.json"):
        stale.unlink()
    converted: list[dict[str, Any]] = []
    for design_dir in selected:
        converted.extend(convert_design(design_dir, out_dir))
    report = {
        "schema": "eliza.ai_eda.edalearn_conversion_report.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "design_root": rel(args.design_root),
        "available_design_count": len(designs),
        "converted_design_count": len(selected),
        "conversion_mode": "all_records" if args.all_records else "sample_limit",
        "sample_limit": None if args.all_records else args.sample_limit,
        "converted_record_count": len(converted),
        "converted_records": converted,
        "release_use_allowed": False,
    }
    report_path = args.out_root / args.run_id / "conversion_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        "STATUS: PASS ai_eda.edalearn_conversion "
        f"designs={len(selected)} records={len(converted)} report={rel(report_path)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
