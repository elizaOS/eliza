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
) -> ReadinessReport:
    target_dir = latest_dir or workspace_root / "benchmarks" / "benchmark_results" / "latest"
    findings: list[ReadinessFinding] = []
    index = _load_index(target_dir)
    contract = index.get("matrix_contract") if isinstance(index, dict) else None
    summary = contract.get("summary") if isinstance(contract, dict) else None

    if not isinstance(contract, dict):
        findings.append(
            ReadinessFinding(
                scope="matrix_contract",
                reason="missing_matrix_contract",
                value="latest/index.json has no matrix_contract object",
            )
        )
    elif contract.get("status") != "complete":
        findings.append(
            ReadinessFinding(
                scope="matrix_contract",
                reason="matrix_contract_incomplete",
                value=str(contract.get("status")),
            )
        )

    if isinstance(summary, dict):
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

    benchmarks = contract.get("benchmarks") if isinstance(contract, dict) else {}
    if isinstance(benchmarks, dict):
        for benchmark_id, benchmark in sorted(benchmarks.items()):
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
                    )
                )

    publishability = validate_latest_publishability(workspace_root, latest_dir=target_dir)
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
        print(f"- {finding.scope}: {finding.reason} value={finding.value}")


def _load_index(latest_dir: Path) -> dict[str, Any]:
    try:
        payload = json.loads((latest_dir / "index.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}
