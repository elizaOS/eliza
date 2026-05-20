from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .calibration_report import _comparison_signature_for_run
from .code_agent_latest_contract import (
    CODE_AGENT_LATEST_ACCEPTABLE_COMPARISON_STATUSES,
    CODE_AGENT_LATEST_AGENT,
    expected_code_agent_comparison_status,
)

REAL_HARNESSES: tuple[str, ...] = ("eliza", "hermes", "openclaw")


@dataclass(frozen=True)
class ComparabilityFinding:
    benchmark_id: str
    reason: str
    value: str


@dataclass(frozen=True)
class ComparabilityReport:
    latest_dir: str
    checked_benchmarks: int
    tolerance: float
    findings: tuple[ComparabilityFinding, ...]

    @property
    def ok(self) -> bool:
        return not self.findings

    def to_json(self) -> str:
        return json.dumps(
            {
                "latest_dir": self.latest_dir,
                "checked_benchmarks": self.checked_benchmarks,
                "tolerance": self.tolerance,
                "ok": self.ok,
                "findings": [asdict(finding) for finding in self.findings],
            },
            indent=2,
            sort_keys=True,
            ensure_ascii=True,
        )


def validate_latest_comparability(
    workspace_root: Path,
    *,
    tolerance: float = 0.08,
    latest_dir: Path | None = None,
    include_benchmarks: set[str] | None = None,
    exclude_benchmarks: set[str] | None = None,
) -> ComparabilityReport:
    target_dir = latest_dir or workspace_root / "benchmarks" / "benchmark_results" / "latest"
    findings: list[ComparabilityFinding] = []
    rows_by_benchmark: dict[str, dict[str, dict[str, Any]]] = {}
    index = _load_index(target_dir)
    filters_active = include_benchmarks is not None or exclude_benchmarks is not None
    contract_benchmarks = (
        ((index.get("matrix_contract") or {}).get("benchmarks") or {})
        if isinstance(index, dict)
        else {}
    )

    for path in sorted(target_dir.glob("*.json")) if target_dir.exists() else []:
        if path.name == "index.json":
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(payload, dict):
            continue
        benchmark_id = str(payload.get("benchmark_id") or "").strip()
        agent = str(payload.get("agent") or "").strip().lower()
        if (
            benchmark_id
            and _row_agent_supported(agent)
            and _benchmark_selected(
                benchmark_id,
                include_benchmarks=include_benchmarks,
                exclude_benchmarks=exclude_benchmarks,
            )
        ):
            rows_by_benchmark.setdefault(benchmark_id, {})[agent] = payload

    benchmark_ids = sorted(
        benchmark_id
        for benchmark_id in set(rows_by_benchmark) | set(contract_benchmarks)
        if _benchmark_selected(
            benchmark_id,
            include_benchmarks=include_benchmarks,
            exclude_benchmarks=exclude_benchmarks,
        )
    )
    if filters_active and not benchmark_ids:
        findings.append(
            ComparabilityFinding(
                benchmark_id=".",
                reason="no_selected_benchmarks",
                value="filters excluded every benchmark",
            )
        )
    for benchmark_id in benchmark_ids:
        contract = contract_benchmarks.get(benchmark_id)
        required = _required_harnesses(contract)
        rows = rows_by_benchmark.get(benchmark_id, {})
        if not required:
            continue
        missing = sorted(agent for agent in required if agent not in rows)
        if missing:
            findings.append(
                ComparabilityFinding(
                    benchmark_id=benchmark_id,
                    reason="missing_required_latest_rows",
                    value=", ".join(missing),
                )
            )
            continue

        scores: dict[str, float] = {}
        signatures: dict[str, str] = {}
        for agent in required:
            row = rows[agent]
            status = row.get("status")
            score = row.get("score")
            if status != "succeeded":
                findings.append(
                    ComparabilityFinding(
                        benchmark_id=benchmark_id,
                        reason=f"{agent}_not_succeeded",
                        value=str(status),
                    )
                )
            if not isinstance(score, (int, float)) or not math.isfinite(float(score)):
                findings.append(
                    ComparabilityFinding(
                        benchmark_id=benchmark_id,
                        reason=f"{agent}_missing_numeric_score",
                        value=str(score),
                    )
                )
            else:
                scores[agent] = float(score)
            if agent == CODE_AGENT_LATEST_AGENT:
                comparison_status = str(row.get("comparison_status") or "").strip()
                if comparison_status not in CODE_AGENT_LATEST_ACCEPTABLE_COMPARISON_STATUSES:
                    findings.append(
                        ComparabilityFinding(
                            benchmark_id=benchmark_id,
                            reason="code_agent_not_comparable_or_better",
                            value=str(row.get("comparison_status")),
                        )
                    )
                expected_status = expected_code_agent_comparison_status(row)
                if expected_status is not None and comparison_status != expected_status:
                    findings.append(
                        ComparabilityFinding(
                            benchmark_id=benchmark_id,
                            reason="code_agent_comparison_status_mismatch",
                            value=json.dumps(
                                {
                                    "expected_status": expected_status,
                                    "row_status": comparison_status,
                                },
                                sort_keys=True,
                            ),
                        )
                    )
            signature = _comparison_signature_for_latest_row(row)
            if signature:
                signatures[agent] = signature

        if len(signatures) == len(required) and len(set(signatures.values())) > 1:
            findings.append(
                ComparabilityFinding(
                    benchmark_id=benchmark_id,
                    reason="mixed_comparison_signatures",
                    value=json.dumps(signatures, sort_keys=True),
                )
            )
        if len(scores) == len(required) and scores:
            spread = max(scores.values()) - min(scores.values())
            baseline = min(scores.values())
            if not math.isclose(
                max(scores.values()),
                baseline,
                rel_tol=tolerance,
                abs_tol=tolerance,
            ):
                findings.append(
                    ComparabilityFinding(
                        benchmark_id=benchmark_id,
                        reason="score_spread_exceeds_tolerance",
                        value=json.dumps(
                            {"scores": scores, "spread": spread},
                            sort_keys=True,
                        ),
                    )
                )

    return ComparabilityReport(
        latest_dir=str(target_dir),
        checked_benchmarks=len(benchmark_ids),
        tolerance=tolerance,
        findings=tuple(findings),
    )


def print_comparability_report(report: ComparabilityReport) -> None:
    print(
        "Latest comparability: "
        f"checked={report.checked_benchmarks} "
        f"tolerance={report.tolerance} "
        f"findings={len(report.findings)}"
    )
    if report.ok:
        print("All required latest real-harness rows are comparable within tolerance.")
        return
    for finding in report.findings:
        print(f"- {finding.benchmark_id}: {finding.reason} value={finding.value}")


def _load_index(latest_dir: Path) -> dict[str, Any]:
    try:
        payload = json.loads((latest_dir / "index.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _comparison_signature_for_latest_row(row: dict[str, Any]) -> str:
    existing = row.get("comparison_signature")
    if isinstance(existing, str) and existing.strip():
        return existing.strip()
    return _comparison_signature_for_run(row)


def _required_harnesses(contract: Any) -> tuple[str, ...]:
    if not isinstance(contract, dict):
        return REAL_HARNESSES
    cells = contract.get("cells")
    if not isinstance(cells, dict):
        return REAL_HARNESSES
    if (
        isinstance(cells.get(CODE_AGENT_LATEST_AGENT), dict)
        and cells[CODE_AGENT_LATEST_AGENT].get("required") is True
    ):
        return (CODE_AGENT_LATEST_AGENT,)
    required = [
        harness
        for harness in REAL_HARNESSES
        if isinstance(cells.get(harness), dict) and cells[harness].get("required") is True
    ]
    return tuple(required)


def _row_agent_supported(agent: str) -> bool:
    return agent in REAL_HARNESSES or agent == CODE_AGENT_LATEST_AGENT


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
