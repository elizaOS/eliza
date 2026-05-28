#!/usr/bin/env python3
"""Audit walk-forward feasibility across supported humanoid profiles."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.validate_task_feasibility import validate  # noqa: E402

DEFAULT_PROFILES = (
    "hiwonder-ainex",
    "unitree-g1",
    "unitree-h1",
    "unitree-r1",
    "asimov-1",
)


def _summarize_profile(profile_id: str, report: dict[str, Any]) -> dict[str, Any]:
    tasks = report.get("tasks") if isinstance(report.get("tasks"), list) else []
    row = tasks[0] if tasks and isinstance(tasks[0], dict) else {}
    passive = (
        row.get("passive_baseline")
        if isinstance(row.get("passive_baseline"), dict)
        else {}
    )
    candidates = (
        row.get("candidate_results")
        if isinstance(row.get("candidate_results"), list)
        else []
    )
    active_success = bool(row.get("success"))
    passive_success = bool(passive.get("success"))
    most_forward = max(
        (item for item in candidates if isinstance(item, dict)),
        key=lambda item: float(item.get("final_delta_x_m") or 0.0),
        default={},
    )
    return {
        "profile_id": profile_id,
        "active_success": active_success,
        "passive_success": passive_success,
        "valid_walking_evidence": active_success and not passive_success,
        "selected_controller": row.get("controller"),
        "selected_final_delta_x_m": row.get("final_delta_x_m"),
        "selected_termination_reason": row.get("termination_reason"),
        "passive_final_delta_x_m": passive.get("final_delta_x_m"),
        "passive_termination_reason": passive.get("termination_reason"),
        "most_forward_controller": most_forward.get("controller"),
        "most_forward_final_delta_x_m": most_forward.get("final_delta_x_m"),
        "most_forward_termination_reason": most_forward.get("termination_reason"),
        "n_candidates": len(candidates),
    }


def audit_profiles(
    profiles: tuple[str, ...],
    *,
    max_steps: int,
) -> dict[str, Any]:
    reports: dict[str, Any] = {}
    summaries: list[dict[str, Any]] = []
    errors: dict[str, str] = {}
    for profile_id in profiles:
        try:
            report = validate(profile_id, ("walk_forward",), max_steps=max_steps)
        except Exception as exc:  # pragma: no cover - defensive evidence path
            errors[profile_id] = repr(exc)
            continue
        reports[profile_id] = report
        summaries.append(_summarize_profile(profile_id, report))
    return {
        "schema": "multi-profile-walk-feasibility-v1",
        "task_id": "walk_forward",
        "max_steps": max_steps,
        "profiles": list(profiles),
        "summaries": summaries,
        "reports": reports,
        "errors": errors,
        "n_profiles": len(profiles),
        "n_valid_walking": sum(1 for row in summaries if row["valid_walking_evidence"]),
        "n_passive_success": sum(1 for row in summaries if row["passive_success"]),
        "ok": any(row["valid_walking_evidence"] for row in summaries) and not errors,
    }


def write_markdown(path: Path, report: dict[str, Any]) -> None:
    lines = [
        "# Multi-profile Walk Feasibility",
        "",
        f"Overall ok: `{report.get('ok')}`",
        f"Valid walking profiles: `{report.get('n_valid_walking')}`",
        f"Passive-success profiles: `{report.get('n_passive_success')}`",
        "",
        "| profile | active success | passive success | selected dx m | passive dx m | most-forward controller | most-forward dx m |",
        "|---|---|---|---:|---:|---|---:|",
    ]
    for row in report.get("summaries", []):
        if not isinstance(row, dict):
            continue
        lines.append(
            f"| `{row.get('profile_id')}` | `{row.get('active_success')}` | "
            f"`{row.get('passive_success')}` | "
            f"{float(row.get('selected_final_delta_x_m') or 0.0):.3f} | "
            f"{float(row.get('passive_final_delta_x_m') or 0.0):.3f} | "
            f"`{row.get('most_forward_controller')}` | "
            f"{float(row.get('most_forward_final_delta_x_m') or 0.0):.3f} |"
        )
    if report.get("errors"):
        lines += ["", "## Errors", "", "```json", json.dumps(report["errors"], indent=2), "```"]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profiles", nargs="+", default=list(DEFAULT_PROFILES))
    parser.add_argument("--max-steps", type=int, default=120)
    parser.add_argument(
        "--out-json",
        type=Path,
        default=ROOT / "evidence" / "multi_profile_walk_feasibility.json",
    )
    parser.add_argument(
        "--out-md",
        type=Path,
        default=ROOT / "evidence" / "multi_profile_walk_feasibility.md",
    )
    args = parser.parse_args(argv)
    report = audit_profiles(tuple(args.profiles), max_steps=args.max_steps)
    args.out_json.parent.mkdir(parents=True, exist_ok=True)
    args.out_json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    write_markdown(args.out_md, report)
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
