#!/usr/bin/env python3
"""Check freshness of chip OS bring-up survey reports against source scripts."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import aggregate_tapeout_readiness as aggregate

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
REPORT = ROOT / "build/reports/chip-os-report-freshness.json"

SCHEMA = "eliza.chip_os_report_freshness.v1"
CLAIM_BOUNDARY = "report_freshness_only_not_boot_or_launcher_evidence"


@dataclass(frozen=True)
class ReportSpec:
    ident: str
    report: str
    sources: tuple[str, ...]
    purpose: str


GATE_REPORT_ALIASES = {
    "aosp-simulator-completion-check": ("android_sim_boot.json", "mvp_simulator.json"),
    "chipyard-generated-linux-contract-check": (
        "chipyard_payload_path.json",
        "cpu_ap_scope.json",
    ),
    "cpu-ap-completion-gate": ("cpu_ap_scope.json", "cpu_ap_boot_readiness.json"),
    "minimum-linux-target-check": ("minimum-linux-kernel-target.json",),
    "software-bsp-scaffold-check": ("software_bsp.json",),
}

GATE_REPORT_ALIAS_SOURCES = {
    "android_sim_boot.json": (
        "packages/chip/scripts/check_android_sim_boot.py",
        "packages/chip/scripts/boot_android_simulator.sh",
    ),
    "mvp_simulator.json": (
        "packages/chip/scripts/run_mvp_simulator.py",
        "packages/chip/scripts/check_mvp_simulator.py",
    ),
    "chipyard_payload_path.json": ("packages/chip/scripts/check_chipyard_payload_path.py",),
    "cpu_ap_scope.json": ("packages/chip/scripts/check_cpu_ap_scope.py",),
    "cpu_ap_boot_readiness.json": ("packages/chip/scripts/check_cpu_ap_boot_readiness.py",),
    "software_bsp.json": ("packages/chip/scripts/check_software_bsp.py",),
    "aosp_product_contract.json": (
        "packages/chip/scripts/check_aosp_product_contract.py",
        "packages/chip/sw/aosp-device/build-aosp-riscv64.sh",
        "packages/chip/scripts/boot_android_simulator.sh",
        "packages/chip/sw/aosp-device/capture-aosp-evidence.sh",
        "packages/chip/sw/aosp-device/local_manifests/eliza.xml",
        "packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/eliza_ai_soc.mk",
        "packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/device.mk",
        "packages/os/android/vendor/eliza/AndroidProducts.mk",
        "packages/os/android/vendor/eliza/eliza_common.mk",
        "packages/os/android/vendor/eliza/products/eliza_openagent_ai_soc_phone.mk",
    ),
    "aosp_hal_service_contract.json": (
        "packages/chip/scripts/check_aosp_hal_service_contract.py",
        "packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/device.mk",
        "packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/BoardConfig.mk",
        "packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/init.eliza.rc",
        "packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/manifest.xml",
        "packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/eliza_e1.xml",
        "packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/hal/e1_npu/Android.bp",
        "packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/hal/e1_npu/E1Npu.h",
        "packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/hal/e1_npu/1.0/IE1Npu.hal",
        "packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/hal/e1_npu_sim/Android.bp",
        "packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/hal/e1_npu_sim/E1NpuSim.h",
        "packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/hal/hwcomposer/Android.bp",
        "packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/hal/hwcomposer/hwcomposer.cpp",
        "packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/sepolicy/file_contexts",
        "packages/chip/sw/aosp-device/device/eliza/eliza_ai_soc/sepolicy/e1_npu.te",
        "packages/chip/sw/linux/drivers/e1/e1_platform_contract.h",
    ),
    "android_system_apk_payload.json": (
        "packages/chip/scripts/check_android_system_apk_payload.py",
        "packages/os/android/vendor/eliza/apps/Eliza/Android.bp",
        "packages/os/android/vendor/eliza/apps/Eliza/Eliza.apk",
        "packages/os/android/vendor/eliza/eliza_common.mk",
        "packages/app-core/platforms/android/app/src/main/java/ai/milady/milady/ElizaAgentService.java",
    ),
    "cross_fork_agent_payload_contract.json": (
        "packages/chip/scripts/check_cross_fork_agent_payload_contract.py",
        "packages/app-core/scripts/bun-riscv64/bun-version.json",
        "packages/app-core/scripts/lib/stage-android-agent.mjs",
        "packages/app-core/platforms/android/app/src/main/java/ai/milady/milady/ElizaAgentService.java",
        "packages/os/linux/elizaos/config/hooks/normal/0010-elizaos-agent.hook.chroot",
        "packages/os/linux/elizaos/config/includes.chroot/etc/systemd/system/elizaos-agent.service",
        "packages/os/linux/elizaos/config/includes.chroot/usr/lib/elizaos/run-agent.sh",
        "packages/os/linux/elizaos/config/includes.chroot/usr/lib/elizaos/wait-agent-health.sh",
        "packages/os/linux/elizaos/config/includes.chroot/etc/systemd/system/elizaos-terminal-tui-smoke.service",
        "packages/os/linux/elizaos/manifest.json",
        "packages/os/linux/elizaos/manifest.json.template",
    ),
    "android_system_bridge_contract.json": (
        "packages/chip/scripts/check_android_system_bridge_contract.py",
        "packages/os/android/system-ui/native/src/main/java/ai/elizaos/system/bridge/SystemBridge.kt",
        "packages/os/android/system-ui/native/src/main/AndroidManifest.xml",
        "packages/os/android/system-ui/native/build.gradle.kts",
        "packages/os/android/system-ui/native/Android.bp",
        "packages/os/android/system-ui/src/providers/AndroidSystemProvider.tsx",
        "packages/os/android/system-ui/src/providers/MockSystemProvider.tsx",
        "packages/os/android/system-ui/src/bridge/bridge-contract.ts",
        "packages/os/android/vendor/eliza/eliza_common.mk",
        "packages/os/android/vendor/eliza/permissions/privapp-permissions-ai.elizaos.system.bridge.xml",
        "packages/chip/sw/aosp-device/local_manifests/eliza.xml",
    ),
}


BASE_REPORTS: tuple[ReportSpec, ...] = (
    ReportSpec(
        "bring_up_status",
        "packages/chip/build/reports/chip-os-bring-up-status.json",
        ("packages/chip/scripts/aggregate_tapeout_readiness.py",),
        "strict aggregate chip OS bring-up status",
    ),
    ReportSpec(
        "boot_gap_inventory",
        "packages/chip/build/reports/chip-os-boot-gap-inventory.json",
        (
            "packages/chip/scripts/check_chip_os_boot_gap_inventory.py",
            "packages/chip/scripts/aggregate_tapeout_readiness.py",
        ),
        "nonpassing aggregate gate to detailed blocker coverage",
    ),
    ReportSpec(
        "objective_matrix",
        "packages/chip/build/reports/chip-os-objective-evidence-matrix.json",
        ("packages/chip/scripts/check_chip_os_objective_evidence_matrix.py",),
        "requirement-by-requirement objective evidence matrix",
    ),
    ReportSpec(
        "closure_plan",
        "packages/chip/build/reports/chip-os-closure-plan.json",
        ("packages/chip/scripts/check_chip_os_closure_plan.py",),
        "dependency-ranked closure plan",
    ),
    ReportSpec(
        "environment_preflight",
        "packages/chip/build/reports/chip-os-environment-preflight.json",
        ("packages/chip/scripts/check_chip_os_environment_preflight.py",),
        "host tool, env var, and evidence path preflight",
    ),
    ReportSpec(
        "keyword_inventory",
        "packages/chip/build/reports/chip-os-gap-keyword-inventory.json",
        ("packages/chip/scripts/check_chip_os_gap_keyword_inventory.py",),
        "source-level unfinished marker inventory",
    ),
    ReportSpec(
        "evidence_provenance",
        "packages/chip/build/reports/chip-os-evidence-provenance.json",
        ("packages/chip/scripts/check_chip_os_evidence_provenance.py",),
        "evidence/report provenance quality audit",
    ),
    ReportSpec(
        "optimization_gap_inventory",
        "packages/chip/build/reports/chip-os-optimization-gap-inventory.json",
        ("packages/chip/scripts/check_chip_os_optimization_gap_inventory.py",),
        "optimization and performance gap inventory",
    ),
    ReportSpec(
        "identity_contract",
        "packages/chip/build/reports/chip-os-identity-contract.json",
        ("packages/chip/scripts/check_chip_os_identity_contract.py",),
        "cross-fork Android launcher and agent identity contract audit",
    ),
    ReportSpec(
        "chipyard_verilator_linux_smoke",
        "packages/chip/build/reports/chipyard_verilator_linux_smoke.json",
        ("packages/chip/scripts/check_chipyard_verilator_linux_smoke.py",),
        "generated AP Verilator Linux smoke report mirror",
    ),
    ReportSpec(
        "os_rv64_qemu_smoke",
        "packages/chip/build/reports/qemu_virt_smoke.json",
        ("packages/os/linux/elizaos/scripts/qemu_virt_smoke.py",),
        "OS RV64 qemu-virt smoke report mirror",
    ),
    ReportSpec(
        "android_launcher_runtime",
        "packages/chip/build/reports/android_launcher_runtime_evidence.json",
        ("packages/chip/scripts/check_android_launcher_runtime_evidence.py",),
        "booted Android launcher and local-agent runtime evidence check",
    ),
    ReportSpec(
        "android_evidence_capture_contract",
        "packages/chip/build/reports/android_evidence_capture_contract.json",
        (
            "packages/chip/scripts/check_android_evidence_capture_contract.py",
            "packages/chip/sw/aosp-device/capture-aosp-evidence.sh",
            "packages/chip/sw/aosp-device/cuttlefish-boot-gate.sh",
            "packages/chip/sw/aosp-device/evidence_manifest.json",
            "packages/chip/docs/project/aosp-simulator-completion-gate.yaml",
        ),
        "Android evidence capture workflow and launcher runtime artifact contract",
    ),
    ReportSpec(
        "android_app_runtime_contract",
        "packages/chip/build/reports/android_app_runtime_contract.json",
        (
            "packages/chip/scripts/check_android_app_runtime_contract.py",
            "packages/app-core/platforms/android/app/build.gradle",
            "packages/app-core/platforms/android/app/src/main/AndroidManifest.xml",
            "packages/app-core/platforms/android/app/src/main/java/ai/milady/milady/ElizaAgentService.java",
            "packages/app-core/platforms/android/app/src/main/java/ai/milady/milady/ElizaNativeBridge.java",
            "packages/os/android/vendor/eliza/eliza_common.mk",
            "packages/os/android/vendor/eliza/permissions/default-permissions-ai.elizaos.app.xml",
            "packages/os/android/vendor/eliza/permissions/privapp-permissions-ai.elizaos.app.xml",
            "packages/os/android/vendor/eliza/overlays/frameworks/base/core/res/res/values/config.xml",
            "packages/chip/sw/aosp-device/start-eliza-agent-riscv64.sh",
            "packages/chip/sw/aosp-device/agent-smoke-riscv64.sh",
            "packages/chip/sw/aosp-device/scripts/cuttlefish_agent_smoke.py",
            "packages/chip/sw/aosp-device/capture-aosp-evidence.sh",
            "packages/chip/sw/aosp-device/install-eliza-apk-riscv64.sh",
        ),
        "Android APK/package/service/runtime static contract check",
    ),
    ReportSpec(
        "android_sim_boot",
        "packages/chip/build/reports/android_sim_boot.json",
        ("packages/chip/scripts/check_android_sim_boot.py",),
        "Android simulator boot evidence check",
    ),
    ReportSpec(
        "software_bsp",
        "packages/chip/build/reports/software_bsp.json",
        ("packages/chip/scripts/check_software_bsp.py",),
        "software BSP scaffold and external evidence report",
    ),
    ReportSpec(
        "os_rv64_chip_boot_contract",
        "packages/chip/build/reports/os_rv64_chip_boot_contract.json",
        ("packages/chip/scripts/check_os_rv64_chip_boot_contract.py",),
        "Linux RV64 chip/emulator boot objective contract",
    ),
)


def gate_script_path(script: object) -> Path | None:
    if not isinstance(script, str) or not script:
        return None
    path = Path(script)
    if not path.is_absolute():
        path = ROOT / path
    return path.resolve()


def expected_report_candidates(script: object, gate_name: object | None = None) -> list[str]:
    path = gate_script_path(script)
    candidates: set[str] = set()
    if isinstance(gate_name, str):
        candidates.update(GATE_REPORT_ALIASES.get(gate_name, ()))
    if path is None:
        return sorted(candidates)
    stem = path.stem
    candidates.add(f"{stem}.json")
    if stem.startswith("check_"):
        candidates.add(f"{stem.removeprefix('check_')}.json")
    if stem.startswith("test_"):
        candidates.add(f"{stem.removeprefix('test_')}.json")
    return sorted(candidates)


def dynamic_gate_report_specs() -> list[ReportSpec]:
    specs: list[ReportSpec] = []
    for gate in aggregate.GATES:
        script = str(gate.script)
        for report_name in expected_report_candidates(script, gate.name):
            report = ROOT / "build/reports" / report_name
            if not report.is_file():
                continue
            source = f"packages/chip/{script}" if not Path(script).is_absolute() else script
            sources = GATE_REPORT_ALIAS_SOURCES.get(report_name, (source,))
            ident = f"gate_{gate.name}_{Path(report_name).stem}".replace("-", "_")
            specs.append(
                ReportSpec(
                    ident,
                    f"packages/chip/build/reports/{report_name}",
                    sources,
                    f"aggregate gate detail report for {gate.name}",
                )
            )
    return specs


def report_specs() -> tuple[ReportSpec, ...]:
    deduped: dict[str, ReportSpec] = {}
    for spec in (*BASE_REPORTS, *dynamic_gate_report_specs()):
        deduped.setdefault(spec.report, spec)
    return tuple(deduped.values())


def rel(path: Path) -> str:
    try:
        return path.relative_to(REPO).as_posix()
    except ValueError:
        return str(path)


def resolve(path: str) -> Path:
    candidate = Path(path)
    if candidate.is_absolute():
        return candidate
    return REPO / candidate


def finding(code: str, message: str, evidence: str, next_step: str) -> dict[str, Any]:
    return {
        "code": code,
        "severity": "blocker",
        "message": message,
        "evidence": evidence,
        "next_step": next_step,
    }


def row_for_spec(spec: ReportSpec) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    report = resolve(spec.report)
    source_paths = [resolve(source) for source in spec.sources]
    findings: list[dict[str, Any]] = []
    missing_sources = [source for source in source_paths if not source.exists()]
    if not report.exists():
        findings.append(
            finding(
                f"missing_report_{spec.ident}",
                f"{spec.purpose} report is missing",
                spec.report,
                "Run the report-generating checker before relying on the chip OS survey.",
            )
        )
    for source in missing_sources:
        findings.append(
            finding(
                f"missing_report_source_{spec.ident}",
                f"{spec.purpose} source is missing",
                rel(source),
                "Restore the missing checker/source path or remove this report from the freshness watch list.",
            )
        )
    newest_source = max(
        (source.stat().st_mtime for source in source_paths if source.exists()),
        default=None,
    )
    report_mtime = report.stat().st_mtime if report.exists() else None
    stale = report_mtime is not None and newest_source is not None and report_mtime < newest_source
    if stale:
        findings.append(
            finding(
                f"stale_report_{spec.ident}",
                f"{spec.purpose} report is older than one of its source scripts",
                spec.report,
                "Regenerate this report after source edits before using it as current survey evidence.",
            )
        )
    return (
        {
            "id": spec.ident,
            "report": spec.report,
            "purpose": spec.purpose,
            "sources": spec.sources,
            "present": report.exists(),
            "stale": stale,
            "report_mtime": report_mtime,
            "newest_source_mtime": newest_source,
            "missing_sources": [rel(source) for source in missing_sources],
        },
        findings,
    )


def build_report() -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    specs = report_specs()
    for spec in specs:
        row, row_findings = row_for_spec(spec)
        rows.append(row)
        findings.extend(row_findings)
    return {
        "schema": SCHEMA,
        "status": "blocked" if findings else "pass",
        "claim_boundary": CLAIM_BOUNDARY,
        "summary": {
            "reports": len(rows),
            "missing_reports": sum(1 for row in rows if not row["present"]),
            "stale_reports": sum(1 for row in rows if row["stale"]),
            "missing_sources": sum(len(row["missing_sources"]) for row in rows),
            "findings": len(findings),
        },
        "reports": rows,
        "findings": findings,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", default=str(REPORT))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    report = build_report()
    output = Path(args.report)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    summary = report["summary"]
    print(
        f"STATUS: {str(report['status']).upper()} chip_os_report_freshness "
        f"reports={summary['reports']} missing_reports={summary['missing_reports']} "
        f"stale_reports={summary['stale_reports']} missing_sources={summary['missing_sources']} "
        f"findings={summary['findings']} report={rel(output)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
