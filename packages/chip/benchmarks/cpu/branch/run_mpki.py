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
    read_cbp5,
    read_jsonl,
)

RESULTS_DIR = ROOT / "benchmarks/results"
EVIDENCE_DIR = ROOT / "docs/evidence/cpu_ap"
RTL_EVIDENCE_PATH = EVIDENCE_DIR / "mpki_results_synthetic.json"
MODEL_EVIDENCE_PATH = RESULTS_DIR / "branch-prediction-mpki-model.json"
DEFAULT_SYNTHETIC = list(SYNTHETIC_GENERATORS.keys())


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


def evaluate_external_model(traces: list[Path]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for path in traces:
        ext = path.suffix.lower()
        if ext == ".bin":
            iterator = read_cbp5(path)
            cls = "cbp5_binary_real_workload"
        elif ext == ".jsonl":
            iterator = read_jsonl(path)
            cls = "jsonl_external_trace"
        else:
            raise ValueError(f"unsupported trace extension {ext} on {path}")
        sim = BPUSimulator()
        branches = 0
        for event in iterator:
            sim.feed([event])
            branches += 1
        out[path.stem] = {
            "trace_class": cls,
            "branches": branches,
            "instruction_count_estimate": branches * 5,
            "mpki": sim.mpki(branches * 5),
            "counters": sim.stats(),
        }
    return out


def run_model_backend(
    out: Path,
    synthetic: list[str],
    external_traces: list[Path],
    print_only: bool,
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
        type=Path,
        action="append",
        default=[],
        help="path to an external trace file (.bin CBP-5 or .jsonl); model backend only",
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
    return run_model_backend(out, args.synthetic, args.trace, args.print_only)


if __name__ == "__main__":
    raise SystemExit(main())
