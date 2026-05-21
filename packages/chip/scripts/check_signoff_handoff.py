#!/usr/bin/env python3
"""Validate a signoff handoff bundle and import vendor reports back.

Two modes:

  1. Validate (default): load the `eliza.pd_signoff_handoff.v1` manifest, check
     the schema, and verify provenance — every referenced local file exists and
     its sha256 matches what the bundle recorded. A blocked (NDA) bundle is
     accepted as a valid empty bundle and reported as BLOCKED, not FAIL.

  2. Import-back (--import-report): ingest a PrimeTime/Tempus report (.rpt text
     or .json) for THIS bundle into the canonical `eliza.pd_timing_path.v1`
     schema. The importer VERIFIES PROVENANCE (the vendor report must name the
     bundle's top design) and NEVER synthesizes numbers. It is redaction-safe:
     it keeps startpoint/endpoint/slack/path topology and strips vendor cell
     internals (only the stage pin + an optional cell-class label survive).

Fail-closed: a missing file, sha mismatch, wrong schema, or a vendor report
that does not reference this bundle's top design exits non-zero. We never fill
in a slack we could not read from the report.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import normalize_timing_paths as ntp
import yaml

ROOT = Path(__file__).resolve().parents[1]
HANDOFF_SCHEMA = "eliza.pd_signoff_handoff.v1"
SUPPORTED_VENDORS = frozenset({"primetime", "tempus"})


def resolve(value: str) -> Path:
    p = Path(value)
    if not p.is_absolute():
        p = (ROOT / value).resolve()
    return p


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _load_bundle(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(f"handoff bundle missing: {path}")
    text = path.read_text()
    payload = yaml.safe_load(text) if path.suffix in (".yaml", ".yml") else json.loads(text)
    if not isinstance(payload, dict):
        raise ValueError(f"handoff bundle is not a mapping: {path}")
    if payload.get("schema") != HANDOFF_SCHEMA:
        raise ValueError(
            f"handoff bundle has schema '{payload.get('schema')}'; expected {HANDOFF_SCHEMA}"
        )
    return payload


def _verify_file_ref(ref: dict[str, Any], errors: list[str]) -> None:
    path = resolve(str(ref["path"]))
    if not path.is_file():
        errors.append(f"referenced file missing: {ref['path']}")
        return
    actual = _sha256(path)
    if actual != ref.get("sha256"):
        errors.append(
            f"sha256 mismatch for {ref['path']}: bundle={ref.get('sha256')} actual={actual}"
        )


def validate_bundle(bundle: dict[str, Any]) -> tuple[bool, list[str]]:
    """Return (is_blocked, errors)."""
    if bundle.get("blocked"):
        return True, []
    errors: list[str] = []
    design = bundle.get("design", {})
    if not isinstance(design, dict) or not design:
        errors.append("open bundle has no design section")
        return False, errors
    for key in ("netlist", "sdc"):
        ref = design.get(key)
        if not isinstance(ref, dict):
            errors.append(f"design.{key} missing or not a file ref")
            continue
        _verify_file_ref(ref, errors)
    spefs = design.get("spef", [])
    if not isinstance(spefs, list) or not spefs:
        errors.append("design.spef must be a non-empty list")
    else:
        for ref in spefs:
            _verify_file_ref(ref, errors)
    sdb_ref = bundle.get("scenario_db")
    if isinstance(sdb_ref, dict):
        _verify_file_ref(sdb_ref, errors)
    else:
        errors.append("scenario_db file ref missing")
    if not bundle.get("liberty_refs"):
        errors.append("liberty_refs is empty for an open node")
    return False, errors


def _strip_to_redaction_safe(path: dict[str, Any]) -> dict[str, Any]:
    """Keep slack/topology; strip vendor cell internals from each stage.

    A stage keeps its pin and edge but the cell field is collapsed to a
    coarse class label (the substring before the first '/' or '__') so we do
    not republish a partner's proprietary cell names verbatim.
    """
    safe_stages = []
    for stage in path.get("stages", []):
        cell = str(stage.get("cell", ""))
        cell_class = cell.split("__", 1)[0].split("/", 1)[0] if cell else ""
        safe_stages.append(
            {
                "pin": stage.get("pin"),
                "cell_class": cell_class,
                "edge": stage.get("edge"),
                "delay": stage.get("delay"),
                "time": stage.get("time"),
            }
        )
    return {
        "startpoint": path["startpoint"],
        "endpoint": path["endpoint"],
        "path_group": path.get("path_group", ""),
        "path_type": path["path_type"],
        "slack": path["slack"],
        "met": path["met"],
        "arrival": path.get("arrival"),
        "required": path.get("required"),
        "stages": safe_stages,
    }


def _import_vendor_json(text: str) -> tuple[list[dict[str, Any]], list[str]]:
    """Ingest a vendor JSON timing dump.

    The vendor JSON must already be a list of path records carrying at least
    startpoint/endpoint/path_type/slack. We do not invent any of these — a
    record missing a required field is dropped with a warning.
    """
    warnings: list[str] = []
    payload = json.loads(text)
    records = payload.get("paths") if isinstance(payload, dict) else payload
    if not isinstance(records, list):
        raise ValueError("vendor JSON must be a list of paths or {paths: [...]}")
    out: list[dict[str, Any]] = []
    required = ("startpoint", "endpoint", "path_type", "slack")
    for rec in records:
        if not isinstance(rec, dict) or any(k not in rec for k in required):
            warnings.append(f"dropped vendor record missing required fields: {rec}")
            continue
        out.append(
            {
                "startpoint": str(rec["startpoint"]),
                "endpoint": str(rec["endpoint"]),
                "path_group": str(rec.get("path_group", "")),
                "path_type": str(rec["path_type"]),
                "slack": float(rec["slack"]),
                "met": bool(rec.get("met", float(rec["slack"]) >= 0.0)),
                "arrival": rec.get("arrival"),
                "required": rec.get("required"),
                "stages": rec.get("stages", []),
            }
        )
    return out, warnings


def import_back(
    bundle: dict[str, Any],
    report_path: Path,
    source_tool: str,
) -> dict[str, Any]:
    if source_tool not in SUPPORTED_VENDORS:
        raise ValueError(
            f"unsupported source tool '{source_tool}'; one of {sorted(SUPPORTED_VENDORS)}"
        )
    if bundle.get("blocked"):
        raise ValueError(
            "cannot import vendor report against a blocked (NDA) handoff bundle"
        )
    if not report_path.is_file():
        raise FileNotFoundError(f"vendor report missing: {report_path}")

    top = str(bundle.get("design", {}).get("top", ""))
    text = report_path.read_text()

    # Provenance: the vendor report must reference this bundle's top design.
    if top and top not in text:
        raise ValueError(
            f"provenance check failed: vendor report does not reference top '{top}'. "
            "Refusing to import paths that cannot be tied to this handoff bundle."
        )

    if report_path.suffix == ".json":
        raw_paths, warnings = _import_vendor_json(text)
    else:
        parsed, warnings = ntp.parse_report(text)
        raw_paths = [
            {
                "startpoint": p.startpoint,
                "endpoint": p.endpoint,
                "path_group": p.path_group,
                "path_type": p.path_type,
                "slack": p.slack,
                "met": p.met,
                "arrival": p.arrival,
                "required": p.required,
                "stages": [
                    {"pin": s.pin, "cell": s.cell, "edge": s.edge, "delay": s.delay, "time": s.time}
                    for s in p.stages
                ],
            }
            for p in parsed
        ]

    safe = [_strip_to_redaction_safe(p) for p in raw_paths]
    return {
        "schema": ntp.SCHEMA,
        "source_tool": source_tool,
        "source_report": str(report_path),
        "handoff_node_id": bundle.get("node_id"),
        "handoff_top": top,
        "provenance_verified": True,
        "redaction_safe": True,
        "path_count": len(safe),
        "parse_warnings": warnings,
        "paths": safe,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--handoff", required=True, help="handoff bundle manifest")
    parser.add_argument("--import-report", help="vendor .rpt/.json to import back")
    parser.add_argument("--source-tool", default="primetime")
    parser.add_argument("--out", help="write imported eliza.pd_timing_path.v1 JSON here")
    args = parser.parse_args()

    try:
        bundle = _load_bundle(resolve(args.handoff))
    except (FileNotFoundError, ValueError, json.JSONDecodeError, yaml.YAMLError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1

    if args.import_report:
        try:
            result = import_back(bundle, resolve(args.import_report), args.source_tool)
        except (FileNotFoundError, ValueError, json.JSONDecodeError) as exc:
            print(f"FAIL: {exc}", file=sys.stderr)
            return 1
        text = json.dumps(result, indent=2, sort_keys=True) + "\n"
        if args.out:
            out_path = resolve(args.out)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(text)
            print(
                f"PASS: imported {result['path_count']} {args.source_tool} paths "
                f"into {ntp.SCHEMA}: {out_path}"
            )
        else:
            sys.stdout.write(text)
        return 0

    blocked, errors = validate_bundle(bundle)
    if blocked:
        print(
            f"BLOCKED: handoff bundle for node '{bundle.get('node_id')}' is empty "
            f"({bundle.get('blocked_reason')})"
        )
        return 2
    if errors:
        print(f"FAIL: handoff bundle invalid ({len(errors)} problems):", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    print(
        f"PASS: handoff bundle for node '{bundle.get('node_id')}' valid "
        f"({bundle.get('scenario_count')} scenarios, provenance verified)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
