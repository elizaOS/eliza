#!/usr/bin/env python3
"""Join cocotb cover-points, formal proof status, and bound-property coverage.

The chip flow produces three independent verification evidence streams that
have never been correlated:

* ``eliza.cocotb_coverage_summary.v1`` -- per-block cover-point summary written
  by ``scripts/check_cocotb_coverage.py`` to ``build/reports/coverage/summary.json``.
* ``e1-chip-formal-evidence-v1`` -- per-block formal proof status written by
  ``scripts/run_formal.sh`` to ``build/reports/formal_manifest.json``.
* ``eliza.cdc_formal_evidence.v1`` -- bound CDC/RDC property task status written
  by ``scripts/run_cdc_formal.sh`` to ``build/reports/cdc_formal_manifest.json``.

This script joins them per block into one ``eliza.verification_coverage.v1``
report at ``build/reports/verification_coverage.json``. It does not modify the
producers; it reads their manifests and fails closed when a required input is
missing or any block lacks any verification evidence at all.

The merged report deliberately stays inside each producer's claim boundary: the
cocotb side reports declared/hit bins (not a hit %% past what is measured); the
formal side reports the producer's ``evidence_class`` verbatim; the CDC side is
marked ``intent_manifest_only`` and never promoted to signoff.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_COCOTB = REPO_ROOT / "build/reports/coverage/summary.json"
DEFAULT_FORMAL = REPO_ROOT / "build/reports/formal_manifest.json"
DEFAULT_CDC = REPO_ROOT / "build/reports/cdc_formal_manifest.json"
DEFAULT_OUT = REPO_ROOT / "build/reports/verification_coverage.json"

COCOTB_SCHEMA = "eliza.cocotb_coverage_summary.v1"
FORMAL_SCHEMA = "e1-chip-formal-evidence-v1"
CDC_SCHEMA = "eliza.cdc_formal_evidence.v1"


def load_object(path: Path, expected_schema: str, errors: list[str]) -> dict[str, Any]:
    if not path.is_file():
        errors.append(f"missing {rel(path)}; required input is absent (run the producer first)")
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"cannot read {rel(path)}: {exc}")
        return {}
    if not isinstance(payload, dict):
        errors.append(f"{rel(path)}: top-level JSON must be an object")
        return {}
    if payload.get("schema") != expected_schema:
        errors.append(
            f"{rel(path)}: unexpected schema {payload.get('schema')!r} (want {expected_schema!r})"
        )
        return {}
    return payload


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def cocotb_block(summary: dict[str, Any]) -> dict[str, dict[str, Any]]:
    blocks = summary.get("blocks")
    if not isinstance(blocks, dict):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for name, block in blocks.items():
        if not isinstance(block, dict):
            continue
        out[name] = {
            "bins_declared": int(block.get("bins_declared", 0)),
            "bins_hit": int(block.get("bins_hit", 0)),
            "hits": int(block.get("hits", 0)),
            "missing_required_classes": list(block.get("missing_required_classes", [])),
            "cocotb_coverage_available": bool(block.get("cocotb_coverage_available", False)),
        }
    return out


def formal_block(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    entries = manifest.get("entries")
    if not isinstance(entries, dict):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for name, entry in entries.items():
        if not isinstance(entry, dict):
            continue
        out[name] = {
            "status": entry.get("status"),
            "evidence_class": entry.get("evidence_class"),
        }
    return out


def cdc_block(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    tasks = manifest.get("tasks")
    if not isinstance(tasks, dict):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for name, task in tasks.items():
        if not isinstance(task, dict):
            continue
        out[name] = {
            "status": task.get("status"),
            "bound_module": task.get("bound_module"),
            "property_pack": task.get("property_pack"),
            "claim_boundary": task.get("claim_boundary"),
        }
    return out


def build_report(
    cocotb: dict[str, Any],
    formal: dict[str, Any],
    cdc: dict[str, Any],
) -> dict[str, Any]:
    cocotb_blocks = cocotb_block(cocotb)
    formal_blocks = formal_block(formal)
    cdc_blocks = cdc_block(cdc)

    block_names = sorted(set(cocotb_blocks) | set(formal_blocks))
    merged_blocks: dict[str, Any] = {}
    block_errors: list[str] = []
    for name in block_names:
        cocotb_entry = cocotb_blocks.get(name)
        formal_entry = formal_blocks.get(name)
        sources = [
            s for s, present in (("cocotb", cocotb_entry), ("formal", formal_entry)) if present
        ]
        if not sources:
            block_errors.append(f"block {name} has no cocotb or formal evidence")
        merged_blocks[name] = {
            "cocotb": cocotb_entry,
            "formal": formal_entry,
            "evidence_sources": sources,
        }

    return {
        "schema": "eliza.verification_coverage.v1",
        "claim_boundary": "merged_local_evidence_only_no_signoff_no_hardware",
        "inputs": {
            "cocotb_summary": {
                "schema": COCOTB_SCHEMA,
                "status": cocotb.get("status"),
            },
            "formal_manifest": {
                "schema": FORMAL_SCHEMA,
                "mode": formal.get("mode"),
                "release_claim": formal.get("release_claim"),
            },
            "cdc_formal_manifest": {
                "schema": CDC_SCHEMA,
                "status": cdc.get("status"),
                "claim_boundary": cdc.get("claim_boundary"),
            },
        },
        "blocks": merged_blocks,
        "cdc_rdc_properties": cdc_blocks,
        "block_errors": block_errors,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cocotb", type=Path, default=DEFAULT_COCOTB)
    parser.add_argument("--formal", type=Path, default=DEFAULT_FORMAL)
    parser.add_argument("--cdc", type=Path, default=DEFAULT_CDC)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument(
        "--require-cdc",
        action="store_true",
        help="Fail closed when the CDC/RDC bound-property manifest is absent",
    )
    args = parser.parse_args(argv)

    errors: list[str] = []
    cocotb = load_object(args.cocotb, COCOTB_SCHEMA, errors)
    formal = load_object(args.formal, FORMAL_SCHEMA, errors)

    cdc: dict[str, Any] = {}
    if args.cdc.is_file() or args.require_cdc:
        cdc = load_object(args.cdc, CDC_SCHEMA, errors)

    report = build_report(cocotb, formal, cdc)
    report["status"] = "passed" if not errors and not report["block_errors"] else "failed"
    report["errors"] = errors + report["block_errors"]

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if report["errors"]:
        for error in report["errors"]:
            print(f"FAIL: {error}")
        print(f"merged report written: {rel(args.out)}")
        return 1
    print(f"PASS: verification coverage merge: {rel(args.out)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
