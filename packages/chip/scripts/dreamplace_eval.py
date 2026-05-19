#!/usr/bin/env python3
"""DREAMPlace 4.0 evaluation harness.

DREAMPlace is a GPU-accelerated analytical placer (Lin/Pan et al., DAC 2019;
DREAMPlace 4.0 adds full-flow placement with macro placement and detailed
placement). On the largest ICCAD'15 benchmarks 4.0 achieves a 30x speedup
over CPU placers without requiring reinforcement learning. We evaluate it as
a no-RL-training-cost alternative to AlphaChip on the same e1 benchmark.

Inputs:
  --bench-dir          Directory containing the Circuit Training benchmark.
                       Must hold *.pb.txt netlist plus *.openroad.plc.
  --out-dir            Where to write DREAMPlace logs and the final .plc.
  --dreamplace-repo    Path to the DREAMPlace checkout (use scripts/alphachip/
                       build_dreamplace_from_source.sh to obtain it).
  --use-gpu            Force GPU placement (default: GPU if CUDA visible).
  --num-bins-x         X bin count for analytical placement (default 512).
  --num-bins-y         Y bin count for analytical placement (default 512).

Outputs (under --out-dir):
  dreamplace.params.json     fully-resolved Params JSON (DREAMPlace input).
  dreamplace.log             tool log.
  dreamplace.placement.plc   final placement in Circuit Training .plc format.
  dreamplace_eval.json       proxy metrics + comparison to OpenROAD baseline.

This script does the I/O glue. The actual placement runs in the DREAMPlace
Docker image built by scripts/alphachip/build_dreamplace_from_source.sh.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bench-dir", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--dreamplace-repo", default="external/DREAMPlace")
    parser.add_argument(
        "--dreamplace-image",
        default="circuit_training:dreamplace_build",
        help="Image built by scripts/alphachip/build_dreamplace_from_source.sh.",
    )
    parser.add_argument("--use-gpu", action="store_true")
    parser.add_argument("--num-bins-x", type=int, default=512)
    parser.add_argument("--num-bins-y", type=int, default=512)
    parser.add_argument(
        "--baseline-plc",
        help="OpenROAD baseline .plc for proxy comparison.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Emit the params JSON and exit without invoking DREAMPlace.",
    )
    return parser.parse_args()


def fail(message: str, **context: Any) -> int:
    payload = {"error": message, **context}
    print(f"FAIL: {message}", file=sys.stderr)
    json.dump(payload, sys.stderr, indent=2, sort_keys=True)
    sys.stderr.write("\n")
    return 1


def resolve(value: str) -> Path:
    p = Path(value)
    if not p.is_absolute():
        p = (ROOT / value).resolve()
    return p


def make_params(args: argparse.Namespace, bench_dir: Path, out_dir: Path) -> dict[str, Any]:
    netlist = next(bench_dir.glob("*.pb.txt"), None)
    init_plc = next(bench_dir.glob("*.openroad.plc"), None)
    if netlist is None:
        raise FileNotFoundError(f"no *.pb.txt in {bench_dir}")
    if init_plc is None:
        raise FileNotFoundError(f"no *.openroad.plc in {bench_dir}")
    use_gpu = args.use_gpu or bool(os.environ.get("CUDA_VISIBLE_DEVICES"))
    return {
        "aux_input": str(netlist),
        "init_placement": str(init_plc),
        "result_dir": str(out_dir),
        "global_place_flag": 1,
        "legalize_flag": 1,
        "detailed_place_flag": 1,
        "macro_place_flag": 1,
        "num_bins_x": args.num_bins_x,
        "num_bins_y": args.num_bins_y,
        "gpu": 1 if use_gpu else 0,
        "deterministic_flag": 1,
        "random_seed": int(os.environ.get("DREAMPLACE_SEED", "1337")),
    }


def parse_dreamplace_log(log_path: Path) -> dict[str, Any]:
    """Pull HPWL/runtime/iteration metrics from a DREAMPlace log."""
    metrics: dict[str, Any] = {
        "hpwl_initial": None,
        "hpwl_final": None,
        "overflow_final": None,
        "global_place_runtime_s": None,
        "detailed_place_runtime_s": None,
        "macro_place_runtime_s": None,
        "total_runtime_s": None,
    }
    if not log_path.is_file():
        return metrics
    for raw in log_path.read_text().splitlines():
        line = raw.strip()
        if "Initial HPWL" in line:
            metrics["hpwl_initial"] = _last_float(line)
        elif "Final HPWL" in line:
            metrics["hpwl_final"] = _last_float(line)
        elif "Final overflow" in line or "Overflow" in line and "final" in line.lower():
            metrics["overflow_final"] = _last_float(line)
        elif "Global placement takes" in line:
            metrics["global_place_runtime_s"] = _last_float(line)
        elif "Detailed placement takes" in line:
            metrics["detailed_place_runtime_s"] = _last_float(line)
        elif "Macro placement takes" in line:
            metrics["macro_place_runtime_s"] = _last_float(line)
        elif "Total time" in line:
            metrics["total_runtime_s"] = _last_float(line)
    return metrics


def _last_float(line: str) -> float | None:
    for token in reversed(line.replace(",", " ").split()):
        try:
            return float(token)
        except ValueError:
            continue
    return None


def run_dreamplace(args: argparse.Namespace, params_path: Path, out_dir: Path) -> int:
    if shutil.which("docker") is None:
        return fail("docker not on PATH; cannot invoke DREAMPlace")
    repo = resolve(args.dreamplace_repo)
    if not repo.is_dir():
        return fail("DREAMPlace repo missing", dreamplace_repo=str(repo))
    cmd = [
        "docker",
        "run",
        "--rm",
    ]
    if args.use_gpu:
        cmd += ["--gpus", "all"]
    cmd += [
        "-v",
        f"{ROOT}:{ROOT}",
        "-v",
        f"{repo}:/dreamplace",
        "-w",
        str(repo),
        args.dreamplace_image,
        "python3.9",
        "dreamplace/Placer.py",
        str(params_path),
    ]
    log_path = out_dir / "dreamplace.log"
    print(f"RUN: {' '.join(cmd)}")
    with log_path.open("w") as fh:
        proc = subprocess.run(cmd, cwd=ROOT, stdout=fh, stderr=subprocess.STDOUT, check=False)
    if proc.returncode != 0:
        return fail("DREAMPlace exited non-zero", returncode=proc.returncode, log=str(log_path))
    return 0


def main() -> int:
    args = parse_args()
    bench_dir = resolve(args.bench_dir)
    out_dir = resolve(args.out_dir)
    if not bench_dir.is_dir():
        return fail("bench dir missing", bench_dir=str(bench_dir))
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        params = make_params(args, bench_dir, out_dir)
    except FileNotFoundError as exc:
        return fail(str(exc), bench_dir=str(bench_dir))
    params_path = out_dir / "dreamplace.params.json"
    params_path.write_text(json.dumps(params, indent=2, sort_keys=True) + "\n")
    if args.dry_run:
        print(f"PASS: dry-run params written: {params_path}")
        return 0
    rc = run_dreamplace(args, params_path, out_dir)
    if rc != 0:
        return rc
    log_metrics = parse_dreamplace_log(out_dir / "dreamplace.log")
    final = {
        "schema": "eliza.pd_dreamplace_eval.v1",
        "bench_dir": str(bench_dir),
        "out_dir": str(out_dir),
        "params": params,
        "metrics": log_metrics,
    }
    if args.baseline_plc:
        final["baseline_plc"] = args.baseline_plc
    (out_dir / "dreamplace_eval.json").write_text(
        json.dumps(final, indent=2, sort_keys=True) + "\n"
    )
    print(f"PASS: DREAMPlace eval written: {out_dir / 'dreamplace_eval.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
