#!/usr/bin/env python3
"""Finalize a validated Nebius full robot training run.

This is intentionally a guarded archive step. It refuses to produce a completion
report unless the monitor status says ``state=complete`` and the production
validation report says ``ok=true``. It does not delete cloud resources or access
keys; cleanup should happen manually after the final artifacts are archived.
"""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def _load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _write_markdown(path: Path, report: dict[str, Any]) -> None:
    checks = report.get("checks", {})
    summary = report.get("summary", {})
    lines = [
        "# Nebius Full Training Finalization",
        "",
        f"Run: `{report.get('run_id')}`",
        f"Result: `{'complete' if report.get('ok') else 'not-finalized'}`",
        f"Finalized at: `{report.get('finalized_at')}`",
        "",
        "## Completion Gates",
        "",
        "| gate | result |",
        "|---|---:|",
    ]
    for name, value in checks.items():
        lines.append(f"| `{name}` | `{bool(value)}` |")
    lines += [
        "",
        "## Stage Summary",
        "",
        f"Completed stages: `{summary.get('completed_stage_count', 0)}` / "
        f"`{summary.get('total_stage_count', 0)}`",
        "",
        "## Artifact Pointers",
        "",
    ]
    for name, value in report.get("artifacts", {}).items():
        lines.append(f"- `{name}`: `{value}`")
    if not report.get("ok"):
        lines += [
            "",
            "## Missing Gates",
            "",
        ]
        missing = report.get("missing_gates") or summary.get("missing_gates") or []
        if missing:
            lines.extend(f"- `{name}`" for name in missing)
        else:
            lines.append("- unknown")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _training_report_ready_for_finalization(report: dict[str, Any]) -> bool:
    if report.get("ok") is True:
        return True
    requirements = report.get("completion_requirements")
    if not isinstance(requirements, dict):
        return False
    ignored = {
        "finalization_ok",
        "finalization_report_matches_current_validation",
    }
    non_finalization_requirements = [
        bool(value) for name, value in requirements.items() if name not in ignored
    ]
    return (
        report.get("validation_ok") is True
        and bool(non_finalization_requirements)
        and all(non_finalization_requirements)
    )


def _inventory_ready_for_finalization(inventory: dict[str, Any]) -> bool:
    if inventory.get("ok") is True:
        return True
    missing = inventory.get("missing")
    if not isinstance(missing, list):
        return False
    allowed_missing = {"finalization_report", "finalization_summary"}
    return bool(inventory) and set(map(str, missing)).issubset(allowed_missing)


def finalize_nebius_full_training_run(run_root: Path) -> dict[str, Any]:
    run_root = run_root.resolve()
    monitor = _load_json(run_root / "monitor_status.json")
    validation = _load_json(run_root / "validation_report.json")
    inventory = _load_json(run_root / "artifact_inventory.json")
    training_report = _load_json(run_root / "training_comparison_report.json")
    summary = monitor.get("summary") if isinstance(monitor.get("summary"), dict) else {}
    checks = validation.get("checks") if isinstance(validation.get("checks"), dict) else {}
    training_report_ready = _training_report_ready_for_finalization(training_report)
    inventory_ready = _inventory_ready_for_finalization(inventory)
    ok = (
        monitor.get("state") == "complete"
        and monitor.get("ok") is True
        and validation.get("ok") is True
        and inventory_ready
        and training_report_ready
        and bool(checks)
        and all(bool(value) for value in checks.values())
    )
    missing_gates = [name for name, value in checks.items() if not value]
    if not missing_gates and isinstance(summary.get("missing_gates"), list):
        missing_gates = list(summary["missing_gates"])
    if not inventory_ready:
        missing_gates.append("artifact_inventory")
    if not training_report_ready:
        missing_gates.append("training_comparison_report")
    effective_summary = dict(summary)
    effective_summary["passed_gates"] = [
        name for name, value in checks.items() if bool(value)
    ]
    effective_summary["missing_gates"] = list(missing_gates)
    report = {
        "schema": "robot-nebius-full-training-finalization-v1",
        "ok": ok,
        "run_id": monitor.get("run_id") or validation.get("run_id"),
        "run_root": str(run_root),
        "finalized_at": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "monitor_state": monitor.get("state"),
        "monitor_ok": monitor.get("ok"),
        "validation_ok": validation.get("ok"),
        "artifact_inventory_ok": inventory.get("ok"),
        "artifact_inventory_ready_for_finalization": inventory_ready,
        "training_report_ok": training_report.get("ok"),
        "training_report_ready_for_finalization": training_report_ready,
        "checks": checks,
        "summary": effective_summary,
        "missing_gates": missing_gates,
        "artifacts": {
            "monitor_status": str(run_root / "monitor_status.json"),
            "monitor_summary": str(run_root / "monitor_summary.md"),
            "validation_report": str(run_root / "validation_report.json"),
            "validation_summary": str(run_root / "validation_summary.md"),
            "artifact_inventory": str(run_root / "artifact_inventory.json"),
            "artifact_inventory_summary": str(run_root / "artifact_inventory.md"),
            "training_comparison_report": str(run_root / "training_comparison_report.json"),
            "training_comparison_summary": str(run_root / "training_comparison_report.md"),
            "finalization_report": str(run_root / "finalization_report.json"),
            "finalization_summary": str(run_root / "finalization_summary.md"),
        },
    }
    _write_json(run_root / "finalization_report.json", report)
    _write_markdown(run_root / "finalization_summary.md", report)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "run_root",
        type=Path,
        nargs="?",
        default=Path(__file__).resolve().parents[1]
        / "evidence"
        / "nebius_full_training"
        / "synced_run",
    )
    args = parser.parse_args(argv)
    report = finalize_nebius_full_training_run(args.run_root)
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
