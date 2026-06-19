#!/usr/bin/env python3
"""
Benchmark Visualization — Generates ASCII charts and summary tables
from TypeScript benchmark results.

Usage:
    python3 visualize.py [results_dir]
"""

import json
import sys
from pathlib import Path

RESULTS_DIR = Path(__file__).parent / "results"


def load_latest_result(runtime: str) -> dict | None:
    """Load the latest result file for a given runtime."""
    files = sorted(RESULTS_DIR.glob(f"{runtime}-*.json"))
    if not files:
        return None
    with open(files[-1]) as f:
        return json.load(f)


def bar(value: float, max_val: float, width: int = 40) -> str:
    """Create an ASCII bar."""
    if max_val <= 0:
        return ""
    filled = int((value / max_val) * width)
    filled = min(filled, width)
    return "█" * filled + "░" * (width - filled)


def format_ms(ms: float) -> str:
    if ms < 0.001:
        return f"{ms * 1_000_000:.0f}ns"
    if ms < 1:
        return f"{ms * 1000:.0f}μs"
    if ms < 1000:
        return f"{ms:.2f}ms"
    return f"{ms / 1000:.2f}s"


def format_throughput(mps: float) -> str:
    if mps > 100000:
        return f"{mps / 1000:.0f}K"
    if mps > 1000:
        return f"{mps / 1000:.1f}K"
    return f"{mps:.1f}"


def print_header(title: str) -> None:
    width = 72
    print()
    print("═" * width)
    print(f"  {title}")
    print("═" * width)


def print_latency_chart(results: dict) -> None:
    """Print latency comparison chart."""
    print_header("LATENCY BY SCENARIO (avg ms)")

    scenarios = results.get("scenarios", {})
    if not scenarios:
        print("  No scenario data available.")
        return

    # Get max latency for scaling
    max_lat = max(s["latency"]["avg_ms"] for s in scenarios.values())

    for sid, s in scenarios.items():
        avg = s["latency"]["avg_ms"]
        p95 = s["latency"]["p95_ms"]
        label = f"  {sid:<28}"
        b = bar(avg, max_lat, 30)
        print(f"{label} {b} {format_ms(avg):>10}  (p95: {format_ms(p95)})")


def print_throughput_chart(results: dict) -> None:
    """Print throughput comparison chart."""
    print_header("THROUGHPUT BY SCENARIO (msg/s)")

    scenarios = results.get("scenarios", {})
    # Exclude DB scenarios from throughput (they have inflated numbers)
    msg_scenarios = {k: v for k, v in scenarios.items()
                     if not k.startswith("db-") and not k.startswith("startup")}
    if not msg_scenarios:
        print("  No message scenario data available.")
        return

    max_tp = max(s["throughput"]["messages_per_second"] for s in msg_scenarios.values())

    for sid, s in msg_scenarios.items():
        tp = s["throughput"]["messages_per_second"]
        label = f"  {sid:<28}"
        b = bar(tp, max_tp, 30)
        print(f"{label} {b} {format_throughput(tp):>8} msg/s")


def print_memory_chart(results: dict) -> None:
    """Print memory usage chart."""
    print_header("PEAK MEMORY BY SCENARIO (MB)")

    scenarios = results.get("scenarios", {})
    if not scenarios:
        return

    max_mem = max(s["resources"]["memory_rss_peak_mb"] for s in scenarios.values())

    for sid, s in scenarios.items():
        peak = s["resources"]["memory_rss_peak_mb"]
        delta = s["resources"]["memory_delta_mb"]
        label = f"  {sid:<28}"
        b = bar(peak, max_mem, 30)
        print(f"{label} {b} {peak:>7.1f}MB  (delta: {delta:+.1f}MB)")


def print_db_throughput(results: dict) -> None:
    """Print DB operation throughput."""
    print_header("DATABASE THROUGHPUT")

    scenarios = results.get("scenarios", {})
    for sid in ["db-write-throughput", "db-read-throughput"]:
        if sid in scenarios:
            s = scenarios[sid]
            tp = s["throughput"]["messages_per_second"]
            avg_per_op = s["latency"]["avg_ms"]
            op = "WRITE" if "write" in sid else "READ"
            print(f"  {op}: {format_throughput(tp)} ops/s  (avg batch: {format_ms(avg_per_op)})")


def print_latency_distribution(results: dict) -> None:
    """Print latency distribution for single-message scenario."""
    print_header("LATENCY DISTRIBUTION — single-message")

    if "single-message" not in results.get("scenarios", {}):
        print("  No single-message data.")
        return

    s = results["scenarios"]["single-message"]
    lat = s["latency"]

    print(f"  Min:    {format_ms(lat['min_ms']):>10}")
    print(f"  Median: {format_ms(lat['median_ms']):>10}")
    print(f"  Avg:    {format_ms(lat['avg_ms']):>10}")
    print(f"  P95:    {format_ms(lat['p95_ms']):>10}")
    print(f"  P99:    {format_ms(lat['p99_ms']):>10}")
    print(f"  Max:    {format_ms(lat['max_ms']):>10}")
    print(f"  Stddev: {format_ms(lat['stddev_ms']):>10}")
    print()

    # Histogram of raw values
    raw = lat.get("raw_ms", [])
    if raw:
        # Create 10 buckets
        min_val = min(raw)
        max_val = max(raw)
        if max_val > min_val:
            bucket_width = (max_val - min_val) / 10
            buckets = [0] * 10
            for v in raw:
                idx = min(int((v - min_val) / bucket_width), 9)
                buckets[idx] += 1

            max_count = max(buckets)
            print("  Histogram:")
            for i, count in enumerate(buckets):
                lo = min_val + i * bucket_width
                hi = lo + bucket_width
                b = bar(count, max_count, 20)
                print(f"    {format_ms(lo):>8}-{format_ms(hi):<8} {b} {count}")


def print_provider_scaling(results: dict) -> None:
    """Show provider scaling impact."""
    print_header("PROVIDER SCALING")

    scenarios = results.get("scenarios", {})
    prov_scenarios = sorted(
        [(k, v) for k, v in scenarios.items() if k.startswith("provider-scaling")],
        key=lambda x: x[1]["latency"]["avg_ms"],
    )

    if not prov_scenarios:
        print("  No provider scaling data.")
        return

    base = scenarios.get("single-message", {}).get("latency", {}).get("avg_ms", 0)
    if base > 0:
        print(f"  Baseline (single-message): {format_ms(base)}")
        print()

    for sid, s in prov_scenarios:
        count = sid.split("-")[-1]
        avg = s["latency"]["avg_ms"]
        ratio = avg / base if base > 0 else 0
        print(f"  {count:>3} providers: {format_ms(avg):>10}  ({ratio:.1f}x baseline)")


def print_summary_table(results: dict) -> None:
    """Print a summary table of all results."""
    print_header("SUMMARY TABLE")

    sys_info = results.get("system", {})
    print(f"  System: {sys_info.get('os', 'unknown')} {sys_info.get('arch', '')}")
    print(f"  CPUs: {sys_info.get('cpus', '?')} | RAM: {sys_info.get('memory_gb', '?')}GB")
    print(f"  Runtime: {sys_info.get('runtime_version', 'unknown')}")
    print()

    print(f"  {'Scenario':<28} {'Avg':>8} {'P95':>8} {'Throughput':>12} {'Peak RSS':>10}")
    print(f"  {'─' * 28} {'─' * 8} {'─' * 8} {'─' * 12} {'─' * 10}")

    for sid, s in results.get("scenarios", {}).items():
        avg = format_ms(s["latency"]["avg_ms"])
        p95 = format_ms(s["latency"]["p95_ms"])
        tp = format_throughput(s["throughput"]["messages_per_second"]) + "/s"
        mem = f"{s['resources']['memory_rss_peak_mb']:.0f}MB"
        print(f"  {sid:<28} {avg:>8} {p95:>8} {tp:>12} {mem:>10}")


def main() -> None:
    results_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else RESULTS_DIR

    # Load TypeScript results (primary)
    ts_result = load_latest_result("typescript")
    if ts_result is None:
        print("No TypeScript results found. Run the benchmark first.")
        sys.exit(1)

    print()
    print("╔══════════════════════════════════════════════════════════════════════════╗")
    print("║           Eliza Framework Benchmark — Visualization                     ║")
    print("╚══════════════════════════════════════════════════════════════════════════╝")

    print_summary_table(ts_result)
    print_latency_chart(ts_result)
    print_throughput_chart(ts_result)
    print_memory_chart(ts_result)
    print_db_throughput(ts_result)
    print_latency_distribution(ts_result)
    print_provider_scaling(ts_result)

    # Check for Python/Rust results
    py_result = load_latest_result("python")
    rs_result = load_latest_result("rust")

    if py_result or rs_result:
        print_header("CROSS-RUNTIME COMPARISON")
        runtimes = {"TypeScript": ts_result}
        if py_result:
            runtimes["Python"] = py_result
        if rs_result:
            runtimes["Rust"] = rs_result

        # Compare single-message if available
        print(f"\n  {'Runtime':<14} {'Avg Latency':>12} {'P95':>10} {'Throughput':>12} {'Peak RSS':>10}")
        print(f"  {'─' * 14} {'─' * 12} {'─' * 10} {'─' * 12} {'─' * 10}")
        for name, r in runtimes.items():
            if "single-message" in r.get("scenarios", {}):
                s = r["scenarios"]["single-message"]
                print(f"  {name:<14} {format_ms(s['latency']['avg_ms']):>12} {format_ms(s['latency']['p95_ms']):>10} {format_throughput(s['throughput']['messages_per_second']) + '/s':>12} {s['resources']['memory_rss_peak_mb']:.0f}MB")
    else:
        print_header("NOTE")
        print("  Only TypeScript results available.")
        print("  Run Python and Rust benchmarks to enable cross-runtime comparison.")

    print()


if __name__ == "__main__":
    main()
