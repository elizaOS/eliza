#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from chip_utils import load_json_object, require

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import check_software_bsp  # noqa: E402

OUT = ROOT / "build/reports/software_bsp_scope.json"
EVIDENCE_MANIFEST = ROOT / "docs/evidence/software-bsp-evidence-manifest.json"
LOG_MANIFEST = ROOT / "docs/android/bsp-log-evidence-manifest.json"
ARTIFACT_MANIFEST = ROOT / "docs/android/bsp-artifact-manifest.json"
BOOT_SCHEMA = ROOT / "docs/android/boot-transcript.schema.json"
ANDROID_PROOF_TEMPLATE = (
    ROOT / "docs/benchmarks/capabilities/e1_npu_android_proof_manifest.template.json"
)
NNAPI_PROOF_TEMPLATE = ROOT / "docs/benchmarks/capabilities/e1_npu_nnapi.proof.template.json"
SCaffold_CHECKER = ROOT / "sw/check_bsp_scaffolds.py"
SOFTWARE_BSP_CHECKER = ROOT / "scripts/check_software_bsp.py"

REQUIRED_TARGETS = {"buildroot", "linux", "opensbi", "aosp"}
ALTERNATE_TARGETS = {"u-boot"}
REQUIRED_AOSP_EVIDENCE = {
    "docs/evidence/android/eliza_ai_soc_lunch.log",
    "docs/evidence/android/eliza_ai_soc_vendorimage.log",
    "docs/evidence/android/eliza_ai_soc_checkvintf.log",
    "docs/evidence/android/eliza_ai_soc_sepolicy_build.log",
    "docs/evidence/android/eliza_ai_soc_selinux_neverallow.log",
    "docs/evidence/android/eliza_ai_soc_cts_vts_plan.log",
    "docs/evidence/android/eliza_ai_soc_cvd_hal_smoke.log",
    "docs/evidence/android/cuttlefish_riscv64_smoke.log",
    "docs/evidence/android/qemu_riscv64_smoke.log",
    "docs/evidence/android/renode_e1_soc_smoke.log",
}
REQUIRED_CAPTURE_COMMAND_TOKENS = {
    "buildroot": (
        "capture-buildroot-evidence.sh /path/to/buildroot defconfig",
        "capture-buildroot-evidence.sh /path/to/buildroot image-manifest",
        "E1_SMOKE_CMD=",
        "E1_NPU_ML_SMOKE_CMD=",
    ),
    "linux": (
        "capture-linux-bsp-evidence.sh /path/to/linux kernel-build",
        "capture-linux-bsp-evidence.sh /path/to/linux dtb-check",
        "E1_SMOKE_CMD=",
    ),
    "opensbi": (
        "capture-opensbi-evidence.sh /path/to/opensbi build",
        "capture-opensbi-evidence.sh /path/to/opensbi handoff",
        "ELIZA_OPENSBI_HANDOFF_CMD=",
    ),
    "u-boot": (
        "capture-u-boot-evidence.sh /path/to/u-boot build",
        "capture-u-boot-evidence.sh /path/to/u-boot boot-chain",
        "ELIZA_UBOOT_CMD=",
        "ELIZA_UBOOT_BOOT_CMD=",
    ),
    "aosp": (
        "capture-aosp-evidence.sh /path/to/aosp lunch",
        "capture-aosp-evidence.sh /path/to/aosp vendorimage",
        "capture-aosp-evidence.sh /path/to/aosp checkvintf",
        "capture-aosp-evidence.sh /path/to/aosp cuttlefish-smoke",
        "AOSP_QEMU_SMOKE_COMMAND=",
        "AOSP_RENODE_SMOKE_COMMAND=",
    ),
}
REQUIRED_BOOT_SCHEMA_ENVS = {"cuttlefish_riscv64", "qemu_riscv64", "renode_e1_soc"}


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def list_values(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def contains_all(text: str, tokens: tuple[str, ...]) -> bool:
    lowered = text.lower()
    return all(token.lower() in lowered for token in tokens)


def code_from_text(text: str, fallback: str) -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "_" for char in text)
    parts = [part for part in cleaned.split("_") if part]
    return "_".join(parts[:10]) or fallback


def target_reports() -> list[dict[str, Any]]:
    return [check_software_bsp.target_report(name) for name in sorted(REQUIRED_TARGETS)]


def structured_findings(
    reports: list[dict[str, Any]], checks: list[dict[str, Any]]
) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    for check in checks:
        if check.get("status") == "pass":
            continue
        ident = str(check.get("id", "scope_check"))
        findings.append(
            {
                "code": f"software_bsp_scope_check_failed_{code_from_text(ident, 'scope_check')}",
                "severity": "blocker",
                "message": f"{ident} structural scope check is {check.get('status')}",
                "evidence": str(check.get("evidence", "")),
                "next_step": "Repair the software BSP scope contract before using this report as release evidence.",
            }
        )
    for report in reports:
        target = str(report.get("target", "target"))
        if report.get("scaffold_status") != "PASS":
            findings.append(
                {
                    "code": f"software_bsp_scaffold_not_pass_{code_from_text(target, 'target')}",
                    "severity": "blocker",
                    "message": f"{target} scaffold status is {report.get('scaffold_status')}",
                    "evidence": "targets[].scaffold_status",
                    "next_step": "Repair the scaffold contract before using this target for BSP release evidence.",
                }
            )
        if report.get("evidence_status") == "PASS":
            continue
        for item in list_values(report.get("missing_evidence")):
            if not isinstance(item, dict):
                continue
            code = str(item.get("blocker_code") or code_from_text(str(item.get("path")), "missing"))
            findings.append(
                {
                    "code": f"software_bsp_missing_evidence_{code}",
                    "severity": "blocker",
                    "message": f"{target} missing {item.get('artifact') or item.get('path')}",
                    "evidence": str(item.get("path", "")),
                    "next_step": str(
                        item.get("capture_command") or item.get("validation_command") or ""
                    ),
                }
            )
        for item in list_values(report.get("invalid_evidence")):
            if not isinstance(item, dict):
                continue
            path = str(item.get("path", "evidence"))
            for problem in list_values(item.get("problems")):
                text = str(problem)
                findings.append(
                    {
                        "code": (
                            "software_bsp_invalid_evidence_"
                            f"{code_from_text(path + '_' + text, 'invalid')}"
                        ),
                        "severity": "blocker",
                        "message": text,
                        "evidence": path,
                        "next_step": f"Regenerate {path} with PASS markers, then run python3 scripts/check_software_bsp.py {target} --require-evidence.",
                    }
                )
        for error in list_values(report.get("errors")):
            text = str(error)
            findings.append(
                {
                    "code": f"software_bsp_error_{code_from_text(target + '_' + text, 'error')}",
                    "severity": "blocker",
                    "message": text,
                    "evidence": target,
                    "next_step": f"Fix the {target} BSP scaffold and rerun python3 scripts/check_software_bsp.py {target} --require-evidence.",
                }
            )
    return findings


def evidence_paths_for_target(manifest: dict[str, Any], target: str) -> set[str]:
    entries = list_values(mapping(mapping(manifest.get("targets")).get(target)).get("evidence"))
    return {str(entry.get("path")) for entry in entries if isinstance(entry, dict)}


def manifests_match_checker_targets(
    evidence_manifest: dict[str, Any], log_manifest: dict[str, Any]
) -> bool:
    if evidence_manifest.get("claim_boundary") != "external_transcripts_only":
        return False
    if log_manifest.get("claim_boundary") != "expected_future_log_markers_only_not_boot_evidence":
        return False
    log_specs = mapping(log_manifest.get("logs"))
    for target in REQUIRED_TARGETS:
        checker_paths = set(check_software_bsp.TARGETS[target]["evidence"])
        manifest_paths = evidence_paths_for_target(evidence_manifest, target)
        if manifest_paths != checker_paths:
            return False
        for path in checker_paths:
            spec = mapping(log_specs.get(path))
            if not spec:
                return False
            for key in (
                "blocker_code",
                "claim_boundary",
                "producer_command",
                "capture_hint",
                "required_metadata",
            ):
                if not spec.get(key):
                    return False
            if not any(spec.get(key) for key in ("required_all", "required_any")):
                return False
            if not list_values(spec.get("forbidden_claims")):
                return False
    return True


def scaffold_passes_and_evidence_blocks(reports: list[dict[str, Any]]) -> bool:
    if {str(report.get("target")) for report in reports} != REQUIRED_TARGETS:
        return False
    any_blocked = False
    for report in reports:
        if report.get("scaffold_status") != "PASS":
            return False
        if report.get("evidence_status") == "PASS":
            continue
        if not list_values(report.get("missing_evidence")) and not list_values(
            report.get("invalid_evidence")
        ):
            return False
        any_blocked = True
    return any_blocked


def aosp_boundaries_are_fail_closed() -> bool:
    errors: list[str] = []
    check_software_bsp.check_boot_transcript_schema(errors)
    check_software_bsp.check_aosp_product_glue(errors)
    check_software_bsp.check_android_proof_templates(errors)
    if errors:
        return False
    proof = load_json_object(ANDROID_PROOF_TEMPLATE)
    nnapi = load_json_object(NNAPI_PROOF_TEMPLATE)
    statuses = mapping(proof.get("required_statuses"))
    return (
        proof.get("schema") == "eliza.e1_npu_android_proof_manifest.v1"
        and proof.get("status") == "blocked"
        and proof.get("claim_boundary") == check_software_bsp.ANDROID_PROOF_TEMPLATE_BOUNDARY
        and all(status == "blocked" for status in statuses.values())
        and set(statuses) >= check_software_bsp.REQUIRED_ANDROID_PROOF_STATUSES
        and nnapi.get("schema") == "eliza.e1_npu_nnapi_capability.v1"
        and set(mapping(nnapi.get("transcripts"))) >= check_software_bsp.REQUIRED_NNAPI_TRANSCRIPTS
    )


def capture_plans_cover_release_evidence() -> bool:
    for target, tokens in REQUIRED_CAPTURE_COMMAND_TOKENS.items():
        commands = check_software_bsp.capture_plan_commands(
            target,
            buildroot=None,
            linux=None,
            opensbi=None,
            u_boot=None,
            aosp=None,
            target_host=None,
            opensbi_handoff_cmd=None,
            qemu_smoke_cmd=None,
            renode_smoke_cmd=None,
        )
        text = "\n".join(commands)
        if not contains_all(text, tokens):
            return False
    return True


def boot_schema_is_reference_only(schema: dict[str, Any]) -> bool:
    properties = mapping(schema.get("properties"))
    environment = mapping(properties.get("environment"))
    claim_boundary = mapping(properties.get("claim_boundary"))
    return (
        set(list_values(environment.get("enum"))) == REQUIRED_BOOT_SCHEMA_ENVS
        and claim_boundary.get("const")
        == "virtual_device_smoke_only_not_boot_or_compatibility_evidence"
        and {
            "smoke_log_path",
            "required_markers",
            "forbidden_markers",
            "blockers",
        }
        <= set(str(field) for field in list_values(schema.get("required")))
    )


def artifact_manifest_blocks_boot_claims(manifest: dict[str, Any]) -> bool:
    targets = mapping(manifest.get("targets"))
    if manifest.get("claim_boundary") != "host_checkable_manifest_only_not_boot_evidence":
        return False
    for target in REQUIRED_TARGETS:
        entry = mapping(targets.get(target))
        if not entry.get("external_tree") or not entry.get("source_command"):
            return False
        if set(list_values(entry.get("required_repo_evidence"))) != set(
            check_software_bsp.TARGETS[target]["evidence"]
        ):
            return False
        claim = str(entry.get("minimum_claim_to_clear_block", "")).lower()
        if target != "aosp" and "android" in claim:
            return False
    return True


def build_report() -> dict[str, Any]:
    evidence_manifest = load_json_object(EVIDENCE_MANIFEST)
    log_manifest = load_json_object(LOG_MANIFEST)
    artifact_manifest = load_json_object(ARTIFACT_MANIFEST)
    boot_schema = load_json_object(BOOT_SCHEMA)
    reports = target_reports()
    missing_total = sum(len(list_values(report.get("missing_evidence"))) for report in reports)
    invalid_total = sum(len(list_values(report.get("invalid_evidence"))) for report in reports)
    checks = [
        {
            "id": "software_bsp_manifests_match_checker_targets",
            "status": "pass"
            if manifests_match_checker_targets(evidence_manifest, log_manifest)
            else "fail",
            "evidence": rel(EVIDENCE_MANIFEST),
        },
        {
            "id": "software_bsp_scaffolds_pass_but_external_evidence_blocks_release",
            "status": "pass" if scaffold_passes_and_evidence_blocks(reports) else "fail",
            "evidence": rel(SOFTWARE_BSP_CHECKER),
        },
        {
            "id": "aosp_boot_compatibility_and_nnapi_claims_fail_closed",
            "status": "pass" if aosp_boundaries_are_fail_closed() else "fail",
            "evidence": rel(ANDROID_PROOF_TEMPLATE),
        },
        {
            "id": "capture_plans_cover_external_build_boot_and_runtime_evidence",
            "status": "pass" if capture_plans_cover_release_evidence() else "fail",
            "evidence": rel(SOFTWARE_BSP_CHECKER),
        },
        {
            "id": "virtual_device_boot_schema_is_reference_only",
            "status": "pass" if boot_schema_is_reference_only(boot_schema) else "fail",
            "evidence": rel(BOOT_SCHEMA),
        },
        {
            "id": "artifact_manifest_blocks_boot_and_compatibility_claims",
            "status": "pass" if artifact_manifest_blocks_boot_claims(artifact_manifest) else "fail",
            "evidence": rel(ARTIFACT_MANIFEST),
        },
    ]
    findings = structured_findings(reports, checks)
    return {
        "schema": "eliza.software_bsp_scope.v1",
        "status": "software_bsp_scope_release_blocked",
        "claim_boundary": (
            "Software BSP scope audit only; not external Buildroot evidence, not external "
            "Linux kernel evidence, not OpenSBI handoff evidence, not Android boot evidence, "
            "not alternate U-Boot boot-chain evidence, not Android compatibility evidence, "
            "not CTS/VTS evidence, not NNAPI acceleration evidence, and not a product BSP release claim."
        ),
        "current_scaffolds": {
            "software_bsp_checker": rel(SOFTWARE_BSP_CHECKER),
            "scaffold_checker": rel(SCaffold_CHECKER),
            "evidence_manifest": rel(EVIDENCE_MANIFEST),
            "log_evidence_manifest": rel(LOG_MANIFEST),
            "artifact_manifest": rel(ARTIFACT_MANIFEST),
            "boot_transcript_schema": rel(BOOT_SCHEMA),
            "android_proof_template": rel(ANDROID_PROOF_TEMPLATE),
            "nnapi_proof_template": rel(NNAPI_PROOF_TEMPLATE),
        },
        "targets": reports,
        "findings": findings,
        "blocked_until_real_evidence": [
            "external Buildroot defconfig transcript and image manifest with PASS provenance markers",
            "Buildroot target runtime MMIO and e1-npu ML smoke transcripts from the built image",
            "external Linux kernel build and dtbs_check transcripts for Eliza E1 drivers/devicetree",
            "Linux target runtime MMIO smoke transcript showing /dev/e1-npu and DMA/display contract markers",
            "external OpenSBI build transcript and fw_dynamic handoff UART/simulator transcript",
            "alternate U-Boot build and OpenSBI-to-U-Boot boot-chain transcripts if U-Boot is selected for production boot",
            "AOSP lunch, vendorimage, VINTF, SELinux build, and neverallow transcripts from an external AOSP tree",
            "Cuttlefish, QEMU, and Renode virtual-device smoke transcripts with explicit no-compatibility claim boundary",
            "Android CTS/VTS smoke intake record with result directory, excluded modules, and no full compatibility claim",
            "Android e1-NPU proof artifacts for VTS/CTS, SELinux/VINTF, NNAPI accelerator query, and absent-device fail-closed probe",
            "reviewer approval that scaffold, reference-device, and template logs are not used as product BSP evidence",
        ],
        "summary": {
            "check_count": len(checks),
            "passing_check_count": len([check for check in checks if check["status"] == "pass"]),
            "missing_evidence_count": missing_total,
            "invalid_evidence_count": invalid_total,
            "release_claim_allowed": False,
        },
        "checks": checks,
    }


def validate_report(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    require(data.get("schema") == "eliza.software_bsp_scope.v1", "schema mismatch", errors)
    require(
        data.get("status") == "software_bsp_scope_release_blocked",
        "status must remain software_bsp_scope_release_blocked",
        errors,
    )
    boundary = str(data.get("claim_boundary", ""))
    for token in (
        "not external Buildroot evidence",
        "not external Linux kernel evidence",
        "not OpenSBI handoff evidence",
        "not alternate U-Boot boot-chain evidence",
        "not Android boot evidence",
        "not Android compatibility evidence",
        "not CTS/VTS evidence",
        "not NNAPI acceleration evidence",
        "not a product BSP release claim",
    ):
        require(token in boundary, f"claim boundary missing {token}", errors)
    summary = data.get("summary")
    if not isinstance(summary, dict):
        errors.append("summary must be a mapping")
        return errors
    require(
        summary.get("release_claim_allowed") is False,
        "release_claim_allowed must stay false",
        errors,
    )
    require(
        (
            isinstance(summary.get("missing_evidence_count"), int)
            and isinstance(summary.get("invalid_evidence_count"), int)
            and (
                summary.get("missing_evidence_count", 0) + summary.get("invalid_evidence_count", 0)
            )
            > 0
        ),
        "missing/invalid evidence counts must show external evidence blockers",
        errors,
    )
    targets = data.get("targets")
    if (
        not isinstance(targets, list)
        or {str(item.get("target")) for item in targets if isinstance(item, dict)}
        != REQUIRED_TARGETS
    ):
        errors.append("targets must cover selected buildroot, linux, opensbi, and aosp targets")
    elif all(isinstance(item, dict) and item.get("evidence_status") == "PASS" for item in targets):
        errors.append(
            "software BSP target evidence must not all pass while release_claim_allowed is false"
        )
    findings = data.get("findings")
    if not isinstance(findings, list) or not findings:
        errors.append("findings must list structured software BSP blockers")
    checks = data.get("checks")
    if not isinstance(checks, list) or not checks:
        errors.append("checks must be a non-empty list")
        return errors
    for check in checks:
        if not isinstance(check, dict):
            errors.append("checks entries must be mappings")
            continue
        if check.get("status") not in {"pass", "fail"}:
            errors.append(f"{check.get('id')}: status must be pass or fail")
    blocked = data.get("blocked_until_real_evidence")
    if not isinstance(blocked, list) or len(blocked) < 9:
        errors.append("software BSP scope must enumerate blocked real-evidence items")
    scaffolds = data.get("current_scaffolds")
    if not isinstance(scaffolds, dict):
        errors.append("current_scaffolds must be a mapping")
    else:
        for key in (
            "software_bsp_checker",
            "scaffold_checker",
            "evidence_manifest",
            "log_evidence_manifest",
            "artifact_manifest",
            "boot_transcript_schema",
            "android_proof_template",
            "nnapi_proof_template",
        ):
            require(isinstance(scaffolds.get(key), str), f"current_scaffolds missing {key}", errors)
    return errors


def main() -> int:
    report = build_report()
    errors = validate_report(report)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print(f"Software BSP scope check passed: {rel(OUT)} remains release-blocked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
