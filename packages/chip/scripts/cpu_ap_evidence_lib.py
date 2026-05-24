#!/usr/bin/env python3
"""Shared CPU/AP generated-artifact and transcript evidence validators."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SELECTED_MANIFEST = ROOT / "docs/generators/chipyard/eliza-rocket-manifest.json"
IMPORT_TEMPLATE = ROOT / "docs/generators/chipyard/import-manifest.template.json"
GENERATED_MANIFEST = ROOT / "build/chipyard/eliza_rocket/ElizaRocketConfig.manifest.json"
EVIDENCE_MANIFEST = ROOT / "docs/evidence/cpu-ap-evidence-manifest.json"
PLATFORM_CONTRACT = ROOT / "sw/platform/e1_platform_contract.json"

EXPECTED_CHIPYARD = {
    "repo": "https://github.com/ucb-bar/chipyard.git",
    "tag": "main-2026-05-20",
    "commit": "48f904aefbb3903dce6efa7901982642853ae6a7",
}

DEFAULT_FORBIDDEN_EVIDENCE_TERMS = [
    "placeholder",
    "template only",
    "sample only",
    "not real evidence",
    "todo",
    "eliza-evidence: template=true",
    "eliza-evidence: status=FAIL",
    "eliza-evidence: status=BLOCKED",
    "qemu-virt software reference",
    "Renode software reference",
    "/path/to/",
    "/exact/external/",
    "'/exact/",
]

UART_TX_RE = re.compile(r"^UART TX \(([0-9a-fA-F]{1,2})\):", re.MULTILINE)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def reject_duplicate_json_keys(path: Path, errors: list[str]) -> None:
    duplicates: list[str] = []

    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        seen: set[str] = set()
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in seen:
                duplicates.append(key)
            seen.add(key)
            result[key] = value
        return result

    try:
        json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=reject_duplicates)
    except FileNotFoundError:
        errors.append(f"missing JSON manifest: {rel(path)}")
        return
    except json.JSONDecodeError as exc:
        errors.append(f"{rel(path)} is invalid JSON: {exc}")
        return
    if duplicates:
        errors.append(
            f"{rel(path)} contains duplicate JSON keys: " + ", ".join(sorted(set(duplicates)))
        )


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_tree(path: Path) -> str:
    digest = hashlib.sha256()
    for item in sorted(child for child in path.rglob("*") if child.is_file()):
        relative = item.relative_to(path).as_posix().encode()
        digest.update(relative)
        digest.update(b"\0")
        digest.update(sha256_file(item).encode())
        digest.update(b"\0")
    return digest.hexdigest()


def sha256_path(path: Path) -> str:
    if path.is_dir():
        return sha256_tree(path)
    return sha256_file(path)


def reconstruct_uart_tx_text(text: str) -> str:
    """Decode Chipyard `+uart_tx_printf=1` byte lines into UART text."""
    values = [int(match.group(1), 16) & 0xFF for match in UART_TX_RE.finditer(text)]
    if not values:
        return ""
    return bytes(values).decode("utf-8", errors="replace")


def text_with_reconstructed_uart(text: str) -> str:
    reconstructed = reconstruct_uart_tx_text(text)
    if not reconstructed:
        return text
    return "\n".join(
        (
            text,
            "eliza-evidence: reconstructed_uart_tx_begin",
            reconstructed,
            "eliza-evidence: reconstructed_uart_tx_end",
        )
    )


def load_evidence_manifest(errors: list[str]) -> dict[str, Any]:
    if not EVIDENCE_MANIFEST.is_file():
        errors.append(f"missing CPU/AP evidence manifest: {rel(EVIDENCE_MANIFEST)}")
        return {}
    try:
        manifest = load_json(EVIDENCE_MANIFEST)
    except json.JSONDecodeError as exc:
        errors.append(f"{rel(EVIDENCE_MANIFEST)} is invalid JSON: {exc}")
        return {}
    validate_evidence_manifest(manifest, errors)
    return manifest


def artifact_specs(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    artifacts = manifest.get("generated_artifacts", {})
    if not isinstance(artifacts, dict):
        return {}
    return {name: spec for name, spec in artifacts.items() if isinstance(spec, dict)}


def transcript_specs(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    transcripts = manifest.get("transcripts", {})
    if not isinstance(transcripts, dict):
        return {}
    return {name: spec for name, spec in transcripts.items() if isinstance(spec, dict)}


def validate_evidence_manifest(manifest: dict[str, Any], errors: list[str]) -> None:
    require(
        manifest.get("schema_version") == 1,
        "CPU/AP evidence manifest schema_version must be 1",
        errors,
    )
    require(
        manifest.get("claim_boundary")
        == "generated_chipyard_artifacts_and_external_transcripts_only",
        "CPU/AP evidence manifest must use generated_chipyard_artifacts_and_external_transcripts_only",
        errors,
    )
    require(
        manifest.get("completion_claim")
        == "blocked_until_all_required_artifacts_and_evidence_pass",
        "CPU/AP evidence manifest must keep completion claim blocked",
        errors,
    )
    require(
        manifest.get("selected_manifest")
        in {
            rel(SELECTED_MANIFEST),
            "generators/chipyard/eliza-rocket-manifest.json",
        },
        "CPU/AP evidence manifest selected_manifest path drifted",
        errors,
    )
    require(
        manifest.get("generated_manifest") == rel(GENERATED_MANIFEST),
        "CPU/AP evidence manifest generated_manifest path drifted",
        errors,
    )
    require(
        manifest.get("capture_helper") == "scripts/capture_cpu_ap_evidence.py",
        "CPU/AP evidence manifest capture_helper path drifted",
        errors,
    )
    expected_linux_gates = {
        "rv64gc_isa": "build/evidence/cpu_ap/eliza_e1_isa_cache_mmu.log",
        "s_mode_privilege": "build/evidence/cpu_ap/eliza_e1_opensbi_boot.log",
        "mmu_sv39_or_stronger": "build/evidence/cpu_ap/eliza_e1_isa_cache_mmu.log",
        "clint_timer_software_irq": "build/evidence/cpu_ap/eliza_e1_trap_timer_irq.log",
        "plic_external_irq": "build/evidence/cpu_ap/eliza_e1_trap_timer_irq.log",
        "uart_console": "build/evidence/cpu_ap/eliza_e1_linux_boot.log",
        "dtb_linux_boot_contract": "build/chipyard/eliza_rocket/eliza-e1.dts",
        "opensbi_handoff": "build/evidence/cpu_ap/eliza_e1_opensbi_boot.log",
        "linux_initramfs_smoke": "build/evidence/cpu_ap/eliza_e1_linux_boot.log",
    }
    gate_matrix = manifest.get("linux_capable_gate_matrix", [])
    if not isinstance(gate_matrix, list):
        errors.append("CPU/AP evidence manifest linux_capable_gate_matrix must be a list")
    else:
        seen_gates: set[str] = set()
        for gate in gate_matrix:
            if not isinstance(gate, dict):
                errors.append("CPU/AP Linux-capable gate matrix entries must be objects")
                continue
            gate_id = gate.get("gate")
            if not isinstance(gate_id, str):
                errors.append("CPU/AP Linux-capable gate missing gate id")
                continue
            seen_gates.add(gate_id)
            expected_evidence = expected_linux_gates.get(gate_id)
            if expected_evidence is None:
                errors.append(f"CPU/AP Linux-capable gate is not approved: {gate_id}")
                continue
            require(
                gate.get("status") == "blocked",
                f"CPU/AP Linux-capable gate {gate_id} must remain blocked until evidence passes",
                errors,
            )
            require(
                gate.get("evidence") == expected_evidence,
                f"CPU/AP Linux-capable gate {gate_id} evidence path drifted",
                errors,
            )
            for key in ("pass_requires", "fail_if"):
                values = gate.get(key)
                if not isinstance(values, list) or not values:
                    errors.append(f"CPU/AP Linux-capable gate {gate_id} must list {key}")
        missing_gates = sorted(set(expected_linux_gates) - seen_gates)
        if missing_gates:
            errors.append(
                "CPU/AP evidence manifest missing Linux-capable gates: " + ", ".join(missing_gates)
            )
    qemu_reference = manifest.get("qemu_reference_evidence", {})
    if not isinstance(qemu_reference, dict):
        errors.append("CPU/AP evidence manifest qemu_reference_evidence must be an object")
    else:
        require(
            qemu_reference.get("status")
            == "software_reference_only_not_linux_capable_cpu_evidence",
            "QEMU reference evidence must remain excluded from Linux-capable CPU/AP claims",
            errors,
        )
        require(
            qemu_reference.get("attempt_log") == "build/reports/qemu_os_boot_attempt.log",
            "QEMU OS attempt log path drifted",
            errors,
        )
        require(
            qemu_reference.get("capture_command") == "scripts/run_qemu.sh --check-os",
            "QEMU OS attempt capture command drifted",
            errors,
        )
        allowed_results = qemu_reference.get("allowed_results", [])
        if not isinstance(allowed_results, list) or set(allowed_results) != {
            "BLOCKED",
            "FAIL",
            "PASS",
        }:
            errors.append("QEMU OS attempt must declare exact BLOCKED/FAIL/PASS states")
        claim_limit = qemu_reference.get("claim_limit")
        if not isinstance(claim_limit, str) or "cannot satisfy" not in claim_limit:
            errors.append("QEMU reference evidence must state it cannot satisfy AP evidence gates")
    policy = manifest.get("target_policy", {})
    if not isinstance(policy, dict):
        errors.append("CPU/AP evidence manifest target_policy must be an object")
    else:
        require(
            policy.get("initial_linux_bringup_claim")
            == "single_hart_rocket_rv64gc_linux_smoke_only",
            "CPU/AP target policy must limit the initial Rocket path to Linux smoke",
            errors,
        )
        require(
            policy.get("phone_2028_ap_claim")
            == "blocked_until_phone_class_artifacts_and_evidence_pass",
            "CPU/AP target policy must keep the 2028 phone-class AP claim blocked",
            errors,
        )
        required_phone_items = {
            "multi_hart_application_cpu_topology_or_documented_equivalent",
            "riscv_application_profile_and_extension_matrix",
            "cache_hierarchy_and_coherency_evidence",
            "mmu_page_table_and_tlb_evidence",
            "sustained_boot_and_benchmark_evidence",
            "power_thermal_voltage_frequency_evidence",
            "process_14a_corner_benchmark_derate_evidence",
            "android_cts_vts_and_userspace_evidence",
        }
        found_phone_items = policy.get("phone_2028_claim_requires", [])
        if not isinstance(found_phone_items, list):
            errors.append("CPU/AP target policy phone_2028_claim_requires must be a list")
        else:
            missing_phone_items = sorted(required_phone_items - set(found_phone_items))
            if missing_phone_items:
                errors.append(
                    "CPU/AP target policy missing 2028 phone-class blockers: "
                    + ", ".join(missing_phone_items)
                )
        forbidden = policy.get("forbidden_without_evidence", [])
        if not isinstance(forbidden, list):
            errors.append("CPU/AP target policy forbidden_without_evidence must be a list")
        else:
            for phrase in ("phone-class AP", "Android compatible", "production silicon"):
                require(
                    phrase in forbidden,
                    f"CPU/AP target policy must forbid unsupported claim: {phrase}",
                    errors,
                )

    artifacts = artifact_specs(manifest)
    required_artifacts = {"generated_src", "verilog", "dts", "simulator"}
    missing_artifacts = sorted(required_artifacts - set(artifacts))
    if missing_artifacts:
        errors.append(
            "CPU/AP evidence manifest missing generated artifact specs: "
            + ", ".join(missing_artifacts)
        )
    for name, spec in artifacts.items():
        path = spec.get("path")
        if not isinstance(path, str) or not path.startswith("build/chipyard/eliza_rocket/"):
            errors.append(f"CPU/AP artifact {name} has invalid path: {path!r}")
        if spec.get("manifest_key") != name:
            errors.append(f"CPU/AP artifact {name} manifest_key must match artifact name")
        sha_key = spec.get("sha256_key")
        if not isinstance(sha_key, str) or not sha_key:
            errors.append(f"CPU/AP artifact {name} missing sha256_key")
        kind = spec.get("kind")
        if kind not in {"file", "directory", "file_or_directory"}:
            errors.append(
                f"CPU/AP artifact {name} kind must be file, directory, or file_or_directory"
            )
        if name == "simulator":
            require(
                spec.get("requires_executable") is True,
                "CPU/AP simulator artifact must require an executable file",
                errors,
            )

    transcripts = transcript_specs(manifest)
    required_transcripts = {
        "opensbi_boot_log",
        "linux_boot_log",
        "trap_timer_irq_log",
        "isa_cache_mmu_log",
        "ap_benchmark_log",
    }
    missing_transcripts = sorted(required_transcripts - set(transcripts))
    if missing_transcripts:
        errors.append(
            "CPU/AP evidence manifest missing transcript specs: " + ", ".join(missing_transcripts)
        )
    for name, spec in transcripts.items():
        path = spec.get("path")
        if not isinstance(path, str) or not path.startswith("build/evidence/cpu_ap/"):
            errors.append(f"CPU/AP transcript {name} has invalid path: {path!r}")
        if spec.get("manifest_key") != name:
            errors.append(f"CPU/AP transcript {name} manifest_key must match transcript name")
        sha_key = spec.get("sha256_key")
        if not isinstance(sha_key, str) or not sha_key:
            errors.append(f"CPU/AP transcript {name} missing sha256_key")
        for key in ("required_strings", "raw_required_strings"):
            if not isinstance(spec.get(key), list) or not spec.get(key):
                errors.append(f"CPU/AP transcript {name} must list {key}")


def text_problems(text: str, spec: dict[str, Any], rel_path: str, *, raw: bool) -> list[str]:
    problems: list[str] = []
    searchable_text = text_with_reconstructed_uart(text)
    min_bytes = int(spec.get("min_bytes", 160))
    if len(searchable_text.strip()) < min_bytes:
        problems.append(f"{rel_path} is too small to be a real command transcript")

    forbidden = DEFAULT_FORBIDDEN_EVIDENCE_TERMS + spec.get("forbidden_strings", [])
    lower = searchable_text.lower()
    found_forbidden = [
        term for term in forbidden if isinstance(term, str) and term.lower() in lower
    ]
    if found_forbidden:
        problems.append(
            f"{rel_path} contains forbidden placeholder/failure markers: "
            + ", ".join(found_forbidden)
        )

    key = "raw_required_strings" if raw else "required_strings"
    missing = [
        term for term in spec.get(key, []) if isinstance(term, str) and term not in searchable_text
    ]
    if missing:
        problems.append(f"{rel_path} missing required transcript markers: " + ", ".join(missing))

    for group in spec.get("at_least_one", []):
        if not isinstance(group, list) or not group:
            problems.append(f"{rel_path} has invalid at_least_one rule in manifest")
        elif not any(isinstance(term, str) and term in searchable_text for term in group):
            problems.append(
                f"{rel_path} must contain at least one marker from: " + ", ".join(group)
            )

    return problems


def transcript_metadata_problems(text: str, rel_path: str) -> list[str]:
    problems: list[str] = []
    expected_manifest = rel(GENERATED_MANIFEST)
    expected_sha = sha256_path(GENERATED_MANIFEST) if GENERATED_MANIFEST.is_file() else None

    manifest_marker = f"eliza-evidence: generated_manifest={expected_manifest}"
    if manifest_marker not in text:
        problems.append(f"{rel_path} must bind to generated manifest {expected_manifest}")

    if expected_sha is None:
        problems.append(f"{rel_path} cannot be release evidence until {expected_manifest} exists")
    else:
        sha_marker = f"eliza-evidence: generated_manifest_sha256={expected_sha}"
        if sha_marker not in text:
            problems.append(f"{rel_path} generated_manifest_sha256 must match {expected_manifest}")

    if "eliza-evidence: generated_manifest_sha256=missing" in text:
        problems.append(f"{rel_path} records a missing generated manifest hash")
    return problems


def validate_path_kind(path: Path, spec: dict[str, Any], errors: list[str], label: str) -> None:
    kind = spec.get("kind")
    if kind == "file":
        require(path.is_file(), f"missing generated {label} file: {rel(path)}", errors)
    elif kind == "directory":
        require(path.is_dir(), f"missing generated {label} directory: {rel(path)}", errors)
        if path.is_dir() and not any(path.iterdir()):
            errors.append(f"generated {label} directory is empty: {rel(path)}")
    elif kind == "file_or_directory":
        require(path.exists(), f"missing generated {label} artifact: {rel(path)}", errors)
        if path.is_dir() and not any(path.iterdir()):
            errors.append(f"generated {label} directory is empty: {rel(path)}")
    else:
        errors.append(f"generated {label} has invalid manifest kind: {kind!r}")

    if spec.get("requires_executable") is True and path.exists():
        executable_found = False
        if path.is_file():
            executable_found = path.stat().st_mode & 0o111 != 0
        elif path.is_dir():
            executable_found = any(
                item.is_file() and item.stat().st_mode & 0o111 != 0 for item in path.rglob("*")
            )
        if not executable_found:
            errors.append(f"generated {label} artifact lacks an executable file: {rel(path)}")


def validate_sha256(
    path: Path,
    expected_hashes: dict[str, Any],
    name: str,
    sha256_key: str,
    errors: list[str],
) -> None:
    expected = expected_hashes.get(sha256_key)
    if not isinstance(expected, str) or not expected:
        errors.append(f"generated import manifest missing sha256 entry: {sha256_key}")
        return
    if not path.exists():
        return
    actual = sha256_path(path)
    if expected != actual:
        errors.append(f"{name} sha256 mismatch: expected {expected}, got {actual}")
