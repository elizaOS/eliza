from __future__ import annotations

import json
import subprocess
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .artifact_guard import ArtifactGuardReport, build_artifact_guard_report
from .inventory import BenchmarkInventoryReport, build_inventory_report
from .latest_readiness import ReadinessReport, validate_latest_readiness


@dataclass(frozen=True)
class ReviewPackage:
    ok: bool
    manifest: dict[str, Any]
    markdown: str


def build_review_package(
    workspace_root: Path,
    *,
    latest_dir: Path | None = None,
    reviewed_by: str,
    reviewer_note: str,
    tolerance: float = 0.08,
    check_runtime_gates: bool = True,
    include_benchmarks: set[str] | None = None,
    exclude_benchmarks: set[str] | None = None,
    generated_at: str | None = None,
    git_sha: str | None = None,
) -> ReviewPackage:
    """Build the final benchmark review scorecard/manifest from latest artifacts.

    The package is intentionally derived from the same validator reports an
    operator runs manually: static inventory, latest readiness, and generated
    artifact leak guard. It can still write a blocked package so reviewers get
    concrete next actions, but ``ok`` is true only when every gate passes and a
    human review note is present.
    """

    target_dir = latest_dir or workspace_root / "benchmarks" / "benchmark_results" / "latest"
    repo_root = workspace_root.parent
    timestamp = generated_at or _now_iso()
    sha = git_sha or _current_git_sha(repo_root)
    note = reviewer_note.strip()

    inventory = build_inventory_report(repo_root)
    readiness = validate_latest_readiness(
        workspace_root,
        tolerance=tolerance,
        latest_dir=target_dir,
        check_runtime_gates=check_runtime_gates,
        include_benchmarks=include_benchmarks,
        exclude_benchmarks=exclude_benchmarks,
    )
    artifact_guard = build_artifact_guard_report(workspace_root)
    latest_rows, row_findings = _load_latest_rows(
        target_dir,
        include_benchmarks=include_benchmarks,
        exclude_benchmarks=exclude_benchmarks,
    )

    blocking_findings = _blocking_findings(
        inventory=inventory,
        readiness=readiness,
        artifact_guard=artifact_guard,
        latest_rows=latest_rows,
        row_findings=row_findings,
        reviewer_note=note,
    )
    manifest = {
        "schema_version": 1,
        "generated_at": timestamp,
        "git_sha": sha,
        "reviewed_by": reviewed_by.strip(),
        "reviewer_note": note,
        "latest_dir": str(target_dir),
        "filters": {
            "include_benchmarks": sorted(include_benchmarks or []),
            "exclude_benchmarks": sorted(exclude_benchmarks or []),
            "runtime_gates_checked": check_runtime_gates,
            "tolerance": tolerance,
        },
        "summary": {
            "ok": not blocking_findings,
            "latest_rows": len(latest_rows),
            "inventory_gaps": _inventory_gap_count(inventory),
            "readiness_findings": len(readiness.findings),
            "artifact_offenders": len(artifact_guard.offending),
            "blocking_findings": len(blocking_findings),
        },
        "gates": {
            "inventory": _inventory_gate(inventory),
            "latest_readiness": json.loads(readiness.to_json()),
            "artifact_guard": _artifact_gate(artifact_guard),
        },
        "latest_rows": latest_rows,
        "blocking_findings": blocking_findings,
    }
    return ReviewPackage(
        ok=bool(manifest["summary"]["ok"]),
        manifest=manifest,
        markdown=_render_markdown(manifest),
    )


def write_review_package(package: ReviewPackage, out_dir: Path) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "manifest.json"
    scorecard_path = out_dir / "scorecard.md"
    manifest_path.write_text(
        json.dumps(package.manifest, indent=2, sort_keys=True, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )
    scorecard_path.write_text(package.markdown, encoding="utf-8")
    return manifest_path, scorecard_path


def _now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _current_git_sha(repo_root: Path) -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return "unknown"
    return result.stdout.strip() or "unknown"


def _load_latest_rows(
    latest_dir: Path,
    *,
    include_benchmarks: set[str] | None,
    exclude_benchmarks: set[str] | None,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    rows: list[dict[str, Any]] = []
    findings: list[dict[str, str]] = []
    if not latest_dir.is_dir():
        findings.append(
            {
                "gate": "latest_rows",
                "scope": str(latest_dir),
                "reason": "missing_latest_dir",
                "value": "latest directory does not exist",
            }
        )
        return rows, findings

    for path in sorted(latest_dir.glob("*.json")):
        if path.name == "index.json":
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            findings.append(
                {
                    "gate": "latest_rows",
                    "scope": path.name,
                    "reason": "unreadable_latest_row",
                    "value": str(exc),
                }
            )
            continue
        if not isinstance(payload, dict):
            findings.append(
                {
                    "gate": "latest_rows",
                    "scope": path.name,
                    "reason": "latest_row_not_object",
                    "value": type(payload).__name__,
                }
            )
            continue

        benchmark_id = str(payload.get("benchmark_id") or _filename_benchmark(path))
        if not _benchmark_selected(
            benchmark_id,
            include_benchmarks=include_benchmarks,
            exclude_benchmarks=exclude_benchmarks,
        ):
            continue
        rows.append(_summarize_latest_row(path, payload, benchmark_id))
    return rows, findings


def _filename_benchmark(path: Path) -> str:
    stem = path.stem
    if "__" in stem:
        return stem.split("__", 1)[0]
    return stem


def _filename_agent(path: Path) -> str:
    stem = path.stem
    if "__" in stem:
        return stem.split("__", 1)[1]
    return ""


def _summarize_latest_row(
    path: Path,
    payload: dict[str, Any],
    benchmark_id: str,
) -> dict[str, Any]:
    metrics = payload.get("metrics")
    metrics = metrics if isinstance(metrics, dict) else {}
    token_metrics = payload.get("token_metrics")
    token_metrics = token_metrics if isinstance(token_metrics, dict) else {}
    return {
        "file": path.name,
        "benchmark_id": benchmark_id,
        "agent": str(payload.get("agent") or payload.get("harness") or _filename_agent(path)),
        "status": str(payload.get("status") or ""),
        "provider": str(payload.get("provider") or ""),
        "model": str(payload.get("model") or ""),
        "run_id": str(payload.get("run_id") or ""),
        "score": payload.get("score"),
        "unit": payload.get("unit"),
        "higher_is_better": payload.get("higher_is_better"),
        "output_dir": str(payload.get("output_dir") or ""),
        "trajectory_dir": str(
            payload.get("trajectory_dir")
            or payload.get("target_trajectory_dir")
            or metrics.get("trajectory_dir")
            or ""
        ),
        "input_tokens": _metric_value(payload, token_metrics, "input_tokens"),
        "output_tokens": _metric_value(payload, token_metrics, "output_tokens"),
        "total_tokens": _metric_value(payload, token_metrics, "total_tokens"),
        "cached_tokens": _metric_value(payload, token_metrics, "cached_tokens"),
    }


def _metric_value(payload: dict[str, Any], token_metrics: dict[str, Any], key: str) -> Any:
    return payload.get(key, token_metrics.get(key))


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


def _blocking_findings(
    *,
    inventory: BenchmarkInventoryReport,
    readiness: ReadinessReport,
    artifact_guard: ArtifactGuardReport,
    latest_rows: list[dict[str, Any]],
    row_findings: list[dict[str, str]],
    reviewer_note: str,
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    if inventory.registry_entries_without_adapters:
        findings.append(
            _finding(
                "inventory",
                "registry_entries_without_adapters",
                "registry entries have no orchestrator adapter",
                ", ".join(inventory.registry_entries_without_adapters),
            )
        )
    if inventory.benchmark_directories_without_adapters:
        findings.append(
            _finding(
                "inventory",
                "benchmark_directories_without_adapters",
                "benchmark directories have no orchestrator adapter",
                ", ".join(inventory.benchmark_directories_without_adapters),
            )
        )
    for finding in readiness.findings:
        row = asdict(finding)
        row["gate"] = "latest_readiness"
        findings.append(row)
    for path in artifact_guard.offending:
        findings.append(
            _finding(
                "artifact_guard",
                path,
                "generated_artifact_committed",
                "remove generated benchmark output from the git index",
            )
        )
    findings.extend(row_findings)
    if not latest_rows:
        findings.append(
            _finding(
                "latest_rows",
                "latest",
                "no_latest_rows",
                "no selected latest row JSON files were found",
            )
        )
    if not reviewer_note:
        findings.append(
            _finding(
                "reviewer_note",
                "manual_review",
                "missing_reviewer_note",
                "provide a note confirming trajectories/replays were opened and spot-reviewed",
            )
        )
    return findings


def _finding(gate: str, scope: str, reason: str, value: str) -> dict[str, Any]:
    return {
        "gate": gate,
        "scope": scope,
        "reason": reason,
        "value": value,
    }


def _inventory_gap_count(report: BenchmarkInventoryReport) -> int:
    return len(report.registry_entries_without_adapters) + len(
        report.benchmark_directories_without_adapters
    )


def _inventory_gate(report: BenchmarkInventoryReport) -> dict[str, Any]:
    return {
        "ok": not report.has_gaps,
        "adapter_count": report.adapter_count,
        "registry_entry_count": report.registry_entry_count,
        "benchmark_directory_count": report.benchmark_directory_count,
        "checklist_count": report.checklist_count,
        "registry_entries_without_adapters": list(report.registry_entries_without_adapters),
        "adapters_without_registry_entries": list(report.adapters_without_registry_entries),
        "benchmark_directories_without_adapters": list(
            report.benchmark_directories_without_adapters
        ),
    }


def _artifact_gate(report: ArtifactGuardReport) -> dict[str, Any]:
    return {
        "ok": report.ok,
        "checked_count": report.checked_count,
        "offending": list(report.offending),
    }


def _render_markdown(manifest: dict[str, Any]) -> str:
    summary = manifest["summary"]
    lines = [
        "# Benchmark Review Scorecard",
        "",
        f"- status: `{'ok' if summary['ok'] else 'blocked'}`",
        f"- git SHA: `{manifest['git_sha']}`",
        f"- generated at: `{manifest['generated_at']}`",
        f"- latest dir: `{manifest['latest_dir']}`",
        f"- reviewed by: `{manifest['reviewed_by'] or 'unspecified'}`",
        f"- latest rows: `{summary['latest_rows']}`",
        f"- readiness findings: `{summary['readiness_findings']}`",
        f"- artifact offenders: `{summary['artifact_offenders']}`",
        "",
        "## Reviewer Note",
        "",
        manifest["reviewer_note"] or "_Missing manual trajectory/replay review note._",
        "",
        "## Gate Summary",
        "",
        "| gate | status | detail |",
        "| --- | --- | --- |",
        _gate_row("inventory", manifest["gates"]["inventory"]["ok"], f"gaps={summary['inventory_gaps']}"),
        _gate_row(
            "latest readiness",
            manifest["gates"]["latest_readiness"]["ok"],
            f"findings={summary['readiness_findings']}",
        ),
        _gate_row(
            "artifact guard",
            manifest["gates"]["artifact_guard"]["ok"],
            f"offenders={summary['artifact_offenders']}",
        ),
        "",
    ]

    blockers = manifest["blocking_findings"]
    if blockers:
        lines.extend(["## Blocking Findings", ""])
        for finding in blockers:
            lines.append(
                f"- `{finding.get('gate', 'gate')}` `{finding.get('scope', '')}`: "
                f"{finding.get('reason', '')} - {finding.get('value', '')}"
            )
        lines.append("")

    lines.extend(
        [
            "## Latest Rows",
            "",
            "| benchmark | agent | status | score | provider | model | run id | trajectory dir |",
            "| --- | --- | --- | --- | --- | --- | --- | --- |",
        ]
    )
    for row in manifest["latest_rows"]:
        lines.append(
            "| "
            + " | ".join(
                [
                    _md(row.get("benchmark_id")),
                    _md(row.get("agent")),
                    _md(row.get("status")),
                    _md(row.get("score")),
                    _md(row.get("provider")),
                    _md(row.get("model")),
                    _md(row.get("run_id")),
                    _md(row.get("trajectory_dir")),
                ]
            )
            + " |"
        )
    lines.append("")
    return "\n".join(lines)


def _gate_row(name: str, ok: bool, detail: str) -> str:
    return f"| {_md(name)} | `{'ok' if ok else 'blocked'}` | {_md(detail)} |"


def _md(value: Any) -> str:
    if value is None:
        return ""
    return str(value).replace("\n", " ").replace("|", "\\|")
