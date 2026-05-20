"""Backend-agnostic LPDDR DRAM simulator runner.

Drives DRAMSim3 (preferred) or Ramulator2 against the LPDDR5X-10667
and LPDDR6-14400 configurations under ``configs/``. Each sweep produces
``eliza.memory.dram_sim_sweep.v1`` JSON records that the gate parser
under ``scripts/check_bandwidth_sustained.py`` consumes in
simulator-only mode and that the evidence file
``docs/evidence/memory/dram_sim_evidence.yaml`` aggregates.

Numbers are tagged ``simulator_only`` and cannot satisfy the
phone-class real-target bandwidth claims in
``docs/evidence/memory/uma-dram-evidence-gate.yaml``.
"""

from __future__ import annotations

import importlib
import json
import shutil
import subprocess
import sys
import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path

from .trace_gen import WORKLOADS as TRACE_WORKLOADS
from .trace_gen import write_trace

ROOT = Path(__file__).resolve().parents[3]
CONFIGS_DIR = Path(__file__).parent / "configs"

# DRAMSim3-runnable .ini per SKU. The companion ``<sku>.ini`` files in
# the same directory are JEDEC reference data; the ``<sku>_dramsim3.ini``
# files are the LPDDR4-protocol approximations DRAMSim3 actually accepts.
DRAMSIM3_INI_SUFFIX = "_dramsim3.ini"


@dataclass(frozen=True)
class DramConfig:
    """Per-SKU LPDDR configuration consumed by the simulator backends."""

    standard: str
    data_rate_mtps: int
    bus_width_bits: int
    channels: int
    bits_per_channel: int
    capacity_gib: int
    config_path: Path

    @property
    def peak_bandwidth_gbps(self) -> float:
        bytes_per_transfer = self.bus_width_bits / 8.0
        return bytes_per_transfer * self.data_rate_mtps / 1e3

    @property
    def dramsim3_config_path(self) -> Path:
        """Return the DRAMSim3-runnable .ini path for this SKU."""
        stem = self.config_path.stem
        return self.config_path.with_name(f"{stem}{DRAMSIM3_INI_SUFFIX}")

    @property
    def tck_ns(self) -> float:
        """DRAM command-clock period in nanoseconds.

        DRAMSim3 uses this as its internal cycle counter unit and it
        must match the ``tCK`` value in the DRAMSim3-runnable .ini for
        bandwidth/latency conversions to land in physical units. DDR
        signaling transfers two bits per command clock (one on each
        edge), so ``tCK_ns = 2 * 1000 / data_rate_mtps``. For example
        at 10667 MT/s ``tCK`` = 0.1875 ns; at 14400 MT/s ``tCK`` =
        0.1389 ns.

        Stored on the SKU because DRAMSim3 reports per-channel cycle
        counts rather than nanoseconds.
        """
        return 1000.0 / self.data_rate_mtps * 2.0


SKUS: dict[str, DramConfig] = {
    "lpddr5x_10667": DramConfig(
        standard="LPDDR5X-10667",
        data_rate_mtps=10667,
        bus_width_bits=64,
        channels=4,
        bits_per_channel=16,
        capacity_gib=16,
        config_path=CONFIGS_DIR / "lpddr5x_10667.ini",
    ),
    "lpddr6_14400": DramConfig(
        standard="LPDDR6-14400",
        data_rate_mtps=14400,
        bus_width_bits=96,
        channels=4,
        bits_per_channel=24,
        capacity_gib=24,
        config_path=CONFIGS_DIR / "lpddr6_14400.ini",
    ),
}

# Default sweep used by ``make dramsim-sweep`` and the evidence
# regeneration entrypoint. Order is stable so report files diff cleanly.
DEFAULT_WORKLOADS: tuple[str, ...] = (
    "microbench",
    "stream_copy",
    "stream_scale",
    "stream_add",
    "stream_triad",
    "pointer_chase",
)

# Trace replay length. Sized so the longest workload (pointer_chase at
# period 8) drains and DRAMSim3 reaches steady state before the cycle
# budget runs out. Microbench and STREAM all complete well within this.
DEFAULT_TRACE_CYCLES = 500_000


@dataclass
class DramSimResult:
    schema: str = "eliza.memory.dram_sim_sweep.v1"
    status: str = "simulator_only"
    backend: str = ""
    config: DramConfig | None = None
    workload: str = ""
    requested_address_range_bytes: int = 0
    transactions_emitted: int = 0
    measured_read_bandwidth_gbps: float = 0.0
    measured_write_bandwidth_gbps: float = 0.0
    measured_total_bandwidth_gbps: float = 0.0
    measured_p95_latency_ns: float = 0.0
    measured_average_latency_ns: float = 0.0
    captured_utc: str = field(
        default_factory=lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    )
    raw_log_path: str = ""
    raw_stats_path: str = ""

    def to_dict(self) -> dict:
        cfg = self.config
        return {
            "schema": self.schema,
            "status": self.status,
            "evidence_class": "dramsim3_behavioral_simulation",
            "backend": self.backend,
            "captured_utc": self.captured_utc,
            "standard": cfg.standard if cfg else None,
            "data_rate_mtps": cfg.data_rate_mtps if cfg else None,
            "bus_width_bits": cfg.bus_width_bits if cfg else None,
            "channels": cfg.channels if cfg else None,
            "bits_per_channel": cfg.bits_per_channel if cfg else None,
            "capacity_gib": cfg.capacity_gib if cfg else None,
            "peak_bandwidth_gbps": cfg.peak_bandwidth_gbps if cfg else None,
            "workload": self.workload,
            "requested_address_range_bytes": self.requested_address_range_bytes,
            "transactions_emitted": self.transactions_emitted,
            "measured_read_bandwidth_gbps": self.measured_read_bandwidth_gbps,
            "measured_write_bandwidth_gbps": self.measured_write_bandwidth_gbps,
            "measured_total_bandwidth_gbps": self.measured_total_bandwidth_gbps,
            "measured_average_latency_ns": self.measured_average_latency_ns,
            "measured_p95_latency_ns": self.measured_p95_latency_ns,
            "simulator_only_note": (
                "DRAMSim3 behavioural-model result. Cannot satisfy the "
                "phone-class real-target bandwidth gate in "
                "docs/evidence/memory/uma-dram-evidence-gate.yaml."
            ),
            "raw_log_path": self.raw_log_path,
            "raw_stats_path": self.raw_stats_path,
        }


def available_backends() -> list[str]:
    backends: list[str] = []
    if shutil.which("dramsim3main") or _local_dramsim3_binary() is not None:
        backends.append("dramsim3")
    if shutil.which("ramulator2") or _module_present("ramulator"):
        backends.append("ramulator2")
    return backends


def _module_present(name: str) -> bool:
    try:
        importlib.import_module(name)
        return True
    except ImportError:
        return False


def _local_dramsim3_binary() -> Path | None:
    """Return the in-repo DRAMSim3 build output if it exists."""
    candidate = ROOT / "external" / "dramsim3" / "build" / "dramsim3main"
    return candidate if candidate.is_file() else None


def _resolve_dramsim3_binary() -> str:
    on_path = shutil.which("dramsim3main")
    if on_path is not None:
        return on_path
    local = _local_dramsim3_binary()
    if local is None:
        raise RuntimeError(
            "dramsim3main not found on PATH and external/dramsim3/build/"
            "dramsim3main is not built; run "
            "`cmake -S external/dramsim3 -B external/dramsim3/build -DCMAKE_BUILD_TYPE=Release"
            " && cmake --build external/dramsim3/build --target dramsim3main -j`"
        )
    return str(local)


def run_dram_sweep(
    config: DramConfig, workloads: Iterable[str], output_dir: Path
) -> list[DramSimResult]:
    """Run the simulator across a list of workload names and return
    one DramSimResult per workload.  When no backend is installed, the
    function returns an empty list and writes a blocked-status JSON so
    the gate parser can record it as a missing dependency."""

    backends = available_backends()
    output_dir.mkdir(parents=True, exist_ok=True)
    if not backends:
        _write_blocked_no_backend(output_dir)
        return []

    backend = backends[0]
    runner_fn = _dramsim3_run if backend == "dramsim3" else _ramulator2_run

    results: list[DramSimResult] = []
    for workload in workloads:
        result = DramSimResult(
            backend=backend,
            config=config,
            workload=workload,
            requested_address_range_bytes=config.capacity_gib * 1024**3,
            raw_log_path=str(output_dir / f"dram_sim_{backend}_{workload}.log"),
        )
        try:
            measured = runner_fn(config, workload, output_dir)
        except RuntimeError as exc:
            blocked = {
                "schema": "eliza.memory.dram_sim_blocked.v1",
                "status": "blocked_backend_execution_failure",
                "reason": str(exc),
                "backend": backend,
                "workload": workload,
                "standard": config.standard,
            }
            (output_dir / f"dram_sim_{backend}_{workload}_blocked.json").write_text(
                json.dumps(blocked, indent=2)
            )
            continue
        result.measured_read_bandwidth_gbps = measured["read_gbps"]
        result.measured_write_bandwidth_gbps = measured["write_gbps"]
        result.measured_total_bandwidth_gbps = measured["total_gbps"]
        result.measured_p95_latency_ns = measured["p95_latency_ns"]
        result.measured_average_latency_ns = measured["avg_latency_ns"]
        result.transactions_emitted = measured["transactions_emitted"]
        result.raw_stats_path = measured["raw_stats_path"]
        out_path = output_dir / f"dram_sim_{backend}_{workload}.json"
        out_path.write_text(json.dumps(result.to_dict(), indent=2))
        results.append(result)
    return results


def _write_blocked_no_backend(output_dir: Path) -> None:
    blocked = {
        "schema": "eliza.memory.dram_sim_blocked.v1",
        "status": "blocked_no_simulator_backend",
        "reason": "Neither DRAMSim3 nor Ramulator2 is installed",
        "expected_paths": [
            "compiler/runtime/dramsim_wrap/configs/lpddr5x_10667.ini",
            "compiler/runtime/dramsim_wrap/configs/lpddr6_14400.ini",
        ],
        "unblock_commands": {
            "dramsim3": [
                "git clone --depth 1 https://github.com/umd-memsys/DRAMsim3.git external/dramsim3",
                "cmake -S external/dramsim3 -B external/dramsim3/build -DCMAKE_BUILD_TYPE=Release",
                "cmake --build external/dramsim3/build --target dramsim3main -j",
                "export PATH=$PWD/external/dramsim3/build:$PATH",
            ],
            "ramulator2": [
                "git clone --depth 1 https://github.com/CMU-SAFARI/ramulator2.git external/ramulator2",
                "cmake -S external/ramulator2 -B external/ramulator2/build -DCMAKE_BUILD_TYPE=Release",
                "cmake --build external/ramulator2/build -j",
                "export PATH=$PWD/external/ramulator2/build:$PATH",
            ],
        },
        "note": (
            "Both upstreams are open-source academic simulators. The wrapper "
            "prefers DRAMSim3 when both are installed because its LPDDR4 "
            "controller model can be scaled to LPDDR5X/LPDDR6 timing for a "
            "behavioural approximation."
        ),
    }
    (output_dir / "dram_sim_blocked.json").write_text(json.dumps(blocked, indent=2))


def _dramsim3_run(config: DramConfig, workload: str, output_dir: Path) -> dict:
    """Invoke DRAMSim3 against the SKU config with the requested workload
    trace, parse the resulting ``dramsim3.json``, and return measured
    bandwidth and latency in physical units. Fails closed via
    ``RuntimeError`` so the caller can record a per-workload blocked JSON
    instead of fabricating numbers."""
    bin_path = _resolve_dramsim3_binary()
    ini_path = config.dramsim3_config_path
    if not ini_path.is_file():
        raise RuntimeError(
            f"DRAMSim3-runnable ini not found at {ini_path}; the "
            f"JEDEC reference {config.config_path.name} is not directly "
            "consumable by DRAMSim3 (it has no LPDDR5X/LPDDR6 protocol)."
        )
    if workload not in TRACE_WORKLOADS:
        raise RuntimeError(f"unknown workload {workload!r}; supported: {sorted(TRACE_WORKLOADS)}")

    # The trace must address only inside the per-channel capacity that
    # DRAMSim3 actually models (4 channels x channel_size MiB). Using the
    # full SKU capacity would walk off the modeled aperture. We use the
    # full 16 GiB for the LPDDR5X SKU and the LPDDR6 modeled aperture
    # for the AI SKU (documented in lpddr6_14400_dramsim3.ini).
    aperture_bytes = _modeled_aperture_bytes(config)
    workload_dir = output_dir / workload
    workload_dir.mkdir(parents=True, exist_ok=True)
    trace_path = workload_dir / f"{workload}.trc"
    transactions = write_trace(workload, aperture_bytes, trace_path)

    # DRAMSim3 will not create its output directory; pre-create it.
    stats_dir = workload_dir / "dramsim3"
    stats_dir.mkdir(parents=True, exist_ok=True)
    log_path = workload_dir / "dramsim3.log"

    cmd = [
        bin_path,
        str(ini_path),
        "-t",
        str(trace_path),
        "-o",
        str(stats_dir),
        "-c",
        str(DEFAULT_TRACE_CYCLES),
    ]
    completed = subprocess.run(  # noqa: S603 - intentional binary invocation
        cmd,
        capture_output=True,
        text=True,
        check=False,
    )
    log_path.write_text(
        f"$ {' '.join(cmd)}\n\n[stdout]\n{completed.stdout}\n[stderr]\n{completed.stderr}\n"
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"dramsim3main exited {completed.returncode}: {completed.stderr.strip() or '(no stderr)'}"
        )
    stats_path = stats_dir / "dramsim3.json"
    if not stats_path.is_file():
        raise RuntimeError(f"dramsim3main produced no stats at {stats_path}; see {log_path}")

    measured = _parse_dramsim3_stats(stats_path, config)
    measured["transactions_emitted"] = transactions
    measured["raw_stats_path"] = str(stats_path)
    return measured


def _modeled_aperture_bytes(config: DramConfig) -> int:
    """Return the DRAM aperture DRAMSim3 actually models for ``config``.

    DRAMSim3 caps geometry by ``channels * channel_size`` MiB. Both
    .ini files cap at 16 GiB (4 channels x 4096 MiB) regardless of the
    SKU's declared capacity, so we walk that aperture in trace gen.
    """
    return 16 * 1024 * 1024 * 1024


def _parse_dramsim3_stats(stats_path: Path, config: DramConfig) -> dict:
    """Aggregate DRAMSim3 per-channel stats into total bandwidth and
    p95 read latency in physical units (GB/s and nanoseconds)."""
    data = json.loads(stats_path.read_text())

    total_reads = 0
    total_writes = 0
    total_cycles = 0
    weighted_avg_lat_cycles_num = 0.0
    weighted_avg_lat_cycles_den = 0
    # Build full read-latency histogram across channels for p95.
    lat_histogram: dict[int, int] = {}

    for ch_id, ch in data.items():
        if not isinstance(ch, Mapping):
            continue
        nr = int(ch.get("num_reads_done", 0))
        nw = int(ch.get("num_writes_done", 0))
        nc = int(ch.get("num_cycles", 0))
        total_reads += nr
        total_writes += nw
        total_cycles = max(total_cycles, nc)
        avg_lat = float(ch.get("average_read_latency", 0.0))
        if nr > 0:
            weighted_avg_lat_cycles_num += avg_lat * nr
            weighted_avg_lat_cycles_den += nr
        # The "read_latency" sub-object is a per-cycle histogram with
        # integer cycle keys. Sum into the cross-channel histogram.
        rl = ch.get("read_latency")
        if isinstance(rl, Mapping):
            for cyc_key, count in rl.items():
                try:
                    cyc = int(cyc_key)
                except (TypeError, ValueError):
                    continue
                lat_histogram[cyc] = lat_histogram.get(cyc, 0) + int(count)
        del ch_id  # silence unused-var

    if total_cycles == 0:
        raise RuntimeError(f"DRAMSim3 stats at {stats_path} report zero cycles; trace too short")

    # Bytes per access = burst length * device_width / 8. For the LPDDR4
    # protocol used by our DRAMSim3 .ini, BL=16 and device_width=16, so
    # 32 bytes per access per channel. Sum across channels.
    bytes_per_access = 32
    elapsed_seconds = total_cycles * config.tck_ns * 1e-9
    if elapsed_seconds <= 0:
        raise RuntimeError(f"DRAMSim3 stats at {stats_path} yielded non-positive elapsed time")
    read_gbps = total_reads * bytes_per_access / elapsed_seconds / 1e9
    write_gbps = total_writes * bytes_per_access / elapsed_seconds / 1e9
    total_gbps = read_gbps + write_gbps

    avg_lat_cycles = (
        weighted_avg_lat_cycles_num / weighted_avg_lat_cycles_den
        if weighted_avg_lat_cycles_den > 0
        else 0.0
    )
    avg_lat_ns = avg_lat_cycles * config.tck_ns

    p95_lat_ns = _p95_latency_ns(lat_histogram, config)

    return {
        "read_gbps": round(read_gbps, 4),
        "write_gbps": round(write_gbps, 4),
        "total_gbps": round(total_gbps, 4),
        "avg_latency_ns": round(avg_lat_ns, 3),
        "p95_latency_ns": round(p95_lat_ns, 3),
    }


def _p95_latency_ns(histogram: dict[int, int], config: DramConfig) -> float:
    """Compute the 95th-percentile read latency from the cycle
    histogram. Returns 0.0 when no reads completed."""
    total = sum(histogram.values())
    if total == 0:
        return 0.0
    threshold = total * 0.95
    running = 0
    for cyc in sorted(histogram):
        running += histogram[cyc]
        if running >= threshold:
            return cyc * config.tck_ns
    # Fallback: last bucket.
    return max(histogram) * config.tck_ns


def _ramulator2_run(config: DramConfig, workload: str, output_dir: Path) -> dict:
    """Same fail-closed contract as the dramsim3 runner."""
    bin_path = shutil.which("ramulator2")
    raise RuntimeError(
        f"ramulator2 backend located at {bin_path or 'python bindings'} but "
        f"no workload driver checked in for {workload!r}; pending STREAM "
        "trace harness."
    )


def run_full_sweep(
    output_root: Path | None = None,
    workloads: Iterable[str] = DEFAULT_WORKLOADS,
) -> list[DramSimResult]:
    """Run the default workload list against every SKU in :data:`SKUS`.

    Writes per-SKU per-workload JSON under
    ``build/reports/memory/dramsim3_<sku>_<workload>.json`` and returns
    the flat list of results.
    """
    out_root = output_root or (ROOT / "build" / "reports" / "memory")
    out_root.mkdir(parents=True, exist_ok=True)
    all_results: list[DramSimResult] = []
    for sku_id, cfg in SKUS.items():
        sku_dir = out_root / sku_id
        sku_dir.mkdir(parents=True, exist_ok=True)
        results = run_dram_sweep(cfg, workloads, sku_dir)
        # Mirror canonical-named outputs at the top level so the
        # evidence yaml and gate parsers can resolve them by SKU.
        for r in results:
            top = out_root / f"dramsim3_{sku_id}_{r.workload}.json"
            top.write_text(json.dumps(r.to_dict(), indent=2))
        all_results.extend(results)
    return all_results


if __name__ == "__main__":
    res = run_full_sweep()
    if not res:
        print(
            "dramsim wrapper: no backend installed; wrote blocked JSON",
            file=sys.stderr,
        )
        sys.exit(2)
    for r in res:
        if r.config is None:
            continue
        print(
            f"{r.config.standard:>14} {r.workload:>14} "
            f"read={r.measured_read_bandwidth_gbps:7.2f} GB/s "
            f"write={r.measured_write_bandwidth_gbps:7.2f} GB/s "
            f"p95={r.measured_p95_latency_ns:7.2f} ns"
        )
