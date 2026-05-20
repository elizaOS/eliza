from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

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
) -> PublishabilityReport:
    target_dir = latest_dir or workspace_root / "benchmarks" / "benchmark_results" / "latest"
    findings: list[PublishabilityFinding] = []
    checked = 0
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
        _scan_latest_row_contract(payload, path=path.name, findings=findings)
        _scan_payload(payload, path=path.name, json_path="$", findings=findings)

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
    if not isinstance(score, (int, float)):
        findings.append(
            PublishabilityFinding(
                file=path,
                path="$.score",
                reason="latest_row_missing_numeric_score",
                value=_short_value(score),
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


def _short_value(value: Any) -> str:
    rendered = json.dumps(value, ensure_ascii=True, sort_keys=True, default=str)
    if len(rendered) <= 180:
        return rendered
    return f"{rendered[:177]}..."
