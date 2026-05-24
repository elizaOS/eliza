#!/usr/bin/env python3
"""Fail-closed gate for PD evidence manifests being release-usable."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parents[1]
EVIDENCE_DIR = ROOT / "docs/evidence/pd"
REPORT = ROOT / "build/reports/pd_release_evidence.json"
PROHIBITED_RELEASE_USE = {
    "prohibited_until_external_review",
    "prohibited_until_signoff_replay",
}
RELEASE_READY_STATUSES = {
    "release_ready",
    "approved_release_evidence",
    "signoff_clean",
}

BLOCKER_CLASS_PATTERNS = {
    "drc": ("drc", "klayout", "magic"),
    "lvs": ("lvs", "netgen", "netlist"),
    "antenna": ("antenna",),
    "timing": ("sta", "timing", "wns", "tns", "slack", "setup", "hold", "spef", "sdf"),
    "drv": ("drv", "slew", "cap", "fanout", "congestion"),
    "release_artifacts": ("artifact", "manifest", "evidence", "external", "review", "signoff replay"),
}

BLOCKER_BUCKET_PATTERNS = {
    "commercial_eda_or_foundry_access": (
        "commercial eda",
        "ccopt",
        "fusion compiler",
        "primetime",
        "tempus",
        "foundry mpw",
        "vendor partnership",
        "license",
    ),
    "release_run_missing_final_artifacts": (
        "final/",
        "release run",
        "release-ready",
        "signoff replay",
        "archived from a release run",
        "post-route",
    ),
    "rtl_frontend_replay_required": (
        "frontend",
        "yosys",
        "systemverilog",
        "bootrom",
        "rtl",
        "read_verilog",
    ),
    "timing_closure": ("wns", "tns", "setup", "hold", "timing", "sta", "slack"),
    "drc_lvs_antenna_signoff": ("drc", "lvs", "antenna", "klayout", "magic", "netgen"),
    "dfx_or_test_insertion": ("dft", "scan", "mbist", "jtag", "atpg", "fault"),
    "macro_or_pdk_reference": ("openram", "sram", "macro", "lef", "gds", "liberty", "pdk"),
    "placement_ppa_training": ("alphachip", "dreamplace", "ppo", "h200", "gpu", "autotuner", "optuna"),
    "external_review_required": ("external review", "externally reviewed", "review"),
}

BUCKET_COMMANDS = {
    "commercial_eda_or_foundry_access": "document commercial EDA/foundry access in docs/evidence/pd/commercial-eda-gate.yaml",
    "release_run_missing_final_artifacts": "scripts/run_openlane.sh --release",
    "rtl_frontend_replay_required": "python3 scripts/check_e1_soc_pd_input_contract.py --strict",
    "timing_closure": "python3 scripts/run_multi_corner_sta.py",
    "drc_lvs_antenna_signoff": "python3 scripts/check_pd_signoff.py",
    "dfx_or_test_insertion": "run DFT/scan/MBIST/ATPG insertion flow and update docs/evidence/pd/dft-evidence.yaml",
    "macro_or_pdk_reference": "python3 scripts/check_e1_soc_pd_input_contract.py --strict",
    "placement_ppa_training": "python3 scripts/run_post_route_ppa.py",
    "external_review_required": "attach external review/signoff approval metadata to the PD evidence manifest",
    "release_artifacts": "python3 scripts/check_pd_release_evidence.py",
}

STALE_BOOTROM_STRING_TOKENS = (
    "parameter string",
    "string rom_path",
    "systemverilog `string`",
    "bootrom `string`",
)


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def load_yaml_mapping(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)} must be a YAML mapping")
    return data


def write_report(status: str, findings: list[dict[str, Any]], summary: dict[str, Any]) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(
        json.dumps(
            {
                "schema": "eliza.pd_release_evidence_report.v1",
                "status": status,
                "release_credit": False,
                "claim_boundary": "pd_release_evidence_manifest_check_only_not_signoff_or_tapeout_evidence",
                "summary": {"release_ready": False, "release_credit": False, **summary},
                "findings": findings,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


def blocker_classes(release_blockers: list[Any], status: Any, release_use: Any) -> list[str]:
    haystack = " ".join(str(item).lower() for item in [status, release_use, *release_blockers])
    classes = [
        name
        for name, needles in BLOCKER_CLASS_PATTERNS.items()
        if any(needle in haystack for needle in needles)
    ]
    return classes or ["release_artifacts"]


def blocker_buckets(text: str) -> list[str]:
    lowered = text.lower()
    buckets = [
        name
        for name, needles in BLOCKER_BUCKET_PATTERNS.items()
        if any(needle in lowered for needle in needles)
    ]
    return buckets or ["release_artifacts"]


def source_bootrom_string_blocker_resolved() -> bool:
    bootrom = ROOT / "rtl/bootrom/e1_bootrom.sv"
    if not bootrom.is_file():
        return False
    text = bootrom.read_text(encoding="utf-8").lower()
    return "parameter string" not in text and "string rom_path" not in text


def stale_or_misclassified_markers(path: Path, data: dict[str, Any], blockers: list[str]) -> list[dict[str, Any]]:
    markers: list[dict[str, Any]] = []
    blocker_text = "\n".join(blockers).lower()
    if path.name == "e1-soc-hard-macro-signoff-gate.yaml":
        flow_progress = data.get("flow_progress")
        stale_flow_progress = (
            isinstance(flow_progress, dict)
            and flow_progress.get("yosys_jsonheader") == "fail_read_verilog_bootrom_sv_string_type"
        )
        stale_blocker_text = any(token in blocker_text for token in STALE_BOOTROM_STRING_TOKENS) and not (
            "now fixed" in blocker_text or "fixed in the current" in blocker_text
        )
        if (stale_flow_progress or stale_blocker_text) and source_bootrom_string_blocker_resolved():
            markers.append(
                {
                    "code": "stale_bootrom_string_frontend_blocker",
                    "severity": "warning",
                    "message": (
                        "Current rtl/bootrom/e1_bootrom.sv no longer contains the "
                        "bootrom string construct named by this evidence manifest; "
                        "the remaining release blocker is missing clean signoff replay "
                        "and final OpenLane artifacts."
                    ),
                    "release_credit": False,
                    "next_command": "scripts/run_openlane.sh --release",
                }
            )
    summary = data.get("summary")
    if isinstance(summary, dict) and summary.get("input_contract_pass") is True:
        markers.append(
            {
                "code": "local_contract_pass_not_release_evidence",
                "severity": "info",
                "message": (
                    "The local PD input contract is internally consistent, but "
                    "external signoff, DRC/LVS/STA/antenna, and tapeout release "
                    "evidence are still required."
                ),
                "release_credit": False,
                "next_command": "python3 scripts/check_pd_signoff.py",
            }
        )
    return markers


def blocker_records(path: Path, data: dict[str, Any], release_blockers: list[Any]) -> list[dict[str, Any]]:
    records = []
    for index, blocker in enumerate(release_blockers, start=1):
        text = str(blocker)
        buckets = blocker_buckets(text)
        records.append(
            {
                "index": index,
                "text": text,
                "buckets": buckets,
                "primary_bucket": buckets[0],
                "next_command": BUCKET_COMMANDS.get(buckets[0], BUCKET_COMMANDS["release_artifacts"]),
                "release_credit": False,
            }
        )
    for marker in stale_or_misclassified_markers(path, data, [str(item) for item in release_blockers]):
        records.append(
            {
                "index": len(records) + 1,
                "text": marker["message"],
                "buckets": [marker["code"]],
                "primary_bucket": marker["code"],
                "next_command": marker["next_command"],
                "release_credit": False,
                "diagnostic_only": True,
                "diagnostic_code": marker["code"],
                "severity": marker["severity"],
            }
        )
    return records


def release_bucket_next_actions(bucket_counts: dict[str, int]) -> list[dict[str, Any]]:
    return [
        {
            "bucket": bucket,
            "count": count,
            "next_command": BUCKET_COMMANDS.get(bucket, BUCKET_COMMANDS["release_artifacts"]),
            "release_credit": False,
        }
        for bucket, count in sorted(bucket_counts.items(), key=lambda item: (-item[1], item[0]))
    ]


def repo_artifact_generation_summary(bucket_counts: dict[str, int]) -> dict[str, Any]:
    rows = []
    for bucket, count in sorted(bucket_counts.items(), key=lambda item: (-item[1], item[0])):
        rows.append(
            {
                "bucket": bucket,
                "count": count,
                "repo_generatable_now": False,
                "can_close_release_from_current_repo": False,
                "blocked_by": {
                    "final_signoff_replay": bucket
                    in {
                        "release_run_missing_final_artifacts",
                        "timing_closure",
                        "drc_lvs_antenna_signoff",
                        "rtl_frontend_replay_required",
                    },
                    "external_review_or_foundry_access": bucket
                    in {
                        "commercial_eda_or_foundry_access",
                        "external_review_required",
                        "macro_or_pdk_reference",
                    },
                    "dfx_or_test_evidence": bucket == "dfx_or_test_insertion",
                    "placement_ppa_training_evidence": bucket == "placement_ppa_training",
                    "diagnostic_only_local_contract": bucket
                    == "local_contract_pass_not_release_evidence",
                },
                "next_command": BUCKET_COMMANDS.get(bucket, BUCKET_COMMANDS["release_artifacts"]),
                "release_credit": False,
            }
        )
    return {
        "release_credit": False,
        "repo_generatable_now_count": 0,
        "can_close_from_current_repo_count": 0,
        "blocked_generation_count": sum(bucket_counts.values()),
        "claim_boundary": (
            "PD manifest blocker buckets may name local commands, but none can be "
            "promoted to release credit from current repo state without a clean final "
            "signoff replay plus required external review/foundry/DFX/approval evidence."
        ),
        "buckets": rows,
    }


def manifest_diagnostic(path: Path, item: dict[str, Any]) -> dict[str, Any]:
    classes = blocker_classes(
        item["release_blockers"],
        item["status"],
        item["release_use"],
    )
    records = item.get("blocker_records", [])
    bucket_counts: dict[str, int] = {}
    for record in records:
        for bucket in record.get("buckets", []):
            bucket_counts[bucket] = bucket_counts.get(bucket, 0) + 1
    return {
        "path": item["path"],
        "status": item["status"],
        "release_use": item["release_use"],
        "release_blocker_count": len(item["release_blockers"]),
        "blocker_classes": classes,
        "blocker_bucket_counts": bucket_counts,
        "blocker_records": records,
        "missing_or_blocked_artifact_classes": classes,
        "next_commands": [
            "scripts/run_openlane.sh --release",
            "python3 scripts/check_pd_signoff.py",
            "python3 scripts/check_pd_release_evidence.py",
            "python3 scripts/openlane_pd_blocker_summary.py --write-report",
        ],
        "exact_artifact_path": rel(path),
        "release_credit": False,
        "claim_boundary": (
            "This manifest is not release evidence until it has a release-ready status, "
            "non-prohibited release_use, zero release_blockers, and externally reviewed "
            "clean or formally waived PD signoff artifacts."
        ),
    }


def main() -> int:
    try:
        paths = sorted(EVIDENCE_DIR.glob("*.yaml"))
        if not paths:
            write_report(
                "blocked",
                [
                    {
                        "code": "pd_release_evidence_missing_manifest",
                        "severity": "blocker",
                        "message": f"no PD evidence manifests under {rel(EVIDENCE_DIR)}",
                        "evidence": rel(EVIDENCE_DIR),
                        "next_command": "add release-ready PD evidence manifests under docs/evidence/pd",
                        "release_credit": False,
                    }
                ],
                {"manifests": 0, "failures": 0, "blocked": 1},
            )
            print(f"STATUS: BLOCKED PD release evidence no manifests under {rel(EVIDENCE_DIR)}")
            return 2
        blocked: list[dict[str, Any]] = []
        release_ready = 0
        release_blocker_count = 0
        prohibited_count = 0
        bucket_counts: dict[str, int] = {}
        stale_or_misclassified_count = 0
        for path in paths:
            data = load_yaml_mapping(path)
            schema = data.get("schema")
            if not isinstance(schema, str) or not schema.startswith("eliza."):
                raise ValueError(f"{rel(path)}: missing eliza schema")
            status = data.get("status")
            release_use = data.get("release_use")
            release_blockers = data.get("release_blockers") or []
            if not isinstance(release_blockers, list):
                raise ValueError(f"{rel(path)}: release_blockers must be a list")
            if status in RELEASE_READY_STATUSES and release_use not in PROHIBITED_RELEASE_USE and not release_blockers:
                release_ready += 1
                continue
            if release_use in PROHIBITED_RELEASE_USE:
                prohibited_count += 1
            release_blocker_count += len(release_blockers)
            records = blocker_records(path, data, release_blockers)
            for record in records:
                if record.get("diagnostic_code", "").startswith("stale_"):
                    stale_or_misclassified_count += 1
                for bucket in record.get("buckets", []):
                    bucket_counts[bucket] = bucket_counts.get(bucket, 0) + 1
            blocked.append(
                {
                    "path": rel(path),
                    "status": status,
                    "release_use": release_use,
                    "release_blockers": [str(item) for item in release_blockers],
                    "blocker_records": records,
                    "required_statuses": sorted(RELEASE_READY_STATUSES),
                    "prohibited_release_use": sorted(PROHIBITED_RELEASE_USE),
                }
            )
    except ValueError as exc:
        write_report(
            "fail",
            [
                {
                    "code": "pd_release_evidence_invalid",
                    "severity": "error",
                    "message": str(exc),
                    "evidence": rel(EVIDENCE_DIR),
                }
            ],
            {"manifests": 0, "failures": 1, "blocked": 0},
        )
        print(f"FAIL: PD release evidence invalid: {exc}")
        return 1

    if blocked:
        write_report(
            "blocked",
            [
                {
                    "code": "pd_release_evidence_blocked",
                    "severity": "blocker",
                    "message": (
                        f"{item['path']} status={item['status']} "
                        f"release_use={item['release_use']} "
                        f"release_blockers={len(item['release_blockers'])}"
                    ),
                    "evidence": item["path"],
                    "next_step": "Replace draft/prohibited PD evidence with externally reviewed release-ready signoff evidence.",
                    "next_command": "python3 scripts/check_pd_release_evidence.py",
                    "release_credit": False,
                    "diagnostic": manifest_diagnostic(ROOT / item["path"], item),
                    "evidence_requirements": item,
                }
                for item in blocked
            ],
            {
                "manifests": len(paths),
                "release_ready": release_ready,
                "blocked": len(blocked),
                "prohibited": prohibited_count,
                "release_blockers": release_blocker_count,
                "bucket_counts": bucket_counts,
                "bucket_next_actions": release_bucket_next_actions(bucket_counts),
                "repo_artifact_generation_summary": repo_artifact_generation_summary(
                    bucket_counts
                ),
                "stale_or_misclassified_diagnostics": stale_or_misclassified_count,
                "failures": 0,
            },
        )
        print(
            "STATUS: BLOCKED PD release evidence "
            f"manifests={len(paths)} release_ready={release_ready} "
            f"blocked={len(blocked)} prohibited={prohibited_count} "
            f"release_blockers={release_blocker_count}"
        )
        for item in blocked[:10]:
            print(
                f"  - {item['path']} status={item['status']} "
                f"release_use={item['release_use']} "
                f"release_blockers={len(item['release_blockers'])}"
            )
        if len(blocked) > 10:
            print(f"  - ... {len(blocked) - 10} more blocked manifests")
        return 2

    write_report(
        "pass",
        [],
        {"release_ready": True, "manifests": len(paths), "blocked": 0, "failures": 0},
    )
    print(f"STATUS: PASS PD release evidence manifests={len(paths)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
