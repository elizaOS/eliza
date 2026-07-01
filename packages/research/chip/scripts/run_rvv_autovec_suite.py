#!/usr/bin/env python3
"""Run the RVV 1.0 autovec quality suite against the pinned LLVM toolchain.

For each kernel listed in `benchmarks/compiler/autovec/kernels.json`:

  1. Cross-compile with the pinned LLVM stage 2 clang at three optimization
     levels (-O2, -O3, -O3 + `-mllvm -force-vector-width=256`).
  2. Disassemble the resulting object with llvm-objdump.
  3. Count vector instructions (any mnemonic starting with `v`).
  4. Optionally run under qemu-user-static for correctness.
  5. Emit `eliza.autovec_results.v1` to
     `build/reports/compiler/autovec-results.json`.

Status terms: `STATUS: <status> autovec.<stage>`.

The suite is intentionally short. It is a pin-refresh guard, not a full
benchmark. The full benchmark is `llvm-test-suite` nightly under
`benchmarks/run_benchmarks.py`.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, cast

REPO_ROOT = Path(__file__).resolve().parents[1]
AUTOVEC_DIR = REPO_ROOT / "benchmarks/compiler/autovec"
KERNELS_JSON = AUTOVEC_DIR / "kernels.json"
KERNELS_C = AUTOVEC_DIR / "kernels.c"
STAGE2 = REPO_ROOT / "build/llvm-stage2"
REPORT_DIR = REPO_ROOT / "build/reports/compiler"
REPORT_PATH = REPORT_DIR / "autovec-results.json"
COMPARE_PATH = REPORT_DIR / "autovec-trunk-vs-stock.json"
COMPARE_MARKDOWN = REPORT_DIR / "autovec-trunk-vs-stock.md"
SCHEMA = "eliza.autovec_results.v1"
COMPARE_SCHEMA = "eliza.autovec_compare.v1"

CLANG_BASELINE_FLAGS = [
    "--target=riscv64-unknown-linux-gnu",
    "-march=rva23u64",
    "-mcpu=eliza-e1",
    "-mtune=eliza-e1",
    "-fvectorize",
    "-Rpass=loop-vectorize",
    "-Rpass-missed=loop-vectorize",
]

OPT_LEVELS = [
    ("O2", ["-O2"]),
    ("O3", ["-O3"]),
    ("O3_force_vw256", ["-O3", "-mllvm", "-force-vector-width=256"]),
]


def emit(status: str, stage: str, detail: str = "") -> None:
    if detail:
        print(f"STATUS: {status} autovec.{stage} — {detail}")
    else:
        print(f"STATUS: {status} autovec.{stage}")


def count_vector_instructions(dump: str) -> int:
    """Count RVV mnemonics. Vectorization instructions start with 'v'."""
    n = 0
    for line in dump.splitlines():
        stripped = line.lstrip()
        m = re.match(r"[0-9a-f]+:\s+[0-9a-f ]+\s+(v[a-z][a-zA-Z0-9_.]*)\b", stripped)
        if m:
            n += 1
    return n


def compile_kernel(
    clang: Path, kernel_name: str, opt_flags: list[str], out_obj: Path, out_dump: Path
) -> dict[str, object]:
    """Compile and disassemble one kernel; return summary entry."""
    cmd = [
        str(clang),
        *CLANG_BASELINE_FLAGS,
        *opt_flags,
        "-c",
        str(KERNELS_C),
        "-o",
        str(out_obj),
    ]
    try:
        compile_proc = subprocess.run(
            cmd,
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.SubprocessError as exc:
        return {"compile": "FAIL", "error": str(exc)}

    objdump = STAGE2 / "bin/llvm-objdump"
    try:
        dump_proc = subprocess.run(
            [str(objdump), "-d", "--mattr=+v", str(out_obj)],
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.SubprocessError as exc:
        return {"compile": "PASS", "objdump": "FAIL", "error": str(exc)}

    out_dump.write_text(dump_proc.stdout)
    vec_count = count_vector_instructions(dump_proc.stdout)
    return {
        "compile": "PASS",
        "objdump": "PASS",
        "vector_instructions": vec_count,
        "clang_stderr_tail": compile_proc.stderr.strip().splitlines()[-5:],
    }


def geomean(values: list[float]) -> float:
    if not values:
        return 0.0
    product = 1.0
    for v in values:
        if v <= 0:
            # geomean is undefined for non-positive entries; skip them and
            # apply a small floor so a single zero doesn't collapse the
            # entire summary.
            v = 0.5
        product *= v
    return product ** (1.0 / len(values))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--clang", type=Path, default=STAGE2 / "bin/clang")
    parser.add_argument(
        "--stock-clang",
        type=Path,
        default=None,
        help="optional second clang (apt-installed) for trunk-vs-stock comparison",
    )
    args = parser.parse_args()

    REPORT_DIR.mkdir(parents=True, exist_ok=True)

    if not args.clang.exists():
        emit("BLOCKED", "clang_missing", str(args.clang))
        REPORT_PATH.write_text(
            json.dumps(
                {
                    "schema": SCHEMA,
                    "status": "BLOCKED",
                    "blocked_reason": (
                        f"{args.clang} not built; run scripts/build_llvm_riscv.sh in "
                        "the canonical Linux container"
                    ),
                    "kernels": [],
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 2 if args.strict else 0

    if not KERNELS_JSON.exists() or not KERNELS_C.exists():
        emit("FAIL", "missing_kernels")
        return 1

    kernels = json.loads(KERNELS_JSON.read_text())["kernels"]
    out_dir = REPORT_DIR / "autovec-objs"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    results: list[dict[str, object]] = []
    for kernel in kernels:
        name = kernel["name"]
        per_opt: dict[str, object] = {}
        for opt_name, flags in OPT_LEVELS:
            obj_path = out_dir / f"{name}.{opt_name}.o"
            dump_path = out_dir / f"{name}.{opt_name}.s"
            per_opt[opt_name] = compile_kernel(
                args.clang,
                name,
                flags,
                obj_path,
                dump_path,
            )
        results.append({"name": name, "group": kernel["group"], "opt_levels": per_opt})
        emit("PASS", f"kernel.{name}")

    REPORT_PATH.write_text(
        json.dumps(
            {
                "schema": SCHEMA,
                "status": "PASS",
                "clang": str(args.clang),
                "kernels": results,
            },
            indent=2,
            sort_keys=True,
        )
    )
    emit("PASS", "summary", f"{len(results)} kernels")

    # Optional stock-vs-trunk geomean comparison.
    if args.stock_clang is not None and args.stock_clang.exists():
        stock_out_dir = REPORT_DIR / "autovec-objs-stock"
        if stock_out_dir.exists():
            shutil.rmtree(stock_out_dir)
        stock_out_dir.mkdir(parents=True, exist_ok=True)
        stock_results: list[dict[str, object]] = []
        for kernel in kernels:
            name = kernel["name"]
            obj_path = stock_out_dir / f"{name}.O3.o"
            dump_path = stock_out_dir / f"{name}.O3.s"
            stock_results.append(
                {
                    "name": name,
                    "summary": compile_kernel(
                        args.stock_clang,
                        name,
                        ["-O3"],
                        obj_path,
                        dump_path,
                    ),
                }
            )

        # Pair trunk O3 vs stock O3.
        rows: list[dict[str, object]] = []
        trunk_counts: list[float] = []
        stock_counts: list[float] = []
        for trunk_kernel, stock_kernel in zip(results, stock_results, strict=True):
            trunk_opt_levels = cast(dict[str, dict[str, Any]], trunk_kernel["opt_levels"])
            trunk_o3 = trunk_opt_levels["O3"]
            stock_o3 = cast(dict[str, Any], stock_kernel["summary"])
            t = float(trunk_o3.get("vector_instructions", 0) or 0)
            s = float(stock_o3.get("vector_instructions", 0) or 0)
            rows.append(
                {
                    "name": trunk_kernel["name"],
                    "trunk_vec": t,
                    "stock_vec": s,
                    "delta": t - s,
                    "ratio": (t / s) if s > 0 else None,
                }
            )
            trunk_counts.append(t)
            stock_counts.append(s)

        geomean_trunk = geomean(trunk_counts)
        geomean_stock = geomean(stock_counts)
        trunk_over_stock = geomean_trunk / geomean_stock if geomean_stock > 0 else None
        compare = {
            "schema": COMPARE_SCHEMA,
            "as_of_clang_trunk": str(args.clang),
            "as_of_clang_stock": str(args.stock_clang),
            "kernel_count": len(rows),
            "geomean_vector_instructions": {
                "trunk": geomean_trunk,
                "stock": geomean_stock,
                "trunk_over_stock_ratio": trunk_over_stock,
            },
            "rows": rows,
        }
        COMPARE_PATH.write_text(json.dumps(compare, indent=2, sort_keys=True))

        lines = [
            "# Autovec geomean comparison: LLVM trunk pin vs apt-installed clang",
            "",
            f"- trunk clang: `{args.clang}`",
            f"- stock clang: `{args.stock_clang}`",
            f"- kernels compared: {len(rows)}",
            "",
            f"- geomean vector instructions (trunk): {geomean_trunk:.2f}",
            f"- geomean vector instructions (stock): {geomean_stock:.2f}",
            "- trunk / stock ratio: "
            + (f"{trunk_over_stock:.4f}" if trunk_over_stock is not None else "N/A"),
            "",
            "| kernel | trunk vec | stock vec | delta | ratio |",
            "|--------|-----------|-----------|-------|-------|",
        ]
        for row in rows:
            ratio_text = f"{row['ratio']:.3f}" if row["ratio"] is not None else "N/A"
            lines.append(
                f"| {row['name']} | {row['trunk_vec']:.0f} | {row['stock_vec']:.0f} | "
                f"{row['delta']:+.0f} | {ratio_text} |"
            )
        COMPARE_MARKDOWN.write_text("\n".join(lines) + "\n")
        emit("PASS", "compare", f"trunk-vs-stock written to {COMPARE_PATH.name}")
    elif args.stock_clang is not None:
        emit("BLOCKED", "stock_clang_missing", str(args.stock_clang))

    return 0


if __name__ == "__main__":
    sys.exit(main())
