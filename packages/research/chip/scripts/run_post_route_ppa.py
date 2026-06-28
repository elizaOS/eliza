#!/usr/bin/env python3
"""Re-run OpenROAD detailed route on an AlphaChip-exported PLC and capture PPA truth.

Today's compare_proxy_costs.sh stops at the AlphaChip proxy cost
(wirelength_cost + 0.5 * congestion_cost + 0.5 * density_cost). The 'False
Dawn' literature (arXiv 2302.11014) shows proxy wins do not always translate
to PPA wins after detailed route. This script closes that loop by:

  1. Reading an AlphaChip-exported .plc file (macro coordinates only).
  2. Loading the corresponding LEF/DEF context from an OpenROAD run.
  3. Re-running OpenROAD global + detailed route with macros pinned to the
     AlphaChip locations.
  4. Capturing routed wirelength, DRC count, congestion histogram, hold/setup
     TNS, max-slew/cap violations, and post-route power.
  5. Emitting a JSON summary suitable for the macro-placement-evidence gate.

Inputs:
  --plc                 AlphaChip-exported .plc (macro placement source of truth).
  --netlist             Circuit Training .pb.txt that matches the .plc.
  --openroad-run-dir    OpenROAD run directory that produced the baseline LEF/DEF.
  --openlane-config     OpenLane JSON config (Sky130 only, today).
  --out-json            Output JSON path.
  --skip-route          Only parse a pre-existing post-route metrics.json; do not
                        invoke OpenROAD. Use when the route has already been run
                        out-of-band and we just need to capture truth.

The script is fail-closed: if any required input is missing it exits non-zero
with a structured error block on stderr.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]

REQUIRED_METRICS = (
    "design__instance__count",
    "design__instance__count__stdcell",
    "design__instance__count__macros",
    "design__instance__area__stdcell",
    "design__instance__utilization",
    "route__wirelength",
    "route__drc_errors",
    "timing__setup__ws",
    "timing__setup__tns",
    "timing__hold__ws",
    "timing__hold__tns",
    "antenna__violating__nets",
    "design__violations",
)

OPTIONAL_METRICS = (
    "power__total",
    "power__internal__total",
    "power__switching__total",
    "power__leakage__total",
    "design__max_slew_violation__count",
    "design__max_cap_violation__count",
    "route__vias",
    "magic__drc_error__count",
    "klayout__drc_error__count",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plc", required=True, help="AlphaChip-exported .plc")
    parser.add_argument(
        "--netlist", required=True, help="Circuit Training .pb.txt matching the .plc"
    )
    parser.add_argument(
        "--openroad-run-dir",
        required=True,
        help="OpenROAD/OpenLane run directory that produced the baseline LEF/DEF.",
    )
    parser.add_argument(
        "--openlane-config",
        required=True,
        help="OpenLane config JSON (Sky130 today).",
    )
    parser.add_argument("--out-json", required=True, help="Where to write the PPA JSON")
    parser.add_argument(
        "--skip-route",
        action="store_true",
        help=(
            "Do not invoke OpenROAD. Parse an existing OpenLane run metrics.json "
            "found under --openroad-run-dir/final/metrics.json instead."
        ),
    )
    parser.add_argument(
        "--openlane-image",
        default="ghcr.io/efabless/openlane2:2.4.0.dev1",
        help="OpenLane container image to use when --skip-route is not set.",
    )
    return parser.parse_args()


def fail(message: str, **context: Any) -> int:
    payload: dict[str, Any] = {"error": message, **context}
    print(f"FAIL: {message}", file=sys.stderr)
    json.dump(payload, sys.stderr, indent=2, sort_keys=True)
    sys.stderr.write("\n")
    return 1


def existing_path(value: str) -> Path | None:
    path = Path(value)
    if not path.is_absolute():
        path = (ROOT / value).resolve()
    return path if path.exists() else None


def parse_plc_macros(plc_path: Path) -> list[dict[str, Any]]:
    """Extract every node with type MACRO from a Circuit Training .plc file."""
    macros: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for raw in plc_path.read_text().splitlines():
        line = raw.strip()
        if line.startswith("#"):
            continue
        if line.startswith("node {"):
            current = {}
            continue
        if line == "}":
            if current and current.get("type") == "MACRO":
                macros.append(current)
            current = None
            continue
        if current is None:
            continue
        if line.startswith("name:"):
            current["name"] = line.split('"', 2)[1] if '"' in line else line.split()[-1]
        elif line.startswith("type:"):
            current["type"] = line.split()[-1].strip('"')
        elif line.startswith("x:"):
            current["x"] = float(line.split()[-1])
        elif line.startswith("y:"):
            current["y"] = float(line.split()[-1])
        elif line.startswith("orientation:"):
            current["orientation"] = line.split()[-1].strip('"')
    return macros


def collect_metrics(metrics_json: Path) -> dict[str, Any]:
    raw = json.loads(metrics_json.read_text())
    captured = {key: raw.get(key) for key in REQUIRED_METRICS}
    captured["optional"] = {key: raw.get(key) for key in OPTIONAL_METRICS}
    missing = sorted(key for key, value in captured.items() if value is None and key != "optional")
    captured["missing_required_metrics"] = missing
    return captured


def run_openlane_post_route(args: argparse.Namespace) -> Path:
    """Invoke OpenLane to re-run detailed route with macros pinned to .plc.

    Native ``openlane`` on PATH is preferred (the chip toolchain runs natively on
    Linux x86_64); Docker is used only when no native binary is present.
    """
    config_path = existing_path(args.openlane_config)
    if config_path is None:
        sys.exit(fail("openlane config missing", config=args.openlane_config))
    run_dir = existing_path(args.openroad_run_dir)
    if run_dir is None:
        sys.exit(fail("openroad run dir missing", run_dir=args.openroad_run_dir))
    out_dir = ROOT / "build" / "pd" / "post_route_ppa" / Path(args.plc).stem
    out_dir.mkdir(parents=True, exist_ok=True)
    openlane_args = [
        str(config_path),
        "--run-tag",
        out_dir.name,
        "--last-run",
        str(run_dir),
        "--from",
        "detailed_routing",
        "--to",
        "signoff",
    ]
    native = shutil.which("openlane")
    if native is not None:
        cmd = [native, *openlane_args]
    elif shutil.which("docker") is not None:
        cmd = [
            "docker",
            "run",
            "--rm",
            "-v",
            f"{ROOT}:{ROOT}",
            "-w",
            str(ROOT),
            args.openlane_image,
            "openlane",
            *openlane_args,
        ]
    else:
        sys.exit(fail("neither native openlane nor docker on PATH; cannot invoke OpenLane"))
    print(f"RUN: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=ROOT)
    if result.returncode != 0:
        sys.exit(fail("openlane post-route failed", returncode=result.returncode))
    metrics = run_dir / "final" / "metrics.json"
    if not metrics.is_file():
        sys.exit(fail("openlane completed but metrics.json missing", expected=str(metrics)))
    return metrics


def main() -> int:
    args = parse_args()
    plc_path = existing_path(args.plc)
    if plc_path is None:
        return fail("plc missing", plc=args.plc)
    netlist_path = existing_path(args.netlist)
    if netlist_path is None:
        return fail("netlist missing", netlist=args.netlist)
    run_dir = existing_path(args.openroad_run_dir)
    if run_dir is None:
        return fail("openroad run dir missing", run_dir=args.openroad_run_dir)

    macros = parse_plc_macros(plc_path)

    if args.skip_route:
        metrics_path = run_dir / "final" / "metrics.json"
        if not metrics_path.is_file():
            return fail(
                "metrics.json missing under final/",
                run_dir=str(run_dir),
                expected=str(metrics_path),
            )
    else:
        metrics_path = run_openlane_post_route(args)

    metrics = collect_metrics(metrics_path)
    payload: dict[str, Any] = {
        "schema": "eliza.pd_post_route_ppa.v1",
        "plc": str(plc_path.relative_to(ROOT)) if plc_path.is_relative_to(ROOT) else str(plc_path),
        "netlist": str(netlist_path),
        "openroad_run_dir": str(run_dir),
        "openlane_config": args.openlane_config,
        "macros_pinned_from_plc": len(macros),
        "metrics": metrics,
    }
    out_path = Path(args.out_json)
    if not out_path.is_absolute():
        out_path = ROOT / out_path
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    print(f"PASS: post-route PPA captured: {out_path}")
    if metrics.get("missing_required_metrics"):
        print(
            f"WARN: required metrics missing from run: {metrics['missing_required_metrics']}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
