#!/usr/bin/env python3
"""Merge per-block cocotb cover-point JSON into one summary and fail closed.

This script consumes the JSON files produced by ``verify/cocotb/test_e1_*``
under ``build/reports/coverage/<block>.json`` (see
``verify/cocotb/coverage_helpers.py``) and emits a merged summary at
``build/reports/coverage/summary.json``. It fails closed when any required
cover-point class is missing for a block we expect to have coverage for.

Required cover-point classes per block are intentionally narrow so the merge
step matches the implemented test coverage and surfaces real regressions:

- ``npu``     : ``opcode``, ``axi_resp``
- ``dma``     : ``axi_resp``, ``irq_vector``
- ``soc``     : ``mmio_region``, ``irq_vector``
- ``chip``    : ``mmio_region``, ``irq_vector``
- ``display`` : ``mmio_region``
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_COVERAGE_DIR = REPO_ROOT / "build/reports/coverage"

REQUIRED_CLASSES: dict[str, frozenset[str]] = {
    "npu": frozenset({"opcode", "axi_resp"}),
    "dma": frozenset({"axi_resp", "irq_vector"}),
    "soc": frozenset({"mmio_region", "irq_vector"}),
    "chip": frozenset({"mmio_region", "irq_vector"}),
    "display": frozenset({"mmio_region"}),
}

EXPECTED_BLOCKS = frozenset(REQUIRED_CLASSES)


def load_block(path: Path) -> dict[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"FAIL: cannot read {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise SystemExit(f"FAIL: {path}: top-level JSON must be an object")
    if payload.get("schema") != "eliza.cocotb_coverage.v1":
        raise SystemExit(f"FAIL: {path}: unexpected schema {payload.get('schema')!r}")
    if not isinstance(payload.get("classes"), dict):
        raise SystemExit(f"FAIL: {path}: missing 'classes' dict")
    return payload


def block_summary(block: str, payload: dict[str, object]) -> dict[str, object]:
    classes_in = payload.get("classes", {})
    assert isinstance(classes_in, dict)
    classes_out: dict[str, dict[str, object]] = {}
    total_hits = 0
    total_bins_hit = 0
    total_bins_declared = 0
    for class_name, points in classes_in.items():
        if not isinstance(points, dict):
            raise SystemExit(f"FAIL: {block}: class {class_name} must be a dict")
        class_hits = 0
        class_bins_hit = 0
        class_bins_declared = 0
        point_entries: dict[str, dict[str, object]] = {}
        for point_name, entry in points.items():
            if not isinstance(entry, dict):
                raise SystemExit(f"FAIL: {block}.{class_name}.{point_name} must be a dict")
            hits = int(entry.get("hits", 0))
            unique_bins = int(entry.get("unique_bins", 0))
            declared = list(entry.get("declared_bins", []))
            class_hits += hits
            class_bins_hit += unique_bins
            class_bins_declared += len(declared)
            point_entries[point_name] = {
                "hits": hits,
                "unique_bins": unique_bins,
                "declared_bins": declared,
                "uncovered_bins": sorted(
                    set(str(b) for b in declared) - set(str(b) for b in entry.get("bins", {}))
                ),
            }
        classes_out[class_name] = {
            "points": point_entries,
            "hits": class_hits,
            "bins_hit": class_bins_hit,
            "bins_declared": class_bins_declared,
        }
        total_hits += class_hits
        total_bins_hit += class_bins_hit
        total_bins_declared += class_bins_declared
    required = REQUIRED_CLASSES.get(block, frozenset())
    missing = sorted(required - set(classes_out))
    return {
        "block": block,
        "classes": classes_out,
        "required_classes": sorted(required),
        "missing_required_classes": missing,
        "hits": total_hits,
        "bins_hit": total_bins_hit,
        "bins_declared": total_bins_declared,
        "cocotb_coverage_available": bool(payload.get("cocotb_coverage_available", False)),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--coverage-dir",
        type=Path,
        default=DEFAULT_COVERAGE_DIR,
        help="Directory holding per-block coverage JSON files",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output path for merged summary (default <coverage-dir>/summary.json)",
    )
    parser.add_argument(
        "--require-blocks",
        action="store_true",
        help="Fail closed if any expected block JSON is absent",
    )
    args = parser.parse_args(argv)

    coverage_dir = args.coverage_dir
    summary_path = args.out or (coverage_dir / "summary.json")

    if not coverage_dir.is_dir():
        print(
            f"FAIL: coverage directory {coverage_dir} missing; "
            "run `make cocotb-coverage` to populate it"
        )
        return 1

    block_summaries: dict[str, dict[str, object]] = {}
    block_files: dict[str, str] = {}
    for json_path in sorted(coverage_dir.glob("*.json")):
        if json_path.name == "summary.json":
            continue
        block = json_path.stem
        payload = load_block(json_path)
        if payload.get("block") != block:
            print(f"FAIL: {json_path}: block field {payload.get('block')!r} != filename {block!r}")
            return 1
        block_summaries[block] = block_summary(block, payload)
        try:
            block_files[block] = str(json_path.relative_to(REPO_ROOT))
        except ValueError:
            block_files[block] = str(json_path)

    errors: list[str] = []
    for block, summary in block_summaries.items():
        missing = summary.get("missing_required_classes", [])
        if isinstance(missing, list) and missing:
            errors.append(
                f"block {block} missing required cover-point classes: {', '.join(missing)}"
            )

    if args.require_blocks:
        for block in sorted(EXPECTED_BLOCKS):
            if block not in block_summaries:
                errors.append(f"block {block} has no coverage JSON under {coverage_dir}")

    try:
        coverage_dir_rel = str(coverage_dir.relative_to(REPO_ROOT))
    except ValueError:
        coverage_dir_rel = str(coverage_dir)
    merged = {
        "schema": "eliza.cocotb_coverage_summary.v1",
        "coverage_dir": coverage_dir_rel,
        "expected_blocks": sorted(EXPECTED_BLOCKS),
        "required_classes": {block: sorted(classes) for block, classes in REQUIRED_CLASSES.items()},
        "blocks": block_summaries,
        "block_files": block_files,
        "status": "passed" if not errors else "failed",
        "errors": errors,
    }
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(merged, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        print(f"summary written: {summary_path}")
        return 1
    print(f"PASS: cocotb coverage merge: {summary_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
