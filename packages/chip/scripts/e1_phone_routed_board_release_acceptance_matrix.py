#!/usr/bin/env python3
"""Build the E1 phone routed-board release acceptance matrix.

The matrix is fail-closed by construction: it inventories source requirements,
current file presence, missing nets, and next unblock actions without promoting
route, fabrication, enclosure, factory, or end-to-end readiness.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parents[1]
E1_DIR = ROOT / "board/kicad/e1-phone"
READINESS_DIR = E1_DIR / "production/readiness"
REPORT_DATE = "2026-05-22"

DEFAULT_ROUTE_INVENTORY = E1_DIR / "kicad-route-readiness-inventory-2026-05-22.yaml"
DEFAULT_BURNDOWN = E1_DIR / "routed-layout-si-drc-burndown-2026-05-22.yaml"
DEFAULT_RELEASE_PLAN = E1_DIR / "routed-release-plan.yaml"
DEFAULT_YAML_REPORT = READINESS_DIR / f"routed-board-release-acceptance-matrix-{REPORT_DATE}.yaml"
DEFAULT_MD_REPORT = READINESS_DIR / f"routed-board-release-acceptance-matrix-{REPORT_DATE}.md"


DOMAIN_REQUIREMENT_HINTS = {
    "usb_c_power_sidekey_spine": ("usb_c_power", "side_buttons", "battery"),
    "display_touch_mipi_dsi": ("display_touch",),
    "front_rear_camera_mipi_csi": ("cameras",),
    "cellular_wifi_bt_rf_host": ("radios",),
    "compute_memory_storage_escape": ("compute_storage",),
    "split_interconnect_and_audio_haptics": ("split_interconnect", "audio_haptics"),
    "factory_test_fiducials_and_manufacturing_coupons": ("manufacturing",),
}


class NoAliasDumper(yaml.SafeDumper):
    def ignore_aliases(self, data: Any) -> bool:
        return True


def read_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{display_rel(path)}: expected YAML mapping")
    return data


def display_rel(path: Path) -> str:
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
    if path_text.startswith("mechanical/"):
        return ROOT / path
    return E1_DIR / path


def flatten_exact_nets(node: Any) -> list[str]:
    nets: list[str] = []
    if isinstance(node, dict):
        for value in node.values():
            nets.extend(flatten_exact_nets(value))
    elif isinstance(node, list):
        nets.extend(str(item) for item in node)
    return nets


def path_presence(path_text: str, source_present: bool | None = None) -> dict[str, Any]:
    resolved = resolve_repo_path(path_text)
    exists = resolved.exists()
    kind = "missing"
    if resolved.is_file():
        kind = "file"
    elif resolved.is_dir():
        kind = "directory"
    return {
        "path": path_text,
        "resolved_path": display_rel(resolved),
        "present": exists,
        "artifact_kind": kind,
        "source_declared_present": source_present,
    }


def dedupe_by_path(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_path: dict[str, dict[str, Any]] = {}
    for row in rows:
        path = row["path"]
        existing = by_path.setdefault(path, {**row, "source_ids": [], "required_statuses": []})
        source_id = row.get("source_id")
        if source_id and source_id not in existing["source_ids"]:
            existing["source_ids"].append(source_id)
        required_status = row.get("required_status")
        if required_status and required_status not in existing["required_statuses"]:
            existing["required_statuses"].append(required_status)
        existing["present"] = bool(existing["present"] or row["present"])
        if existing["artifact_kind"] == "missing" and row["artifact_kind"] != "missing":
            existing["artifact_kind"] = row["artifact_kind"]
    return [by_path[path] for path in sorted(by_path)]


def collect_required_outputs(
    burndown: dict[str, Any], release_plan: dict[str, Any]
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in burndown.get("required_kicad_routed_board_outputs", []):
        if not isinstance(item, dict):
            continue
        row = path_presence(str(item["path"]), item.get("present"))
        rows.append(
            {
                **row,
                "source": "routed-layout-si-drc-burndown.required_kicad_routed_board_outputs",
                "source_id": item.get("id"),
                "required_status": item.get("required_status"),
            }
        )
    for domain in burndown.get("route_domains", []):
        for output in domain.get("required_route_outputs", []):
            row = path_presence(str(output))
            rows.append(
                {
                    **row,
                    "source": "routed-layout-si-drc-burndown.route_domains.required_route_outputs",
                    "source_id": domain.get("id"),
                    "required_status": "domain_acceptance_required",
                }
            )
    manifest = release_plan.get("required_release_output_manifest", {})
    for output_id, item in manifest.items():
        if not isinstance(item, dict) or not item.get("release_required", False):
            continue
        row = path_presence(str(item["expected_path"]), item.get("present"))
        rows.append(
            {
                **row,
                "source": "routed-release-plan.required_release_output_manifest",
                "source_id": output_id,
                "required_status": item.get("blocker"),
                "owner": item.get("owner"),
            }
        )
    return dedupe_by_path(rows)


def collect_validation_evidence(burndown: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for evidence_id, evidence in burndown.get("validation_evidence_required", {}).items():
        if not isinstance(evidence, dict):
            continue
        artifacts = []
        for artifact in evidence.get("required_artifacts", []):
            artifacts.append(path_presence(str(artifact)))
        missing = [item["path"] for item in artifacts if not item["present"]]
        rows.append(
            {
                "id": evidence_id,
                "acceptance_rule": evidence.get("acceptance_rule"),
                "source_declared_present": evidence.get("present"),
                "present": not missing and bool(artifacts),
                "required_artifacts": artifacts,
                "missing_artifacts": missing,
            }
        )
    return rows


def first_matching_unblock_action(
    release_plan: dict[str, Any], missing_outputs: list[str], current_blockers: list[str]
) -> str:
    for step in release_plan.get("order_of_operations", []):
        exit_outputs = [str(item) for item in step.get("exit_outputs", [])]
        if any(output in missing_outputs for output in exit_outputs):
            actions = step.get("actions", [])
            return str(
                actions[0] if actions else step.get("current_status", "complete prior blocked step")
            )
    return (
        current_blockers[0]
        if current_blockers
        else "complete the first blocked routed-release prerequisite"
    )


def route_domain_rows(
    route_inventory: dict[str, Any],
    burndown: dict[str, Any],
    release_plan: dict[str, Any],
) -> list[dict[str, Any]]:
    inventory_by_id = {
        item.get("id"): item
        for item in route_inventory.get("route_domain_net_inventory", [])
        if isinstance(item, dict)
    }
    route_requirements = release_plan.get("route_completion_requirements", {})
    rows: list[dict[str, Any]] = []
    for domain in burndown.get("route_domains", []):
        domain_id = str(domain["id"])
        inventory = inventory_by_id.get(domain_id, {})
        exact_nets = sorted(set(flatten_exact_nets(domain.get("exact_nets", {}))))
        missing_nets = sorted(set(inventory.get("missing_exact_nets", [])))
        present_count = inventory.get(
            "exact_nets_present_count", len(exact_nets) - len(missing_nets)
        )
        outputs = [
            path_presence(str(output)) for output in domain.get("required_route_outputs", [])
        ]
        missing_outputs = [output["path"] for output in outputs if not output["present"]]
        evidence = []
        for requirement_id in DOMAIN_REQUIREMENT_HINTS.get(domain_id, ()):
            requirement = route_requirements.get(requirement_id)
            if isinstance(requirement, dict):
                evidence.append(
                    {
                        "id": requirement_id,
                        "required_nets": requirement.get("required_nets", []),
                        "required_evidence": requirement.get("required_evidence", []),
                    }
                )
        current_blockers = [str(item) for item in domain.get("current_blockers", [])]
        rows.append(
            {
                "id": domain_id,
                "owner": domain.get("owner"),
                "source_status": domain.get("status"),
                "route_classes": domain.get("route_classes", []),
                "route_regions": domain.get("route_regions", []),
                "required_exact_net_count": len(exact_nets),
                "present_exact_net_count": present_count,
                "missing_exact_net_count": len(missing_nets),
                "missing_exact_nets": missing_nets,
                "required_production_outputs": outputs,
                "missing_production_outputs": missing_outputs,
                "required_acceptance_evidence": evidence,
                "current_blockers": current_blockers,
                "current_presence": {
                    "nets_complete": not missing_nets,
                    "required_outputs_complete": not missing_outputs,
                    "route_execution_ready": False,
                    "release_accepted": False,
                },
                "next_unblock_action": first_matching_unblock_action(
                    release_plan, missing_outputs, current_blockers
                ),
            }
        )
    return rows


def build_report(
    route_inventory_path: Path,
    burndown_path: Path,
    release_plan_path: Path,
    yaml_report_path: Path,
    md_report_path: Path,
) -> dict[str, Any]:
    route_inventory = read_yaml(route_inventory_path)
    burndown = read_yaml(burndown_path)
    release_plan = read_yaml(release_plan_path)

    domains = route_domain_rows(route_inventory, burndown, release_plan)
    required_outputs = collect_required_outputs(burndown, release_plan)
    validation_evidence = collect_validation_evidence(burndown)
    missing_outputs = [row for row in required_outputs if not row["present"]]
    missing_evidence = [row for row in validation_evidence if not row["present"]]
    domains_with_missing_nets = [row for row in domains if row["missing_exact_net_count"]]
    domains_with_missing_outputs = [row for row in domains if row["missing_production_outputs"]]

    forbidden_claims = sorted(
        set(route_inventory.get("forbidden_claims", []))
        | set(burndown.get("forbidden_claims", []))
        | set(release_plan.get("forbidden_claims", []))
    )

    return {
        "schema": "eliza.e1_phone_routed_board_release_acceptance_matrix.v1",
        "status": "blocked_fail_closed_routed_board_release_acceptance_not_met",
        "date": REPORT_DATE,
        "claim_boundary": (
            "Fail-closed acceptance matrix generated from routed-board source inventories. "
            "This is not a routed PCB, DRC/ERC result, SI/PI/RF signoff, manufacturing package, "
            "routed STEP, enclosure release, factory release, or end-to-end phone readiness claim."
        ),
        "inputs": {
            "kicad_route_readiness_inventory": display_rel(route_inventory_path),
            "routed_layout_si_drc_burndown": display_rel(burndown_path),
            "routed_release_plan": display_rel(release_plan_path),
            "yaml_report_path": display_rel(yaml_report_path),
            "markdown_report_path": display_rel(md_report_path),
            "source_statuses": {
                "kicad_route_readiness_inventory": route_inventory.get("status"),
                "routed_layout_si_drc_burndown": burndown.get("status"),
                "routed_release_plan": release_plan.get("status"),
            },
        },
        "summary": {
            "route_domain_count": len(domains),
            "domains_with_missing_exact_nets": len(domains_with_missing_nets),
            "domains_with_missing_production_outputs": len(domains_with_missing_outputs),
            "required_output_path_count": len(required_outputs),
            "missing_required_output_path_count": len(missing_outputs),
            "validation_evidence_category_count": len(validation_evidence),
            "missing_validation_evidence_category_count": len(missing_evidence),
            "release_state": "blocked_fail_closed",
            "acceptance_allowed": False,
        },
        "fail_closed_policy": {
            "route_execution_ready": False,
            "routed_release_accepted": False,
            "fabrication_ready": False,
            "enclosure_ready": False,
            "factory_ready": False,
            "end_to_end_phone_ready": False,
            "acceptance_unlock_requires_all_route_domains_outputs_and_validation_evidence_present": True,
        },
        "route_domain_acceptance_matrix": domains,
        "missing_production_outputs": missing_outputs,
        "required_acceptance_evidence": validation_evidence,
        "next_global_unblock_actions": [
            step
            for step in release_plan.get("order_of_operations", [])
            if str(step.get("current_status", "")).startswith("blocked")
        ],
        "forbidden_claims": forbidden_claims,
    }


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# E1 Phone Routed-Board Release Acceptance Matrix",
        "",
        f"Date: {report['date']}",
        "",
        f"Status: `{report['status']}`",
        "",
        report["claim_boundary"],
        "",
        "## Summary",
        "",
        "| Metric | Value |",
        "| --- | ---: |",
    ]
    for key, value in report["summary"].items():
        lines.append(f"| `{key}` | `{value}` |")
    lines.extend(
        [
            "",
            "## Route Domains",
            "",
            "| Domain | Missing nets | Missing outputs | Next unblock action |",
            "| --- | ---: | ---: | --- |",
        ]
    )
    for domain in report["route_domain_acceptance_matrix"]:
        lines.append(
            "| `{id}` | {nets} | {outputs} | {action} |".format(
                id=domain["id"],
                nets=domain["missing_exact_net_count"],
                outputs=len(domain["missing_production_outputs"]),
                action=str(domain["next_unblock_action"]).replace("|", "\\|"),
            )
        )
    lines.extend(
        [
            "",
            "## Required Acceptance Evidence",
            "",
            "| Evidence | Present | Missing artifacts | Acceptance rule |",
            "| --- | --- | ---: | --- |",
        ]
    )
    for evidence in report["required_acceptance_evidence"]:
        lines.append(
            "| `{id}` | `{present}` | {missing} | {rule} |".format(
                id=evidence["id"],
                present=evidence["present"],
                missing=len(evidence["missing_artifacts"]),
                rule=str(evidence["acceptance_rule"]).replace("|", "\\|"),
            )
        )
    lines.extend(
        [
            "",
            "## Fail-Closed Claims",
            "",
            "Acceptance remains blocked. Forbidden claims include:",
            "",
        ]
    )
    lines.extend(f"- `{claim}`" for claim in report["forbidden_claims"])
    lines.append("")
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--route-inventory", type=Path, default=DEFAULT_ROUTE_INVENTORY)
    parser.add_argument("--burndown", type=Path, default=DEFAULT_BURNDOWN)
    parser.add_argument("--release-plan", type=Path, default=DEFAULT_RELEASE_PLAN)
    parser.add_argument("--yaml-report", type=Path, default=DEFAULT_YAML_REPORT)
    parser.add_argument("--md-report", type=Path, default=DEFAULT_MD_REPORT)
    parser.add_argument("--write-report", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report(
        args.route_inventory,
        args.burndown,
        args.release_plan,
        args.yaml_report,
        args.md_report,
    )
    yaml_text = yaml.dump(report, Dumper=NoAliasDumper, sort_keys=False, width=100)
    md_text = render_markdown(report)
    if args.write_report:
        args.yaml_report.parent.mkdir(parents=True, exist_ok=True)
        args.yaml_report.write_text(yaml_text, encoding="utf-8")
        args.md_report.write_text(md_text, encoding="utf-8")
    else:
        print(yaml_text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
