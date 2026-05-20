from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .latest_comparability import validate_latest_comparability
from .latest_publishability import validate_latest_publishability
from .runtime_gates import build_runtime_gate_report


@dataclass(frozen=True)
class ReadinessFinding:
    scope: str
    reason: str
    value: str
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class ReadinessReport:
    latest_dir: str
    tolerance: float
    findings: tuple[ReadinessFinding, ...]

    @property
    def ok(self) -> bool:
        return not self.findings

    def to_json(self) -> str:
        return json.dumps(
            {
                "latest_dir": self.latest_dir,
                "tolerance": self.tolerance,
                "ok": self.ok,
                "findings": [asdict(finding) for finding in self.findings],
            },
            indent=2,
            sort_keys=True,
            ensure_ascii=True,
        )


def validate_latest_readiness(
    workspace_root: Path,
    *,
    tolerance: float = 0.08,
    latest_dir: Path | None = None,
    check_runtime_gates: bool = True,
    include_benchmarks: set[str] | None = None,
    exclude_benchmarks: set[str] | None = None,
) -> ReadinessReport:
    target_dir = latest_dir or workspace_root / "benchmarks" / "benchmark_results" / "latest"
    findings: list[ReadinessFinding] = []
    index = _load_index(target_dir)
    contract = index.get("matrix_contract") if isinstance(index, dict) else None
    summary = contract.get("summary") if isinstance(contract, dict) else None

    filters_active = include_benchmarks is not None or exclude_benchmarks is not None

    if not isinstance(contract, dict):
        findings.append(
            ReadinessFinding(
                scope="matrix_contract",
                reason="missing_matrix_contract",
                value="latest/index.json has no matrix_contract object",
            )
        )
    elif contract.get("status") != "complete" and not filters_active:
        findings.append(
            ReadinessFinding(
                scope="matrix_contract",
                reason="matrix_contract_incomplete",
                value=str(contract.get("status")),
            )
        )

    if isinstance(summary, dict) and not filters_active:
        for key in (
            "unsupported_real_cells",
            "missing_required_real_cells",
            "failed_required_real_cells",
        ):
            count = summary.get(key)
            if isinstance(count, int) and count > 0:
                findings.append(
                    ReadinessFinding(
                        scope="matrix_contract.summary",
                        reason=key,
                        value=str(count),
                    )
                )
        no_required = summary.get("no_required_real_harness_benchmarks")
        if isinstance(no_required, int) and no_required > 0:
            findings.append(
                ReadinessFinding(
                    scope="matrix_contract.summary",
                    reason="no_required_real_harness_benchmarks",
                    value=str(no_required),
                )
            )

    selected_contract_benchmarks = 0
    benchmarks = contract.get("benchmarks") if isinstance(contract, dict) else {}
    if isinstance(benchmarks, dict):
        for benchmark_id, benchmark in sorted(benchmarks.items()):
            if not _benchmark_selected(
                str(benchmark_id),
                include_benchmarks=include_benchmarks,
                exclude_benchmarks=exclude_benchmarks,
            ):
                continue
            selected_contract_benchmarks += 1
            if not isinstance(benchmark, dict):
                continue
            cells = benchmark.get("cells")
            if not isinstance(cells, dict):
                continue
            for harness, cell in sorted(cells.items()):
                if not isinstance(cell, dict):
                    continue
                state = cell.get("state")
                if state == "succeeded":
                    continue
                findings.append(
                    ReadinessFinding(
                        scope=f"{benchmark_id}::{harness}",
                        reason=str(state or "unknown_state"),
                        value=str(cell.get("reason") or cell.get("status") or ""),
                        metadata=_cell_readiness_metadata(cell),
                    )
                )
    if filters_active and isinstance(contract, dict) and selected_contract_benchmarks == 0:
        findings.append(
            ReadinessFinding(
                scope="matrix_contract.benchmarks",
                reason="no_selected_benchmarks",
                value="filters excluded every benchmark in latest/index.json",
            )
        )

    publishability = validate_latest_publishability(
        workspace_root,
        latest_dir=target_dir,
        include_benchmarks=include_benchmarks,
        exclude_benchmarks=exclude_benchmarks,
    )
    findings.extend(
        ReadinessFinding(
            scope=f"publishability:{finding.file}{finding.path}",
            reason=finding.reason,
            value=finding.value,
        )
        for finding in publishability.findings
    )
    comparability = validate_latest_comparability(
        workspace_root,
        tolerance=tolerance,
        latest_dir=target_dir,
        include_benchmarks=include_benchmarks,
        exclude_benchmarks=exclude_benchmarks,
    )
    findings.extend(
        ReadinessFinding(
            scope=f"comparability:{finding.benchmark_id}",
            reason=finding.reason,
            value=finding.value,
        )
        for finding in comparability.findings
    )
    if check_runtime_gates:
        runtime_gates = build_runtime_gate_report(workspace_root)
        findings.extend(
            ReadinessFinding(
                scope=f"runtime_gate:{gate.id}",
                reason="runtime_gate_blocked",
                value=str(gate.reason or ""),
                metadata=gate.metadata,
            )
            for gate in runtime_gates.gates
            if not gate.ok
        )

    return ReadinessReport(
        latest_dir=str(target_dir),
        tolerance=tolerance,
        findings=tuple(findings),
    )


def print_readiness_report(report: ReadinessReport) -> None:
    print(
        "Latest readiness: "
        f"tolerance={report.tolerance} findings={len(report.findings)}"
    )
    if report.ok:
        print("Latest benchmark matrix is complete, publishable, and comparable.")
        return
    for finding in report.findings:
        suffix = ""
        if finding.metadata:
            suffix = f" metadata={json.dumps(finding.metadata, sort_keys=True)}"
        print(f"- {finding.scope}: {finding.reason} value={finding.value}{suffix}")


def _cell_readiness_metadata(cell: dict[str, Any]) -> dict[str, Any] | None:
    metadata: dict[str, Any] = {}
    required_env = cell.get("required_env")
    if isinstance(required_env, list):
        env_values = [str(value) for value in required_env if str(value).strip()]
        if env_values:
            metadata["required_env"] = env_values
    return metadata or None


def _load_index(latest_dir: Path) -> dict[str, Any]:
    try:
        payload = json.loads((latest_dir / "index.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _benchmark_selected(
    benchmark_id: str,
    *,
    include_benchmarks: set[str] | None,
    exclude_benchmarks: set[str] | None,
) -> bool:
    if include_benchmarks is not None and benchmark_id not in include_benchmarks:
        return False
    if exclude_benchmarks is not None and benchmark_id in exclude_benchmarks:
        return False
    return True
