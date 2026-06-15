#!/usr/bin/env python3
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]

MIN_BLOCKS = ROOT / "docs/project/phone-soc-minimum-blocks.yaml"
UMA = ROOT / "docs/project/uma-coherency-validation-strategy.yaml"
AI_OPTIONS = ROOT / "docs/project/ai-accelerator-options.yaml"
HANDOFFS = ROOT / "docs/project/spec-rtl-sw-pd-handoff-work-order.yaml"
GATE_DOC = ROOT / "docs/project/phone-soc-architecture-gates.md"
MEDIA_SCOPE_REPORT = ROOT / "build/reports/phone_media_pipeline_scope.json"
MEDIA_SCOPE_CHECK = ROOT / "scripts/check_phone_media_pipeline_scope.py"

REQUIRED_BLOCKS = {
    "application_cpu_cluster",
    "management_security_subsystem",
    "unified_memory_subsystem",
    "coherent_interconnect",
    "ai_accelerator",
    "graphics_display_subsystem",
    "wireless_connectivity",
    "phone_io_and_power",
    "physical_implementation",
}

REQUIRED_UMA_AXES = {
    "coherency_policy",
    "iommu_isolation",
    "memory_qos",
    "android_buffer_lifecycle",
}

REQUIRED_AI_OPTIONS = {
    "keep_e1_mmio_npu",
    "integrate_open_npu_ip",
    "vector_cpu_baseline",
    "gpu_compute_or_2d_first",
    "external_ai_module_reference",
}

REQUIRED_HANDOFFS = {
    "spec_to_contract",
    "contract_to_rtl",
    "rtl_to_verification",
    "rtl_to_software",
    "software_to_benchmarks",
    "rtl_to_fpga",
    "rtl_to_pd_package_release",
}

CLAIM_TOKENS = [
    "android_boot_claim_requires",
    "wifi_claim_requires",
    "ai_throughput_claim_requires",
    "tapeout_claim_requires",
]
REQUIRED_FALSE_CLAIM_FLAGS = (
    "claim_allowed",
    "release_claim_allowed",
    "android_boot_claim_allowed",
    "wifi_claim_allowed",
    "ai_throughput_claim_allowed",
    "tapeout_claim_allowed",
)


def load_yaml(path: Path, errors: list[str]) -> dict:
    if not path.is_file():
        errors.append(f"missing required artifact: {path.relative_to(ROOT)}")
        return {}
    data = yaml.safe_load(path.read_text())
    if not isinstance(data, dict):
        errors.append(f"{path.relative_to(ROOT)} must be a YAML mapping")
        return {}
    return data


def require_file(path: str, errors: list[str], field: str) -> None:
    candidate = Path(path)
    if candidate.is_absolute() or ".." in candidate.parts:
        errors.append(f"{field} must be a relative repo path: {path}")
        return
    migrated_candidate = ROOT / "docs" / candidate
    if not (ROOT / candidate).exists() and not migrated_candidate.exists():
        errors.append(f"{field} points at missing repo artifact: {path}")


def require_false_claim_flags(data: dict, label: str, errors: list[str]) -> None:
    for field in REQUIRED_FALSE_CLAIM_FLAGS:
        if data.get(field) is not False:
            errors.append(f"{label}.{field} must be false")


def check_min_blocks(data: dict, errors: list[str]) -> None:
    if data.get("schema") != "eliza.phone_soc_minimum_blocks.v1":
        errors.append("phone-soc-minimum-blocks.yaml has wrong schema")
    if data.get("status") != "pre_hardware_release_blocked":
        errors.append("phone-soc-minimum-blocks.yaml must remain pre_hardware_release_blocked")
    require_false_claim_flags(data, "phone-soc-minimum-blocks.yaml", errors)

    policy = data.get("release_claim_policy")
    if not isinstance(policy, dict):
        errors.append("phone-soc-minimum-blocks.yaml missing release_claim_policy")
    else:
        for token in CLAIM_TOKENS:
            values = policy.get(token)
            if not isinstance(values, list) or len(values) < 3:
                errors.append(f"release_claim_policy.{token} must list evidence gates")

    blocks = data.get("phone_soc_blocks")
    if not isinstance(blocks, list):
        errors.append("phone-soc-minimum-blocks.yaml must list phone_soc_blocks")
        return

    ids = {block.get("id") for block in blocks if isinstance(block, dict)}
    missing = sorted(REQUIRED_BLOCKS - ids)
    if missing:
        errors.append("phone_soc_blocks missing: " + ", ".join(missing))

    for index, block in enumerate(blocks):
        if not isinstance(block, dict):
            errors.append(f"phone_soc_blocks[{index}] must be a mapping")
            continue
        block_id = block.get("id", f"phone_soc_blocks[{index}]")
        if "blocked" not in str(block.get("current_status", "")):
            errors.append(f"{block_id}: current_status must be explicitly blocked")
        for field in ("minimum_subblocks", "current_repo_artifacts", "evidence_required"):
            value = block.get(field)
            if not isinstance(value, list) or len(value) < 2:
                errors.append(f"{block_id}: {field} must list at least two items")
        for path in block.get("current_repo_artifacts", []):
            if isinstance(path, str) and path.endswith(
                (".md", ".yaml", ".json", ".py", ".sv", ".mk")
            ):
                require_file(path, errors, f"{block_id}.current_repo_artifacts")
        if not isinstance(block.get("closure_gate"), str) or not block["closure_gate"]:
            errors.append(f"{block_id}: missing closure_gate")


def check_uma(data: dict, errors: list[str]) -> None:
    if data.get("schema") != "eliza.uma_coherency_validation_strategy.v1":
        errors.append("uma-coherency-validation-strategy.yaml has wrong schema")
    if data.get("status") != "fail_closed_until_evidence":
        errors.append("UMA strategy must remain fail_closed_until_evidence")
    require_false_claim_flags(data, "uma-coherency-validation-strategy.yaml", errors)
    axes = data.get("validation_axes")
    if not isinstance(axes, list):
        errors.append("UMA strategy must list validation_axes")
        return
    ids = {axis.get("id") for axis in axes if isinstance(axis, dict)}
    missing = sorted(REQUIRED_UMA_AXES - ids)
    if missing:
        errors.append("UMA validation_axes missing: " + ", ".join(missing))
    for axis in axes:
        if not isinstance(axis, dict):
            continue
        axis_id = axis.get("id", "<axis>")
        tests = axis.get("minimum_tests")
        if not isinstance(tests, list) or len(tests) < 4:
            errors.append(f"UMA axis {axis_id} must list at least four minimum_tests")
        if not isinstance(axis.get("release_gate"), str) or not axis["release_gate"]:
            errors.append(f"UMA axis {axis_id} missing release_gate")
    artifacts = data.get("required_artifacts")
    if not isinstance(artifacts, list) or len(artifacts) < 4:
        errors.append("UMA strategy must list required evidence artifacts")


def check_ai_options(data: dict, errors: list[str]) -> None:
    if data.get("schema") != "eliza.ai_accelerator_options.v1":
        errors.append("ai-accelerator-options.yaml has wrong schema")
    if data.get("status") != "decision_open_fail_closed":
        errors.append("AI accelerator options must remain decision_open_fail_closed")
    require_false_claim_flags(data, "ai-accelerator-options.yaml", errors)
    options = data.get("options")
    if not isinstance(options, list):
        errors.append("AI accelerator options must list options")
        return
    ids = {option.get("id") for option in options if isinstance(option, dict)}
    missing = sorted(REQUIRED_AI_OPTIONS - ids)
    if missing:
        errors.append("AI options missing: " + ", ".join(missing))
    for option in options:
        if not isinstance(option, dict):
            continue
        option_id = option.get("id", "<option>")
        for field in ("advantages", "blockers", "validation_gates"):
            value = option.get(field)
            if not isinstance(value, list) or len(value) < 3:
                errors.append(f"AI option {option_id} must list at least three {field}")
    common = data.get("required_common_gates")
    for term in ("unsupported op count", "CPU fallback percentage", "platform claim level"):
        if term not in "\n".join(str(item) for item in common or []):
            errors.append(f"AI common gates missing term: {term}")


def check_handoffs(data: dict, errors: list[str]) -> None:
    if data.get("schema") != "eliza.pipeline_handoff_work_order.v1":
        errors.append("spec-rtl-sw-pd-handoff-work-order.yaml has wrong schema")
    if data.get("status") != "fail_closed_open_work":
        errors.append("handoff work order must remain fail_closed_open_work")
    require_false_claim_flags(data, "spec-rtl-sw-pd-handoff-work-order.yaml", errors)
    handoffs = data.get("handoffs")
    if not isinstance(handoffs, list):
        errors.append("handoff work order must list handoffs")
        return
    ids = {handoff.get("id") for handoff in handoffs if isinstance(handoff, dict)}
    missing = sorted(REQUIRED_HANDOFFS - ids)
    if missing:
        errors.append("handoffs missing: " + ", ".join(missing))
    for handoff in handoffs:
        if not isinstance(handoff, dict):
            continue
        handoff_id = handoff.get("id", "<handoff>")
        for path in handoff.get("current_artifacts", []):
            if isinstance(path, str):
                require_file(path, errors, f"{handoff_id}.current_artifacts")
        missing_artifacts = handoff.get("missing_artifacts")
        if not isinstance(missing_artifacts, list) or len(missing_artifacts) < 2:
            errors.append(f"{handoff_id}: missing_artifacts must list at least two blockers")
        gate = handoff.get("fail_closed_gate")
        if not isinstance(gate, str) or not gate.startswith(("make ", "python3 ")):
            errors.append(f"{handoff_id}: fail_closed_gate must be a concrete command")


def check_gate_doc(errors: list[str]) -> None:
    if not GATE_DOC.is_file():
        errors.append("missing docs/project/phone-soc-architecture-gates.md")
        return
    text = GATE_DOC.read_text()
    for term in (
        "make phone-soc-claim-check",
        "Android boots",
        "WiFi/Bluetooth works",
        "AI throughput",
        "GPU/display",
        "UMA/coherency",
        "Tapeout",
        "Scaffold checks may pass while these claims remain blocked.",
    ):
        if term not in text:
            errors.append(f"phone-soc-architecture-gates.md missing term: {term}")


def check_existing_fail_closed_controls(errors: list[str]) -> None:
    makefile = (ROOT / "Makefile").read_text()
    for target in (
        "software-bsp-evidence-check",
        "qemu-check-strict",
        "renode-check-strict",
        "pd-signoff-check",
    ):
        if target not in makefile:
            errors.append(f"Makefile missing fail-closed target: {target}")

    benchmark_plan = (ROOT / "benchmarks/configs/benchmark_plan.json").read_text()
    for term in (
        "placeholder_allowed",
        "release_blocking",
        "tflite_e1_npu",
        "--nnapi_accelerator_name=e1-npu",
    ):
        if term not in benchmark_plan:
            errors.append(f"benchmark plan missing AI claim guard: {term}")

    real_world = (ROOT / "docs/manufacturing/real-world-verification-gaps.yaml").read_text()
    for term in ("wifi_bluetooth_gnss_nfc_stack", "not available", "release_gate"):
        if term not in real_world:
            errors.append(f"real-world gap manifest missing WiFi/product claim guard: {term}")


def check_media_scope_gate(errors: list[str]) -> None:
    result = subprocess.run(
        [sys.executable, str(MEDIA_SCOPE_CHECK)],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if result.returncode != 0:
        errors.append("phone media pipeline scope check failed:\n" + result.stdout)
        return
    if not MEDIA_SCOPE_REPORT.is_file():
        errors.append("phone media pipeline scope report was not generated")
        return
    text = MEDIA_SCOPE_REPORT.read_text(encoding="utf-8")
    for term in ("media_pipeline_scope_release_blocked", "not GPU", "camera_isp_stack"):
        if term not in text:
            errors.append(f"phone media pipeline scope report missing term: {term}")


def main() -> int:
    errors: list[str] = []
    min_blocks = load_yaml(MIN_BLOCKS, errors)
    uma = load_yaml(UMA, errors)
    ai_options = load_yaml(AI_OPTIONS, errors)
    handoffs = load_yaml(HANDOFFS, errors)

    if min_blocks:
        check_min_blocks(min_blocks, errors)
    if uma:
        check_uma(uma, errors)
    if ai_options:
        check_ai_options(ai_options, errors)
    if handoffs:
        check_handoffs(handoffs, errors)
    check_gate_doc(errors)
    check_existing_fail_closed_controls(errors)
    check_media_scope_gate(errors)

    if errors:
        print("Phone SoC claim check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1

    print("phone SoC claim gates structurally checked and fail-closed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
