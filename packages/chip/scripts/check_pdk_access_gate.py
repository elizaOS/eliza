#!/usr/bin/env python3
"""Fail-closed advanced-node PDK/foundry access gate."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
ACCESS_GATE = ROOT / "docs/evidence/process/pdk-access-gate.yaml"
PORTABILITY_INDEX = ROOT / "pd/openlane/portability-index.yaml"
REPORT = ROOT / "build/reports/pdk_access_gate.json"
EXPECTED_SCHEMA = "eliza.process_pdk_access_gate.v1"
EXPECTED_STUB_SCHEMA = "eliza.pd_advanced_node_access_gate.v1"
REQUIRED_TARGETS = {"primary", "stretch", "second_source", "backup"}
REQUIRED_GLOBAL_UNBLOCKS = {
    "At_least_one_executed_foundry_agreement",
    "Commercial_signoff_EDA_seat_held",
    "Hard_IP_licenses_for_LPDDR_PHY_USB_MIPI_PLL_SRAM_compiler_at_selected_node",
    "Mask_set_NRE_budget_committed",
    "Tapeout_NRE_budget_committed",
    "Wafer_allocation_window_secured",
}


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def repo_path(path_text: str) -> Path:
    path = Path(path_text)
    if path.is_absolute():
        return path
    return ROOT / path


def load_yaml_mapping(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(f"missing file: {rel(path)}")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)} must be a YAML mapping")
    return data


def write_report(status: str, findings: list[dict[str, Any]], summary: dict[str, Any]) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(
        json.dumps(
            {
                "schema": "eliza.pdk_access_gate_report.v1",
                "status": status,
                "generated_utc": datetime.now(UTC).isoformat(),
                "claim_boundary": "foundry_access_gate_only_not_pdk_license_or_tapeout_evidence",
                "summary": {"release_ready": False, **summary},
                "findings": findings,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


def checklist_blockers(target_id: str, target: dict[str, Any]) -> list[str]:
    blockers: list[str] = []
    checklist = target.get("next_action_checklist")
    if not isinstance(checklist, list) or not checklist:
        return [f"{target_id}: missing next_action_checklist"]
    for index, item in enumerate(checklist):
        if not isinstance(item, dict):
            blockers.append(f"{target_id}.next_action_checklist[{index}]: must be mapping")
            continue
        status = item.get("status")
        if status != "done":
            blockers.append(f"{target_id}.{item.get('id', index)}: status={status}")
        if not item.get("evidence_required"):
            blockers.append(f"{target_id}.{item.get('id', index)}: missing evidence_required")
    return blockers


def validate_target(
    target_id: str,
    target: dict[str, Any],
    portability_entries: dict[str, dict[str, Any]],
    blockers: list[str],
    failures: list[str],
) -> None:
    pdk = target.get("pdk")
    if not isinstance(pdk, str) or not pdk:
        failures.append(f"{target_id}: missing pdk")
        return
    access_gate_file = target.get("access_gate_file")
    library_manifest = target.get("library_manifest")
    corner_manifest = target.get("corner_manifest")
    for field, value in {
        "access_gate_file": access_gate_file,
        "library_manifest": library_manifest,
        "corner_manifest": corner_manifest,
    }.items():
        if not isinstance(value, str) or not value:
            failures.append(f"{target_id}: missing {field}")
            continue
        if not repo_path(value).is_file():
            failures.append(f"{target_id}: {field} missing file: {value}")

    stub = load_yaml_mapping(repo_path(str(access_gate_file)))
    if stub.get("schema") != EXPECTED_STUB_SCHEMA:
        failures.append(f"{target_id}: unexpected stub schema {stub.get('schema')!r}")
    if stub.get("pdk") != pdk:
        failures.append(f"{target_id}: stub pdk mismatch")
    if not isinstance(stub.get("unblock_requires"), list) or not stub["unblock_requires"]:
        failures.append(f"{target_id}: stub missing unblock_requires")
    if not isinstance(stub.get("forbidden_claims_until_unblocked"), list):
        failures.append(f"{target_id}: stub missing forbidden claims")

    matching_entries = [
        entry
        for entry in portability_entries.values()
        if entry.get("pdk_name") == pdk or entry.get("config") == access_gate_file
    ]
    if not matching_entries:
        failures.append(f"{target_id}: no portability-index entry for {pdk}")
    for entry in matching_entries:
        if entry.get("access_gate") != target.get("status"):
            failures.append(
                f"{target_id}: portability access_gate {entry.get('access_gate')!r} "
                f"does not match target status {target.get('status')!r}"
            )

    if target.get("status") != "unblocked":
        blockers.append(f"{target_id}: status={target.get('status')}")
    blockers.extend(checklist_blockers(target_id, target))


def main() -> int:
    try:
        access = load_yaml_mapping(ACCESS_GATE)
        portability = load_yaml_mapping(PORTABILITY_INDEX)
        if access.get("schema") != EXPECTED_SCHEMA:
            raise ValueError(f"unexpected schema: {access.get('schema')!r}")
        targets = access.get("advanced_node_targets")
        if not isinstance(targets, dict):
            raise ValueError("advanced_node_targets must be a mapping")
        missing_targets = REQUIRED_TARGETS - set(targets)
        if missing_targets:
            raise ValueError("missing advanced node targets: " + ", ".join(sorted(missing_targets)))
        global_unblocks = access.get("unblock_requires_global")
        if not isinstance(global_unblocks, list):
            raise ValueError("unblock_requires_global must be a list")
        missing_global = REQUIRED_GLOBAL_UNBLOCKS - set(global_unblocks)
        if missing_global:
            raise ValueError(
                "missing global unblock requirements: " + ", ".join(sorted(missing_global))
            )
        configs = portability.get("configs")
        if not isinstance(configs, list):
            raise ValueError("portability configs must be a list")
        portability_entries = {
            str(entry.get("id")): entry for entry in configs if isinstance(entry, dict)
        }

        failures: list[str] = []
        blockers: list[str] = []
        blocked_targets = 0
        checklist_not_started = 0
        for target_id in sorted(REQUIRED_TARGETS):
            target = targets[target_id]
            if not isinstance(target, dict):
                failures.append(f"{target_id}: target must be a mapping")
                continue
            if target.get("status") != "unblocked":
                blocked_targets += 1
            checklist = target.get("next_action_checklist")
            if isinstance(checklist, list):
                checklist_not_started += sum(
                    1
                    for item in checklist
                    if isinstance(item, dict) and item.get("status") != "done"
                )
            validate_target(target_id, target, portability_entries, blockers, failures)
        global_unmet = len(REQUIRED_GLOBAL_UNBLOCKS)
    except ValueError as exc:
        write_report(
            "fail",
            [
                {
                    "code": "pdk_access_gate_invalid",
                    "severity": "error",
                    "message": str(exc),
                    "evidence": rel(ACCESS_GATE),
                }
            ],
            {"blockers": 0, "failures": 1},
        )
        print(f"FAIL: PDK access gate invalid: {exc}")
        return 1

    if failures:
        write_report(
            "fail",
            [
                {
                    "code": "pdk_access_gate_invalid",
                    "severity": "error",
                    "message": failure,
                    "evidence": rel(ACCESS_GATE),
                }
                for failure in failures
            ],
            {"blockers": len(blockers), "failures": len(failures)},
        )
        print("FAIL: PDK access gate invalid")
        for failure in failures[:20]:
            print(f"  - {failure}")
        if len(failures) > 20:
            print(f"  - ... {len(failures) - 20} more failures")
        return 1
    if blockers:
        findings = [
            {
                "code": "pdk_access_global_unmet",
                "severity": "blocker",
                "message": f"global.{requirement}: unmet",
                "evidence": rel(ACCESS_GATE),
                "next_step": "Execute foundry, EDA, hard-IP, mask/NRE, and wafer-access agreements before claiming advanced-node readiness.",
            }
            for requirement in sorted(REQUIRED_GLOBAL_UNBLOCKS)
        ] + [
            {
                "code": "pdk_access_target_blocked",
                "severity": "blocker",
                "message": blocker,
                "evidence": rel(ACCESS_GATE),
                "next_step": "Complete the target checklist item and attach the required foundry/PDK evidence.",
            }
            for blocker in blockers
        ]
        write_report(
            "blocked",
            findings,
            {
                "advanced_targets": len(REQUIRED_TARGETS),
                "blocked_targets": blocked_targets,
                "checklist_not_started": checklist_not_started,
                "global_unmet": global_unmet,
                "blockers": len(blockers) + global_unmet,
                "failures": 0,
            },
        )
        print(
            "STATUS: BLOCKED PDK access gate "
            f"advanced_targets={len(REQUIRED_TARGETS)} blocked={blocked_targets} "
            f"checklist_not_started={checklist_not_started} global_unmet={global_unmet} "
            f"blockers={len(blockers) + global_unmet}"
        )
        for requirement in sorted(REQUIRED_GLOBAL_UNBLOCKS):
            print(f"  - global.{requirement}: unmet")
        for blocker in blockers[:12]:
            print(f"  - {blocker}")
        if len(blockers) > 12:
            print(f"  - ... {len(blockers) - 12} more blockers")
        return 2

    write_report(
        "pass",
        [],
        {
            "release_ready": True,
            "advanced_targets": len(REQUIRED_TARGETS),
            "blocked_targets": 0,
            "checklist_not_started": 0,
            "global_unmet": 0,
            "blockers": 0,
            "failures": 0,
        },
    )
    print("STATUS: PASS PDK access gate advanced-node access unblocked")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
