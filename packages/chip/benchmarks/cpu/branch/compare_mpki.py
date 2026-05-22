#!/usr/bin/env python3
"""Head-to-head MPKI: Eliza E1 BPU vs a CVA6/Ariane-class baseline predictor.

Replays the *same* branch traces through both behavioural models so the
comparison is apples-to-apples: identical branch list, identical retired-
instruction denominator. The E1 model is the TAGE-SC-L + ITTAGE + FTB + RAS +
SC + loop predictor from :mod:`benchmarks.cpu.branch.bpu_model`; the baseline is
the BHT(128) + BTB(32) + RAS(2) model from
:mod:`benchmarks.cpu.branch.baseline_predictors`, sized from the canonical CVA6
64-bit default config.

Trace sources, in order:
  * every synthetic generator in ``SYNTHETIC_GENERATORS`` (planning-only);
  * any ``*.btrace.json`` QEMU-RV64 workload trace passed via ``--trace`` or a
    ``--trace <dir>`` containing them;
  * any CBP-5 ``.gz`` trace passed via ``--trace`` (replayed against the model).

Writes ``docs/evidence/cpu_ap/bpu-vs-cva6-mpki.json`` with
``schema=eliza.bpu_vs_cva6_mpki.v1`` at claim level ``L2_ARCH_SIM`` — both
predictors are behavioural models, not RTL. The companion RTL evidence for the
E1 side lives at ``docs/evidence/cpu_ap/mpki_results_synthetic.json`` (synthetic)
and ``docs/evidence/cpu_ap/mpki_results_cbp5_rtl.json`` (CBP-5); it is referenced
here for corroboration, not merged into the headline.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from benchmarks.cpu.branch.baseline_predictors import (  # noqa: E402
    CVA6_CONFIG,
    Cva6BaselinePredictor,
)
from benchmarks.cpu.branch.bpu_model import (  # noqa: E402
    DEFAULT_GEOMETRY,
    BPUSimulator,
    BranchEvent,
)
from benchmarks.cpu.branch.traces import (  # noqa: E402
    SYNTHETIC_GENERATORS,
    read_cbp5_with_count,
)
from benchmarks.cpu.branch.workload_trace import read_workload_trace  # noqa: E402

EVIDENCE_PATH = ROOT / "docs/evidence/cpu_ap/bpu-vs-cva6-mpki.json"
SYNTHETIC_INSTR_PER_BRANCH = 5


def _score(branches: list[BranchEvent], inst_count: int) -> dict[str, object]:
    """Run both predictors over one trace and return the per-trace comparison."""
    e1 = BPUSimulator()
    e1.feed(branches)
    cva6 = Cva6BaselinePredictor()
    cva6.feed(branches)
    e1_mpki = e1.mpki(inst_count)
    cva6_mpki = cva6.mpki(inst_count)
    if cva6_mpki > 0 and e1_mpki >= 0:
        improvement_ratio = cva6_mpki / e1_mpki if e1_mpki > 0 else float("inf")
        mpki_reduction = cva6_mpki - e1_mpki
    else:
        improvement_ratio = 1.0
        mpki_reduction = 0.0
    return {
        "branches": len(branches),
        "instruction_count": inst_count,
        "e1_mpki": round(e1_mpki, 6),
        "cva6_mpki": round(cva6_mpki, 6),
        "mpki_reduction": round(mpki_reduction, 6),
        "improvement_ratio_cva6_over_e1": (
            round(improvement_ratio, 4) if math.isfinite(improvement_ratio) else "inf"
        ),
        "e1_misp": int(e1.stats().get("misp", 0)),
        "cva6_misp": int(cva6.stats().get("misp", 0)),
        "e1_counters": e1.stats(),
        "cva6_counters": cva6.stats(),
    }


def _collect_synthetic() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for name, gen in SYNTHETIC_GENERATORS.items():
        events = list(gen())
        inst_count = len(events) * SYNTHETIC_INSTR_PER_BRANCH
        row = _score(events, inst_count)
        row["trace_class"] = "synthetic_planning_only"
        out[name] = row
    return out


def _collect_traces(paths: Iterable[Path]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for path in paths:
        name = path.name
        if name.endswith(".btrace.json"):
            branches, inst_count = read_workload_trace(path)
            key = name[: -len(".btrace.json")]
            trace_class = "qemu_rv64_workload"
        elif path.suffix.lower() == ".gz":
            branches, stats = read_cbp5_with_count(path)
            inst_count = stats.instruction_count
            key = path.stem
            trace_class = "cbp5_train_traces_only"
        else:
            raise ValueError(f"unsupported trace {path}")
        if not inst_count:
            raise ValueError(f"trace {path} reported zero instructions; refusing to score")
        row = _score(branches, inst_count)
        row["trace_class"] = trace_class
        out[key] = row
    return out


def _expand(paths: Iterable[Path]) -> list[Path]:
    out: list[Path] = []
    for p in paths:
        if p.is_dir():
            out.extend(sorted(p.glob("*.btrace.json")))
            out.extend(sorted(p.glob("*.gz")))
        elif p.is_file():
            out.append(p)
        else:
            raise FileNotFoundError(f"trace path does not exist: {p}")
    return out


def _geomean(values: Iterable[float]) -> float:
    vals = [v for v in values if v > 0]
    if not vals:
        return 0.0
    return math.exp(sum(math.log(v) for v in vals) / len(vals))


def _aggregate(results: dict[str, dict]) -> dict[str, object]:
    e1_vals = [r["e1_mpki"] for r in results.values()]
    cva6_vals = [r["cva6_mpki"] for r in results.values()]
    total_inst = sum(r["instruction_count"] for r in results.values())
    total_e1_misp = sum(r["e1_misp"] for r in results.values())
    total_cva6_misp = sum(r["cva6_misp"] for r in results.values())
    e1_geo = _geomean(e1_vals)
    cva6_geo = _geomean(cva6_vals)
    pooled_e1 = total_e1_misp * 1000.0 / total_inst if total_inst else 0.0
    pooled_cva6 = total_cva6_misp * 1000.0 / total_inst if total_inst else 0.0
    e1_wins = sorted(name for name, r in results.items() if r["e1_mpki"] < r["cva6_mpki"])
    e1_ties = sorted(name for name, r in results.items() if r["e1_mpki"] == r["cva6_mpki"])
    e1_regressions = sorted(
        (
            {
                "trace": name,
                "e1_mpki": r["e1_mpki"],
                "cva6_mpki": r["cva6_mpki"],
                "delta_mpki": round(r["e1_mpki"] - r["cva6_mpki"], 6),
            }
            for name, r in results.items()
            if r["e1_mpki"] > r["cva6_mpki"]
        ),
        key=lambda item: item["delta_mpki"],
        reverse=True,
    )
    return {
        "e1_geomean_mpki": round(e1_geo, 6),
        "cva6_geomean_mpki": round(cva6_geo, 6),
        "geomean_improvement_ratio_cva6_over_e1": (
            round(cva6_geo / e1_geo, 4) if e1_geo > 0 else "inf"
        ),
        "pooled_instruction_count": total_inst,
        "pooled_e1_mpki": round(pooled_e1, 6),
        "pooled_cva6_mpki": round(pooled_cva6, 6),
        "pooled_improvement_ratio_cva6_over_e1": (
            round(pooled_cva6 / pooled_e1, 4) if pooled_e1 > 0 else "inf"
        ),
        "trace_count": len(results),
        "e1_win_count": len(e1_wins),
        "e1_tie_count": len(e1_ties),
        "e1_regression_count": len(e1_regressions),
        "e1_wins": e1_wins,
        "e1_ties": e1_ties,
        "e1_regressions": e1_regressions,
    }


def build_evidence(traces: list[Path]) -> dict[str, object]:
    synthetic = _collect_synthetic()
    external = _collect_traces(traces)
    all_traces = {**synthetic, **external}
    return {
        "schema": "eliza.bpu_vs_cva6_mpki.v1",
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "claim_level": "L2_ARCH_SIM",
        "provenance": "simulator",
        "harness": "benchmarks/cpu/branch/compare_mpki.py",
        "description": (
            "Head-to-head MPKI of the Eliza E1 BPU (TAGE-SC-L + ITTAGE + FTB +"
            " RAS + SC + loop) against a CVA6/Ariane-class BHT+BTB+RAS baseline,"
            " both behavioural models replayed over the identical branch traces."
        ),
        "predictors": {
            "e1": {
                "predictor": "eliza_e1_tage_sc_l_ittage",
                "model": "benchmarks/cpu/branch/bpu_model.py:BPUSimulator",
                "geometry": {
                    key: list(value) if isinstance(value, tuple) else value
                    for key, value in DEFAULT_GEOMETRY.items()
                },
            },
            "cva6_baseline": {
                "model": "benchmarks/cpu/branch/baseline_predictors.py:Cva6BaselinePredictor",
                "config": CVA6_CONFIG,
            },
        },
        "per_trace": all_traces,
        "aggregate": {
            "all": _aggregate(all_traces),
            "synthetic_only": _aggregate(synthetic) if synthetic else None,
            "external_only": _aggregate(external) if external else None,
        },
        "corroborating_rtl_evidence": {
            "e1_synthetic_rtl": "docs/evidence/cpu_ap/mpki_results_synthetic.json",
            "e1_cbp5_rtl": "docs/evidence/cpu_ap/mpki_results_cbp5_rtl.json",
            "note": (
                "E1 RTL MPKI exists at L1_RTL_FULL_SOC via cocotb on bpu_top.sv."
                " No CVA6 RTL is run here, so the headline comparison is held at"
                " the behavioural-model level (L2_ARCH_SIM) for both predictors;"
                " the E1 RTL evidence corroborates the E1 model side only."
            ),
        },
        "claim_policy": {
            "is_behavioural_model": True,
            "both_predictors_same_level": True,
            "spec2017_claim": False,
            "android_claim": False,
            "v8_claim": False,
            "reason": (
                "Both predictors are behavioural models scored on identical"
                " traces. Synthetic generators are planning-only; CBP-5 traces"
                " back a CBP train-set comparison only. This file does not back"
                " SPEC2017, AOSP, or JS-engine MPKI claims."
            ),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--trace",
        "--traces",
        type=Path,
        action="append",
        default=[],
        help="external trace file (.btrace.json or .gz CBP-5) or a directory of them",
    )
    parser.add_argument("--out", type=Path, default=EVIDENCE_PATH)
    parser.add_argument(
        "--print-only",
        action="store_true",
        help="emit JSON to stdout without writing to disk",
    )
    args = parser.parse_args()

    traces = _expand(args.trace)
    evidence = build_evidence(traces)

    aggregate = evidence["aggregate"]
    assert isinstance(aggregate, dict)
    agg = aggregate["all"]
    print(
        f"eliza-evidence: E1 geomean MPKI={agg['e1_geomean_mpki']} "
        f"CVA6 geomean MPKI={agg['cva6_geomean_mpki']} "
        f"ratio(CVA6/E1)={agg['geomean_improvement_ratio_cva6_over_e1']} "
        f"over {agg['trace_count']} traces",
        file=sys.stderr,
    )

    if args.print_only:
        json.dump(evidence, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
        return 0
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
    print(f"eliza-evidence: status=PASS path={args.out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
