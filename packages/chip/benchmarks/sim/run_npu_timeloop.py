#!/usr/bin/env python3
"""Run Timeloop / Accelergy against the E1 NPU architecture description.

This driver is intentionally fail-closed:

- If the ``timeloop-mapper`` or ``accelergy`` binaries are not on PATH, it
  emits a ``status: blocked`` report with a clear BLOCKED reason and exits
  with code 0 (a blocked-by-missing-tool result is a planning artifact,
  not a regression). Strict pipelines that want a hard fail call this
  script with ``--require-tools``.
- When the binaries are present, the driver runs ``timeloop-mapper`` on
  ``benchmarks/sim/configs/e1_npu_timeloop_arch.yaml`` for every kernel
  declared in ``benchmarks/sim/run_npu_scale_sim.py`` and harvests the
  reported energy column.

No fabricated energy / cycle numbers are produced. The output is a
``provenance: simulator`` JSON whose only metric is the modeled
``energy_joules_per_inference``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from compiler.runtime.e1_npu_scale_model import (  # noqa: E402
    MIN_REAL_V1,
    OPEN_2028_FIRST,
    OPEN_2028_SOTA,
    OPEN_2028_STRETCH,
    NpuScaleConfig,
    estimate_attention_qk_s8,
    estimate_conv2d_s8,
    estimate_gemm_s8,
)

CONFIGS = {
    MIN_REAL_V1.name: MIN_REAL_V1,
    OPEN_2028_FIRST.name: OPEN_2028_FIRST,
    OPEN_2028_STRETCH.name: OPEN_2028_STRETCH,
    OPEN_2028_SOTA.name: OPEN_2028_SOTA,
}
ARCH_YAML = ROOT / "benchmarks/sim/configs/e1_npu_timeloop_arch.yaml"


@dataclass(frozen=True)
class TimeloopTool:
    name: str
    binary: str


REQUIRED_TOOLS = (
    TimeloopTool(name="timeloop-mapper", binary="timeloop-mapper"),
    TimeloopTool(name="accelergy", binary="accelergy"),
)


def file_hash(path: Path) -> dict[str, str | int]:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return {
        "path": str(path.relative_to(ROOT)),
        "sha256": digest.hexdigest(),
        "bytes": path.stat().st_size,
    }


def tool_status() -> list[dict[str, str | bool]]:
    statuses: list[dict[str, str | bool]] = []
    for tool in REQUIRED_TOOLS:
        path = shutil.which(tool.binary)
        statuses.append(
            {
                "name": tool.name,
                "binary": tool.binary,
                "available": path is not None,
                "path": path or "",
            }
        )
    return statuses


def blocked_report(reason: str, statuses: list[dict[str, str | bool]]) -> dict[str, Any]:
    return {
        "schema": "eliza.npu_timeloop_energy.v1",
        "status": "blocked",
        "provenance": "simulator",
        "claim_boundary": (
            "Timeloop/Accelergy modeled energy only; not measured RTL, "
            "silicon power, or phone-class energy evidence."
        ),
        "blocker": {
            "reason": reason,
            "required_tools": [tool.binary for tool in REQUIRED_TOOLS],
            "resolution": (
                "Install timeloop (timeloop-mapper) and accelergy in tools/bin "
                "or on PATH, then re-run benchmarks/sim/run_npu_timeloop.py."
            ),
        },
        "tools": statuses,
        "arch_yaml": file_hash(ARCH_YAML) if ARCH_YAML.is_file() else None,
        "kernels": [],
        "summary": {
            "kernel_count": 0,
            "energy_joules_per_inference": None,
        },
    }


def build_workload(config: NpuScaleConfig):
    return [
        estimate_gemm_s8(config, 4096, 4096, 4096),
        estimate_gemm_s8(config, 1024, 1024, 4096),
        estimate_conv2d_s8(config, 1, 56, 56, 256, 256, 3, 3),
        estimate_attention_qk_s8(config, 1, 16, 2048, 2048, 128),
    ]


def write_problem_yaml(target: Path, m: int, n: int, k: int) -> None:
    text = (
        "problem:\n"
        '  shape: { name: "GEMM", dimensions: [M, N, K] }\n'
        "  instance:\n"
        f"    M: {m}\n"
        f"    N: {n}\n"
        f"    K: {k}\n"
    )
    target.write_text(text, encoding="utf-8")


def parse_timeloop_energy(stdout: str) -> float | None:
    for line in stdout.splitlines():
        if line.strip().lower().startswith("energy ="):
            try:
                return float(line.split("=", 1)[1].split()[0])
            except (ValueError, IndexError):
                return None
    return None


def run_timeloop_for_kernel(estimate, config: NpuScaleConfig) -> dict[str, Any]:
    if estimate.kernel.startswith("gemm"):
        m, k, n = estimate.macs // (estimate.macs and 1), 4096, 1
    m = max(1, estimate.macs // max(1, config.int8_macs_per_tile_per_cycle * config.tiles))
    n = 1
    k = max(1, estimate.macs // m // n) if m and n else 1
    with tempfile.TemporaryDirectory() as workdir:
        work = Path(workdir)
        problem = work / "problem.yaml"
        write_problem_yaml(problem, m, n, k)
        try:
            completed = subprocess.run(
                [
                    "timeloop-mapper",
                    str(ARCH_YAML),
                    str(problem),
                ],
                cwd=work,
                capture_output=True,
                check=False,
                text=True,
                timeout=600,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            return {
                "kernel": estimate.kernel,
                "status": "error",
                "error": str(exc),
                "energy_joules_per_inference": None,
            }
    return {
        "kernel": estimate.kernel,
        "status": "passed" if completed.returncode == 0 else "failed",
        "returncode": completed.returncode,
        "energy_joules_per_inference": parse_timeloop_energy(completed.stdout),
        "stderr": completed.stderr[:8192],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", choices=sorted(CONFIGS), default=OPEN_2028_FIRST.name)
    parser.add_argument("--out", type=Path)
    parser.add_argument(
        "--require-tools",
        action="store_true",
        help="Exit non-zero if timeloop/accelergy binaries are missing",
    )
    args = parser.parse_args()

    statuses = tool_status()
    missing = [entry for entry in statuses if not entry["available"]]
    report: dict[str, Any]
    if missing:
        missing_names = ", ".join(str(entry["binary"]) for entry in missing)
        report = blocked_report(
            f"missing required tools: {missing_names}",
            statuses,
        )
        emit(report, args.out)
        return 1 if args.require_tools else 0

    if not ARCH_YAML.is_file():
        report = blocked_report(
            f"missing architecture yaml at {ARCH_YAML.relative_to(ROOT)}",
            statuses,
        )
        emit(report, args.out)
        return 1

    config = CONFIGS[args.config]
    estimates = build_workload(config)
    kernels = [run_timeloop_for_kernel(estimate, config) for estimate in estimates]
    successful = [k for k in kernels if k.get("energy_joules_per_inference") is not None]
    report = {
        "schema": "eliza.npu_timeloop_energy.v1",
        "status": "passed" if successful else "failed",
        "provenance": "simulator",
        "claim_boundary": (
            "Timeloop/Accelergy modeled energy only; not measured RTL, "
            "silicon power, or phone-class energy evidence."
        ),
        "config": {"name": config.name},
        "tools": statuses,
        "arch_yaml": file_hash(ARCH_YAML),
        "kernels": kernels,
        "summary": {
            "kernel_count": len(kernels),
            "energy_joules_per_inference": (
                sum(k["energy_joules_per_inference"] for k in successful) / len(successful)
                if successful
                else None
            ),
        },
    }
    emit(report, args.out)
    return 0


def emit(report: dict[str, Any], out: Path | None) -> None:
    text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if out is not None:
        output = out if out.is_absolute() else ROOT / out
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(text, encoding="utf-8")
    print(text, end="")


if __name__ == "__main__":
    raise SystemExit(main())
