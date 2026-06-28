#!/usr/bin/env python3
"""Check whether TFLite benchmark entries can run with real local evidence.

This is a CLI-only readiness check. It does not build TensorFlow Lite, download
models, or run the benchmark. When the local machine lacks a real
benchmark_model binary, it records that blocker instead of treating the
repo-local smoke shim as product evidence. It can also check the e1-npu
NNAPI proof gate without fabricating proof files or target results.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config", type=Path, default=Path("benchmarks/configs/benchmark_plan.json")
    )
    parser.add_argument(
        "--status-json", type=Path, help="Optional output path for the readiness JSON."
    )
    parser.add_argument(
        "--benchmark",
        choices=("tflite_cpu", "tflite_e1_npu", "all"),
        default="tflite_cpu",
        help="Benchmark readiness target to check.",
    )
    parser.add_argument(
        "--allow-host-smoke-tools",
        action="store_true",
        help="Diagnose host-smoke mode instead of strict real-tool mode.",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    root = repo_root()
    sys.path.insert(0, str(root))
    from benchmarks import run_benchmarks

    args = parse_args(argv)
    config_path = args.config if args.config.is_absolute() else root / args.config
    config = run_benchmarks.load_config(config_path)
    names = {"tflite_cpu", "tflite_e1_npu"} if args.benchmark == "all" else {args.benchmark}
    benches = run_benchmarks.selected_benchmarks(config, names)
    checks: list[dict[str, Any]] = []
    ready = True
    for bench in benches:
        dependencies = run_benchmarks.dependency_status(
            bench,
            root,
            allow_host_smoke=args.allow_host_smoke_tools,
        )
        missing_details = run_benchmarks.missing_dependency_details(dependencies)
        blocked_assets = run_benchmarks.blocked_assets(dependencies)
        bench_ready = not missing_details and not blocked_assets
        ready = ready and bench_ready
        check: dict[str, Any] = {
            "benchmark": bench["name"],
            "status": "ready" if bench_ready else "blocked",
            "command": bench["command"],
            "resolved_command": run_benchmarks.command_with_resolved_executable(
                bench["command"], dependencies
            ),
            "dependencies": dependencies,
            "missing_dependency_details": missing_details,
            "blocked_assets": blocked_assets,
        }
        if not bench_ready:
            blockers = missing_details + blocked_assets
            check["blocker"] = blockers[0] if blockers else {"reason": "unknown"}
        checks.append(check)

    status: dict[str, Any] = {
        "schema": "eliza.tflite_cpu_benchmark_readiness.v1",
        "benchmark": args.benchmark,
        "strict_real_tools": not args.allow_host_smoke_tools,
        "status": "ready" if ready else "blocked",
        "checks": checks,
    }
    if len(checks) == 1:
        status.update({key: checks[0][key] for key in checks[0] if key != "benchmark"})

    output = json.dumps(status, indent=2, sort_keys=True) + "\n"
    if args.status_json:
        status_path = (
            args.status_json if args.status_json.is_absolute() else root / args.status_json
        )
        status_path.parent.mkdir(parents=True, exist_ok=True)
        status_path.write_text(output, encoding="utf-8")
    print(output, end="")
    return 0 if ready else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
