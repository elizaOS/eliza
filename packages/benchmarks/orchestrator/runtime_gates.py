from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

from . import adapters as adapter_module
from .adapters import (
    GAIA_OFFICIAL_DATASET_UNAVAILABLE_REASON,
    HERMES_SANDBOX_UNAVAILABLE_REASON,
    HYPERLIQUID_LIVE_UNAVAILABLE_REASON,
    SWE_BENCH_DOCKER_UNAVAILABLE_REASON,
    TERMINAL_BENCH_DOCKER_UNAVAILABLE_REASON,
    VISION_LANGUAGE_HARNESS_RUNTIME_UNAVAILABLE_REASON,
    VISION_LANGUAGE_REAL_INPUTS_UNAVAILABLE_REASON,
)


@dataclass(frozen=True)
class RuntimeGate:
    id: str
    ok: bool
    reason: str | None
    benchmarks: tuple[str, ...]


@dataclass(frozen=True)
class RuntimeGateReport:
    gates: tuple[RuntimeGate, ...]

    @property
    def ok(self) -> bool:
        return all(gate.ok for gate in self.gates)

    def to_json(self) -> str:
        return json.dumps(
            {
                "ok": self.ok,
                "gates": [asdict(gate) for gate in self.gates],
            },
            indent=2,
            sort_keys=True,
            ensure_ascii=True,
        )


def build_runtime_gate_report(_workspace_root: Path | None = None) -> RuntimeGateReport:
    gates = (
        RuntimeGate(
            id="gaia_official_dataset",
            ok=adapter_module._has_gaia_official_dataset(),
            reason=None
            if adapter_module._has_gaia_official_dataset()
            else GAIA_OFFICIAL_DATASET_UNAVAILABLE_REASON,
            benchmarks=("gaia", "gaia_orchestrated"),
        ),
        RuntimeGate(
            id="hyperliquid_live",
            ok=adapter_module._has_hyperliquid_live_backend(),
            reason=None
            if adapter_module._has_hyperliquid_live_backend()
            else HYPERLIQUID_LIVE_UNAVAILABLE_REASON,
            benchmarks=("hyperliquid_bench",),
        ),
        RuntimeGate(
            id="terminal_bench_docker",
            ok=adapter_module._has_terminal_bench_docker_backend(),
            reason=None
            if adapter_module._has_terminal_bench_docker_backend()
            else TERMINAL_BENCH_DOCKER_UNAVAILABLE_REASON,
            benchmarks=("terminal_bench",),
        ),
        RuntimeGate(
            id="swe_bench_docker",
            ok=adapter_module._has_swe_bench_docker_backend(),
            reason=None
            if adapter_module._has_swe_bench_docker_backend()
            else SWE_BENCH_DOCKER_UNAVAILABLE_REASON,
            benchmarks=("swe_bench", "swe_bench_orchestrated"),
        ),
        RuntimeGate(
            id="hermes_sandbox",
            ok=adapter_module._has_hermes_sandbox_backend(),
            reason=None
            if adapter_module._has_hermes_sandbox_backend()
            else HERMES_SANDBOX_UNAVAILABLE_REASON,
            benchmarks=(
                "hermes_tblite",
                "hermes_terminalbench_2",
                "hermes_yc_bench",
                "hermes_swe_env",
            ),
        ),
        RuntimeGate(
            id="vision_language_real_inputs",
            ok=adapter_module._has_vision_language_real_inputs(),
            reason=None
            if adapter_module._has_vision_language_real_inputs()
            else VISION_LANGUAGE_REAL_INPUTS_UNAVAILABLE_REASON,
            benchmarks=("vision_language",),
        ),
        RuntimeGate(
            id="vision_language_harness_runtime",
            ok=adapter_module._has_vision_language_harness_runtime(),
            reason=None
            if adapter_module._has_vision_language_harness_runtime()
            else VISION_LANGUAGE_HARNESS_RUNTIME_UNAVAILABLE_REASON,
            benchmarks=("vision_language",),
        ),
    )
    return RuntimeGateReport(gates=gates)


def print_runtime_gate_report(report: RuntimeGateReport) -> None:
    failed = [gate for gate in report.gates if not gate.ok]
    print(f"Runtime gates: total={len(report.gates)} failed={len(failed)}")
    for gate in report.gates:
        state = "ok" if gate.ok else "blocked"
        benchmarks = ", ".join(gate.benchmarks)
        if gate.ok:
            print(f"- {gate.id}: {state} benchmarks={benchmarks}")
        else:
            print(f"- {gate.id}: {state} benchmarks={benchmarks} reason={gate.reason}")
