#!/usr/bin/env python3
"""Run locally available benchmark binaries as non-release host evidence.

This runner is intentionally separate from benchmarks/run_benchmarks.py real
release runs. The release runner must keep target, process, power, thermal, and
calibration metadata strict. This script only answers a narrower question:
which benchmark tools can execute on this host today, what did they print, and
what metrics can the existing parsers extract?
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import platform
import pty
import re
import select
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

DEFAULT_CONFIG = Path("benchmarks/configs/benchmark_plan.json")
DEFAULT_OUT = Path("benchmarks/results/local-host-benchmark-evidence.json")
DEFAULT_BENCHMARKS = (
    "coremark",
    "stream",
    "lmbench_bw_mem",
    "lmbench_lat_mem_rd",
    "fio_seq_read",
    "fio_rand_rw",
    "tflite_cpu",
)


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument(
        "--bench",
        action="append",
        default=[],
        help="Benchmark name to run; repeat as needed. Defaults to local host runnable set.",
    )
    parser.add_argument("--timeout-seconds", type=int, default=30)
    parser.add_argument(
        "--require-pass",
        action="store_true",
        help="Exit non-zero if no local benchmark executes and parses successfully.",
    )
    return parser.parse_args(argv)


def rel(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def code_from_text(text: str, fallback: str) -> str:
    code = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return code or fallback


def compact_dependency_status(dependencies: list[dict[str, Any]]) -> list[dict[str, Any]]:
    compact: list[dict[str, Any]] = []
    keep = {
        "name",
        "kind",
        "available",
        "path",
        "evidence_kind",
        "provenance",
        "release_claim_allowed",
        "sha256",
        "size_bytes",
        "blocked_reason",
        "blocker_id",
        "reason",
        "resolution",
    }
    for dep in dependencies:
        compact.append({key: value for key, value in dep.items() if key in keep})
    return compact


def local_host_command(
    bench: dict[str, Any], command: list[str], root: Path, run_dir: Path
) -> tuple[list[str], str | None]:
    """Return bounded host-only command overrides for slow synthetic workloads."""
    name = bench["name"]
    if name == "lmbench_bw_mem":
        return [
            command[0],
            "-W",
            "0",
            "-N",
            "1",
            "8M",
            "rd",
        ], "bounded host evidence: one 8M read sample instead of release-plan 64M"
    if name == "lmbench_lat_mem_rd":
        return [
            command[0],
            "-W",
            "0",
            "-N",
            "1",
            "64K",
            "128",
        ], (
            "bounded host evidence: sampled 64K/128 stride sweep instead of release-plan 64M; "
            "runner stops after enough latency points for parser validation"
        )
    if name.startswith("fio_"):
        fio_dir = root / "benchmarks/results/fio"
        fio_dir.mkdir(parents=True, exist_ok=True)
        rw = "read" if name == "fio_seq_read" else "randrw"
        bs = "1m" if name == "fio_seq_read" else "4k"
        extra = "" if name == "fio_seq_read" else "rwmixread=70\n"
        job = "seq-read-local" if name == "fio_seq_read" else "rand-rw-local"
        cfg = run_dir / f"{name}.fio"
        cfg.write_text(
            "[global]\n"
            "ioengine=sync\n"
            "direct=0\n"
            "size=32m\n"
            "directory=benchmarks/results/fio\n"
            "runtime=3\n"
            "time_based\n"
            "group_reporting\n\n"
            f"[{job}]\n"
            f"rw={rw}\n"
            f"{extra}"
            f"bs={bs}\n"
            f"filename={name}.dat\n",
            encoding="utf-8",
        )
        return [command[0], "--output-format=json", rel(cfg, root)], (
            "bounded host evidence: 32MiB/3s fio workload instead of release-plan 128MiB/30s"
        )
    return command, None


def is_lmbench_latency_point(line: str) -> bool:
    parts = line.split()
    if len(parts) != 2:
        return False
    try:
        float(parts[0])
        float(parts[1])
    except ValueError:
        return False
    return True


def run_sampled_lat_mem_rd(
    command: list[str],
    root: Path,
    timeout_seconds: int,
    run_benchmarks: Any,
    sample_points: int = 8,
) -> tuple[str, int, float, int]:
    started = time.monotonic()
    master_fd, slave_fd = pty.openpty()
    process = subprocess.Popen(
        command,
        cwd=root,
        env=run_benchmarks.benchmark_env(root, allow_host_smoke=False),
        text=True,
        stdin=subprocess.DEVNULL,
        stdout=slave_fd,
        stderr=slave_fd,
        start_new_session=True,
    )
    os.close(slave_fd)
    chunks: list[str] = []
    points = 0
    deadline = started + timeout_seconds
    pending = ""
    try:
        while time.monotonic() < deadline:
            remaining = max(0.0, deadline - time.monotonic())
            ready, _, _ = select.select([master_fd], [], [], min(0.25, remaining))
            if not ready:
                if process.poll() is not None:
                    break
                continue
            try:
                chunk = os.read(master_fd, 4096).decode(errors="replace")
            except OSError:
                break
            if chunk == "":
                if process.poll() is not None:
                    break
                continue
            chunks.append(chunk)
            pending += chunk
            while "\n" in pending:
                line, pending = pending.split("\n", 1)
                if is_lmbench_latency_point(line.strip()):
                    points += 1
                    if points >= sample_points:
                        raise StopIteration
        if pending and is_lmbench_latency_point(pending.strip()):
            points += 1
    except StopIteration:
        pass
    finally:
        os.close(master_fd)
    if process.poll() is None:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    elapsed = time.monotonic() - started
    output = "".join(chunks)
    return output, int(process.returncode or 0), elapsed, points


def run_one(
    bench: dict[str, Any],
    root: Path,
    run_dir: Path,
    timeout_seconds: int,
    run_benchmarks: Any,
) -> dict[str, Any]:
    dependencies = run_benchmarks.dependency_status(bench, root, allow_host_smoke=False)
    missing_details = run_benchmarks.missing_dependency_details(dependencies)
    blocked_assets = run_benchmarks.blocked_assets(dependencies)
    dependency_blockers = run_benchmarks.missing_dependency_blockers(bench, dependencies)
    command = run_benchmarks.command_with_resolved_executable(bench["command"], dependencies)
    command, override_note = local_host_command(bench, command, root, run_dir)
    log_path = run_dir / f"{bench['name']}.log"
    result: dict[str, Any] = {
        "name": bench["name"],
        "suite": bench.get("suite", bench["name"]),
        "version": bench.get("version", "unknown"),
        "command": bench["command"],
        "resolved_command": command,
        "parser": bench.get("parser"),
        "dependencies": compact_dependency_status(dependencies),
        "artifacts": {"raw_output": rel(log_path, root)},
        "claim_boundary": "local host execution only; not target, phone, PDK, power, or thermal evidence",
    }
    if override_note:
        result["local_host_workload_override"] = override_note
    blockers = dependency_blockers + blocked_assets
    if missing_details or blockers:
        result.update(
            {
                "status": "blocked",
                "missing_dependency_details": missing_details,
                "blocked_requirements": dependency_blockers,
                "blocked_assets": blocked_assets,
            }
        )
        log_path.write_text("blocked local benchmark evidence\n", encoding="utf-8")
        run_benchmarks.record_artifact_hash(result, "raw_output", log_path)
        return result

    if bench["name"] == "lmbench_lat_mem_rd":
        output, returncode, elapsed, sampled_points = run_sampled_lat_mem_rd(
            command, root, timeout_seconds, run_benchmarks
        )
        log_path.write_text(output + "\nSAMPLED_EARLY\n", encoding="utf-8")
        run_benchmarks.record_artifact_hash(result, "raw_output", log_path)
        parser_name, metrics = run_benchmarks.parse_metrics(bench, output)
        result.update(
            {
                "returncode": returncode,
                "elapsed_seconds": elapsed,
                "sampled_early": True,
                "sampled_point_count": sampled_points,
            }
        )
        if parser_name is None:
            result.update({"status": "failed", "error": "local parser did not find metrics"})
            return result
        result["parser"] = parser_name
        result["metrics"] = metrics
        result["status"] = "passed"
        return result

    started = time.monotonic()
    try:
        process = subprocess.Popen(
            command,
            cwd=root,
            env=run_benchmarks.benchmark_env(root, allow_host_smoke=False),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        output, _ = process.communicate(
            timeout=min(int(bench.get("timeout_seconds", timeout_seconds)), timeout_seconds)
        )
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        output, _ = process.communicate()
        elapsed = time.monotonic() - started
        if isinstance(output, bytes):
            output = output.decode(errors="replace")
        log_path.write_text(output + "\nTIMEOUT\n", encoding="utf-8")
        run_benchmarks.record_artifact_hash(result, "raw_output", log_path)
        result.update({"status": "timeout", "elapsed_seconds": elapsed})
        parser_name, metrics = run_benchmarks.parse_metrics(bench, output)
        if parser_name is not None:
            result.update(
                {
                    "status": "partial_timeout",
                    "parser": parser_name,
                    "metrics": metrics,
                    "warning": "command timed out after producing parseable partial metrics",
                }
            )
        return result

    elapsed = time.monotonic() - started
    log_path.write_text(output, encoding="utf-8")
    run_benchmarks.record_artifact_hash(result, "raw_output", log_path)
    result.update({"returncode": process.returncode, "elapsed_seconds": elapsed})
    parser_name, metrics = run_benchmarks.parse_metrics(bench, output)
    if parser_name is None:
        result.update({"status": "failed", "error": "local parser did not find metrics"})
        return result
    result["parser"] = parser_name
    result["metrics"] = metrics
    result["status"] = "passed" if process.returncode == 0 else "failed"
    if process.returncode != 0:
        result["error"] = f"command exited {process.returncode}"
    return result


def structured_findings(results: list[dict[str, Any]], passed: list[str]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for row in results:
        status = str(row.get("status", "unknown"))
        if status == "passed":
            continue
        name = str(row.get("name", "benchmark"))
        code_status = code_from_text(status, "status")
        evidence: dict[str, Any] = {
            "benchmark": name,
            "status": status,
            "raw_output": row.get("artifacts", {}).get("raw_output")
            if isinstance(row.get("artifacts"), dict)
            else None,
            "claim_boundary": row.get("claim_boundary"),
        }
        if status == "blocked":
            message = (
                f"{name} local-host benchmark is blocked by missing dependencies "
                "or release-blocked assets"
            )
            evidence["missing_dependency_details"] = row.get("missing_dependency_details", [])
            evidence["blocked_requirements"] = row.get("blocked_requirements", [])
            next_step = (
                "Install or archive the benchmark dependency with provenance, then "
                "rerun the local-host probe; keep target performance claims gated "
                "on chip/AP or AOSP runtime evidence."
            )
        elif status in {"timeout", "partial_timeout"}:
            message = f"{name} local-host benchmark timed out"
            evidence["elapsed_seconds"] = row.get("elapsed_seconds")
            next_step = (
                "Use a bounded local smoke workload for parser plumbing, or capture "
                "real chip/AP target benchmark evidence with calibrated power, "
                "thermal, and raw artifact metadata before making performance claims."
            )
        else:
            message = f"{name} local-host benchmark did not produce valid parsed evidence"
            evidence["error"] = row.get("error")
            next_step = (
                "Repair the local benchmark command/parser plumbing and rerun the "
                "probe; do not promote local host output as Linux/AOSP chip runtime "
                "evidence."
            )
        findings.append(
            {
                "code": f"local_host_benchmark_{code_status}_{code_from_text(name, 'benchmark')}",
                "severity": "blocker",
                "message": message,
                "evidence": evidence,
                "next_step": next_step,
            }
        )
    if not passed:
        findings.append(
            {
                "code": "local_host_benchmark_no_parseable_passes",
                "severity": "blocker",
                "message": "no requested local-host benchmark executed and parsed successfully",
                "evidence": [row.get("name") for row in results],
                "next_step": (
                    "Get at least one bounded local benchmark probe passing for "
                    "parser plumbing, then separately capture chip/AP Linux and "
                    "AOSP target benchmark evidence before any no-issues runtime "
                    "or performance claim."
                ),
            }
        )
    return findings


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    root = repo_root()
    sys.path.insert(0, str(root))
    from benchmarks import run_benchmarks

    config_path = args.config if args.config.is_absolute() else root / args.config
    out_path = args.out if args.out.is_absolute() else root / args.out
    run_dir = out_path.parent / "local-host-benchmark-logs"
    run_dir.mkdir(parents=True, exist_ok=True)
    (root / "benchmarks/results/fio").mkdir(parents=True, exist_ok=True)

    selected_names = set(args.bench or DEFAULT_BENCHMARKS)
    config = run_benchmarks.load_config(config_path)
    benches = run_benchmarks.selected_benchmarks(config, selected_names)
    results = [
        run_one(bench, root, run_dir, args.timeout_seconds, run_benchmarks) for bench in benches
    ]
    passed = [row["name"] for row in results if row.get("status") == "passed"]
    blocked = [row["name"] for row in results if row.get("status") == "blocked"]
    failed = [row["name"] for row in results if row.get("status") == "failed"]
    timed_out = [
        row["name"] for row in results if row.get("status") in {"timeout", "partial_timeout"}
    ]
    partial = [row["name"] for row in results if row.get("status") == "partial_timeout"]
    report: dict[str, Any] = {
        "schema": "eliza.local_host_benchmark_evidence.v1",
        "status": "local_host_evidence_not_release" if passed else "blocked",
        "claim_boundary": (
            "Runs real local host benchmark binaries to validate benchmark plumbing and parser "
            "coverage. Results are not target silicon, AOSP, phone, PDK, calibrated power, or "
            "thermal evidence and must not be used for release performance claims."
        ),
        "generated_utc": run_benchmarks.utc_now(),
        "host": {
            "hostname": socket.gethostname(),
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "python": platform.python_version(),
        },
        "config": rel(config_path, root),
        "summary": {
            "requested_benchmarks": [bench["name"] for bench in benches],
            "passed_count": len(passed),
            "blocked_count": len(blocked),
            "failed_count": len(failed),
            "timeout_count": len(timed_out),
            "partial_timeout_count": len(partial),
            "passed": passed,
            "blocked": blocked,
            "failed": failed,
            "timeout": timed_out,
            "partial_timeout": partial,
        },
        "results": results,
    }
    report["findings"] = structured_findings(results, passed)
    write_json(out_path, report)
    print(f"wrote {rel(out_path, root)}")
    print(
        "local host benchmark evidence: "
        f"passed={len(passed)} blocked={len(blocked)} failed={len(failed)} timeout={len(timed_out)}"
    )
    if args.require_pass and not passed:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
