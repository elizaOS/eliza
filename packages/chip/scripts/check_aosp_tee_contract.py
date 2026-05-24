#!/usr/bin/env python3
"""Static AOSP TEE protected-agent contract gate (plan §5 / measured-boot "AOSP Path").

This gate validates the parts of the AOSP confidential-path contract that are
checkable locally WITHOUT building or booting AOSP:

  1. sepolicy gating: a dedicated `eliza_pvm_mgr` domain is the ONLY domain
     permitted to reach the protected-VM (pVM/AVF) management binder and the
     vsock control channel, with a fail-closed neverallow envelope.
  2. TEE policy + golden measurements are produced and placed at
     /product/etc/eliza/tee-policy.json and /product/etc/eliza/tee-measurements.json
     (same schema as Linux), wired into the product copy + artifact allowlist.
  3. The pVM -> normalized TeeEvidence export shape conforms to the agent
     contract (packages/agent/src/services/tee-evidence.ts): required
     measurements present as sha256:<64 hex>, an allowed pVM kind, a
     non-simulated kind/provider, and NO confidentiality claims (those are
     BLOCKED on the bring-up track).

It does NOT build, boot, or attest. The AOSP CONFIDENTIALITY claim is held
explicitly BLOCKED: riscv64 has no CoVE-capable KVM/crosvm path and the
16 KB-page IOPMP/measurement validation is not done. This gate asserts
bring-up readiness of the contract, not a confidential boot.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent

OS_VENDOR = WORKSPACE / "os/android/vendor/eliza"
SEPOLICY_PVM = OS_VENDOR / "sepolicy/eliza_pvm_mgr.te"
SEPOLICY_FILE_CONTEXTS = OS_VENDOR / "sepolicy/file_contexts"
TEE_POLICY = OS_VENDOR / "tee/tee-policy.json"
TEE_MEASUREMENTS = OS_VENDOR / "tee/tee-measurements.json"
OS_COMMON = OS_VENDOR / "eliza_common.mk"
INIT_RC = OS_VENDOR / "init/init.eliza.rc"

CHIP_AOSP = ROOT / "sw/aosp-device"
PVM_EVIDENCE_FIXTURE = CHIP_AOSP / "fixtures/tee/pvm-tee-evidence.bringup.json"

REPORT = ROOT / "build/reports/aosp_tee_contract.json"

SCHEMA = "eliza.aosp_tee_contract.v1"
CLAIM_BOUNDARY = "aosp_tee_contract_bringup_only_not_confidential_boot"

# Mirror packages/os/scripts/os-release-lib.mjs requiredTeeMeasurementNames and
# packages/agent/src/services/tee-evidence.ts TeeKind / detectSimulatedEvidence.
REQUIRED_MEASUREMENTS = ("boot", "os", "agent", "policy")
ALLOWED_PVM_KINDS = ("pkvm", "avf", "tdx", "sev-snp")
# Claims the agent treats as confidentiality posture; on the bring-up track
# these MUST be absent/false because the confidential boot is BLOCKED.
BLOCKED_CONFIDENTIALITY_CLAIMS = ("memoryEncrypted", "ioProtected", "npuProtected")
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
SIMULATED_TOKENS = ("mock", "sim", "fake", "debug")


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    message: str
    evidence: str
    next_step: str


def rel(path: Path) -> str:
    try:
        return path.relative_to(WORKSPACE).as_posix()
    except ValueError:
        return str(path)


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def load_json(path: Path) -> Any:
    return json.loads(read_text(path))


def blocker(
    findings: list[Finding], code: str, message: str, evidence: str, next_step: str
) -> None:
    findings.append(Finding(code, "blocker", message, evidence, next_step))


def add_if(
    findings: list[Finding],
    condition: bool,
    code: str,
    message: str,
    evidence: str,
    next_step: str,
) -> None:
    if condition:
        blocker(findings, code, message, evidence, next_step)


def is_simulated_token(value: str) -> bool:
    low = value.lower()
    return any(token in low for token in SIMULATED_TOKENS)


def check_sepolicy(findings: list[Finding]) -> None:
    if not SEPOLICY_PVM.is_file():
        blocker(
            findings,
            "pvm_sepolicy_domain_missing",
            "no dedicated eliza_pvm_mgr SELinux domain gates the protected-VM management/vsock channel",
            rel(SEPOLICY_PVM),
            "Add vendor/eliza/sepolicy/eliza_pvm_mgr.te declaring the domain and the gated binder/vsock allow rules.",
        )
        return
    text = read_text(SEPOLICY_PVM)
    avf_policy_build_gated = "ELIZA_AVF_SEPOLICY_BUILD_GATED=1" in text
    add_if(
        findings,
        "type eliza_pvm_mgr, domain;" not in text,
        "pvm_sepolicy_domain_not_declared",
        "eliza_pvm_mgr.te does not declare a dedicated domain type",
        rel(SEPOLICY_PVM),
        "Declare `type eliza_pvm_mgr, domain;` so the management surface has its own SELinux domain.",
    )
    add_if(
        findings,
        not avf_policy_build_gated
        and "binder_call(eliza_pvm_mgr, virtualizationservice)" not in text,
        "pvm_sepolicy_no_virtmgr_binder_call",
        "eliza_pvm_mgr is not granted the protected-VM management (virtualizationservice) binder call",
        rel(SEPOLICY_PVM),
        "Grant binder_call(eliza_pvm_mgr, virtualizationservice) when the target exports AVF sepolicy types, or keep ELIZA_AVF_SEPOLICY_BUILD_GATED=1 on riscv64 bring-up trees that do not.",
    )
    add_if(
        findings,
        "allow eliza_pvm_mgr eliza_pvm_vsock_device:chr_file" not in text,
        "pvm_sepolicy_no_vsock_allow",
        "eliza_pvm_mgr is not granted access to the protected-VM vsock control device",
        rel(SEPOLICY_PVM),
        "Grant eliza_pvm_mgr the vsock control device so it can drive the pVM control channel.",
    )
    # The gating must be exclusive: a neverallow envelope must keep apps and
    # other domains off the vsock channel and the management binder.
    has_app_vsock_neverallow = (
        "neverallow" in text and "eliza_pvm_vsock_device" in text and "appdomain" in text
    )
    add_if(
        findings,
        not has_app_vsock_neverallow,
        "pvm_sepolicy_vsock_not_exclusive",
        "no neverallow keeps app domains off the protected-VM vsock channel (gating is not exclusive)",
        rel(SEPOLICY_PVM),
        "Add `neverallow { appdomain -eliza_pvm_mgr } eliza_pvm_vsock_device:chr_file *;` to make eliza_pvm_mgr the sole reacher.",
    )
    add_if(
        findings,
        not avf_policy_build_gated
        and "neverallow { appdomain } virtualizationservice_service:service_manager find;"
        not in text,
        "pvm_sepolicy_virtmgr_not_exclusive",
        "no neverallow keeps app domains from finding the protected-VM management service",
        rel(SEPOLICY_PVM),
        "Add a neverallow so only eliza_pvm_mgr can find virtualizationservice_service when the target exports that service type, or keep ELIZA_AVF_SEPOLICY_BUILD_GATED=1 on riscv64 bring-up trees that do not.",
    )
    # file_contexts must label the executable. When the AVF/pVM policy is
    # build-gated, do not relabel /dev/vhost-vsock from vendor policy: platform
    # policy already owns that path as kvm_device on current AOSP trees, and a
    # duplicate vendor label breaks file_contexts compilation. Once the target
    # enables the full policy, the custom vsock label becomes required again.
    if SEPOLICY_FILE_CONTEXTS.is_file():
        fc = read_text(SEPOLICY_FILE_CONTEXTS)
        add_if(
            findings,
            not avf_policy_build_gated and "eliza_pvm_vsock_device" not in fc,
            "pvm_file_contexts_missing_vsock_label",
            "vendor file_contexts does not label the protected-VM vsock device",
            rel(SEPOLICY_FILE_CONTEXTS),
            "Label /dev/vhost-vsock as eliza_pvm_vsock_device in vendor/eliza/sepolicy/file_contexts.",
        )
        add_if(
            findings,
            avf_policy_build_gated
            and re.search(r"^\s*/dev/vhost-vsock\s+", fc, re.MULTILINE) is not None,
            "pvm_file_contexts_build_gated_vsock_conflict",
            "vendor file_contexts labels /dev/vhost-vsock while AVF/pVM policy is build-gated",
            rel(SEPOLICY_FILE_CONTEXTS),
            "Remove the vendor /dev/vhost-vsock label while ELIZA_AVF_SEPOLICY_BUILD_GATED=1; platform policy already labels the device.",
        )
        add_if(
            findings,
            "eliza_pvm_mgr_exec" not in fc,
            "pvm_file_contexts_missing_exec_label",
            "vendor file_contexts does not label the eliza_pvm_mgr service binary",
            rel(SEPOLICY_FILE_CONTEXTS),
            "Label the eliza_pvm_mgr binary as eliza_pvm_mgr_exec in vendor/eliza/sepolicy/file_contexts.",
        )
    else:
        blocker(
            findings,
            "pvm_file_contexts_missing",
            "vendor sepolicy file_contexts is missing",
            rel(SEPOLICY_FILE_CONTEXTS),
            "Add file_contexts labeling the eliza_pvm_mgr binary and runtime evidence directory.",
        )
    # The domain must be started by a real init service entry so it exists.
    if INIT_RC.is_file():
        init_text = read_text(INIT_RC)
        add_if(
            findings,
            "service eliza_pvm_mgr" not in init_text
            or "seclabel u:r:eliza_pvm_mgr:s0" not in init_text,
            "pvm_init_service_missing",
            "init.eliza.rc does not define the eliza_pvm_mgr service with its seclabel",
            rel(INIT_RC),
            "Define `service eliza_pvm_mgr` with `seclabel u:r:eliza_pvm_mgr:s0` so init launches the management domain.",
        )


def check_policy_placement(findings: list[Finding]) -> None:
    if not OS_COMMON.is_file():
        blocker(
            findings,
            "os_common_missing",
            "OS Eliza common product layer is missing",
            rel(OS_COMMON),
            "Restore vendor/eliza/eliza_common.mk before claiming TEE policy placement.",
        )
        return
    common = read_text(OS_COMMON)
    for kind, src, dest in (
        ("policy", "vendor/eliza/tee/tee-policy.json", "etc/eliza/tee-policy.json"),
        (
            "measurements",
            "vendor/eliza/tee/tee-measurements.json",
            "etc/eliza/tee-measurements.json",
        ),
    ):
        copy_line = f"{src}:$(TARGET_COPY_OUT_PRODUCT)/{dest}"
        add_if(
            findings,
            copy_line not in common,
            f"tee_{kind}_not_copied_to_product",
            f"TEE {kind} is not PRODUCT_COPY_FILES-installed to /product/{dest}",
            rel(OS_COMMON),
            f"Add `{copy_line}` to PRODUCT_COPY_FILES so the {kind} ships in the image.",
        )
        allow_line = f"product/{dest}"
        add_if(
            findings,
            allow_line not in common,
            f"tee_{kind}_not_in_artifact_allowlist",
            f"/product/{dest} is not in PRODUCT_ARTIFACT_PATH_REQUIREMENT_ALLOWED_LIST",
            rel(OS_COMMON),
            f"Add `{allow_line}` to the artifact allowlist so the copy is permitted.",
        )


def check_policy_json(findings: list[Finding]) -> None:
    if not TEE_POLICY.is_file():
        blocker(
            findings,
            "tee_policy_file_missing",
            "AOSP TEE policy file is missing",
            rel(TEE_POLICY),
            "Create vendor/eliza/tee/tee-policy.json in the agent TeeEvidencePolicy shape.",
        )
        return
    try:
        doc = load_json(TEE_POLICY)
    except json.JSONDecodeError as exc:
        blocker(
            findings,
            "tee_policy_invalid_json",
            "AOSP TEE policy file is not valid JSON",
            f"{rel(TEE_POLICY)}: {exc}",
            "Fix the JSON syntax in vendor/eliza/tee/tee-policy.json.",
        )
        return
    add_if(
        findings,
        doc.get("confidentialityBlocked") is not True,
        "tee_policy_confidentiality_not_blocked",
        "AOSP TEE policy does not assert confidentialityBlocked=true (bring-up track must hold the confidential claim BLOCKED)",
        rel(TEE_POLICY),
        "Set confidentialityBlocked=true until a CoVE-capable riscv64 KVM/crosvm path exists.",
    )
    policy = doc.get("policy")
    if not isinstance(policy, dict):
        blocker(
            findings,
            "tee_policy_missing_policy_block",
            "AOSP TEE policy file has no `policy` block in the agent TeeEvidencePolicy shape",
            rel(TEE_POLICY),
            "Add a `policy` object matching TeeEvidencePolicy (required, allowedKinds, requiredMeasurements, ...).",
        )
        return
    add_if(
        findings,
        policy.get("required") is not True,
        "tee_policy_not_required",
        "AOSP TEE policy does not mark evidence as required",
        rel(TEE_POLICY),
        "Set policy.required=true so missing evidence fails closed.",
    )
    add_if(
        findings,
        policy.get("rejectSimulatedEvidence") is not True,
        "tee_policy_allows_simulated",
        "AOSP TEE policy does not reject simulated/DevMode evidence",
        rel(TEE_POLICY),
        "Set policy.rejectSimulatedEvidence=true (defends against DevMode allow-all).",
    )
    allowed = policy.get("allowedKinds")
    add_if(
        findings,
        not isinstance(allowed, list) or not set(allowed).issubset(set(ALLOWED_PVM_KINDS)),
        "tee_policy_kinds_out_of_contract",
        "AOSP TEE policy allowedKinds are not a subset of the contracted pVM/cloud kinds",
        f"allowedKinds={allowed!r} contract={list(ALLOWED_PVM_KINDS)}",
        "Restrict policy.allowedKinds to pkvm/avf (on-device) and tdx/sev-snp (cloud Android hosts).",
    )
    req = policy.get("requiredMeasurements")
    add_if(
        findings,
        not isinstance(req, dict) or not set(REQUIRED_MEASUREMENTS).issubset(req.keys()),
        "tee_policy_missing_required_measurements",
        "AOSP TEE policy requiredMeasurements omit one of boot/os/agent/policy",
        f"requiredMeasurements={sorted(req) if isinstance(req, dict) else req!r} required={list(REQUIRED_MEASUREMENTS)}",
        "List boot, os, agent, and policy in policy.requiredMeasurements.",
    )


def check_measurements_json(findings: list[Finding]) -> None:
    if not TEE_MEASUREMENTS.is_file():
        blocker(
            findings,
            "tee_measurements_file_missing",
            "AOSP TEE measurements file is missing",
            rel(TEE_MEASUREMENTS),
            "Create vendor/eliza/tee/tee-measurements.json (generate-tee-measurements.mjs schema).",
        )
        return
    try:
        doc = load_json(TEE_MEASUREMENTS)
    except json.JSONDecodeError as exc:
        blocker(
            findings,
            "tee_measurements_invalid_json",
            "AOSP TEE measurements file is not valid JSON",
            f"{rel(TEE_MEASUREMENTS)}: {exc}",
            "Fix the JSON syntax in vendor/eliza/tee/tee-measurements.json.",
        )
        return
    add_if(
        findings,
        doc.get("schemaVersion") != 1,
        "tee_measurements_bad_schema_version",
        "AOSP TEE measurements schemaVersion is not 1 (Linux schema parity)",
        f"{rel(TEE_MEASUREMENTS)}: schemaVersion={doc.get('schemaVersion')!r}",
        "Use schemaVersion 1 to match packages/os/release/schema/tee-measurements.example.json.",
    )
    measurements = doc.get("measurements")
    if not isinstance(measurements, dict):
        blocker(
            findings,
            "tee_measurements_no_measurements",
            "AOSP TEE measurements file has no measurements object",
            rel(TEE_MEASUREMENTS),
            "Add a measurements object keyed by boot/os/agent/policy with sha256:<hex> digests.",
        )
        return
    missing = [name for name in REQUIRED_MEASUREMENTS if name not in measurements]
    add_if(
        findings,
        bool(missing),
        "tee_measurements_missing_required",
        "AOSP TEE measurements omit a required boot/os/agent/policy entry",
        f"missing={missing}",
        "Populate all of boot/os/agent/policy in the measurements object.",
    )
    for name, digest in measurements.items():
        add_if(
            findings,
            not isinstance(digest, str) or not SHA256.match(digest),
            "tee_measurements_bad_digest",
            f"AOSP TEE measurement {name} is not sha256:<64 lowercase hex>",
            f"{name}={digest!r}",
            "Use sha256:<64 hex> digests (generate-tee-measurements.mjs emits these).",
        )


def check_evidence_fixture(findings: list[Finding]) -> None:
    if not PVM_EVIDENCE_FIXTURE.is_file():
        blocker(
            findings,
            "pvm_evidence_fixture_missing",
            "no pVM -> TeeEvidence export fixture proves the AOSP path emits the agent's TeeEvidence shape",
            rel(PVM_EVIDENCE_FIXTURE),
            "Add fixtures/tee/pvm-tee-evidence.bringup.json conforming to packages/agent/src/services/tee-evidence.ts.",
        )
        return
    try:
        ev = load_json(PVM_EVIDENCE_FIXTURE)
    except json.JSONDecodeError as exc:
        blocker(
            findings,
            "pvm_evidence_invalid_json",
            "pVM TeeEvidence fixture is not valid JSON",
            f"{rel(PVM_EVIDENCE_FIXTURE)}: {exc}",
            "Fix the JSON syntax in the pVM evidence fixture.",
        )
        return
    kind = ev.get("kind")
    add_if(
        findings,
        not isinstance(kind, str) or kind not in ALLOWED_PVM_KINDS,
        "pvm_evidence_kind_out_of_contract",
        "pVM evidence kind is not one of the contracted pVM/cloud kinds",
        f"kind={kind!r} contract={list(ALLOWED_PVM_KINDS)}",
        "Emit kind pkvm/avf (on-device) or tdx/sev-snp (cloud Android host).",
    )
    # detectSimulatedEvidence parity: a real bring-up shape must not be a
    # simulated kind/provider/vendor, or the production policy rejects it.
    for field in ("kind", "provider", "hardwareVendor"):
        value = ev.get(field)
        add_if(
            findings,
            isinstance(value, str) and is_simulated_token(value),
            "pvm_evidence_simulated_marker",
            f"pVM evidence {field} carries a simulated/mock/debug marker the production policy rejects",
            f"{field}={value!r}",
            "Use a non-simulated kind/provider/hardwareVendor for the bring-up export shape.",
        )
    if not isinstance(ev.get("provider"), str) or not ev.get("provider"):
        blocker(
            findings,
            "pvm_evidence_missing_provider",
            "pVM evidence has no provider (eliza_pvm_mgr identity)",
            rel(PVM_EVIDENCE_FIXTURE),
            "Set provider to the eliza_pvm_mgr export identity.",
        )
    if not isinstance(ev.get("securityVersion"), int):
        blocker(
            findings,
            "pvm_evidence_missing_security_version",
            "pVM evidence securityVersion is not an integer",
            rel(PVM_EVIDENCE_FIXTURE),
            "Set an integer securityVersion (anti-rollback floor).",
        )
    measurements = ev.get("measurements")
    if not isinstance(measurements, dict):
        blocker(
            findings,
            "pvm_evidence_no_measurements",
            "pVM evidence has no measurements object",
            rel(PVM_EVIDENCE_FIXTURE),
            "Add boot/os/agent/policy measurements as sha256:<hex>.",
        )
    else:
        missing = [n for n in REQUIRED_MEASUREMENTS if n not in measurements]
        add_if(
            findings,
            bool(missing),
            "pvm_evidence_missing_required_measurements",
            "pVM evidence omits a required boot/os/agent/policy measurement",
            f"missing={missing}",
            "Populate all of boot/os/agent/policy.",
        )
        for name, digest in measurements.items():
            add_if(
                findings,
                not isinstance(digest, str) or not SHA256.match(digest),
                "pvm_evidence_bad_digest",
                f"pVM evidence measurement {name} is not sha256:<64 lowercase hex>",
                f"{name}={digest!r}",
                "Use sha256:<64 hex> digests.",
            )
    freshness = ev.get("freshness")
    add_if(
        findings,
        not isinstance(freshness, dict)
        or not isinstance(freshness.get("nonce"), str)
        or not freshness.get("nonce")
        or not isinstance(freshness.get("timestamp"), str)
        or not freshness.get("timestamp"),
        "pvm_evidence_missing_freshness",
        "pVM evidence lacks a freshness nonce + timestamp (replay defense)",
        rel(PVM_EVIDENCE_FIXTURE),
        "Add freshness.nonce and freshness.timestamp.",
    )
    # Confidentiality is BLOCKED on the bring-up track: the export shape must
    # NOT assert the confidential-posture claims, or it would over-claim.
    claims = ev.get("claims")
    if isinstance(claims, dict):
        overclaimed = [name for name in BLOCKED_CONFIDENTIALITY_CLAIMS if claims.get(name) is True]
        add_if(
            findings,
            bool(overclaimed),
            "pvm_evidence_overclaims_confidentiality",
            "pVM bring-up evidence asserts confidentiality claims that are BLOCKED on this track",
            f"overclaimed={overclaimed}",
            "Remove memoryEncrypted/ioProtected/npuProtected from the bring-up export shape until confidentiality is unblocked.",
        )


def run_check(_args: argparse.Namespace | None = None) -> dict[str, Any]:
    findings: list[Finding] = []
    check_sepolicy(findings)
    check_policy_placement(findings)
    check_policy_json(findings)
    check_measurements_json(findings)
    check_evidence_fixture(findings)

    blockers = [f for f in findings if f.severity == "blocker"]
    return {
        "schema": SCHEMA,
        "status": "pass" if not blockers else "blocked",
        "claim_boundary": CLAIM_BOUNDARY,
        "confidentiality_claim": "BLOCKED",
        "confidentiality_reason": (
            "riscv64 has no CoVE-capable KVM/crosvm path and the 16 KB-page "
            "IOPMP/measurement validation is not done; this gate validates the "
            "AOSP TEE management/export contract and bring-up readiness, not a "
            "confidential boot or attestation."
        ),
        "summary": {"blockers": len(blockers), "findings": len(findings)},
        "findings": [asdict(f) for f in findings],
    }


def write_report(report: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def print_summary(report: dict[str, Any]) -> None:
    print(f"STATUS: {str(report['status']).upper()} aosp.tee_contract")
    print(f"CONFIDENTIALITY: {report['confidentiality_claim']} (contract/bring-up gate only)")
    for finding in report["findings"]:
        print(f"- {finding['code']}: {finding['message']}")
        print(f"  evidence: {finding['evidence']}")


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", default=str(REPORT))
    parser.add_argument("--json-only", action="store_true")
    return parser.parse_args(list(argv))


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    report = run_check(args)
    write_report(report, Path(args.report))
    if not args.json_only:
        print_summary(report)
    return 0 if report["status"] == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main())
