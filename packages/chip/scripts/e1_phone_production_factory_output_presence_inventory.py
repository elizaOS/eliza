#!/usr/bin/env python3
"""Inventory E1 phone production/factory required-output presence.

This script is intentionally fail-closed: it checks whether required output
paths named by the production/factory burndown exist, writes a dated YAML
presence report, and never promotes production, fabrication, factory, first
article, enclosure, or end-to-end readiness.
"""

from __future__ import annotations

import argparse
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parents[1]
DEFAULT_BURNDOWN = (
    ROOT / "board/kicad/e1-phone/production-factory-output-burndown-2026-05-22.yaml"
)
DEFAULT_REPORT = (
    ROOT
    / "board/kicad/e1-phone/production/readiness/"
    "production-factory-required-output-presence-inventory-2026-05-22.yaml"
)
REPORT_DATE = "2026-05-22"
PATH_FIELD_NAMES = {
    "required_outputs",
    "required_common_outputs",
    "required_functional_transcripts",
}


class NoAliasDumper(yaml.SafeDumper):
    def ignore_aliases(self, data: Any) -> bool:
        return True


def read_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: expected a YAML mapping")
    return data


def display_rel(path: Path) -> str:
    if path.is_relative_to(ROOT):
        return path.relative_to(ROOT).as_posix()
    if path.is_relative_to(REPO_ROOT):
        return path.relative_to(REPO_ROOT).as_posix()
    return str(path)


def resolve_repo_path(path_text: str) -> Path:
    path = Path(path_text)
    if path.is_absolute():
        return path
    if path_text.startswith("packages/chip/"):
        return REPO_ROOT / path
    if path_text.startswith("board/"):
        return ROOT / path
    return ROOT / path


def is_path_like(value: str) -> bool:
    if value.startswith(("board/", "packages/chip/", "/")):
        return True
    return "/" in value and "." in Path(value).name


def walk_required_output_paths(
    node: Any, pointer: str = "$", context_id: str | None = None
) -> Iterator[dict[str, str]]:
    if isinstance(node, dict):
        current_context = node.get("id") if isinstance(node.get("id"), str) else context_id
        for key, value in node.items():
            next_pointer = f"{pointer}.{key}"
            if key in PATH_FIELD_NAMES and isinstance(value, list):
                for index, item in enumerate(value):
                    if isinstance(item, str) and is_path_like(item):
                        yield {
                            "source_pointer": f"{next_pointer}[{index}]",
                            "source_field": key,
                            "source_id": current_context or "",
                            "path": item,
                        }
                continue
            yield from walk_required_output_paths(value, next_pointer, current_context)
    elif isinstance(node, list):
        for index, item in enumerate(node):
            yield from walk_required_output_paths(item, f"{pointer}[{index}]", context_id)


def dedupe_records(records: list[dict[str, str]]) -> list[dict[str, Any]]:
    by_path: dict[str, dict[str, Any]] = {}
    for record in records:
        path = record["path"]
        row = by_path.setdefault(
            path,
            {
                "path": path,
                "source_fields": [],
                "source_ids": [],
                "source_pointers": [],
            },
        )
        for field in ("source_fields", "source_ids", "source_pointers"):
            source_value = record[field[:-1] if field.endswith("s") else field]
            if source_value and source_value not in row[field]:
                row[field].append(source_value)

    return [by_path[path] for path in sorted(by_path)]


def presence_rows(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for record in records:
        resolved = resolve_repo_path(record["path"])
        present = resolved.exists()
        kind = "missing"
        if resolved.is_file():
            kind = "file"
        elif resolved.is_dir():
            kind = "directory"
        rows.append(
            {
                **record,
                "resolved_path": display_rel(resolved),
                "present": present,
                "artifact_kind": kind,
            }
        )
    return rows


def build_report(burndown_path: Path, report_path: Path) -> dict[str, Any]:
    burndown = read_yaml(burndown_path)
    raw_records = list(walk_required_output_paths(burndown))
    required_outputs = presence_rows(dedupe_records(raw_records))
    missing = [row for row in required_outputs if not row["present"]]
    present = [row for row in required_outputs if row["present"]]

    return {
        "schema": "eliza.e1_phone_production_factory_required_output_presence_inventory.v1",
        "status": (
            "blocked_fail_closed_required_outputs_missing"
            if missing
            else "blocked_fail_closed_source_burndown_still_blocks_release"
        ),
        "date": REPORT_DATE,
        "claim_boundary": (
            "Presence-only inventory for production/factory required output paths in "
            "production-factory-output-burndown-2026-05-22.yaml. Existing files or "
            "directories are not validated for correctness, signatures, freshness, "
            "supplier acceptance, first-article pass status, or release readiness."
        ),
        "inputs": {
            "production_factory_output_burndown": display_rel(burndown_path),
            "report_path": display_rel(report_path),
            "source_schema": burndown.get("schema"),
            "source_status": burndown.get("status"),
            "source_date": burndown.get("date"),
        },
        "summary": {
            "required_output_path_count": len(required_outputs),
            "present_required_output_path_count": len(present),
            "missing_required_output_path_count": len(missing),
            "all_required_output_paths_present": not missing,
            "release_state": "blocked_fail_closed",
        },
        "fail_closed_policy": {
            "production_fabrication_or_end_to_end_claims_allowed": False,
            "quote_release_allowed": False,
            "fabrication_release_allowed": False,
            "assembly_release_allowed": False,
            "factory_test_release_allowed": False,
            "selected_hardware_first_article_release_allowed": False,
            "enclosure_physical_fit_release_allowed": False,
            "end_to_end_release_allowed": False,
            "presence_only_inventory_cannot_unlock_release": True,
            "missing_or_unvalidated_required_outputs_keep_release_blocked": True,
        },
        "required_output_presence": required_outputs,
        "missing_required_outputs": missing,
        "present_required_outputs": present,
        "forbidden_claims": burndown.get(
            "forbidden_claims",
            [
                "production_ready",
                "production_factory_release_ready",
                "fabrication_ready",
                "assembly_ready",
                "factory_test_ready",
                "first_article_ready",
                "enclosure_ready",
                "end_to_end_phone_ready",
            ],
        ),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--burndown", type=Path, default=DEFAULT_BURNDOWN)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument(
        "--write-report",
        action="store_true",
        help="Write the YAML report to --report instead of printing to stdout.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report(args.burndown, args.report)
    text = yaml.dump(report, Dumper=NoAliasDumper, sort_keys=False, width=100)
    if args.write_report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(text, encoding="utf-8")
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
