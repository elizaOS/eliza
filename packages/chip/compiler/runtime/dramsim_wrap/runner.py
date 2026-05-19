"""Backend-agnostic LPDDR DRAM simulator runner.

Supports DRAMSim3 (preferred) and Ramulator2. The wrapper produces
``eliza.memory.dram_sim_sweep.v1`` JSON records that the gate parser
under ``scripts/check_bandwidth_sustained.py`` consumes when it is
explicitly invoked in simulator-only mode.

Outputs are tagged ``simulator_only`` and cannot satisfy phone-class
real-target bandwidth claims; see
``docs/evidence/memory/uma-dram-evidence-gate.yaml``.
"""

from __future__ import annotations

import importlib
import json
import shutil
import sys
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


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


@dataclass
class DramSimResult:
    schema: str = "eliza.memory.dram_sim_sweep.v1"
    status: str = "simulator_only"
    backend: str = ""
    config: DramConfig | None = None
    workload: str = ""
    requested_address_range_bytes: int = 0
    measured_read_bandwidth_gbps: float = 0.0
    measured_write_bandwidth_gbps: float = 0.0
    measured_p95_latency_ns: float = 0.0
    captured_utc: str = field(
        default_factory=lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    )
    raw_log_path: str = ""

    def to_dict(self) -> dict:
        return {
            "schema": self.schema,
            "status": self.status,
            "backend": self.backend,
            "captured_utc": self.captured_utc,
            "standard": self.config.standard if self.config else None,
            "data_rate_mtps": self.config.data_rate_mtps if self.config else None,
            "bus_width_bits": self.config.bus_width_bits if self.config else None,
            "channels": self.config.channels if self.config else None,
            "bits_per_channel": self.config.bits_per_channel if self.config else None,
            "capacity_gib": self.config.capacity_gib if self.config else None,
            "peak_bandwidth_gbps": self.config.peak_bandwidth_gbps if self.config else None,
            "workload": self.workload,
            "requested_address_range_bytes": self.requested_address_range_bytes,
            "measured_read_bandwidth_gbps": self.measured_read_bandwidth_gbps,
            "measured_write_bandwidth_gbps": self.measured_write_bandwidth_gbps,
            "measured_p95_latency_ns": self.measured_p95_latency_ns,
            "simulator_only_note": (
                "This is a DRAM simulator result. It cannot satisfy the "
                "phone-class real-target bandwidth gate in "
                "docs/evidence/memory/uma-dram-evidence-gate.yaml."
            ),
            "raw_log_path": self.raw_log_path,
        }


def available_backends() -> list[str]:
    backends: list[str] = []
    if shutil.which("dramsim3main") or _module_present("dramsim3"):
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
                "prefers DRAMSim3 when both are installed because LPDDR5X/6 timing "
                "models there are better aligned with the JEDEC standard."
            ),
        }
        (output_dir / "dram_sim_blocked.json").write_text(json.dumps(blocked, indent=2))
        return []

    backend = backends[0]
    results: list[DramSimResult] = []
    runner_fn = _dramsim3_run if backend == "dramsim3" else _ramulator2_run
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
            }
            (output_dir / f"dram_sim_{backend}_{workload}_blocked.json").write_text(
                json.dumps(blocked, indent=2)
            )
            continue
        result.measured_read_bandwidth_gbps = measured["read_gbps"]
        result.measured_write_bandwidth_gbps = measured["write_gbps"]
        result.measured_p95_latency_ns = measured["p95_latency_ns"]
        out_path = output_dir / f"dram_sim_{backend}_{workload}.json"
        out_path.write_text(json.dumps(result.to_dict(), indent=2))
        results.append(result)
    return results


def _dramsim3_run(config: DramConfig, workload: str, output_dir: Path) -> dict:
    """Invoke DRAMSim3 against the config.  When the binary or Python
    bindings are present but the test harness for the workload is not
    yet implemented, fail closed via RuntimeError so the caller writes
    a blocked-status JSON instead of fabricating numbers."""
    bin_path = shutil.which("dramsim3main")
    if bin_path is None:
        # No CLI, try Python bindings
        try:
            module = importlib.import_module("dramsim3")
        except ImportError as exc:
            raise RuntimeError(
                "dramsim3 reported as available but neither dramsim3main "
                "nor python bindings could be invoked"
            ) from exc
        # Python bindings exist but no canonical workload driver is
        # checked in yet; ask the caller to land a driver before claims.
        del module  # silence unused
        raise RuntimeError(
            "dramsim3 python bindings available but no workload driver "
            f"is checked in for {workload!r}. Add an executable workload "
            "driver to compiler/runtime/dramsim_wrap/ before claiming "
            "measured bandwidth."
        )
    # CLI path: the workload-specific .trc files need to be generated by
    # the upstream STREAM/lmbench harness which is BLOCKED on the cross-
    # toolchain. See docs/evidence/memory/bandwidth-sustained-evidence-gate
    # for the current cross-toolchain status.
    raise RuntimeError(
        f"dramsim3main found at {bin_path} but workload trace file for "
        f"{workload!r} is not generated yet; STREAM/lmbench cross-compile "
        "is pending riscv64-unknown-linux-gnu-gcc availability."
    )


def _ramulator2_run(config: DramConfig, workload: str, output_dir: Path) -> dict:
    """Same fail-closed contract as the dramsim3 runner."""
    bin_path = shutil.which("ramulator2")
    raise RuntimeError(
        f"ramulator2 backend located at {bin_path or 'python bindings'} but "
        f"no workload driver checked in for {workload!r}; pending STREAM "
        "trace harness."
    )


if __name__ == "__main__":
    cfg = DramConfig(
        standard="LPDDR5X-10667",
        data_rate_mtps=10667,
        bus_width_bits=64,
        channels=4,
        bits_per_channel=16,
        capacity_gib=16,
        config_path=Path(__file__).parent / "configs" / "lpddr5x_10667.ini",
    )
    out = ROOT / "build" / "memory" / "dram_sim_sweep"
    res = run_dram_sweep(cfg, ["stream_triad", "random_pointer_chase"], out)
    for r in res:
        print(json.dumps(r.to_dict(), indent=2))
    if not res:
        print("dramsim wrapper: no backend installed; wrote blocked JSON")
        sys.exit(2)
