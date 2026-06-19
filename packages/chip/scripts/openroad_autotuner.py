#!/usr/bin/env python3
"""Optuna sweep over OpenLane/OpenROAD parameters; emit a Pareto front.

Tunes the parameters that AutoTuner exposes in the OpenROAD-flow-scripts
repository on top of the existing OpenLane Sky130 release config. Each trial
launches OpenLane in Docker and parses metrics.json. The result is a JSON
Pareto front over routed wirelength, setup TNS, and DRC count.

Search space (kept narrow so 30-100 trials are tractable in a few hours):

  FP_CORE_UTIL                 18 .. 35
  PL_TARGET_DENSITY            0.25 .. 0.55
  GRT_ANTENNA_MARGIN           20 .. 60
  GRT_RESIZER_HOLD_SLACK_MARGIN   0.05 .. 0.30
  GRT_RESIZER_SETUP_SLACK_MARGIN  0.02 .. 0.20
  RT_MAX_LAYER                 {"met4", "met5"}
  CTS_CLK_BUFFER_LIST          single-string passthrough

Outputs:
  build/pd/autotuner/<sweep_id>/
    trials.jsonl                one record per trial
    pareto.json                 non-dominated trials (wirelength, TNS, DRC)
    summary.md                  human-readable top-5 summary
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


@dataclass
class TrialResult:
    trial_id: int
    params: dict[str, Any]
    metrics: dict[str, Any]
    failed: bool
    failure_reason: str | None
    runtime_s: float


@dataclass
class ParetoPoint:
    trial_id: int
    wirelength: float
    setup_tns: float
    drc_errors: float
    params: dict[str, Any]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        default="pd/openlane/config.sky130.json",
        help="Baseline OpenLane config to sweep around.",
    )
    parser.add_argument("--sweep-id", required=True, help="Identifier for this sweep")
    parser.add_argument(
        "--trials",
        type=int,
        default=32,
        help="Number of Optuna trials to run (default 32).",
    )
    parser.add_argument(
        "--openlane-image",
        default="ghcr.io/efabless/openlane2:2.4.0.dev1",
        help="OpenLane container image (must match scripts/check_pd_preflight.py).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Emit the sampled parameter grid but do not invoke OpenLane. Use this "
            "for plan review and CI smoke."
        ),
    )
    parser.add_argument(
        "--max-runtime-s",
        type=int,
        default=18000,
        help="Hard cap (seconds) on total sweep wall time. Default 5h.",
    )
    return parser.parse_args()


def fail(message: str, **context: Any) -> int:
    payload = {"error": message, **context}
    print(f"FAIL: {message}", file=sys.stderr)
    json.dump(payload, sys.stderr, indent=2, sort_keys=True)
    sys.stderr.write("\n")
    return 1


def load_optuna() -> Any:
    try:
        import optuna
    except ImportError:
        return None
    return optuna


def sample_params(trial: Any) -> dict[str, Any]:
    """Build a parameter override dict from an Optuna trial."""
    return {
        "FP_CORE_UTIL": trial.suggest_int("FP_CORE_UTIL", 18, 35),
        "PL_TARGET_DENSITY": trial.suggest_float("PL_TARGET_DENSITY", 0.25, 0.55),
        "GRT_ANTENNA_MARGIN": trial.suggest_int("GRT_ANTENNA_MARGIN", 20, 60),
        "GRT_RESIZER_HOLD_SLACK_MARGIN": trial.suggest_float(
            "GRT_RESIZER_HOLD_SLACK_MARGIN", 0.05, 0.30
        ),
        "GRT_RESIZER_SETUP_SLACK_MARGIN": trial.suggest_float(
            "GRT_RESIZER_SETUP_SLACK_MARGIN", 0.02, 0.20
        ),
        "RT_MAX_LAYER": trial.suggest_categorical("RT_MAX_LAYER", ["met4", "met5"]),
    }


def materialize_config(base_config_path: Path, overrides: dict[str, Any], out_dir: Path) -> Path:
    base = json.loads(base_config_path.read_text())
    base.update(overrides)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "config.json"
    out_path.write_text(json.dumps(base, indent=2, sort_keys=True) + "\n")
    return out_path


def run_openlane_trial(
    config_path: Path,
    trial_dir: Path,
    image: str,
) -> dict[str, Any]:
    if shutil.which("docker") is None:
        raise RuntimeError("docker not on PATH")
    cmd = [
        "docker",
        "run",
        "--rm",
        "-v",
        f"{ROOT}:{ROOT}",
        "-w",
        str(ROOT),
        image,
        "openlane",
        str(config_path),
        "--run-tag",
        trial_dir.name,
    ]
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=False)
    (trial_dir / "stdout.log").write_text(proc.stdout)
    (trial_dir / "stderr.log").write_text(proc.stderr)
    if proc.returncode != 0:
        return {"_openlane_returncode": proc.returncode}
    metrics = list((trial_dir).rglob("final/metrics.json"))
    if not metrics:
        return {"_openlane_returncode": proc.returncode, "_missing_metrics": True}
    return json.loads(metrics[0].read_text())


def is_pareto(point: ParetoPoint, others: list[ParetoPoint]) -> bool:
    for other in others:
        if other.trial_id == point.trial_id:
            continue
        dominates = (
            other.wirelength <= point.wirelength
            and other.setup_tns >= point.setup_tns
            and other.drc_errors <= point.drc_errors
        )
        strict = (
            other.wirelength < point.wirelength
            or other.setup_tns > point.setup_tns
            or other.drc_errors < point.drc_errors
        )
        if dominates and strict:
            return False
    return True


def compute_pareto(results: list[TrialResult]) -> list[ParetoPoint]:
    points: list[ParetoPoint] = []
    for r in results:
        if r.failed:
            continue
        metrics = r.metrics
        wl = metrics.get("route__wirelength")
        tns = metrics.get("timing__setup__tns")
        drc = metrics.get("route__drc_errors")
        if wl is None or tns is None or drc is None:
            continue
        points.append(
            ParetoPoint(
                trial_id=r.trial_id,
                wirelength=float(wl),
                setup_tns=float(tns),
                drc_errors=float(drc),
                params=r.params,
            )
        )
    return [p for p in points if is_pareto(p, points)]


def render_summary(sweep_dir: Path, results: list[TrialResult], pareto: list[ParetoPoint]) -> None:
    lines = [
        "# OpenROAD AutoTuner sweep summary",
        "",
        f"sweep_id: {sweep_dir.name}",
        f"trials_total: {len(results)}",
        f"trials_failed: {sum(1 for r in results if r.failed)}",
        f"pareto_size: {len(pareto)}",
        "",
        "## Pareto front (wirelength, setup_tns, drc_errors)",
        "",
        "| trial | WL | TNS | DRC | params |",
        "| ---: | ---: | ---: | ---: | --- |",
    ]
    for p in sorted(pareto, key=lambda q: q.wirelength):
        lines.append(
            f"| {p.trial_id} | {p.wirelength:.0f} | {p.setup_tns:.3f} | "
            f"{int(p.drc_errors)} | `{json.dumps(p.params, sort_keys=True)}` |"
        )
    (sweep_dir / "summary.md").write_text("\n".join(lines) + "\n")


def main() -> int:
    args = parse_args()
    base_config = (ROOT / args.config).resolve()
    if not base_config.is_file():
        return fail("baseline config missing", config=str(base_config))
    sweep_dir = ROOT / "build" / "pd" / "autotuner" / args.sweep_id
    sweep_dir.mkdir(parents=True, exist_ok=True)
    trials_log = sweep_dir / "trials.jsonl"
    trials_log.write_text("")

    optuna = load_optuna()
    if optuna is None and not args.dry_run:
        return fail(
            "optuna missing; install with `pip install optuna` or use --dry-run",
            sweep_id=args.sweep_id,
        )

    if args.dry_run:
        sampled: list[dict[str, Any]] = []
        for trial_id in range(min(args.trials, 8)):
            sampled.append(
                {
                    "trial_id": trial_id,
                    "params": {
                        "FP_CORE_UTIL": 20 + trial_id * 2,
                        "PL_TARGET_DENSITY": 0.30 + trial_id * 0.03,
                        "GRT_ANTENNA_MARGIN": 30 + trial_id * 4,
                        "GRT_RESIZER_HOLD_SLACK_MARGIN": 0.10 + trial_id * 0.02,
                        "GRT_RESIZER_SETUP_SLACK_MARGIN": 0.05 + trial_id * 0.01,
                        "RT_MAX_LAYER": "met5" if trial_id % 2 else "met4",
                    },
                }
            )
        (sweep_dir / "dry_run_grid.json").write_text(
            json.dumps({"sweep_id": args.sweep_id, "trials": sampled}, indent=2, sort_keys=True)
            + "\n"
        )
        print(f"PASS: dry-run grid written: {sweep_dir / 'dry_run_grid.json'}")
        return 0

    sampler = optuna.samplers.TPESampler(seed=int(os.environ.get("AUTOTUNER_SEED", "1337")))
    study = optuna.create_study(
        sampler=sampler,
        directions=["minimize", "maximize", "minimize"],
    )
    results: list[TrialResult] = []
    start = time.time()
    for trial_id in range(args.trials):
        if time.time() - start > args.max_runtime_s:
            print(f"WARN: max-runtime-s {args.max_runtime_s} reached; stopping early")
            break
        trial = study.ask()
        params = sample_params(trial)
        trial_dir = sweep_dir / f"trial_{trial_id:03d}"
        trial_dir.mkdir(parents=True, exist_ok=True)
        config_path = materialize_config(base_config, params, trial_dir)
        t0 = time.time()
        try:
            metrics = run_openlane_trial(config_path, trial_dir, args.openlane_image)
            failed = "_openlane_returncode" in metrics
            reason = "openlane_nonzero_returncode" if failed else None
        except Exception as exc:  # noqa: BLE001 - boundary with subprocess
            metrics = {}
            failed = True
            reason = f"exception:{exc!r}"
        runtime = time.time() - t0
        result = TrialResult(
            trial_id=trial_id,
            params=params,
            metrics=metrics,
            failed=failed,
            failure_reason=reason,
            runtime_s=runtime,
        )
        results.append(result)
        with trials_log.open("a") as fh:
            fh.write(json.dumps(asdict(result), sort_keys=True) + "\n")
        if not failed:
            study.tell(
                trial,
                [
                    float(metrics.get("route__wirelength", 0)),
                    float(metrics.get("timing__setup__tns", -1e9)),
                    float(metrics.get("route__drc_errors", 0)),
                ],
            )
        else:
            study.tell(trial, state=optuna.trial.TrialState.FAIL)

    pareto = compute_pareto(results)
    (sweep_dir / "pareto.json").write_text(
        json.dumps(
            {
                "sweep_id": args.sweep_id,
                "pareto": [asdict(p) for p in pareto],
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )
    render_summary(sweep_dir, results, pareto)
    print(f"PASS: sweep written to {sweep_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
