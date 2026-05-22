#!/usr/bin/env python3
"""Capture a real RV64 branch trace of the E1 agent-loop workload.

Pipeline (privilege-free, native-toolchain, ISA-faithful to the E1 RV64
target — no perf, no Docker):

  1. cross-compile ``workloads/agent_loop.c`` with riscv64-linux-gnu-gcc
  2. run it under ``qemu-riscv64`` user mode with QEMU's ``libexeclog`` TCG
     plugin, capturing one line per retired instruction
  3. decode the instruction stream to an exact branch-event trace
     (:func:`benchmarks.cpu.branch.workload_trace.decode_execlog`) and write
     a ``.btrace.json`` document under ``external/workload-traces/``

The raw trace lands in the gitignored ``external/`` tree; the committed
artifact is the MPKI evidence emitted by ``run_mpki.py`` over the trace.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from benchmarks.cpu.branch.workload_trace import (  # noqa: E402
    decode_execlog,
    write_workload_trace,
)

WORKLOADS_DIR = ROOT / "benchmarks/cpu/branch/workloads"
TRACE_DIR = ROOT / "external/workload-traces"
QEMU = ROOT / "external/qemu-build/bin/qemu-riscv64"
EXECLOG_PLUGIN = ROOT / "external/qemu-src/build/contrib/plugins/libexeclog.so"
CROSS_CC_CANDIDATES = (
    "riscv64-linux-gnu-gcc",
    str(ROOT / "tools/bin/riscv64-linux-gnu-gcc"),
)


def _find_cc() -> str | None:
    for cc in CROSS_CC_CANDIDATES:
        if shutil.which(cc) or Path(cc).is_file():
            return cc
    return None


def _blocked(reason: str) -> int:
    print(f"STATUS: BLOCKED bpu.workload_trace - {reason}", file=sys.stderr)
    return 2


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--name", default="agent_loop", help="trace base name")
    ap.add_argument(
        "--src",
        default="agent_loop.c",
        help="workload C source under benchmarks/cpu/branch/workloads/",
    )
    ap.add_argument(
        "--steps",
        type=int,
        default=96,
        help="workload scale argv[1] (controls trace length)",
    )
    ap.add_argument(
        "--mode",
        type=int,
        default=0,
        help="workload mode argv[2] (domain/variant selector)",
    )
    ap.add_argument(
        "--keep-execlog",
        action="store_true",
        help="retain the raw execlog text (large) next to the trace",
    )
    args = ap.parse_args()

    workload_src = WORKLOADS_DIR / args.src
    if not workload_src.is_file():
        return _blocked(f"workload source not found: {workload_src.relative_to(ROOT)}")

    cc = _find_cc()
    if cc is None:
        return _blocked("no riscv64-linux-gnu-gcc on PATH or in tools/bin")
    if not QEMU.is_file():
        return _blocked(f"missing {QEMU.relative_to(ROOT)} (build external/qemu-build)")
    if not EXECLOG_PLUGIN.is_file():
        return _blocked(f"missing execlog plugin {EXECLOG_PLUGIN.relative_to(ROOT)}")

    TRACE_DIR.mkdir(parents=True, exist_ok=True)
    binary = TRACE_DIR / f"{args.name}.rv64"
    execlog = TRACE_DIR / f"{args.name}.execlog.txt"
    out_trace = TRACE_DIR / f"{args.name}.btrace.json"

    print(f"eliza-bpu: cross-compiling {workload_src.name} -> {binary.name}")
    rc = subprocess.run(
        [cc, "-O2", "-static", str(workload_src), "-o", str(binary)],
        cwd=str(ROOT),
        check=False,
    ).returncode
    if rc != 0:
        return _blocked(f"cross-compile failed (rc={rc})")

    print(f"eliza-bpu: tracing under qemu-riscv64 (+execlog), steps={args.steps}")
    rc = subprocess.run(
        [
            str(QEMU),
            "-plugin",
            str(EXECLOG_PLUGIN),
            "-d",
            "plugin",
            "-D",
            str(execlog),  # libexeclog writes the instruction stream here
            str(binary),
            str(args.steps),
            str(args.mode),
        ],
        cwd=str(ROOT),
        check=False,
    ).returncode
    if rc != 0:
        return _blocked(f"qemu run failed (rc={rc})")

    print(f"eliza-bpu: decoding {execlog.name}")
    branches, stats = decode_execlog(execlog)
    if stats.branch_count == 0:
        return _blocked("decoded zero branches — check execlog format")

    write_workload_trace(
        out_trace,
        branches,
        stats,
        source={
            "workload": args.name,
            "src": args.src,
            "isa": "rv64gc",
            "toolchain": cc,
            "qemu": "qemu-riscv64 user-mode + libexeclog",
            "scale": args.steps,
            "mode": args.mode,
        },
    )
    if not args.keep_execlog:
        execlog.unlink(missing_ok=True)

    s = stats.as_dict()
    print(f"eliza-bpu: status=PASS trace={out_trace.relative_to(ROOT)}")
    print(
        f"  instructions={s['instruction_count']:,} branches={s['branch_count']:,}"
        f" cond={s['cond_branch_count']:,} call={s['call_count']:,}"
        f" ret={s['return_count']:,} indirect={s['indirect_branch_count']:,}"
        f" direct_jump={s['direct_jump_count']:,}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
