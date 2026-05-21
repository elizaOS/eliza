#!/usr/bin/env python3
"""Export a signoff handoff bundle manifest for a commercial-EDA partner.

This is a SEAM, not an engine. We do not run PrimeTime/Tempus. We assemble a
manifest (`eliza.pd_signoff_handoff.v1`) that points at the exact inputs a
partner needs to reproduce our STA in their tool:

  - the gate netlist
  - the signoff SDC
  - the per-RC-corner SPEF files
  - the Liberty references per delay corner (by basename + node)
  - the MMMC scenario DB (`eliza.pd_mmmc_scenario.v1`)

The bundle records sha256 of every local file so the partner (and our
import-back path) can verify provenance. NDA Liberty/SPEF for advanced nodes
is never embedded; for a blocked node the bundle is emitted with an empty
scenario set and `blocked: true`, naming the foundry/EDA gate that unblocks
it. We never copy or fabricate vendor cell data.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import sta_scenario_db as sdb

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = "eliza.pd_signoff_handoff.v1"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _file_ref(path: Path) -> dict[str, Any]:
    rel = path
    try:
        rel = path.relative_to(ROOT)
    except ValueError:
        rel = path
    return {
        "path": str(rel),
        "sha256": _sha256(path),
        "bytes": path.stat().st_size,
    }


def resolve(value: str) -> Path:
    p = Path(value)
    if not p.is_absolute():
        p = (ROOT / value).resolve()
    return p


def build_handoff(
    *,
    node_id: str,
    netlist: Path,
    sdc: Path,
    spefs: list[Path],
    scenario_db: Path,
) -> dict[str, Any]:
    sset = sdb.build_scenario_set(node_id)

    if sset.blocked:
        return {
            "schema": SCHEMA,
            "node_id": node_id,
            "pdk": sset.pdk,
            "status": sset.status,
            "blocked": True,
            "blocked_reason": sset.blocked_reason,
            "scenario_db": str(scenario_db.relative_to(ROOT))
            if scenario_db.is_relative_to(ROOT)
            else str(scenario_db),
            "design": {},
            "liberty_refs": [],
            "note": (
                "NDA advanced node: no netlist/SDC/SPEF/Liberty embedded. "
                "Bundle unblocks only after foundry + commercial-EDA agreement."
            ),
        }

    missing: list[str] = []
    if not netlist.is_file():
        missing.append(f"netlist {netlist}")
    if not sdc.is_file():
        missing.append(f"sdc {sdc}")
    if not scenario_db.is_file():
        missing.append(f"scenario_db {scenario_db}")
    present_spefs = [s for s in spefs if s.is_file()]
    if not present_spefs:
        missing.append("at least one SPEF")
    if missing:
        raise FileNotFoundError("handoff inputs missing: " + "; ".join(missing))

    # Liberty references are by basename + node; the actual files live in the
    # partner's PDK install. We list them so the partner maps each delay
    # corner to its Liberty, but we do not embed open-PDK Liberty bytes here.
    liberty_refs = sorted(
        {s.delay_corner.liberty for s in sset.scenarios}
    )

    return {
        "schema": SCHEMA,
        "node_id": node_id,
        "pdk": sset.pdk,
        "status": sset.status,
        "blocked": False,
        "blocked_reason": None,
        "scenario_db": _file_ref(scenario_db),
        "scenario_count": len(sset.scenarios),
        "design": {
            "top": "e1_chip_top",
            "netlist": _file_ref(netlist),
            "sdc": _file_ref(sdc),
            "spef": [_file_ref(s) for s in present_spefs],
        },
        "liberty_refs": [
            {"basename": name, "node_id": node_id} for name in liberty_refs
        ],
        "import_back": {
            "schema": "eliza.pd_timing_path.v1",
            "command": (
                "python3 scripts/check_signoff_handoff.py --handoff <bundle> "
                "--import-report <vendor.rpt|json> --source-tool primetime|tempus "
                "--out <paths.json>"
            ),
            "provenance_rule": (
                "import-back verifies the vendor report references THIS bundle "
                "node + top, keeps slack/topology, strips vendor cell internals, "
                "and never synthesizes numbers."
            ),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node-id", default="sky130")
    parser.add_argument("--netlist", help="gate-level netlist (.v)")
    parser.add_argument("--sdc", help="signoff SDC")
    parser.add_argument("--spef", action="append", default=[], help="SPEF (repeatable)")
    parser.add_argument(
        "--scenario-db",
        help="prebuilt scenario DB JSON; if omitted, built next to --out",
    )
    parser.add_argument("--out", required=True, help="write handoff manifest YAML/JSON here")
    args = parser.parse_args()

    out_path = resolve(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    scenario_db_path = (
        resolve(args.scenario_db)
        if args.scenario_db
        else out_path.with_name(f"scenario_db.{args.node_id}.json")
    )

    # Build / refresh the scenario DB next to the bundle so it is self-contained.
    try:
        sset = sdb.build_scenario_set(args.node_id)
    except (FileNotFoundError, ValueError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    if not args.scenario_db:
        scenario_db_path.write_text(
            json.dumps(sdb.scenario_set_to_dict(sset), indent=2, sort_keys=True) + "\n"
        )

    if sset.blocked:
        bundle = build_handoff(
            node_id=args.node_id,
            netlist=Path("/dev/null"),
            sdc=Path("/dev/null"),
            spefs=[],
            scenario_db=scenario_db_path,
        )
        _write_bundle(out_path, bundle)
        print(
            f"BLOCKED: handoff for node '{args.node_id}' emitted empty "
            f"({bundle['blocked_reason']}); manifest: {out_path}"
        )
        return 0

    if not (args.netlist and args.sdc and args.spef):
        print(
            "FAIL: open node requires --netlist, --sdc and at least one --spef",
            file=sys.stderr,
        )
        return 1

    try:
        bundle = build_handoff(
            node_id=args.node_id,
            netlist=resolve(args.netlist),
            sdc=resolve(args.sdc),
            spefs=[resolve(s) for s in args.spef],
            scenario_db=scenario_db_path,
        )
    except FileNotFoundError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1

    _write_bundle(out_path, bundle)
    print(
        f"PASS: signoff handoff for node '{args.node_id}' "
        f"({bundle['scenario_count']} scenarios) written: {out_path}"
    )
    return 0


def _write_bundle(out_path: Path, bundle: dict[str, Any]) -> None:
    if out_path.suffix in (".yaml", ".yml"):
        import yaml

        out_path.write_text(yaml.safe_dump(bundle, sort_keys=True))
    else:
        out_path.write_text(json.dumps(bundle, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
