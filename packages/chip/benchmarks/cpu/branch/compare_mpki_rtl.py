#!/usr/bin/env python3
"""Fail-closed MPKI comparison: E1 BPU RTL vs CVA6-class baseline model.

The behavioural head-to-head lives in :mod:`benchmarks.cpu.branch.compare_mpki`
and writes ``docs/evidence/cpu_ap/bpu-vs-cva6-mpki.json`` at claim level
``L2_ARCH_SIM`` (both predictors are behavioural models). This script raises the
E1 side to **RTL**: it ingests the per-trace MPKI that the cocotb harness
(``verify/cocotb/bpu/test_bpu_mpki.py`` driving ``bpu_top.sv`` via Verilator)
measured on the *same* trace set, pairs every trace with its E1-model and CVA6-
model MPKI, and reports:

  * E1 RTL MPKI per trace and the RTL geomean.
  * The CVA6 baseline-model MPKI per trace (CVA6 has no comparable open RTL
    predictor to run here — its BHT(128)+BTB(32)+RAS(2) front-end is simple
    enough that the behavioural model is faithful; the model is sized directly
    from the CVA6 RTL, cited below).
  * The RTL improvement ratio (CVA6 model geomean / E1 RTL geomean).
  * The E1 model<->RTL correlation on the shared traces, which is what validates
    that the model-level head-to-head is a faithful proxy for the RTL.

Claim discipline: the E1 RTL side is ``L1_RTL_FULL_SOC`` (Verilator on
``bpu_top.sv``). The CVA6 side is a behavioural model (``L2_ARCH_SIM``). The
comparison is therefore held at the lower of the two levels (``L2_ARCH_SIM``)
with an explicit note; only the *E1 side* is hardened to L1 here.

CVA6 RTL sizing citations (paths relative to the chip package):
  * external/cva6/cva6/core/include/cv64a6_imafdc_sv39_config_pkg.sv:62-64
    (RASDepth=2, BTBEntries=32, BHTEntries=128)
  * external/cva6/cva6/core/frontend/bht.sv
  * external/cva6/cva6/core/frontend/btb.sv
  * external/cva6/cva6/core/frontend/ras.sv
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]

MODEL_COMPARISON_PATH = ROOT / "docs/evidence/cpu_ap/bpu-vs-cva6-mpki.json"
RTL_SYNTHETIC_PATH = ROOT / "docs/evidence/cpu_ap/mpki_results_synthetic.json"
RTL_CBP5_PATH = ROOT / "docs/evidence/cpu_ap/mpki_results_cbp5_rtl.json"
RTL_WORKLOAD_PATH = ROOT / "docs/evidence/cpu_ap/mpki_results_workload_rtl.json"
EVIDENCE_PATH = ROOT / "docs/evidence/cpu_ap/bpu-vs-cva6-mpki-rtl.json"

CVA6_RTL_CITATIONS = [
    "external/cva6/cva6/core/include/cv64a6_imafdc_sv39_config_pkg.sv:62-64",
    "external/cva6/cva6/core/frontend/bht.sv",
    "external/cva6/cva6/core/frontend/btb.sv",
    "external/cva6/cva6/core/frontend/ras.sv",
    "external/cva6/cva6/core/frontend/frontend.sv:236-297",
]

# Tolerance band for declaring the E1 RTL "converged" against its own model. The
# RTL and model implement the same TAGE-SC-L+ITTAGE algorithm; once the RTL is
# stable they should track within the configured evidence band. A relative gap
# beyond this band on the shared traces fails closed and must not be quoted as a
# hardened RTL win.
RTL_MODEL_REL_GAP_CONVERGED = 0.50  # 50% relative MPKI gap, geomean


def _load(path: Path) -> dict:
    if not path.is_file():
        raise FileNotFoundError(f"required evidence file missing: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def _geomean(values: list[float]) -> float:
    vals = [v for v in values if v > 0]
    if not vals:
        return 0.0
    return math.exp(sum(math.log(v) for v in vals) / len(vals))


def _pearson(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n < 2:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx <= 0 or syy <= 0:
        return None
    return sxy / math.sqrt(sxx * syy)


def _rank(values: list[float]) -> list[float]:
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    return ranks


def _spearman(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 2:
        return None
    return _pearson(_rank(xs), _rank(ys))


def _collect_rtl_mpki() -> dict[str, dict]:
    """Per-trace E1 RTL MPKI from the cocotb evidence files (whichever exist)."""
    rtl: dict[str, dict] = {}
    sources = [
        (RTL_SYNTHETIC_PATH, "synthetic"),
        (RTL_CBP5_PATH, "cbp5"),
        (RTL_WORKLOAD_PATH, "workload"),
    ]
    for path, group in sources:
        if not path.is_file():
            continue
        doc = json.loads(path.read_text(encoding="utf-8"))
        for name, row in doc.get("workloads", {}).items():
            rtl[name] = {
                "e1_rtl_mpki": row["mpki"],
                "rtl_source": str(path.relative_to(ROOT)),
                "rtl_group": group,
                "trace_class": row.get("trace_class"),
            }
    return rtl


def build_evidence() -> dict:
    model_doc = _load(MODEL_COMPARISON_PATH)
    rtl = _collect_rtl_mpki()
    if not rtl:
        raise FileNotFoundError(
            "no E1 RTL MPKI evidence found; run the cocotb harness "
            "(make mpki-eval-rtl) first"
        )

    model_per_trace = model_doc["per_trace"]

    per_trace: dict[str, dict] = {}
    missing_model: list[str] = []
    for name, info in sorted(rtl.items()):
        m = model_per_trace.get(name)
        if m is None:
            missing_model.append(name)
            continue
        e1_rtl = info["e1_rtl_mpki"]
        e1_model = m["e1_mpki"]
        cva6_model = m["cva6_mpki"]
        ratio_rtl = (cva6_model / e1_rtl) if e1_rtl > 0 else None
        rel_gap = (
            (abs(e1_rtl - e1_model) / e1_model) if e1_model > 0 else (0.0 if e1_rtl == 0 else None)
        )
        per_trace[name] = {
            "trace_class": info["trace_class"] or m.get("trace_class"),
            "rtl_group": info["rtl_group"],
            "rtl_source": info["rtl_source"],
            "e1_rtl_mpki": round(e1_rtl, 6),
            "e1_model_mpki": round(e1_model, 6),
            "cva6_model_mpki": round(cva6_model, 6),
            "improvement_ratio_cva6_model_over_e1_rtl": (
                round(ratio_rtl, 4) if ratio_rtl is not None else None
            ),
            "e1_rtl_vs_model_rel_gap": (round(rel_gap, 4) if rel_gap is not None else None),
        }

    paired = list(per_trace.values())
    e1_rtl_vals = [p["e1_rtl_mpki"] for p in paired]
    e1_model_vals = [p["e1_model_mpki"] for p in paired]
    cva6_model_vals = [p["cva6_model_mpki"] for p in paired]

    e1_rtl_geo = _geomean(e1_rtl_vals)
    e1_model_geo = _geomean(e1_model_vals)
    cva6_model_geo = _geomean(cva6_model_vals)

    pearson = _pearson(e1_rtl_vals, e1_model_vals)
    spearman = _spearman(e1_rtl_vals, e1_model_vals)

    rel_geo_gap = abs(e1_rtl_geo - e1_model_geo) / e1_model_geo if e1_model_geo > 0 else None
    converged = bool(rel_geo_gap is not None and rel_geo_gap <= RTL_MODEL_REL_GAP_CONVERGED)

    ratio_rtl_geo = cva6_model_geo / e1_rtl_geo if e1_rtl_geo > 0 else None

    # The shared traces drive the correlation; a non-converged RTL must not be
    # quoted as a hardened win, so the headline is gated on `converged`.
    if converged:
        comparison_status = "RTL_CORROBORATED"
        headline_note = (
            "E1 RTL tracks the E1 behavioural model within the convergence band "
            "on the shared traces; the model-level head-to-head win is RTL-validated "
            "on the E1 side. Comparison is held at L2_ARCH_SIM because the CVA6 side "
            "remains a behavioural model. Traces listed in rtl_traces_without_model_pair "
            "are reported separately and do not contribute to this corroboration status."
        )
    else:
        comparison_status = "BLOCKED_RTL_NOT_CONVERGED"
        headline_note = (
            "E1 RTL does NOT currently track the E1 behavioural model on the shared "
            "traces (geomean relative gap exceeds the convergence band). This file "
            "records the RTL numbers honestly and FAILS CLOSED: it does not back an "
            "RTL-backed win until the RTL reconverges with the model. Re-run "
            "make bpu-vs-cva6-mpki-rtl after the RTL/model evidence stabilises."
        )

    return {
        "schema": "eliza.bpu_vs_cva6_mpki_rtl.v1",
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "comparison_status": comparison_status,
        "e1_claim_level": "L1_RTL_FULL_SOC",
        "cva6_claim_level": "L2_ARCH_SIM",
        "comparison_claim_level": "L2_ARCH_SIM",
        "provenance": "simulator",
        "simulator": "verilator (oss-cad-suite) via cocotb on bpu_top.sv",
        "harness": "benchmarks/cpu/branch/compare_mpki_rtl.py",
        "description": (
            "Fail-closed RTL MPKI comparison. The E1 side is measured on the "
            "synthesizable bpu_top.sv via the cocotb harness (L1_RTL_FULL_SOC); the "
            "CVA6 side is the behavioural BHT+BTB+RAS baseline model (L2_ARCH_SIM), "
            "sized directly from CVA6 RTL. The headline comparison is held at the "
            "lower of the two levels."
        ),
        "headline_note": headline_note,
        "cva6_baseline": {
            "predictor": "cva6_ariane_bht_btb_ras",
            "model": "benchmarks/cpu/branch/baseline_predictors.py:Cva6BaselinePredictor",
            "no_open_rtl_predictor_to_run": True,
            "model_faithful_because": (
                "CVA6/Ariane front-end is a simple in-order predictor: BHT(128) "
                "2-bit counters PC-indexed, untagged BTB(32) for register-indirect "
                "jumps only, and a depth-2 RAS. There is no TAGE/SC/ITTAGE/loop "
                "predictor to model, so the behavioural model reproduces the RTL "
                "predictor exactly; running CVA6 RTL would add no fidelity."
            ),
            "rtl_sizing": {"BHT_ENTRIES": 128, "BTB_ENTRIES": 32, "RAS_DEPTH": 2},
            "rtl_citations": CVA6_RTL_CITATIONS,
        },
        "model_comparison_source": str(MODEL_COMPARISON_PATH.relative_to(ROOT)),
        "rtl_evidence_sources": sorted({p["rtl_source"] for p in per_trace.values()}),
        "shared_trace_count": len(per_trace),
        "rtl_traces_without_model_pair": sorted(missing_model),
        "per_trace": per_trace,
        "aggregate": {
            "e1_rtl_geomean_mpki": round(e1_rtl_geo, 6),
            "e1_model_geomean_mpki": round(e1_model_geo, 6),
            "cva6_model_geomean_mpki": round(cva6_model_geo, 6),
            "rtl_improvement_ratio_cva6_over_e1_rtl": (
                round(ratio_rtl_geo, 4) if ratio_rtl_geo is not None else None
            ),
        },
        "model_rtl_correlation": {
            "pearson_r": round(pearson, 6) if pearson is not None else None,
            "spearman_rho": round(spearman, 6) if spearman is not None else None,
            "e1_model_geomean_mpki": round(e1_model_geo, 6),
            "e1_rtl_geomean_mpki": round(e1_rtl_geo, 6),
            "geomean_relative_gap": (round(rel_geo_gap, 6) if rel_geo_gap is not None else None),
            "convergence_band_rel_gap": RTL_MODEL_REL_GAP_CONVERGED,
            "converged": converged,
        },
        "claim_policy": {
            "e1_side_is_rtl": True,
            "cva6_side_is_model": True,
            "comparison_held_at_lower_level": True,
            "spec2017_claim": False,
            "android_claim": False,
            "v8_claim": False,
            "reason": (
                "E1 MPKI measured on bpu_top.sv RTL via cocotb/Verilator over the same "
                "traces the behavioural head-to-head uses. CVA6 has no comparable open "
                "RTL predictor; its faithful behavioural model stands in. Synthetic "
                "generators are planning-only; CBP-5 traces back a CBP train-set "
                "comparison only; .btrace.json traces are the E1's own QEMU-RV64 "
                "duty-cycle workloads. This file does not back SPEC2017, AOSP, or "
                "JS-engine MPKI claims."
            ),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=EVIDENCE_PATH)
    parser.add_argument(
        "--print-only",
        action="store_true",
        help="emit JSON to stdout without writing to disk",
    )
    args = parser.parse_args()

    evidence = build_evidence()
    agg = evidence["aggregate"]
    corr = evidence["model_rtl_correlation"]
    print(
        f"eliza-evidence: status={evidence['comparison_status']} "
        f"E1 RTL geomean MPKI={agg['e1_rtl_geomean_mpki']} "
        f"CVA6 model geomean MPKI={agg['cva6_model_geomean_mpki']} "
        f"ratio={agg['rtl_improvement_ratio_cva6_over_e1_rtl']} "
        f"pearson={corr['pearson_r']} spearman={corr['spearman_rho']} "
        f"over {evidence['shared_trace_count']} shared traces",
        file=sys.stderr,
    )

    if args.print_only:
        json.dump(evidence, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
        return 0
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
    print(
        f"eliza-evidence: status={evidence['comparison_status']} "
        f"path={args.out.relative_to(ROOT)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
