#!/usr/bin/env python3
"""Validate an architecture-aware training smoke summary.

`smoke_full_stack.sh` writes `checkpoints/<key>-smoke-fullstack/smoke_summary.json`
with step-level pass/skip bookkeeping. This helper validates that file for
`preflight.sh` without requiring the rest of the preflight gates to run.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any


def candidate_paths(registry_key: str, root: Path = Path(".")) -> list[Path]:
    hyphen_key = registry_key.replace(".", "-")
    return [
        root / "checkpoints" / f"{hyphen_key}-smoke-fullstack" / "smoke_summary.json",
        root / "checkpoints" / f"{registry_key}-smoke-fullstack" / "smoke_summary.json",
    ]


def validate_smoke_summary(
    registry_key: str,
    *,
    max_age_hours: float,
    min_applicable_pct: float,
    root: Path = Path("."),
    now: float | None = None,
) -> tuple[bool, dict[str, Any]]:
    candidates = candidate_paths(registry_key, root)
    summary_path = next((p for p in candidates if p.exists()), None)
    detail: dict[str, Any] = {"candidates": [str(c) for c in candidates]}

    if summary_path is None:
        detail.update(
            {
                "status": "fail",
                "reason": "no smoke_summary.json under checkpoints/<key>-smoke-fullstack/",
            }
        )
        return False, detail

    now = time.time() if now is None else now
    age_hours = (now - summary_path.stat().st_mtime) / 3600.0
    detail.update(
        {
            "summary_path": str(summary_path),
            "age_hours": round(age_hours, 2),
            "max_age_hours": max_age_hours,
        }
    )
    if age_hours > max_age_hours:
        detail.update(
            {
                "status": "fail",
                "reason": f"smoke summary {age_hours:.1f}h old > {max_age_hours}h cutoff",
            }
        )
        return False, detail

    try:
        blob = json.loads(summary_path.read_text())
    except json.JSONDecodeError as exc:
        detail.update({"status": "fail", "reason": f"invalid JSON: {exc}"})
        return False, detail

    schema = int(blob.get("schemaVersion", 0) or 0)
    detail["schemaVersion"] = schema
    if schema < 2:
        detail.update(
            {
                "status": "fail",
                "reason": (
                    f"smoke summary schemaVersion={schema} predates architecture-aware "
                    "step tracking (expected >=2). Re-run scripts/smoke_full_stack.sh."
                ),
            }
        )
        return False, detail

    status = blob.get("status", "")
    applicable_pct = float(blob.get("applicable_passed_pct", 0.0) or 0.0)
    applicable = blob.get("applicable_steps", []) or []
    passed = blob.get("passed_steps", []) or []
    failed = blob.get("failed_steps", []) or []
    skipped_incompat = blob.get("skipped_incompatible_steps", []) or []
    skipped_tooling = blob.get("skipped_tooling_steps", []) or []
    detail.update(
        {
            "status_in_summary": status,
            "applicable_passed_pct": applicable_pct,
            "min_content_pct": min_applicable_pct,
            "applicable_steps": applicable,
            "passed_steps": passed,
            "failed_steps": failed,
            "skipped_incompatible_steps": skipped_incompat,
            "skipped_tooling_steps": skipped_tooling,
        }
    )

    if status != "pass":
        detail.update(
            {
                "status": "fail",
                "reason": f"smoke summary status={status!r} (failed_steps={failed})",
            }
        )
        return False, detail

    if applicable_pct < min_applicable_pct:
        detail.update(
            {
                "status": "fail",
                "reason": f"applicable_passed_pct {applicable_pct:.1f} < {min_applicable_pct}",
            }
        )
        return False, detail

    detail["status"] = "pass"
    return True, detail


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--registry-key", required=True)
    ap.add_argument("--max-age-hours", type=float, required=True)
    ap.add_argument("--min-applicable-pct", type=float, required=True)
    ap.add_argument("--detail-out", type=Path, required=True)
    ap.add_argument("--root", type=Path, default=Path("."))
    args = ap.parse_args(argv)

    ok, detail = validate_smoke_summary(
        args.registry_key,
        max_age_hours=args.max_age_hours,
        min_applicable_pct=args.min_applicable_pct,
        root=args.root,
    )
    args.detail_out.write_text(json.dumps(detail, separators=(",", ":")))
    if ok:
        print(
            f"  smoke {detail['summary_path']} age={detail['age_hours']:.1f}h "
            f"applicable_passed_pct={detail['applicable_passed_pct']:.1f}% "
            f"(applicable={len(detail['applicable_steps'])}, "
            f"passed={len(detail['passed_steps'])}, "
            f"skipped_incompat={len(detail['skipped_incompatible_steps'])}, "
            f"skipped_tooling={len(detail['skipped_tooling_steps'])})",
            file=sys.stderr,
        )
        return 0

    print(f"FAIL: {detail.get('reason', 'smoke summary failed')}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
