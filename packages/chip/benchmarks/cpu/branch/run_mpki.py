#!/usr/bin/env python3
"""MPKI evaluation harness for the Eliza E1 BPU.

Two evaluation backends are exposed:

  * ``rtl`` (default): drives the synthetic traces through ``bpu_top.sv``
    via the existing cocotb harness in ``verify/cocotb/bpu``. The cocotb
    test (``test_bpu_mpki.py``) is the only path that produces the
    ``schema=eliza.bpu_mpki.v1`` evidence consumed by
    ``docs/evidence/cpu_ap/mpki_results_synthetic.json``. Requires
    Verilator or Icarus Verilog plus cocotb on the active Python.

  * ``model``: runs the behavioural :class:`BPUSimulator` only. Useful
    when no local simulator is available, or for quickly sweeping geometry
    knobs. Writes a separate ``schema=eliza.bpu_mpki_model.v1`` envelope
    under ``benchmarks/results/`` so the model output is never confused
    with the RTL output.

External traces (.bin CBP-5 or .jsonl) remain BLOCKED on the RTL path
because the cocotb harness does not yet ingest external files. They can
still be replayed against the behavioural model via ``--backend model
--trace path``.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from benchmarks.cpu.branch.bpu_model import DEFAULT_GEOMETRY, BPUSimulator  # noqa: E402
from benchmarks.cpu.branch.traces import (  # noqa: E402
    SYNTHETIC_GENERATORS,
    read_cbp5_with_count,
    read_jsonl,
)
from benchmarks.cpu.branch.workload_trace import read_workload_trace  # noqa: E402

RESULTS_DIR = ROOT / "benchmarks/results"
EVIDENCE_DIR = ROOT / "docs/evidence/cpu_ap"
RTL_EVIDENCE_PATH = EVIDENCE_DIR / "mpki_results_synthetic.json"
CBP5_EVIDENCE_PATH = EVIDENCE_DIR / "mpki_results_cbp5.json"
MODEL_EVIDENCE_PATH = RESULTS_DIR / "branch-prediction-mpki-model.json"
DEFAULT_SYNTHETIC = list(SYNTHETIC_GENERATORS.keys())

# Workload-class averages for CBP2016 64KB TAGE-SC-L on the CBP2025 training
# trace set, computed from reference_results_training_set.csv in
# https://github.com/ramisheikh/cbp2025 (commit 6074966). Per-trace MPKI from
# the CSV are used directly when the trace stem matches.
CBP5_REFERENCE_BY_CLASS: dict[str, float] = {
    "int": 4.700,
    "fp": 4.015,
    "web": 3.884,
    "compress": 2.799,
    "infra": 2.631,
    "media": 1.062,
}
# Per-sample reference MPKI for the two sample traces shipped with the CBP2025
# repo. The samples are short prefixes of `int_0_trace` / `fp_0_trace`; their
# absolute MPKI is small-window noise and is recorded here only as a wiring
# cross-check, not as a CBP-class claim.
CBP5_REFERENCE_PER_TRACE: dict[str, float] = {
    # Reference numbers from running the CBP2025 stock 64KB TAGE-SC-L on
    # int_0_trace / fp_0_trace at full length (per reference CSV).
    "int_0_trace": 5.1327,
    "fp_0_trace": 0.5736,
}


# ---------------------------------------------------------------------------
# RTL backend (cocotb)
# ---------------------------------------------------------------------------


def _has_simulator() -> bool:
    """Return True iff a usable simulator is on PATH (after sourcing the
    repo-local oss-cad-suite prepend, mirroring run_cocotb_bpu.sh)."""
    candidate_paths = []
    bundled = ROOT / "external/oss-cad-suite/bin"
    if bundled.is_dir():
        candidate_paths.append(str(bundled))
    env_path = os.environ.get("PATH", "")
    search_path = os.pathsep.join(candidate_paths + [env_path]) if candidate_paths else env_path
    return any(shutil.which(tool, path=search_path) for tool in ("verilator", "iverilog"))


def _has_cocotb() -> bool:
    try:
        import cocotb  # noqa: F401
    except ImportError:
        return False
    return True


def run_rtl_backend(out: Path) -> int:
    """Invoke the cocotb MPKI harness; it writes ``out`` directly."""
    out.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["ELIZA_BPU_MPKI_JSON"] = str(out)
    env["COCOTB_DIR"] = "verify/cocotb/bpu"
    env["COCOTB_MODULE"] = "test_bpu_mpki"
    env["COCOTB_TOPLEVEL"] = "bpu_top_tb"
    env["REQUIRE_BPU_COCOTB"] = "1"
    # Force the runner to fail closed if cocotb is missing rather than
    # silently emitting STATUS: BLOCKED — the model backend is the explicit
    # fallback path that a caller must opt into.
    env["REQUIRE_COCOTB"] = "1"
    bundled = ROOT / "external/oss-cad-suite/bin"
    if bundled.is_dir():
        env["PATH"] = f"{bundled}{os.pathsep}{env.get('PATH', '')}"
    cmd = [str(ROOT / "scripts/run_cocotb_bpu.sh")]
    print(f"eliza-evidence: running RTL MPKI harness -> {out.relative_to(ROOT)}")
    result = subprocess.run(cmd, cwd=str(ROOT), env=env, check=False)
    if result.returncode != 0:
        return result.returncode
    if not out.is_file():
        print(
            f"eliza-evidence: status=BLOCKED reason=cocotb harness exited 0 but did not "
            f"write {out.relative_to(ROOT)}",
            file=sys.stderr,
        )
        return 3
    print(f"eliza-evidence: status=PASS path={out.relative_to(ROOT)}")
    return 0


# ---------------------------------------------------------------------------
# Model backend (behavioural BPUSimulator)
# ---------------------------------------------------------------------------


def evaluate_synthetic_model(
    generators: Iterable[str],
    instructions_per_branch_estimate: int = 5,
) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for name in generators:
        gen = SYNTHETIC_GENERATORS[name]
        events = list(gen())
        instructions = len(events) * instructions_per_branch_estimate
        sim = BPUSimulator()
        sim.feed(events)
        out[name] = {
            "trace_class": "synthetic_planning_only",
            "branches": len(events),
            "instruction_count_estimate": instructions,
            "mpki": sim.mpki(instructions),
            "counters": sim.stats(),
        }
    return out


def _classify_cbp5_stem(stem: str) -> str | None:
    """Map a CBP-5 trace stem (e.g. ``int_3_trace``) to its workload class."""
    for cls in CBP5_REFERENCE_BY_CLASS:
        if stem.startswith(cls + "_") or stem == cls:
            return cls
    if stem.startswith("sample_int"):
        return "int"
    if stem.startswith("sample_fp"):
        return "fp"
    return None


def evaluate_external_model(traces: list[Path]) -> dict[str, dict]:
    """Run the behavioural BPU model on a list of external trace files.

    For CBP-5 ``.gz`` traces, instruction and branch counts come from the
    actual trace; MPKI is computed against the true retired-instruction
    count so the number is directly comparable to the CBP2025 stock-sim
    output (which uses the same formula).
    """
    out: dict[str, dict] = {}
    for path in traces:
        if path.name.endswith(".btrace.json"):
            branches, inst_count = read_workload_trace(path)
            sim = BPUSimulator()
            sim.feed(branches)
            mpki = sim.mpki(inst_count) if inst_count else 0.0
            out[path.name[: -len(".btrace.json")]] = {
                "trace_class": "qemu_rv64_workload",
                "branches": len(branches),
                "instruction_count": inst_count,
                "mpki": round(mpki, 6),
                "counters": sim.stats(),
            }
            continue
        ext = path.suffix.lower()
        if ext == ".gz":
            branches, stats = read_cbp5_with_count(path)
            inst_count = stats.instruction_count
            trace_class = "cbp5_train_traces_only"
            cls = _classify_cbp5_stem(path.stem)
            cbp5_ref = CBP5_REFERENCE_PER_TRACE.get(
                path.stem.replace("sample_", "").replace("_trace", "_0_trace")
            )
            if cbp5_ref is None and cls is not None:
                cbp5_ref = CBP5_REFERENCE_BY_CLASS[cls]
            extra_meta: dict[str, object] = {
                "branch_stats": stats.as_dict(),
                "cbp5_workload_class": cls,
                "cbp5_tage_sc_l_64kb_reference_mpki": cbp5_ref,
            }
        elif ext == ".jsonl":
            branches = list(read_jsonl(path))
            inst_count = len(branches) * 5
            trace_class = "jsonl_external_trace"
            extra_meta = {
                "instruction_count_estimate_basis": "5 instructions per branch",
            }
        else:
            raise ValueError(f"unsupported trace extension {ext} on {path}")

        sim = BPUSimulator()
        sim.feed(branches)
        mpki = sim.mpki(inst_count) if inst_count else 0.0

        out[path.stem] = {
            "trace_class": trace_class,
            "branches": len(branches),
            "instruction_count": inst_count,
            "mpki": round(mpki, 6),
            "counters": sim.stats(),
            **extra_meta,
        }
    return out


def _expand_trace_paths(inputs: Iterable[Path]) -> list[Path]:
    """Resolve ``--trace`` arguments that may be files or directories.

    Directories are searched non-recursively for ``*.gz`` and ``*.jsonl``
    so a single ``--trace external/cbp5-traces/`` argument picks up the
    whole CBP-5 set.
    """
    out: list[Path] = []
    for p in inputs:
        if p.is_dir():
            out.extend(sorted(p.glob("*.gz")))
            out.extend(sorted(p.glob("*.jsonl")))
            out.extend(sorted(p.glob("*.btrace.json")))
        elif p.is_file():
            out.append(p)
        else:
            raise FileNotFoundError(f"trace path does not exist: {p}")
    return out


def _build_cbp5_envelope(external_results: dict[str, dict]) -> dict[str, object]:
    """Construct the ``eliza.bpu_mpki.v1`` envelope for CBP-5 traces."""
    aggregate_inst = sum(r["instruction_count"] for r in external_results.values())
    aggregate_branches = sum(r["branches"] for r in external_results.values())
    aggregate_misp = sum(int(r["counters"].get("misp", 0)) for r in external_results.values())
    aggregate_mpki = (aggregate_misp * 1000.0 / aggregate_inst) if aggregate_inst else 0.0
    return {
        "schema": "eliza.bpu_mpki.v1",
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "harness": "behavioural-bpu-model",
        "evidence_class": "cbp5_train_traces_only",
        "geometry": {
            key: list(value) if isinstance(value, tuple) else value
            for key, value in DEFAULT_GEOMETRY.items()
        },
        "workloads": external_results,
        "aggregate": {
            "branch_count": aggregate_branches,
            "instruction_count": aggregate_inst,
            "misprediction_count": aggregate_misp,
            "mpki": round(aggregate_mpki, 6),
        },
        "cbp5_tage_sc_l_64kb_reference_mpki_by_class": CBP5_REFERENCE_BY_CLASS,
        "cbp5_tage_sc_l_64kb_reference_mpki_by_trace": CBP5_REFERENCE_PER_TRACE,
        "claim_policy": {
            "evidence_class": "cbp5_train_traces_only",
            "cbp5_claim": True,
            "spec2017_claim": False,
            "android_claim": False,
            "v8_claim": False,
            "reason": (
                "BPU MPKI measured against CBP2025 training traces"
                " (ramisheikh/cbp2025) using the in-tree behavioural BPU"
                " model. Numbers compare directly to the CBP2016 64KB"
                " TAGE-SC-L reference from"
                " reference_results_training_set.csv. These are CBP-5"
                " train-set numbers only; they do not back SPEC2017,"
                " AOSP, or JS-engine MPKI claims."
            ),
        },
    }


def run_model_backend(
    out: Path,
    synthetic: list[str],
    external_traces: list[Path],
    print_only: bool,
    cbp5_out: Path | None,
) -> int:
    synthetic_results = evaluate_synthetic_model(synthetic)
    external_results = evaluate_external_model(external_traces)

    evidence = {
        "schema": "eliza.bpu_mpki_model.v1",
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "geometry": {
            key: list(value) if isinstance(value, tuple) else value
            for key, value in DEFAULT_GEOMETRY.items()
        },
        "workloads": {
            "synthetic": synthetic_results,
            "external": external_results,
        },
        "claim_policy": {
            "synthetic_workloads_are_planning_only": True,
            "real_workload_claims_require_external_traces": True,
            "spec2017_claim": False,
            "android_claim": False,
            "v8_claim": False,
            "model_is_planning_only": True,
            "reason": (
                "Behavioural BPU model output. Synthetic workloads exercise the"
                " model's control paths but do not represent SPEC2017, AOSP, or"
                " JS-engine workloads. The RTL-backed evidence at"
                " docs/evidence/cpu_ap/mpki_results_synthetic.json is the"
                " load-bearing artifact; this file is provided for cross-check"
                " only."
            ),
        },
    }

    if print_only:
        json.dump(evidence, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
    else:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
        print(f"eliza-evidence: status=PASS path={out.relative_to(ROOT)}")

    if cbp5_out is not None and external_results:
        cbp5_envelope = _build_cbp5_envelope(external_results)
        cbp5_out.parent.mkdir(parents=True, exist_ok=True)
        cbp5_out.write_text(json.dumps(cbp5_envelope, indent=2, sort_keys=True) + "\n")
        print(f"eliza-evidence: status=PASS cbp5 path={cbp5_out.relative_to(ROOT)}")

    return 0


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--backend",
        choices=("rtl", "model", "auto"),
        default="auto",
        help=(
            "rtl: run cocotb against bpu_top.sv (requires verilator/iverilog +"
            " cocotb); model: run behavioural BPUSimulator only; auto: rtl when"
            " available, otherwise model (default)"
        ),
    )
    parser.add_argument(
        "--synthetic",
        nargs="*",
        default=DEFAULT_SYNTHETIC,
        help="synthetic workload names to evaluate (default: all)",
    )
    parser.add_argument(
        "--trace",
        "--traces",
        type=Path,
        action="append",
        default=[],
        help=(
            "path to an external trace file (.gz CBP-5 or .jsonl), or a"
            " directory containing them; model backend only"
        ),
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help=(
            "evidence JSON output path; defaults to "
            "docs/evidence/cpu_ap/mpki_results_synthetic.json (rtl) or "
            "benchmarks/results/branch-prediction-mpki-model.json (model)"
        ),
    )
    parser.add_argument(
        "--cbp5-out",
        type=Path,
        default=None,
        help=(
            "additional evidence file for CBP-5 traces only (schema"
            " eliza.bpu_mpki.v1, evidence_class cbp5_train_traces_only);"
            " defaults to docs/evidence/cpu_ap/mpki_results_cbp5.json when"
            " at least one .gz trace is provided"
        ),
    )
    parser.add_argument(
        "--print-only",
        action="store_true",
        help="model backend only: emit JSON to stdout without writing to disk",
    )
    args = parser.parse_args()

    for name in args.synthetic:
        if name not in SYNTHETIC_GENERATORS:
            print(f"unknown synthetic generator: {name}", file=sys.stderr)
            return 2

    backend = args.backend
    if backend == "auto":
        backend = "rtl" if (_has_simulator() and _has_cocotb()) else "model"
        print(f"eliza-evidence: backend=auto selected={backend}")

    if backend == "rtl":
        if args.trace:
            print(
                "RTL backend does not yet ingest external traces; rerun with"
                " --backend model to use --trace",
                file=sys.stderr,
            )
            return 2
        if not _has_simulator():
            print(
                "STATUS: BLOCKED bpu.mpki - no local RTL simulator (verilator/iverilog)",
                file=sys.stderr,
            )
            return 2
        if not _has_cocotb():
            print(
                "STATUS: BLOCKED bpu.mpki - cocotb not importable on active Python",
                file=sys.stderr,
            )
            return 2
        out = args.out or RTL_EVIDENCE_PATH
        return run_rtl_backend(out)

    # Model backend.
    out = args.out or MODEL_EVIDENCE_PATH
    expanded_traces = _expand_trace_paths(args.trace)
    has_cbp5 = any(p.suffix.lower() == ".gz" for p in expanded_traces)
    cbp5_out: Path | None
    if args.cbp5_out is not None:
        cbp5_out = args.cbp5_out
    elif has_cbp5 and not args.print_only:
        cbp5_out = CBP5_EVIDENCE_PATH
    else:
        cbp5_out = None
    return run_model_backend(out, args.synthetic, expanded_traces, args.print_only, cbp5_out)


if __name__ == "__main__":
    raise SystemExit(main())
