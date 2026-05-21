#!/usr/bin/env python3
"""Compute the AlphaChip proxy cost with a fully open, native cost function.

The Circuit Training reward is ``wirelength + 0.5*congestion + 0.5*density``
(``circuit_training.environment.environment.cost_info_function`` with the
default ``congestion_weight=0.5`` and ``density_weight=0.5``). Upstream computes
all three terms inside the closed-source ``plc_wrapper_main`` binary, which the
canonical GCS bucket has served HTTP 403 since February 2026
(``docs/toolchain/alphachip-checkpoint-blocker.md``).

This evaluator instead drives the BSD-3-licensed open reimplementation of the
placement-cost API, ``plc_client_os.PlacementCost`` from the TILOS-AI-Institute
MacroPlacement project, vendored at
``external/repos/tilos-macroplacement/payload/CodeElements/Plc_client``. It reads
the same ``netlist.pb.txt`` topology and ``.plc`` placement that Circuit Training
uses and computes wirelength / congestion / density natively on CPU with no
``plc_wrapper_main`` dependency.

The open client matches the closed binary's wirelength near bit-exactly and its
density within ~1%; the congestion term uses a stochastic fast-router and
diverges by a few percent. When a real ``plc_wrapper_main`` binary is available
(``--plc-wrapper-main`` / ``$PLC_WRAPPER_MAIN``), pass ``--compare-binary`` to
record both costs and their delta in the same evidence file.

Evidence: writes ``eliza.alphachip.open_proxy_cost.v1`` JSON.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
PLC_OS_DIR = ROOT / "external/repos/tilos-macroplacement/payload/CodeElements"

WIRELENGTH_WEIGHT = 1.0
CONGESTION_WEIGHT = 0.5
DENSITY_WEIGHT = 0.5

_PLC_HEADER = {
    "columns": re.compile(r"Columns\s*:\s*([0-9]+)\s+Rows\s*:\s*([0-9]+)"),
    "size": re.compile(r"Width\s*:\s*([0-9.]+)\s+Height\s*:\s*([0-9.]+)"),
    "rpm": re.compile(r"Routes per micron,\s*hor\s*:\s*([0-9.]+)\s+ver\s*:\s*([0-9.]+)"),
    "macro_routes": re.compile(
        r"Routes used by macros,\s*hor\s*:\s*([0-9.]+)\s+ver\s*:\s*([0-9.]+)"
    ),
    "smoothing": re.compile(r"Smoothing factor\s*:\s*([0-9.]+)"),
}


class PlcHeader:
    __slots__ = ("columns", "rows", "width", "height", "rpmh", "rpmv", "marh", "marv", "smooth")

    def __init__(self, text: str) -> None:
        cols = _PLC_HEADER["columns"].search(text)
        size = _PLC_HEADER["size"].search(text)
        rpm = _PLC_HEADER["rpm"].search(text)
        if cols is None or size is None or rpm is None:
            missing = [
                name for name, m in (("columns", cols), ("size", size), ("rpm", rpm)) if m is None
            ]
            raise ValueError(f".plc header missing required fields: {', '.join(missing)}")
        marr = _PLC_HEADER["macro_routes"].search(text)
        smooth = _PLC_HEADER["smoothing"].search(text)
        self.columns = int(cols.group(1))
        self.rows = int(cols.group(2))
        self.width = float(size.group(1))
        self.height = float(size.group(2))
        self.rpmh = float(rpm.group(1))
        self.rpmv = float(rpm.group(2))
        self.marh = float(marr.group(1)) if marr else 0.0
        self.marv = float(marr.group(2)) if marr else 0.0
        self.smooth = float(smooth.group(1)) if smooth else 2.0


def open_proxy_cost(netlist: Path, plc_file: Path, header: PlcHeader) -> dict[str, float]:
    sys.path.insert(0, str(PLC_OS_DIR))
    from Plc_client import plc_client_os as plc_os  # noqa: E402

    plc = plc_os.PlacementCost(str(netlist))
    plc.set_canvas_size(header.width, header.height)
    plc.set_placement_grid(header.columns, header.rows)
    plc.set_routes_per_micron(header.rpmh, header.rpmv)
    plc.set_macro_routing_allocation(header.marh, header.marv)
    plc.set_congestion_smooth_range(header.smooth)
    plc.set_canvas_boundary_check(False)
    plc.restore_placement(str(plc_file))
    wirelength = float(plc.get_cost())
    congestion = float(plc.get_congestion_cost())
    density = float(plc.get_density_cost())
    return {
        "wirelength_cost": wirelength,
        "congestion_cost": congestion,
        "density_cost": density,
        "proxy_cost": WIRELENGTH_WEIGHT * wirelength
        + CONGESTION_WEIGHT * congestion
        + DENSITY_WEIGHT * density,
    }


def binary_proxy_cost(plc_wrapper_main: Path, netlist: Path, plc_file: Path) -> dict[str, float]:
    """Drive the genuine plc_wrapper_main via the upstream CT plc_client.

    Runs in the Circuit Training venv so the closed binary's RPC client is
    importable. Returns the same proxy decomposition for delta comparison.
    """
    driver = (
        "import sys\n"
        "from absl import flags\n"
        "from circuit_training.environment import plc_client, placement_util\n"
        "flags.FLAGS([sys.argv[0], '--plc_wrapper_main=' + sys.argv[1]])\n"
        "plc = placement_util.create_placement_cost(sys.argv[2], sys.argv[3])\n"
        "import json\n"
        "wl, cong, dens = plc.get_cost(), plc.get_congestion_cost(), plc.get_density_cost()\n"
        "print('PROXY_JSON', json.dumps({'wirelength_cost': wl, 'congestion_cost': cong, "
        "'density_cost': dens, 'proxy_cost': wl + 0.5*cong + 0.5*dens}))\n"
    )
    venv_py = ROOT / "external/circuit_training/.venv/bin/python"
    if not venv_py.is_file():
        raise FileNotFoundError(f"Circuit Training venv python missing at {venv_py}")
    env_pythonpath = str(ROOT / "external/circuit_training")
    proc = subprocess.run(
        [str(venv_py), "-c", driver, str(plc_wrapper_main), str(netlist), str(plc_file)],
        capture_output=True,
        text=True,
        env={"PYTHONPATH": env_pythonpath, "TF_CPP_MIN_LOG_LEVEL": "3", "TF_USE_LEGACY_KERAS": "1"},
        timeout=600,
    )
    for line in proc.stdout.splitlines():
        if line.startswith("PROXY_JSON "):
            return json.loads(line[len("PROXY_JSON ") :])
    raise RuntimeError(f"plc_wrapper_main proxy run produced no result:\n{proc.stderr[-2000:]}")


def parse_args() -> argparse.Namespace:
    default_netlist = (
        ROOT
        / "external/circuit_training/circuit_training/environment/test_data/ariane/netlist.pb.txt"
    )
    default_plc = (
        ROOT / "external/circuit_training/circuit_training/environment/test_data/ariane/initial.plc"
    )
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--netlist", type=Path, default=default_netlist)
    parser.add_argument("--plc", type=Path, default=default_plc)
    parser.add_argument("--design", default="ariane")
    parser.add_argument(
        "--out-json",
        type=Path,
        default=ROOT / "build/reports/alphachip/open-proxy-cost.json",
    )
    parser.add_argument(
        "--compare-binary",
        action="store_true",
        help="Also compute the cost with a genuine plc_wrapper_main and record the delta.",
    )
    parser.add_argument(
        "--plc-wrapper-main",
        type=Path,
        default=None,
        help="Path to plc_wrapper_main (defaults to $PLC_WRAPPER_MAIN or the vendored checkpoint).",
    )
    return parser.parse_args()


def resolve_binary(explicit: Path | None) -> Path | None:
    import os

    if explicit is not None:
        # An explicit --plc-wrapper-main is authoritative: do not silently fall
        # back to the vendored binary when the caller named a specific path.
        return explicit if explicit.is_file() else None
    candidates: list[Path] = []
    env = os.environ.get("PLC_WRAPPER_MAIN")
    if env:
        candidates.append(Path(env))
    candidates.append(ROOT / "external/circuit_training/checkpoints/plc_wrapper_main")
    candidates.append(Path("/usr/local/bin/plc_wrapper_main"))
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def main() -> int:
    args = parse_args()
    if not args.netlist.is_file() or not args.plc.is_file():
        print(
            "STATUS: FAIL alphachip.open_proxy_cost missing_inputs "
            f"netlist={rel(args.netlist)} plc={rel(args.plc)}"
        )
        return 1
    if not (PLC_OS_DIR / "Plc_client" / "plc_client_os.py").is_file():
        print(
            "STATUS: FAIL alphachip.open_proxy_cost missing_open_client "
            f"{rel(PLC_OS_DIR / 'Plc_client' / 'plc_client_os.py')}"
        )
        return 1

    header = PlcHeader(args.plc.read_text(encoding="utf-8"))
    started = time.time()
    open_cost = open_proxy_cost(args.netlist, args.plc, header)
    open_elapsed = time.time() - started

    comparison: dict[str, Any] | None = None
    if args.compare_binary:
        binary = resolve_binary(args.plc_wrapper_main)
        if binary is None:
            comparison = {
                "status": "BINARY_UNAVAILABLE",
                "detail": (
                    "plc_wrapper_main not found at --plc-wrapper-main, $PLC_WRAPPER_MAIN, "
                    "external/circuit_training/checkpoints/plc_wrapper_main, or "
                    "/usr/local/bin/plc_wrapper_main. The closed binary is optional here; "
                    "the open client is the authoritative open cost path."
                ),
            }
        else:
            import hashlib

            sha = hashlib.sha256(binary.read_bytes()).hexdigest()
            binary_cost = binary_proxy_cost(binary, args.netlist, args.plc)
            comparison = {
                "status": "COMPARED",
                "plc_wrapper_main": rel(binary),
                "plc_wrapper_main_sha256": sha,
                "binary_cost": binary_cost,
                "delta": {
                    key: open_cost[key] - binary_cost[key]
                    for key in ("wirelength_cost", "congestion_cost", "density_cost", "proxy_cost")
                },
            }

    report = {
        "schema": "eliza.alphachip.open_proxy_cost.v1",
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "design": args.design,
        "netlist": rel(args.netlist),
        "plc": rel(args.plc),
        "open_cost_function": {
            "implementation": "tilos plc_client_os (BSD-3-Clause)",
            "source": rel(PLC_OS_DIR / "Plc_client" / "plc_client_os.py"),
            "requires_plc_wrapper_main": False,
            "weights": {
                "wirelength": WIRELENGTH_WEIGHT,
                "congestion": CONGESTION_WEIGHT,
                "density": DENSITY_WEIGHT,
            },
            "elapsed_seconds": round(open_elapsed, 3),
            **open_cost,
        },
        "binary_comparison": comparison,
        "release_use_allowed": False,
        "claim_boundary": "open_proxy_cost_evidence_only_no_release_or_reproduction_claim",
    }
    args.out_json.parent.mkdir(parents=True, exist_ok=True)
    args.out_json.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")

    print(
        "STATUS: PASS alphachip.open_proxy_cost "
        f"{rel(args.out_json)} proxy={open_cost['proxy_cost']:.6f} "
        f"wl={open_cost['wirelength_cost']:.6f} cong={open_cost['congestion_cost']:.6f} "
        f"dens={open_cost['density_cost']:.6f}"
    )
    if comparison and comparison.get("status") == "COMPARED":
        d = comparison["delta"]
        print(
            "STATUS: PASS alphachip.open_proxy_cost.binary_delta "
            f"d_proxy={d['proxy_cost']:+.6f} d_wl={d['wirelength_cost']:+.6e} "
            f"d_cong={d['congestion_cost']:+.6f} d_dens={d['density_cost']:+.6f}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
