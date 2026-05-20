#!/usr/bin/env python3
"""DREAMPlace 4.0 evaluation harness.

DREAMPlace is a GPU-accelerated analytical placer (Lin/Pan et al., DAC 2019;
DREAMPlace 4.0 adds full-flow placement with macro placement and detailed
placement). On the largest ICCAD'15 benchmarks 4.0 achieves a 30x speedup
over CPU placers without requiring reinforcement learning. We use it as a
no-RL-training-cost reference placer next to AlphaChip on the same e1
benchmark.

Inputs:
  --bench-dir          Directory holding the Circuit Training benchmark
                       (e1_softmacro.pb.txt + e1_softmacro.openroad.plc).
  --out-dir            Output dir for Bookshelf, log, gp.pl, dreamplace.plc,
                       and the eval JSON.
  --dreamplace-repo    Path to the built DREAMPlace install tree (must contain
                       ``install/dreamplace/Placer.py``).
  --dreamplace-image   Docker image with PyTorch + DREAMPlace deps
                       (default: limbo018/dreamplace:cuda).
  --baseline-plc       Optional OpenROAD baseline .plc; HPWL is computed on
                       both and emitted alongside the DREAMPlace number.
  --use-gpu            Forward --gpus all to docker; only works when the
                       host has a working nvidia container runtime AND the
                       image's CUDA arch covers the device.
  --dry-run            Emit Bookshelf + params and exit without invoking
                       DREAMPlace.

Outputs (under --out-dir):
  bookshelf/e1_softmacro.{aux,nodes,nets,pl,scl,wts}    Bookshelf inputs
  dreamplace.params.json                                placer params
  dreamplace.log                                        container stdout
  dreamplace/e1_softmacro/e1_softmacro.gp.pl            placer output
  e1_softmacro.dreamplace.plc                           CT-format result
  dreamplace_eval.json                                  HPWL + runtime
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
ALPHACHIP_DIR = ROOT / "scripts" / "alphachip"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bench-dir", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--dreamplace-repo", default="external/DREAMPlace")
    parser.add_argument("--dreamplace-image", default="limbo018/dreamplace:cuda")
    parser.add_argument("--baseline-plc")
    parser.add_argument("--use-gpu", action="store_true")
    parser.add_argument("--target-density", type=float, default=0.8)
    parser.add_argument("--num-bins-x", type=int, default=64)
    parser.add_argument("--num-bins-y", type=int, default=64)
    parser.add_argument("--iterations", type=int, default=1000)
    parser.add_argument("--seed", type=int, default=1337)
    parser.add_argument("--dry-run", action="store_true")
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


def make_params(args: argparse.Namespace, bookshelf_dir: Path, out_dir: Path) -> dict[str, Any]:
    aux = bookshelf_dir / "e1_softmacro.aux"
    return {
        "aux_input": str(aux),
        "gpu": 1 if args.use_gpu else 0,
        "num_bins_x": args.num_bins_x,
        "num_bins_y": args.num_bins_y,
        "global_place_stages": [
            {
                "num_bins_x": args.num_bins_x,
                "num_bins_y": args.num_bins_y,
                "iteration": args.iterations,
                "learning_rate": 0.01,
                "wirelength": "weighted_average",
                "optimizer": "nesterov",
                "Llambda_density_weight_iteration": 1,
                "Lsub_iteration": 1,
            }
        ],
        "target_density": args.target_density,
        "density_weight": 8e-05,
        "random_seed": args.seed,
        "result_dir": str(out_dir / "dreamplace"),
        "global_place_flag": 1,
        "legalize_flag": 1,
        "detailed_place_flag": 1,
        "macro_place_flag": 0,
        "stop_overflow": 0.1,
        "deterministic_flag": 1,
        "num_threads": 8,
        "plot_flag": 0,
        "dtype": "float32",
        "scale_factor": 0.0,
        "shift_factor": [0.0, 0.0],
        "ignore_net_degree": 100,
        "gp_noise_ratio": 0.025,
        "enable_fillers": 1,
        "abacus_legalize_flag": 1,
    }


_FLOAT_RE = re.compile(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?")


def parse_dreamplace_log(log_path: Path) -> dict[str, Any]:
    metrics: dict[str, Any] = {
        "hpwl_final": None,
        "non_linear_runtime_s": None,
        "detailed_runtime_s": None,
        "total_runtime_s": None,
        "iterations": None,
    }
    if not log_path.is_file():
        return metrics
    for raw in log_path.read_text().splitlines():
        line = raw.strip()
        if "non-linear placement takes" in line:
            nums = _FLOAT_RE.findall(line)
            if nums:
                metrics["non_linear_runtime_s"] = float(nums[-1])
        elif "detailed placement takes" in line:
            nums = _FLOAT_RE.findall(line)
            if nums:
                metrics["detailed_runtime_s"] = float(nums[-1])
        elif "placement takes" in line and "non-linear" not in line and "detailed" not in line:
            nums = _FLOAT_RE.findall(line)
            if nums:
                metrics["total_runtime_s"] = float(nums[-1])
        elif "wHPWL" in line:
            m = re.search(r"iteration\s+(\d+).+?wHPWL\s+([0-9.eE+-]+)", line)
            if m:
                metrics["iterations"] = int(m.group(1))
                metrics["hpwl_final"] = float(m.group(2))
    return metrics


def run_pb_to_bookshelf(pb_file: Path, plc_file: Path, out_dir: Path) -> Path:
    bookshelf_dir = out_dir / "bookshelf"
    bookshelf_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            sys.executable,
            str(ALPHACHIP_DIR / "pb_to_bookshelf.py"),
            "--pb-file",
            str(pb_file),
            "--plc-file",
            str(plc_file),
            "--out-dir",
            str(bookshelf_dir),
            "--design",
            "e1_softmacro",
        ],
        check=True,
    )
    return bookshelf_dir


def run_dreamplace(args: argparse.Namespace, repo: Path, params_path: Path, log_path: Path) -> int:
    if shutil.which("docker") is None:
        return fail("docker not on PATH; cannot invoke DREAMPlace")
    if not (repo / "install" / "dreamplace" / "Placer.py").is_file():
        return fail(
            "DREAMPlace install tree missing; build it first",
            install_dir=str(repo / "install"),
            hint="Run scripts/alphachip/build_dreamplace_from_source.sh or follow external/DREAMPlace/README.md",
        )
    bench_dir = params_path.parent
    cmd: list[str] = ["docker", "run", "--rm"]
    if args.use_gpu:
        cmd += ["--gpus", "all"]
    cmd += [
        "-v",
        f"{repo}:/DREAMPlace",
        "-v",
        f"{bench_dir}:{bench_dir}",
        "-w",
        "/DREAMPlace/install",
        args.dreamplace_image,
        "bash",
        "-lc",
        (
            "pip install -q torch_optimizer==0.3.0 ncg_optimizer==0.2.2 pyunpack patool shapely "
            f"2>&1 | tail -1 && python3 dreamplace/Placer.py {params_path}"
        ),
    ]
    print(f"RUN: {' '.join(cmd)}")
    t0 = time.time()
    with log_path.open("w") as fh:
        proc = subprocess.run(cmd, cwd=ROOT, stdout=fh, stderr=subprocess.STDOUT, check=False)
    print(f"DREAMPlace wall time: {time.time() - t0:.1f}s")
    if proc.returncode != 0:
        return fail("DREAMPlace exited non-zero", returncode=proc.returncode, log=str(log_path))
    return 0


def run_hpwl(pb_file: Path, plc_file: Path, out_json: Path) -> dict[str, Any]:
    proc = subprocess.run(
        [
            sys.executable,
            str(ALPHACHIP_DIR / "plc_hpwl.py"),
            "--pb-file",
            str(pb_file),
            "--plc-file",
            str(plc_file),
            "--out-json",
            str(out_json),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(proc.stdout)


def main() -> int:
    args = parse_args()
    bench_dir = resolve(args.bench_dir)
    out_dir = resolve(args.out_dir)
    if not bench_dir.is_dir():
        return fail("bench dir missing", bench_dir=str(bench_dir))
    out_dir.mkdir(parents=True, exist_ok=True)

    pb_file = next(bench_dir.glob("*.pb.txt"), None)
    plc_file = next(bench_dir.glob("*.openroad.plc"), None)
    if pb_file is None:
        return fail("no *.pb.txt in bench dir", bench_dir=str(bench_dir))
    if plc_file is None:
        return fail("no *.openroad.plc in bench dir", bench_dir=str(bench_dir))

    bookshelf_dir = run_pb_to_bookshelf(pb_file, plc_file, out_dir)
    params = make_params(args, bookshelf_dir, out_dir)
    params_path = out_dir / "dreamplace.params.json"
    params_path.write_text(json.dumps(params, indent=2, sort_keys=True) + "\n")

    if args.dry_run:
        print(f"PASS: dry-run params written: {params_path}")
        return 0

    repo = resolve(args.dreamplace_repo)
    if not repo.is_dir():
        return fail("DREAMPlace repo missing", dreamplace_repo=str(repo))

    log_path = out_dir / "dreamplace.log"
    rc = run_dreamplace(args, repo, params_path, log_path)
    if rc != 0:
        return rc

    gp_pl = out_dir / "dreamplace" / "e1_softmacro" / "e1_softmacro.gp.pl"
    if not gp_pl.is_file():
        return fail("DREAMPlace did not produce gp.pl", expected=str(gp_pl))

    dp_plc = out_dir / "e1_softmacro.dreamplace.plc"
    subprocess.run(
        [
            sys.executable,
            str(ALPHACHIP_DIR / "gp_pl_to_ct_plc.py"),
            "--pb-file",
            str(pb_file),
            "--src-plc",
            str(plc_file),
            "--gp-pl",
            str(gp_pl),
            "--out-plc",
            str(dp_plc),
        ],
        check=True,
    )

    dp_hpwl = run_hpwl(pb_file, dp_plc, out_dir / "hpwl_dreamplace.json")
    baseline_hpwl = run_hpwl(pb_file, plc_file, out_dir / "hpwl_openroad.json")
    log_metrics = parse_dreamplace_log(log_path)

    delta_pct = None
    if baseline_hpwl["hpwl_microns"] > 0:
        delta_pct = (
            100.0
            * (dp_hpwl["hpwl_microns"] - baseline_hpwl["hpwl_microns"])
            / baseline_hpwl["hpwl_microns"]
        )

    final = {
        "schema": "eliza.pd_dreamplace_eval.v2",
        "bench_dir": str(bench_dir),
        "out_dir": str(out_dir),
        "params_file": str(params_path),
        "dreamplace_log": str(log_path),
        "dreamplace_gp_pl": str(gp_pl),
        "dreamplace_plc": str(dp_plc),
        "baseline_plc": str(plc_file),
        "metrics_from_log": log_metrics,
        "hpwl_openroad": baseline_hpwl["hpwl_microns"],
        "hpwl_dreamplace": dp_hpwl["hpwl_microns"],
        "hpwl_delta_pct": delta_pct,
        "num_nets": dp_hpwl["num_nets"],
        "device": "GPU" if args.use_gpu else "CPU",
        "seed": args.seed,
    }
    eval_path = out_dir / "dreamplace_eval.json"
    eval_path.write_text(json.dumps(final, indent=2, sort_keys=True) + "\n")
    print(f"PASS: DREAMPlace eval written: {eval_path}")
    print(f"  HPWL baseline   : {baseline_hpwl['hpwl_microns']:.1f} um")
    print(f"  HPWL DREAMPlace : {dp_hpwl['hpwl_microns']:.1f} um  ({delta_pct:+.2f}%)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
