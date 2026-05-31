#!/usr/bin/env python3
"""Inventory optimization/performance gaps for chip OS bring-up.

This is a survey gate, not a benchmark claim. It collects the performance,
power, thermal, cache, CPU/AP, NPU, and SOTA reports that could affect whether
Linux/AOSP merely boot or actually run the launcher and agent without issues.
"""

from __future__ import annotations

import argparse
from datetime import UTC, datetime
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
REPORT = ROOT / "build/reports/chip-os-optimization-gap-inventory.json"

SCHEMA = "eliza.chip_os_optimization_gap_inventory.v1"
CLAIM_BOUNDARY = "optimization_gap_inventory_only_not_runtime_performance_evidence"
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "runtime_claim_allowed": False,
    "linux_boot_claim_allowed": False,
    "android_boot_claim_allowed": False,
    "launcher_runtime_claim_allowed": False,
    "agent_liveness_claim_allowed": False,
    "benchmark_claim_allowed": False,
    "hardware_boot_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}

PASS_VALUES = {"pass", "passed", "ok", "PASS"}
WEAK_SCOPE_RE = re.compile(
    r"(release[_ -]?blocked|reference[_ -]?only|model(?:ed)?|simulator|not[_ -]?(?:phone|runtime|silicon|hardware|android|nnapi|boot)|no[_ -]?(?:measured|silicon|runtime|release))",
    re.I,
)
BLOCKED_TEXT_RE = re.compile(
    r"\b(blocked|placeholder|not yet|not measured|missing|timeout)\b", re.I
)
EMBEDDED_PAYLOAD_KEYS = {
    "companion_report",
    "companion_reports",
    "companion_report_active_smoke_attempt",
    "diagnostic",
    "diagnostics",
}


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class ArtifactSpec:
    ident: str
    area: str
    path: str
    purpose: str
    required_for: str
    must_pass: bool = True
    pass_values: tuple[str, ...] = ()
    scan_blocked_text: bool = True


ARTIFACTS: tuple[ArtifactSpec, ...] = (
    ArtifactSpec(
        "sota_parity",
        "system",
        "packages/chip/build/reports/sota_parity_audit.json",
        "phone SoC SOTA parity across CPU, NPU, memory, power, security, product, and manufacturing domains",
        "no-issues phone-class runtime and optimization closure",
    ),
    ArtifactSpec(
        "benchmark_efficiency",
        "benchmarks",
        "packages/chip/build/reports/benchmark_efficiency_scope.json",
        "calibrated benchmark/efficiency scope guard",
        "CPU/NPU/IO performance-per-watt claims from real booted targets",
        scan_blocked_text=False,
    ),
    ArtifactSpec(
        "local_coremark_probe",
        "cpu",
        "packages/chip/build/reports/local-host-coremark-probe.json",
        "local host CoreMark probe",
        "CPU baseline only after target provenance and completion are available",
        pass_values=("local_host_evidence_not_release",),
    ),
    ArtifactSpec(
        "cpu_ap_scope",
        "cpu",
        "packages/chip/build/reports/cpu_ap_scope.json",
        "CPU/AP Linux and benchmark evidence scope",
        "sustained AP benchmark evidence on the selected chip/AP emulator",
    ),
    ArtifactSpec(
        "cpu_ap_boot_readiness",
        "cpu",
        "packages/chip/build/reports/cpu_ap_boot_readiness.json",
        "CPU/AP boot readiness evidence",
        "Linux-capable CPU/AP runtime path before optimization claims",
    ),
    ArtifactSpec(
        "minimum_linux_npu_target",
        "npu",
        "packages/chip/build/reports/minimum_linux_npu_target.json",
        "minimum Linux plus NPU target",
        "integrated Linux NPU workload evidence on generated AP",
        scan_blocked_text=False,
    ),
    ArtifactSpec(
        "npu_scope",
        "npu",
        "packages/chip/build/reports/npu_scope.json",
        "NPU release and phone-class scope",
        "Android NNAPI, CPU fallback, measured TOPS/latency/power evidence",
        scan_blocked_text=False,
    ),
    ArtifactSpec(
        "npu_coverage_summary",
        "npu",
        "packages/chip/build/reports/npu_coverage_summary.json",
        "NPU coverage summary",
        "DMA-backed tensor execution, hardware benchmark, NNAPI, and phone-class TOPS coverage",
        must_pass=False,
    ),
    ArtifactSpec(
        "mvp_npu_scale_sim",
        "npu",
        "packages/chip/build/reports/mvp_npu_scale_sim.json",
        "modeled NPU scale simulation",
        "NPU utilization and performance model bounded away from phone/runtime claims",
        must_pass=False,
        scan_blocked_text=False,
    ),
    ArtifactSpec(
        "power_thermal_scope",
        "power_thermal",
        "packages/chip/build/reports/power_thermal_scope.json",
        "sustained power and thermal capture scope",
        "aligned power, thermal, frequency, throttle, and workload evidence",
        scan_blocked_text=False,
    ),
    ArtifactSpec(
        "power_thermal_projection",
        "power_thermal",
        "packages/chip/build/reports/power_thermal_projection.json",
        "power/thermal projection",
        "measured silicon or calibrated emulator power/thermal constraints",
        must_pass=False,
    ),
    ArtifactSpec(
        "phone_runtime_readiness",
        "runtime",
        "packages/chip/build/reports/phone_runtime_readiness_contract.json",
        "phone runtime readiness",
        "display/HWC/camera/audio/radio/sensor/PMIC/power/thermal no-issues runtime",
    ),
    ArtifactSpec(
        "cache_hierarchy_gate",
        "memory",
        "packages/chip/build/reports/cache_hierarchy_gate.json",
        "cache hierarchy gate",
        "CPU/AP and Android memory latency/throughput behavior",
    ),
    ArtifactSpec(
        "memory_uma_claim_gate",
        "memory",
        "packages/chip/docs/evidence/memory/uma-dram-evidence-gate.yaml",
        "UMA DRAM bandwidth/latency evidence gate",
        "contended CPU/NPU/display memory performance",
    ),
    ArtifactSpec(
        "android_peripheral_evidence",
        "runtime",
        "packages/chip/build/reports/android_simulated_peripheral_evidence.json",
        "Android simulated peripheral evidence",
        "launcher no-issues operation across media, network, and radio-like surfaces",
    ),
    ArtifactSpec(
        "android_launcher_runtime",
        "runtime",
        "packages/chip/build/reports/android_launcher_runtime_evidence.json",
        "Android launcher foreground and agent health runtime evidence",
        "HOME foreground, service process, /api/health, logcat, and clean launcher runtime",
    ),
    ArtifactSpec(
        "android_identity_contract",
        "runtime",
        "packages/chip/build/reports/chip-os-identity-contract.json",
        "Android launcher, AOSP vendor, and smoke-script identity contract",
        "consistent package, HOME role, service component, and health endpoint for launcher/agent runtime",
    ),
    ArtifactSpec(
        "android_app_runtime_contract",
        "runtime",
        "packages/chip/build/reports/android_app_runtime_contract.json",
        "Android app runtime contract",
        "APK/package/service/API support needed before launcher foreground and local-agent checks can pass",
    ),
    ArtifactSpec(
        "android_system_apk_payload",
        "runtime",
        "packages/chip/build/reports/android_system_apk_payload.json",
        "staged Android system APK payload",
        "riscv64 local-agent payload and native loader assets packaged into the product image",
    ),
    ArtifactSpec(
        "android_system_bridge",
        "runtime",
        "packages/chip/build/reports/android_system_bridge_contract.json",
        "Android system bridge contract",
        "privileged bridge service registration, permissions, and launcher consumption on a booted product",
    ),
    ArtifactSpec(
        "aosp_hal_service_liveness",
        "runtime",
        "packages/chip/build/reports/aosp_hal_service_contract.json",
        "AOSP HAL service contract",
        "booted-product HAL packaging, VINTF, SELinux, lshal, and service liveness needed for no-issues Android runtime",
    ),
    ArtifactSpec(
        "android_evidence_capture_strictness",
        "runtime",
        "packages/chip/build/reports/android_evidence_capture_contract.json",
        "Android evidence capture strictness",
        "real boot, CTS/VTS, launcher, and agent evidence replacing source-scan or version-only placeholders",
    ),
    ArtifactSpec(
        "android_release_readiness",
        "runtime",
        "packages/chip/build/reports/android_release_readiness_contract.json",
        "Android release readiness contract",
        "release and post-flash checks for chip/riscv64 boot, launcher, agent, logcat, and SELinux behavior",
    ),
)


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


def load_structured(path: Path) -> object | None:
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
        if path.suffix.lower() == ".json":
            return json.loads(text)
        if path.suffix.lower() in {".yaml", ".yml"}:
            return yaml.safe_load(text)
    except (OSError, json.JSONDecodeError, yaml.YAMLError):
        return None
    return None


def nested_values(value: object) -> list[object]:
    values: list[object] = [value]
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).lower() in EMBEDDED_PAYLOAD_KEYS:
                continue
            values.extend(nested_values(child))
    elif isinstance(value, list):
        for child in value:
            values.extend(nested_values(child))
    return values


def status_value(data: object) -> str | None:
    if isinstance(data, dict):
        status = data.get("status")
        if isinstance(status, str):
            return status
    return None


def bool_false_fields(data: object) -> list[str]:
    fields: list[str] = []
    def walk(value: object, prefix: str) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                name = f"{prefix}.{key}" if prefix else str(key)
                lowered = str(key).lower()
                if lowered in EMBEDDED_PAYLOAD_KEYS:
                    continue
                if lowered.endswith("claim_allowed"):
                    continue
                if child is False and any(
                    token in lowered
                    for token in (
                        "claim_allowed",
                        "ready",
                        "coverage",
                        "benchmark",
                        "nnapi",
                        "phone_class",
                        "hardware",
                        "dma_backed",
                    )
                ):
                    fields.append(name)
                walk(child, name)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                walk(child, f"{prefix}[{index}]")

    walk(data, "")
    return fields


def finding(
    spec: ArtifactSpec,
    code: str,
    message: str,
    evidence: str,
    severity: str = "blocker",
) -> dict[str, Any]:
    return {
        "area": spec.area,
        "artifact_id": spec.ident,
        "code": code,
        "severity": severity,
        "message": message,
        "evidence": evidence[:400],
        "source": spec.path,
        "required_for": spec.required_for,
        "next_step": (
            "Replace modeled/reference/local/scope evidence with target-specific "
            "chip-emulator Linux or AOSP runtime measurements, or keep the claim "
            "explicitly blocked."
        ),
    }


def evaluate_artifact(spec: ArtifactSpec) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    path = resolve(spec.path)
    rows: list[dict[str, Any]] = []
    data = load_structured(path)
    if data is None:
        rows.append(
            finding(
                spec,
                "missing_or_invalid_optimization_artifact",
                f"{spec.purpose} artifact is missing or invalid",
                rel(path),
            )
        )
        return (
            {
                "id": spec.ident,
                "area": spec.area,
                "path": spec.path,
                "purpose": spec.purpose,
                "status": None,
                "finding_count": len(rows),
            },
            rows,
        )

    status = status_value(data)
    accepted_statuses = PASS_VALUES | set(spec.pass_values)
    if spec.must_pass and (status is None or status not in accepted_statuses):
        rows.append(
            finding(
                spec,
                "optimization_artifact_not_pass",
                f"{spec.purpose} is not passing",
                f"status={status!r}",
            )
        )

    all_values = nested_values(data)
    text_values = [value for value in all_values if isinstance(value, str)]
    weak_scopes = [value for value in text_values if WEAK_SCOPE_RE.search(value)]
    if weak_scopes:
        rows.append(
            finding(
                spec,
                "optimization_evidence_weak_scope",
                f"{spec.purpose} is scoped as modeled/reference/non-release evidence",
                "; ".join(weak_scopes[:4]),
            )
        )

    blocked_texts = [
        value for value in text_values if spec.scan_blocked_text and BLOCKED_TEXT_RE.search(value)
    ]
    if blocked_texts:
        rows.append(
            finding(
                spec,
                "optimization_evidence_blocked_or_placeholder_text",
                f"{spec.purpose} contains blocked, placeholder, missing, or timeout text",
                "; ".join(blocked_texts[:4]),
            )
        )

    false_fields = bool_false_fields(data)
    if false_fields:
        rows.append(
            finding(
                spec,
                "optimization_required_boolean_false",
                f"{spec.purpose} has false readiness/coverage/claim fields",
                ", ".join(false_fields[:12]),
            )
        )

    return (
        {
            "id": spec.ident,
            "area": spec.area,
            "path": spec.path,
            "purpose": spec.purpose,
            "status": status,
            "finding_count": len(rows),
        },
        rows,
    )


def build_report() -> dict[str, Any]:
    artifacts: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    for spec in ARTIFACTS:
        artifact, artifact_findings = evaluate_artifact(spec)
        artifacts.append(artifact)
        findings.extend(artifact_findings)
    by_area: dict[str, int] = {}
    for item in findings:
        by_area[str(item["area"])] = by_area.get(str(item["area"]), 0) + 1
    return {
        "schema": SCHEMA,
        "status": "blocked" if findings else "pass",
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "generated_utc": utc_now(),
        "summary": {
            "artifacts": len(artifacts),
            "findings": len(findings),
            "areas": dict(sorted(by_area.items())),
        },
        "artifacts": artifacts,
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
        f"STATUS: {str(report['status']).upper()} chip_os_optimization_gap_inventory "
        f"artifacts={summary['artifacts']} findings={summary['findings']} "
        f"areas={len(summary['areas'])} report={rel(output)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
