"""
Performance Metrics Collection Utilities — Python Runtime

High-resolution timing, memory monitoring, and statistical aggregation.
"""

from __future__ import annotations

import math
import os
import platform
import sys
import time
from dataclasses import dataclass, field
from typing import ClassVar

import psutil


# ─── Types ───────────────────────────────────────────────────────────────────

@dataclass
class LatencyStats:
    min_ms: float = 0.0
    max_ms: float = 0.0
    avg_ms: float = 0.0
    median_ms: float = 0.0
    p95_ms: float = 0.0
    p99_ms: float = 0.0
    stddev_ms: float = 0.0
    raw_ms: list[float] = field(default_factory=list)


@dataclass
class ThroughputStats:
    messages_per_second: float = 0.0
    total_messages: int = 0
    total_time_ms: float = 0.0


@dataclass
class PipelineBreakdown:
    compose_state_avg_ms: float = 0.0
    provider_execution_avg_ms: float = 0.0
    should_respond_avg_ms: float = 0.0
    model_call_avg_ms: float = 0.0
    action_dispatch_avg_ms: float = 0.0
    evaluator_avg_ms: float = 0.0
    memory_create_avg_ms: float = 0.0
    memory_get_avg_ms: float = 0.0
    model_time_total_ms: float = 0.0
    """Total time spent in model calls (only meaningful in real-LLM mode)."""
    framework_time_total_ms: float = 0.0
    """Estimated framework-only time: total - model_time (only meaningful in real-LLM mode)."""


@dataclass
class ResourceStats:
    memory_rss_start_mb: float = 0.0
    memory_rss_peak_mb: float = 0.0
    memory_rss_end_mb: float = 0.0
    memory_delta_mb: float = 0.0
    heap_used_start_mb: float = 0.0
    heap_used_peak_mb: float = 0.0
    heap_used_end_mb: float = 0.0


@dataclass
class ScenarioResult:
    iterations: int = 0
    warmup: int = 0
    latency: LatencyStats = field(default_factory=LatencyStats)
    throughput: ThroughputStats = field(default_factory=ThroughputStats)
    pipeline: PipelineBreakdown = field(default_factory=PipelineBreakdown)
    resources: ResourceStats = field(default_factory=ResourceStats)


@dataclass
class SystemInfo:
    os: str = ""
    arch: str = ""
    cpus: int = 0
    memory_gb: float = 0.0
    runtime_version: str = ""
    platform_name: str = "python"


@dataclass
class BenchmarkResult:
    runtime: str = "python"
    timestamp: str = ""
    system: SystemInfo = field(default_factory=SystemInfo)
    scenarios: dict[str, object] = field(default_factory=dict)
    binary_size_bytes: int | None = None


# ─── High-resolution timer ───────────────────────────────────────────────────

class Timer:
    __slots__ = ("_start", "_end")

    def __init__(self) -> None:
        self._start: float = 0.0
        self._end: float = 0.0

    def start(self) -> None:
        self._start = time.perf_counter_ns()

    def stop(self) -> float:
        self._end = time.perf_counter_ns()
        return self.elapsed()

    def elapsed(self) -> float:
        """Return elapsed time in milliseconds."""
        return (self._end - self._start) / 1_000_000


# ─── Memory monitor ─────────────────────────────────────────────────────────

class MemoryMonitor:
    def __init__(self) -> None:
        self._process = psutil.Process(os.getpid())
        self._peak_rss: float = 0.0
        self._start_rss: float = 0.0

    def start(self) -> None:
        info = self._process.memory_info()
        self._start_rss = info.rss
        self._peak_rss = info.rss

    def poll(self) -> None:
        """Call periodically to track peak RSS."""
        info = self._process.memory_info()
        if info.rss > self._peak_rss:
            self._peak_rss = info.rss

    def stop(self) -> ResourceStats:
        info = self._process.memory_info()
        if info.rss > self._peak_rss:
            self._peak_rss = info.rss

        mb = 1024 * 1024
        return ResourceStats(
            memory_rss_start_mb=self._start_rss / mb,
            memory_rss_peak_mb=self._peak_rss / mb,
            memory_rss_end_mb=info.rss / mb,
            memory_delta_mb=(info.rss - self._start_rss) / mb,
            heap_used_start_mb=0.0,  # Python doesn't expose heap separately
            heap_used_peak_mb=0.0,
            heap_used_end_mb=0.0,
        )


# ─── Pipeline instrumentation ───────────────────────────────────────────────

class PipelineTimer:
    CATEGORIES: ClassVar[list[str]] = [
        "compose_state",
        "provider_execution",
        "should_respond",
        "model_call",
        "action_dispatch",
        "evaluator",
        "memory_create",
        "memory_get",
    ]

    def __init__(self) -> None:
        self.timings: dict[str, list[float]] = {cat: [] for cat in self.CATEGORIES}

    def record(self, category: str, duration_ms: float) -> None:
        if category not in self.timings:
            self.timings[category] = []
        self.timings[category].append(duration_ms)

    def get_breakdown(self) -> PipelineBreakdown:
        def avg(arr: list[float]) -> float:
            return sum(arr) / len(arr) if arr else 0.0

        def total(arr: list[float]) -> float:
            return sum(arr)

        model_time_total = total(self.timings["model_call"])

        return PipelineBreakdown(
            compose_state_avg_ms=avg(self.timings["compose_state"]),
            provider_execution_avg_ms=avg(self.timings["provider_execution"]),
            should_respond_avg_ms=avg(self.timings["should_respond"]),
            model_call_avg_ms=avg(self.timings["model_call"]),
            action_dispatch_avg_ms=avg(self.timings["action_dispatch"]),
            evaluator_avg_ms=avg(self.timings["evaluator"]),
            memory_create_avg_ms=avg(self.timings["memory_create"]),
            memory_get_avg_ms=avg(self.timings["memory_get"]),
            model_time_total_ms=model_time_total,
            framework_time_total_ms=0.0,  # Will be computed by the caller with wall-clock total
        )

    def reset(self) -> None:
        self.timings = {cat: [] for cat in self.CATEGORIES}


# ─── Statistics ──────────────────────────────────────────────────────────────

def percentile(sorted_vals: list[float], pct: float) -> float:
    if not sorted_vals:
        return 0.0
    idx = (pct / 100) * (len(sorted_vals) - 1)
    lower = int(math.floor(idx))
    upper = int(math.ceil(idx))
    if lower == upper:
        return sorted_vals[lower]
    weight = idx - lower
    return sorted_vals[lower] * (1 - weight) + sorted_vals[upper] * weight


def compute_latency_stats(raw_ms: list[float]) -> LatencyStats:
    if not raw_ms:
        return LatencyStats(raw_ms=[])

    sorted_vals = sorted(raw_ms)
    avg = sum(sorted_vals) / len(sorted_vals)
    variance = sum((v - avg) ** 2 for v in sorted_vals) / len(sorted_vals)
    stddev = math.sqrt(variance)

    return LatencyStats(
        min_ms=sorted_vals[0],
        max_ms=sorted_vals[-1],
        avg_ms=avg,
        median_ms=percentile(sorted_vals, 50),
        p95_ms=percentile(sorted_vals, 95),
        p99_ms=percentile(sorted_vals, 99),
        stddev_ms=stddev,
        raw_ms=raw_ms,
    )


def compute_throughput_stats(total_messages: int, total_time_ms: float) -> ThroughputStats:
    return ThroughputStats(
        messages_per_second=(total_messages / total_time_ms) * 1000 if total_time_ms > 0 else 0.0,
        total_messages=total_messages,
        total_time_ms=total_time_ms,
    )


# ─── System info ─────────────────────────────────────────────────────────────

def get_system_info() -> SystemInfo:
    mem = psutil.virtual_memory()
    return SystemInfo(
        os=f"{platform.system()} {platform.release()}",
        arch=platform.machine(),
        cpus=os.cpu_count() or 1,
        memory_gb=round(mem.total / (1024**3), 1),
        runtime_version=f"Python {sys.version.split()[0]}",
        platform_name="python",
    )


# ─── Pretty print ───────────────────────────────────────────────────────────

def format_duration(ms: float) -> str:
    if ms < 1:
        return f"{ms * 1000:.0f}us"
    if ms < 1000:
        return f"{ms:.2f}ms"
    return f"{ms / 1000:.2f}s"


def print_scenario_result(
    scenario_id: str,
    result: ScenarioResult,
    real_llm: bool = False,
) -> None:
    lat = result.latency
    tp = result.throughput
    res = result.resources
    pl = result.pipeline
    print(f"\n  {scenario_id}")
    print(f"    Iterations: {result.iterations} (warmup: {result.warmup})")
    print(f"    Latency:  avg={format_duration(lat.avg_ms)}  median={format_duration(lat.median_ms)}  p95={format_duration(lat.p95_ms)}  p99={format_duration(lat.p99_ms)}")
    print(f"    Range:    min={format_duration(lat.min_ms)}  max={format_duration(lat.max_ms)}  stddev={format_duration(lat.stddev_ms)}")
    print(f"    Throughput: {tp.messages_per_second:.1f} msg/s ({tp.total_messages} messages in {format_duration(tp.total_time_ms)})")
    print(f"    Memory:   start={res.memory_rss_start_mb:.1f}MB  peak={res.memory_rss_peak_mb:.1f}MB  delta={res.memory_delta_mb:.1f}MB")
    print(f"    Pipeline: state={format_duration(pl.compose_state_avg_ms)}  model={format_duration(pl.model_call_avg_ms)}  actions={format_duration(pl.action_dispatch_avg_ms)}  memory={format_duration(pl.memory_create_avg_ms)}")
    if real_llm and pl.model_time_total_ms > 0:
        print(f"    Timing:   model_total={format_duration(pl.model_time_total_ms)}  framework_total={format_duration(pl.framework_time_total_ms)}")
