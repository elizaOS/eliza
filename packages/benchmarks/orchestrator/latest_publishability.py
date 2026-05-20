from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .analyze_trajectory import summarize as summarize_trajectory
from .code_agent_latest_contract import (
    CODE_AGENT_LATEST_ACCEPTABLE_COMPARISON_STATUSES,
    CODE_AGENT_LATEST_AGENT,
    CODE_AGENT_LATEST_REQUIRED_NUMERIC_FIELDS,
    CODE_AGENT_LATEST_REQUIRED_PROVENANCE_FIELDS,
    CODE_AGENT_LATEST_REQUIRED_TRUE_FIELDS,
    code_agent_accuracy_for_status,
    expected_code_agent_comparison_status,
)

NON_REAL_FLAG_KEYS: frozenset[str] = frozenset(
    {
        "demo",
        "demo_mode",
        "dry_run",
        "fixture",
        "fixtures",
        "mock",
        "mock_mode",
        "oracle",
        "sample",
        "sample_tasks",
        "stub",
        "synthetic",
        "use_sample_tasks",
        "using_sample_tasks",
    }
)

NON_REAL_WARNING_TOKENS: tuple[str, ...] = (
    "demo",
    "dry_run",
    "fixture",
    "larp",
    "mock",
    "smoke",
    "stub",
)

NON_REAL_STRING_MARKERS: tuple[str, ...] = (
    "bundled smoke",
    "demo mode",
    "dry run",
    "fixture dataset",
    "larp",
    "mock run",
    "mock runtime",
    "oracle mode",
    "sample task set",
    "sample_task_set",
    "smoke task",
    "stub runtime",
    "synthetic dataset",
    "using sample task",
)

@dataclass(frozen=True)
class PublishabilityFinding:
    file: str
    path: str
    reason: str
    value: str


@dataclass(frozen=True)
class PublishabilityReport:
    latest_dir: str
    checked_files: int
    findings: tuple[PublishabilityFinding, ...]

    @property
    def ok(self) -> bool:
        return not self.findings

    def to_json(self) -> str:
        return json.dumps(
            {
                "latest_dir": self.latest_dir,
                "checked_files": self.checked_files,
                "ok": self.ok,
                "findings": [asdict(finding) for finding in self.findings],
            },
            indent=2,
            sort_keys=True,
            ensure_ascii=True,
        )


def validate_latest_publishability(
    workspace_root: Path,
    *,
    latest_dir: Path | None = None,
    include_benchmarks: set[str] | None = None,
    exclude_benchmarks: set[str] | None = None,
) -> PublishabilityReport:
    target_dir = latest_dir or workspace_root / "benchmarks" / "benchmark_results" / "latest"
    findings: list[PublishabilityFinding] = []
    checked = 0
    selected = 0
    filters_active = include_benchmarks is not None or exclude_benchmarks is not None
    if not target_dir.exists():
        return PublishabilityReport(
            latest_dir=str(target_dir),
            checked_files=0,
            findings=(
                PublishabilityFinding(
                    file=str(target_dir),
                    path=".",
                    reason="missing_latest_dir",
                    value="directory does not exist",
                ),
            ),
        )

    for path in sorted(target_dir.glob("*.json")):
        if path.name == "index.json":
            continue
        checked += 1
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            findings.append(
                PublishabilityFinding(
                    file=str(path),
                    path=".",
                    reason="invalid_json",
                    value=str(exc),
                )
            )
            continue
        if not isinstance(payload, dict):
            findings.append(
                PublishabilityFinding(
                    file=path.name,
                    path=".",
                    reason="non_object_json",
                    value=_short_value(payload),
                )
            )
            continue
        benchmark_id = str(payload.get("benchmark_id") or "").strip()
        if not _benchmark_selected(
            benchmark_id,
            include_benchmarks=include_benchmarks,
            exclude_benchmarks=exclude_benchmarks,
        ):
            continue
        selected += 1
        _scan_latest_row_contract(
            payload,
            path=path.name,
            workspace_root=workspace_root,
            findings=findings,
        )
        _scan_payload(payload, path=path.name, json_path="$", findings=findings)
    if filters_active and selected == 0:
        findings.append(
            PublishabilityFinding(
                file=str(target_dir),
                path=".",
                reason="no_selected_latest_rows",
                value="filters excluded every latest row",
            )
        )

    return PublishabilityReport(
        latest_dir=str(target_dir),
        checked_files=checked,
        findings=tuple(findings),
    )


def print_publishability_report(report: PublishabilityReport) -> None:
    print(f"Latest publishability: checked={report.checked_files} findings={len(report.findings)}")
    if report.ok:
        print("No non-real sample/demo/mock/stub markers found in latest rows.")
        return
    for finding in report.findings:
        print(
            f"- {finding.file} {finding.path}: "
            f"{finding.reason} value={finding.value}"
        )


def _scan_payload(
    value: Any,
    *,
    path: str,
    json_path: str,
    findings: list[PublishabilityFinding],
) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{json_path}.{key}" if json_path != "$" else f"$.{key}"
            key_lower = str(key).strip().lower()
            if key_lower in NON_REAL_FLAG_KEYS and _truthy_flag(child):
                findings.append(
                    PublishabilityFinding(
                        file=path,
                        path=child_path,
                        reason="truthy_non_real_flag",
                        value=_short_value(child),
                    )
                )
            if key_lower == "dataset_source" and _lower_string(child) == "sample":
                findings.append(
                    PublishabilityFinding(
                        file=path,
                        path=child_path,
                        reason="sample_dataset_source",
                        value=_short_value(child),
                    )
                )
            if key_lower == "publication_warnings":
                _scan_publication_warnings(
                    child,
                    path=path,
                    json_path=child_path,
                    findings=findings,
                )
            _scan_payload(child, path=path, json_path=child_path, findings=findings)
        return

    if isinstance(value, list):
        for index, child in enumerate(value):
            _scan_payload(
                child,
                path=path,
                json_path=f"{json_path}[{index}]",
                findings=findings,
            )
        return

    if isinstance(value, str):
        lowered = value.strip().lower()
        marker = next(
            (candidate for candidate in NON_REAL_STRING_MARKERS if candidate in lowered),
            None,
        )
        if marker:
            findings.append(
                PublishabilityFinding(
                    file=path,
                    path=json_path,
                    reason=f"non_real_text_marker:{marker}",
                    value=_short_value(value),
                )
            )


def _scan_latest_row_contract(
    payload: dict[str, Any],
    *,
    path: str,
    workspace_root: Path,
    findings: list[PublishabilityFinding],
) -> None:
    status = payload.get("status")
    if status != "succeeded":
        findings.append(
            PublishabilityFinding(
                file=path,
                path="$.status",
                reason="latest_row_not_succeeded",
                value=_short_value(status),
            )
        )
    score = payload.get("score")
    if not _is_finite_number(score):
        findings.append(
            PublishabilityFinding(
                file=path,
                path="$.score",
                reason="latest_row_missing_numeric_score",
                value=_short_value(score),
            )
        )
    if _looks_like_code_agent_report_row(payload, path=path):
        for key in CODE_AGENT_LATEST_REQUIRED_PROVENANCE_FIELDS:
            value = payload.get(key)
            if not isinstance(value, str) or not value.strip():
                findings.append(
                    PublishabilityFinding(
                        file=path,
                        path=f"$.{key}",
                        reason="missing_code_agent_provenance_field",
                        value=_short_value(value),
                    )
                )
            else:
                _scan_code_agent_provenance_artifact(
                    payload,
                    value,
                    key=key,
                    workspace_root=workspace_root,
                    path=path,
                    findings=findings,
                )
        for key in CODE_AGENT_LATEST_REQUIRED_NUMERIC_FIELDS:
            value = payload.get(key)
            if not _is_finite_number(value):
                findings.append(
                    PublishabilityFinding(
                        file=path,
                        path=f"$.{key}",
                        reason="missing_code_agent_numeric_stat",
                        value=_short_value(value),
                    )
                )
        _scan_code_agent_outcome_consistency(payload, path=path, findings=findings)
        _scan_code_agent_delta_consistency(payload, path=path, findings=findings)
        for key in CODE_AGENT_LATEST_REQUIRED_TRUE_FIELDS:
            value = payload.get(key)
            if value is not True:
                findings.append(
                    PublishabilityFinding(
                        file=path,
                        path=f"$.{key}",
                        reason="code_agent_required_gate_not_true",
                        value=_short_value(value),
                    )
                )
        comparison_status = str(payload.get("comparison_status") or "").strip()
        if comparison_status not in CODE_AGENT_LATEST_ACCEPTABLE_COMPARISON_STATUSES:
            findings.append(
                PublishabilityFinding(
                    file=path,
                    path="$.comparison_status",
                    reason="code_agent_not_comparable_or_better",
                    value=_short_value(payload.get("comparison_status")),
                )
            )
        _scan_code_agent_comparison_status_consistency(
            payload,
            path=path,
            findings=findings,
        )
        mode = payload.get("mode")
        if str(mode or "").strip() != "live":
            findings.append(
                PublishabilityFinding(
                    file=path,
                    path="$.mode",
                    reason="code_agent_not_live",
                    value=_short_value(mode),
                )
            )
        _scan_code_agent_efficiency(payload, path=path, findings=findings)


def _scan_code_agent_comparison_status_consistency(
    payload: dict[str, Any],
    *,
    path: str,
    findings: list[PublishabilityFinding],
) -> None:
    expected = expected_code_agent_comparison_status(payload)
    if expected is None:
        return
    actual = str(payload.get("comparison_status") or "").strip()
    if actual != expected:
        findings.append(
            PublishabilityFinding(
                file=path,
                path="$.comparison_status",
                reason="code_agent_comparison_status_mismatch",
                value=json.dumps(
                    {
                        "baseline_accuracy": code_agent_accuracy_for_status(
                            payload,
                            "baseline",
                        ),
                        "expected_status": expected,
                        "row_status": actual,
                        "target_accuracy": code_agent_accuracy_for_status(
                            payload,
                            "target",
                        ),
                    },
                    sort_keys=True,
                ),
            )
        )


def _scan_code_agent_provenance_artifact(
    payload: dict[str, Any],
    value: str,
    *,
    key: str,
    workspace_root: Path,
    path: str,
    findings: list[PublishabilityFinding],
) -> None:
    artifact_path = Path(value).expanduser()
    if not artifact_path.is_absolute():
        artifact_path = workspace_root / artifact_path
    if not artifact_path.exists():
        findings.append(
            PublishabilityFinding(
                file=path,
                path=f"$.{key}",
                reason="missing_code_agent_provenance_artifact",
                value=str(artifact_path),
            )
        )
        return
    if key.endswith("_trajectory_dir"):
        expected = "directory"
        ok = artifact_path.is_dir()
    else:
        expected = "file"
        ok = artifact_path.is_file()
    if not ok:
        findings.append(
            PublishabilityFinding(
                file=path,
                path=f"$.{key}",
                reason="wrong_type_code_agent_provenance_artifact",
                value=f"expected {expected}: {artifact_path}",
            )
        )
        return
    if key.endswith("_trajectory_dir") and not any(
        child.is_file() for child in artifact_path.rglob("*")
    ):
        findings.append(
            PublishabilityFinding(
                file=path,
                path=f"$.{key}",
                reason="empty_code_agent_trajectory_dir",
                value=str(artifact_path),
            )
        )
        return
    if key.endswith("_trajectory_dir"):
        _scan_code_agent_trajectory_evidence(
            payload,
            artifact_path,
            key=key,
            path=path,
            findings=findings,
        )


def _scan_code_agent_trajectory_evidence(
    payload: dict[str, Any],
    artifact_path: Path,
    *,
    key: str,
    path: str,
    findings: list[PublishabilityFinding],
) -> None:
    summary, _records = summarize_trajectory(artifact_path)
    checks = (
        (
            summary.turns <= 0,
            "unparseable_code_agent_trajectory_dir",
            "no parseable trajectory turns",
        ),
        (
            summary.prompt_tokens <= 0,
            "missing_code_agent_trajectory_input_tokens",
            "no input-token telemetry",
        ),
        (
            summary.completion_tokens <= 0,
            "missing_code_agent_trajectory_output_tokens",
            "no output-token telemetry",
        ),
        (
            summary.llm_call_count <= 0,
            "missing_code_agent_trajectory_llm_calls",
            "no LLM-call telemetry",
        ),
        (
            summary.turns_with_cached_field <= 0,
            "missing_code_agent_trajectory_cached_tokens",
            "no cached-token telemetry",
        ),
    )
    for blocked, reason, detail in checks:
        if blocked:
            findings.append(
                PublishabilityFinding(
                    file=path,
                    path=f"$.{key}",
                    reason=reason,
                    value=f"{detail}: {artifact_path}",
                )
            )
    prefix = _code_agent_trajectory_prefix(key)
    if prefix is None or summary.turns <= 0:
        return
    expected_values = {
        "input_tokens": float(summary.prompt_tokens),
        "output_tokens": float(summary.completion_tokens),
        "total_tokens": float(summary.total_tokens),
        "llm_call_count": float(summary.llm_call_count),
    }
    if summary.prompt_tokens > 0 and summary.turns_with_cached_field > 0:
        expected_values["cached_token_percent"] = (
            float(summary.cached_tokens) / float(summary.prompt_tokens) * 100.0
        )
    for metric, expected in expected_values.items():
        row_key = f"{prefix}_{metric}"
        actual = payload.get(row_key)
        if not _is_finite_number(actual):
            continue
        if not math.isclose(float(actual), expected, rel_tol=1e-9, abs_tol=1e-6):
            findings.append(
                PublishabilityFinding(
                    file=path,
                    path=f"$.{row_key}",
                    reason="code_agent_trajectory_metric_mismatch",
                    value=json.dumps(
                        {
                            "artifact": str(artifact_path),
                            "expected_from_trajectory": expected,
                            "row_value": actual,
                        },
                        sort_keys=True,
                    ),
                )
            )


def _code_agent_trajectory_prefix(key: str) -> str | None:
    if key.startswith("target_"):
        return "target"
    if key.startswith("baseline_"):
        return "baseline"
    return None


def _looks_like_code_agent_report_row(payload: dict[str, Any], *, path: str = "") -> bool:
    if str(payload.get("agent") or "").strip() == CODE_AGENT_LATEST_AGENT:
        return True
    if path.endswith(f"__{CODE_AGENT_LATEST_AGENT}.json"):
        return True
    return any(
        key in payload
        for key in (
            "target_adapter",
            "baseline_adapter",
            "target_total_tokens",
            "baseline_total_tokens",
            "target_llm_call_count",
            "baseline_llm_call_count",
            *CODE_AGENT_LATEST_REQUIRED_PROVENANCE_FIELDS,
        )
    )


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_finite_number(value: Any) -> bool:
    return _is_number(value) and math.isfinite(float(value))


def _scan_code_agent_efficiency(
    payload: dict[str, Any],
    *,
    path: str,
    findings: list[PublishabilityFinding],
) -> None:
    regressions = (
        (
            "total_token_delta",
            "code_agent_total_tokens_worse",
            lambda value: value > 0,
        ),
        (
            "llm_call_delta",
            "code_agent_llm_calls_worse",
            lambda value: value > 0,
        ),
        (
            "cached_token_percent_delta",
            "code_agent_cached_token_percent_worse",
            lambda value: value < 0,
        ),
    )
    for key, reason, is_regression in regressions:
        value = payload.get(key)
        if _is_number(value) and is_regression(float(value)):
            findings.append(
                PublishabilityFinding(
                    file=path,
                    path=f"$.{key}",
                    reason=reason,
                    value=_short_value(value),
                )
            )


def _scan_code_agent_delta_consistency(
    payload: dict[str, Any],
    *,
    path: str,
    findings: list[PublishabilityFinding],
) -> None:
    specs = (
        (
            "accuracy_delta",
            "target_accuracy",
            "baseline_accuracy",
        ),
        (
            "input_token_delta",
            "target_input_tokens",
            "baseline_input_tokens",
        ),
        (
            "output_token_delta",
            "target_output_tokens",
            "baseline_output_tokens",
        ),
        (
            "total_token_delta",
            "target_total_tokens",
            "baseline_total_tokens",
        ),
        (
            "llm_call_delta",
            "target_llm_call_count",
            "baseline_llm_call_count",
        ),
        (
            "cached_token_percent_delta",
            "target_cached_token_percent",
            "baseline_cached_token_percent",
        ),
    )
    for delta_key, target_key, baseline_key in specs:
        delta = payload.get(delta_key)
        target = payload.get(target_key)
        baseline = payload.get(baseline_key)
        if not (
            _is_finite_number(delta)
            and _is_finite_number(target)
            and _is_finite_number(baseline)
        ):
            continue
        expected = float(target) - float(baseline)
        if not math.isclose(float(delta), expected, rel_tol=1e-9, abs_tol=1e-6):
            findings.append(
                PublishabilityFinding(
                    file=path,
                    path=f"$.{delta_key}",
                    reason="code_agent_delta_mismatch",
                    value=json.dumps(
                        {
                            "baseline_field": baseline_key,
                            "baseline_value": baseline,
                            "expected_delta": expected,
                            "row_delta": delta,
                            "target_field": target_key,
                            "target_value": target,
                        },
                        sort_keys=True,
                    ),
                )
            )


def _scan_code_agent_outcome_consistency(
    payload: dict[str, Any],
    *,
    path: str,
    findings: list[PublishabilityFinding],
) -> None:
    for prefix in ("target", "baseline"):
        right_key = f"{prefix}_right"
        wrong_key = f"{prefix}_wrong"
        total_key = f"{prefix}_total"
        accuracy_key = f"{prefix}_accuracy"
        right = payload.get(right_key)
        wrong = payload.get(wrong_key)
        total = payload.get(total_key)
        if (
            _is_finite_number(right)
            and _is_finite_number(wrong)
            and _is_finite_number(total)
            and not math.isclose(
                float(right) + float(wrong),
                float(total),
                rel_tol=1e-9,
                abs_tol=1e-6,
            )
        ):
            findings.append(
                PublishabilityFinding(
                    file=path,
                    path=f"$.{total_key}",
                    reason="code_agent_outcome_total_mismatch",
                    value=json.dumps(
                        {
                            "expected_total": float(right) + float(wrong),
                            "right": right,
                            "row_total": total,
                            "wrong": wrong,
                        },
                        sort_keys=True,
                    ),
                )
            )
        if (
            _is_finite_number(right)
            and _is_finite_number(total)
            and float(total) > 0
            and _is_finite_number(payload.get(accuracy_key))
        ):
            expected_accuracy = float(right) / float(total)
            actual_accuracy = payload.get(accuracy_key)
            if not math.isclose(
                float(actual_accuracy),
                expected_accuracy,
                rel_tol=1e-9,
                abs_tol=1e-6,
            ):
                findings.append(
                    PublishabilityFinding(
                        file=path,
                        path=f"$.{accuracy_key}",
                        reason="code_agent_accuracy_mismatch",
                        value=json.dumps(
                            {
                                "expected_accuracy": expected_accuracy,
                                "right": right,
                                "row_accuracy": actual_accuracy,
                                "total": total,
                            },
                            sort_keys=True,
                        ),
                    )
                )
    target_right = payload.get("target_right")
    target_total = payload.get("target_total")
    score = payload.get("score")
    if (
        _is_finite_number(score)
        and _is_finite_number(target_right)
        and _is_finite_number(target_total)
        and float(target_total) > 0
    ):
        expected_score = float(target_right) / float(target_total)
        if not math.isclose(float(score), expected_score, rel_tol=1e-9, abs_tol=1e-6):
            findings.append(
                PublishabilityFinding(
                    file=path,
                    path="$.score",
                    reason="code_agent_score_mismatch",
                    value=json.dumps(
                        {
                            "expected_score": expected_score,
                            "row_score": score,
                            "target_right": target_right,
                            "target_total": target_total,
                        },
                        sort_keys=True,
                    ),
                )
            )


def _scan_publication_warnings(
    value: Any,
    *,
    path: str,
    json_path: str,
    findings: list[PublishabilityFinding],
) -> None:
    if not isinstance(value, list):
        return
    for index, warning in enumerate(value):
        lowered = str(warning).strip().lower()
        if lowered == "sample_task_set" or any(
            token in lowered for token in NON_REAL_WARNING_TOKENS
        ):
            findings.append(
                PublishabilityFinding(
                    file=path,
                    path=f"{json_path}[{index}]",
                    reason="non_real_publication_warning",
                    value=_short_value(warning),
                )
            )


def _truthy_flag(value: Any) -> bool:
    return value not in (False, None, "", 0, [], {})


def _lower_string(value: Any) -> str | None:
    if isinstance(value, str):
        return value.strip().lower()
    return None


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


def _short_value(value: Any) -> str:
    rendered = json.dumps(value, ensure_ascii=True, sort_keys=True, default=str)
    if len(rendered) <= 180:
        return rendered
    return f"{rendered[:177]}..."
