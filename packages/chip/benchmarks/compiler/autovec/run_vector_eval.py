#!/usr/bin/env python3
"""run_vector_eval.py — functional RVV 1.0 vector evaluation.

Builds each driver-wrapped kernel twice (scalar rv64gc, vector rv64gcv),
runs both under QEMU user-mode on an RVV 1.0 substrate (rva23u64, vlen set
to E1's target), and measures the *dynamic* instruction stream of the kernel
region using QEMU's execlog TCG plugin.

The kernel region is the dynamic window bounded by the kernel_region_begin
and kernel_region_end markers emitted by driver.c, so the measurement
excludes libc startup, buffer fill, and the checksum fold.

Per kernel it reports:
  - dynamic instruction count, scalar vs vector,
  - dynamic vector instruction count and per-mnemonic histogram (vector build),
  - scalar/vector dynamic-instruction reduction factor,
  - whether the vector build actually emitted vector ops (autovec success).

This is a *functional* measurement (claim_level "functional"): it proves the
RVV 1.0 ISA + toolchain path executes end to end and quantifies how much work
the vector ISA removes from the dynamic stream. It is NOT a cycle-accurate or
silicon performance claim — QEMU does not model the e1 vector datapath timing.

Invoked by scripts/run_e1_rvv_vector.sh, which owns tool discovery and the
fail-closed evidence emission.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

# Vector mnemonics are exactly those whose disassembly begins with a 'v' that
# is an RVV instruction. We classify by the opcode field rather than guessing
# from the mnemonic prefix: RVV instructions occupy major opcode 0x57 (OP-V)
# for arithmetic/config and 0x07/0x27 (LOAD-FP/STORE-FP) with the vector
# encoding. Easiest robust signal from the execlog disassembly: the mnemonic
# token starts with 'v' AND is not a scalar pseudo. We use an allowlist regex
# over the documented RVV 1.0 mnemonic families to avoid false positives.
_VEC_MNEMONIC = re.compile(
    r"^v(set[iv]|l[esmox]|s[esmox]|add|sub|rsub|mul|mulh|div|rem|wadd|wsub|wmul|"
    r"wmacc|macc|nmsac|madd|nmsub|and|or|xor|sll|srl|sra|nsrl|nsra|min|max|"
    r"mseq|msne|mslt|msle|msgt|merge|mv|fadd|fsub|frsub|fmul|fdiv|frdiv|fmacc|"
    r"fnmacc|fmsac|fnmsac|fmadd|fnmadd|fmsub|fnmsub|fwadd|fwsub|fwmul|fwmacc|"
    r"fmin|fmax|fsgnj|fsqrt|frsqrt|frec|fcvt|fwcvt|fncvt|fmv|fclass|fmerge|"
    r"redsum|redmax|redmin|redand|redor|redxor|wredsum|fredusum|fredosum|"
    r"fredmax|fredmin|fwredusum|fwredosum|rgather|slide|compress|id|first|"
    r"popc|msbf|msif|msof|iota|zext|zext|sext|nclip|ssra|ssrl|ssub|sadd|"
    r"aadd|asub|smul|fclass|cpop|brev|rev|rol|ror|andn|clz|ctz)",
)

# execlog line format: "cpu, 0xPC, 0xOPCODE, \"disasm...\""
_LINE = re.compile(r'^\d+,\s*(0x[0-9a-f]+),\s*0x[0-9a-f]+,\s*"(.*)"\s*$')


def _mnemonic(disasm: str) -> str:
    return disasm.strip().split(None, 1)[0] if disasm.strip() else ""


def build(gcc: Path, march: str, kernel: str, driver: Path, kernels: Path, out: Path) -> None:
    cmd = [
        str(gcc), "-O3", f"-march={march}", "-mabi=lp64d",
        f"-DKERNEL_{kernel}=1",
        str(driver), str(kernels), "-lm", "-o", str(out),
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True)


def run_execlog(qemu: Path, cpu: str, plugin: Path, elf: Path, log: Path) -> int:
    # The driver's exit code is a checksum byte, so a non-zero status is
    # expected and is returned for the scalar/vector divergence check rather
    # than treated as a failure.
    with log.open("wb") as fh:
        proc = subprocess.run(
            [str(qemu), "-cpu", cpu, "-plugin", str(plugin), "-d", "plugin", str(elf)],
            stdout=subprocess.DEVNULL, stderr=fh,
        )
    return proc.returncode


def symbol_pc(objdump: Path, elf: Path, name: str) -> str:
    out = subprocess.run(
        [str(objdump), "-t", str(elf)], check=True, capture_output=True, text=True
    ).stdout
    for line in out.splitlines():
        if line.rstrip().endswith(" " + name) or line.rstrip().endswith("\t" + name):
            return "0x" + line.split()[0].lstrip("0").rjust(1, "0")
    raise RuntimeError(f"symbol {name} not found in {elf}")


def measure_region(log: Path, begin_pc: str, end_pc: str) -> tuple[int, int, dict[str, int]]:
    """Count dynamic insns in the window between the first execution of
    begin_pc and the first subsequent execution of end_pc. Returns
    (total_dynamic, vector_dynamic, vector_histogram)."""
    begin = int(begin_pc, 16)
    end = int(end_pc, 16)
    total = 0
    vec = 0
    hist: dict[str, int] = {}
    in_region = False
    with log.open("r", errors="replace") as fh:
        for raw in fh:
            m = _LINE.match(raw)
            if not m:
                continue
            pc = int(m.group(1), 16)
            disasm = m.group(2)
            if not in_region:
                if pc == begin:
                    in_region = True
                continue
            if pc == end:
                break
            total += 1
            mn = _mnemonic(disasm)
            if _VEC_MNEMONIC.match(mn):
                vec += 1
                hist[mn] = hist.get(mn, 0) + 1
    if not in_region:
        raise RuntimeError(f"region begin {begin_pc} never executed in {log}")
    return total, vec, hist


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gcc", required=True, type=Path)
    ap.add_argument("--objdump", required=True, type=Path)
    ap.add_argument("--qemu", required=True, type=Path)
    ap.add_argument("--plugin", required=True, type=Path)
    ap.add_argument("--cpu", required=True)
    ap.add_argument("--vlen", type=int, required=True)
    ap.add_argument("--driver", required=True, type=Path)
    ap.add_argument("--kernels-c", required=True, type=Path)
    ap.add_argument("--kernels-json", required=True, type=Path)
    ap.add_argument("--build-dir", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    args.build_dir.mkdir(parents=True, exist_ok=True)
    spec = json.loads(args.kernels_json.read_text())

    # Kernels the driver wraps (driver.c uses -DKERNEL_<name>). 2D / collision
    # kernels (conv2d, rope, histogram, trmv) are out of this functional sweep.
    driver_src = args.driver.read_text()
    wrapped = {
        k["name"] for k in spec["kernels"]
        if f"KERNEL_{k['name']}" in driver_src
    }

    results = []
    for entry in spec["kernels"]:
        name = entry["name"]
        if name not in wrapped:
            continue
        v_elf = args.build_dir / f"{name}.rv64gcv.elf"
        s_elf = args.build_dir / f"{name}.rv64gc.elf"
        build(args.gcc, "rv64gcv", name, args.driver, args.kernels_c, v_elf)
        build(args.gcc, "rv64gc", name, args.driver, args.kernels_c, s_elf)

        begin = symbol_pc(args.objdump, v_elf, "kernel_region_begin")
        end = symbol_pc(args.objdump, v_elf, "kernel_region_end")
        s_begin = symbol_pc(args.objdump, s_elf, "kernel_region_begin")
        s_end = symbol_pc(args.objdump, s_elf, "kernel_region_end")

        v_log = args.build_dir / f"{name}.rv64gcv.execlog"
        s_log = args.build_dir / f"{name}.rv64gc.execlog"
        v_exit = run_execlog(args.qemu, args.cpu, args.plugin, v_elf, v_log)
        s_exit = run_execlog(args.qemu, args.cpu, args.plugin, s_elf, s_log)

        v_total, v_vec, v_hist = measure_region(v_log, begin, end)
        s_total, s_vec, _ = measure_region(s_log, s_begin, s_end)

        reduction = round(s_total / v_total, 3) if v_total else None
        results.append({
            "kernel": name,
            "group": entry.get("group"),
            "elem_type": entry.get("elem_type"),
            "expected_vectorized": entry.get("expected_vectorized"),
            "scalar_dynamic_insns": s_total,
            "vector_dynamic_insns": v_total,
            "vector_dynamic_vec_ops": v_vec,
            "scalar_dynamic_vec_ops": s_vec,
            "dynamic_insn_reduction_x": reduction,
            "autovectorized": v_vec > 0,
            "result_checksum_match": v_exit == s_exit,
            "vector_op_histogram": dict(sorted(v_hist.items(), key=lambda kv: -kv[1])),
        })
        print(f"  {name:28s} scalar={s_total:>9d}  vector={v_total:>9d}  "
              f"reduction={reduction}x  vec_ops={v_vec}", file=sys.stderr)

    vectorized = [r for r in results if r["autovectorized"]]
    reductions = [r["dynamic_insn_reduction_x"] for r in vectorized
                  if r["dynamic_insn_reduction_x"]]
    geomean = None
    if reductions:
        prod = 1.0
        for r in reductions:
            prod *= r
        geomean = round(prod ** (1.0 / len(reductions)), 3)

    all_ops: dict[str, int] = {}
    for r in vectorized:
        for op, c in r["vector_op_histogram"].items():
            all_ops[op] = all_ops.get(op, 0) + c

    report = {
        "schema": "eliza.cpu_vector_eval.v1",
        "generated_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "substrate": "qemu-user",
        "substrate_detail": {
            "qemu_cpu": args.cpu,
            "vlen_bits": args.vlen,
            "qemu_binary": str(args.qemu),
            "plugin": str(args.plugin),
        },
        "rvv_version": "1.0",
        "vlen_bits": args.vlen,
        "elen_bits": 64,
        "isa_baseline": "rv64gc",
        "isa_vector": "rv64gcv",
        "compiler": "riscv-none-elf-gcc 15.2.0 (xpack)",
        "claim_level": "functional",
        "metric": "dynamic_instruction_count (kernel region, execlog-windowed)",
        "kernel_count": len(results),
        "autovectorized_count": len(vectorized),
        "checksum_mismatches": [r["kernel"] for r in results
                                if not r["result_checksum_match"]],
        "checksum_note": (
            "A mismatch on a floating-point reduction kernel (e.g. "
            "dot_product_f32_unrolled4) is expected: vectorized reductions "
            "sum elements in a different order than the scalar loop and FP "
            "addition is non-associative. This is a numeric ordering "
            "difference, not a functional defect. Integer kernels must match."
        ),
        "geomean_dynamic_insn_reduction_x": geomean,
        "rvv_ops_exercised": sorted(all_ops.keys()),
        "rvv_op_dynamic_histogram": dict(sorted(all_ops.items(), key=lambda kv: -kv[1])),
        "kernels": results,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    print(f"wrote {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
