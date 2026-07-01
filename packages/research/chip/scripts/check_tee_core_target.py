#!/usr/bin/env python3
"""Validate the CoVE/AP-TEE core target spec (lane-01 W1/C1).

Asserts REAL invariants of docs/spec-db/tee-core-target.yaml, fail-closed:

  1. The trust model is the CoVE confidential-VM shape with the TSM/RoT/TVM/MTT
     TCB and the host hypervisor + OpenSBI explicitly untrusted; the two rejected
     shapes (ePMP enclave, multi-tenant hypervisor) carry a reason.
  2. ISA extensions match the architecture decision: H (two-stage MMU) and Smmtt
     (whole-OS MTT) are required; Smepmp is the Dorami TSM wall ONLY (not the
     whole-OS primitive); BARE IOMMU is forbidden for any private domain. Every
     required extension is BLOCKED with a named dependency (no extension is
     claimed present — the audit found none wired).
  3. TSM budget <= 10k LoC, M-mode, isolated from OpenSBI by Smepmp rule-locking.
  4. No SMT (single-tenant side-channel policy).
  5. The 6 contract page states are present and there is NO private->free edge.
  6. Memory protection forbids AES-XTS and selects counter-mode + counter
     integrity tree with an on-die-SRAM root (the TEE.fail lesson).
  7. forbidden_claims_until_evidence enumerates the confidential-VM, memory-
     encryption, measured-launch, and signed-quote claims, each with required
     evidence — so no product claim leaks before its transcript exists.
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from chip_utils import load_yaml_object  # noqa: E402

TARGET = ROOT / "docs/spec-db/tee-core-target.yaml"
OUT = ROOT / "build/reports/tee_core_target.json"

REQUIRED_PAGE_STATES = {
    "free",
    "private",
    "shared",
    "measured",
    "device_assigned",
    "scrub_pending",
}
REQUIRED_TCB = {"m_mode_tsm", "rot_dice", "measured_tvm", "mtt"}
REQUIRED_UNTRUSTED = {"host_hypervisor_salus", "opensbi_below_tsm"}
REQUIRED_FORBIDDEN_CLAIMS = {
    "confidential_vm_isolation",
    "memory_encryption",
    "measured_launch",
    "attestation_quote_signed",
}
FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "confidential_vm_isolation_claim_allowed": False,
    "memory_encryption_claim_allowed": False,
    "measured_launch_claim_allowed": False,
    "signed_quote_claim_allowed": False,
    "silicon_claim_allowed": False,
}


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def validate(spec: dict[str, Any]) -> list[str]:
    errors: list[str] = []

    if spec.get("schema") != "eliza.tee_core_target.v1":
        errors.append("schema must be eliza.tee_core_target.v1")
    if spec.get("target_class") != "single_tenant_whole_os_confidential_vm":
        errors.append("target_class must be single_tenant_whole_os_confidential_vm")
    boundary = str(spec.get("claim_boundary", ""))
    for token in ("planning spec", "BLOCKED", "not a bug"):
        if token not in boundary:
            errors.append(f"claim_boundary must state '{token}'")

    trust = spec.get("trust_model", {})
    if trust.get("shape") != "cove_ap_tee_confidential_vm":
        errors.append("trust_model.shape must be cove_ap_tee_confidential_vm")
    tcb = set(trust.get("tcb", []))
    missing_tcb = sorted(REQUIRED_TCB.difference(tcb))
    if missing_tcb:
        errors.append(f"trust_model.tcb missing: {', '.join(missing_tcb)}")
    untrusted = set(trust.get("untrusted", []))
    missing_unt = sorted(REQUIRED_UNTRUSTED.difference(untrusted))
    if missing_unt:
        errors.append(f"trust_model.untrusted missing: {', '.join(missing_unt)}")
    rejected = trust.get("rejected_shapes", [])
    rejected_ids = {r.get("id") for r in rejected if isinstance(r, dict)}
    for needed in ("m_mode_monitor_epmp_enclave", "multi_tenant_confidential_hypervisor"):
        if needed not in rejected_ids:
            errors.append(f"trust_model must reject shape {needed} with a reason")
    for r in rejected:
        if isinstance(r, dict) and not str(r.get("reason", "")).strip():
            errors.append(f"rejected shape {r.get('id')} must carry a reason")

    isa = spec.get("isa_extensions", {})
    required_exts = {e.get("id"): e for e in isa.get("required", []) if isinstance(e, dict)}
    for ext in ("H", "Smmtt", "Smepmp"):
        if ext not in required_exts:
            errors.append(f"isa_extensions.required must include {ext}")
        elif (
            required_exts[ext].get("status") != "blocked"
            or not str(required_exts[ext].get("blocked_on", "")).strip()
        ):
            errors.append(f"isa extension {ext} must be status blocked with a named blocked_on")
    smepmp = required_exts.get("Smepmp", {})
    if "dorami" not in str(smepmp.get("role", "")) or "tsm_wall" not in str(smepmp.get("role", "")):
        errors.append("Smepmp role must be the Dorami TSM wall (not the whole-OS primitive)")
    if "whole_os" not in str(required_exts.get("Smmtt", {}).get("role", "")):
        errors.append("Smmtt must be the whole-OS confidentiality primitive")
    forbidden_exts = {e.get("id") for e in isa.get("forbidden", []) if isinstance(e, dict)}
    if "bare_iommu_for_private_domain" not in forbidden_exts:
        errors.append("isa_extensions.forbidden must forbid BARE IOMMU for a private domain")

    tsm = spec.get("tsm_budget", {})
    if not isinstance(tsm.get("max_loc"), int) or tsm["max_loc"] > 10000:
        errors.append("tsm_budget.max_loc must be an integer <= 10000")
    if tsm.get("privilege") != "m_mode":
        errors.append("tsm_budget.privilege must be m_mode")
    if "smepmp" not in str(tsm.get("isolated_from_opensbi_by", "")):
        errors.append("tsm_budget must be isolated_from_opensbi_by smepmp rule-locking")

    smt = spec.get("smt_policy", {})
    if smt.get("smt_enabled") is not False:
        errors.append("smt_policy.smt_enabled must be false")

    page_states = set(spec.get("page_states", []))
    missing_states = sorted(REQUIRED_PAGE_STATES.difference(page_states))
    if missing_states:
        errors.append(f"page_states missing: {', '.join(missing_states)}")
    no_edge = spec.get("no_direct_edge", [])
    if not any(
        isinstance(e, dict) and e.get("from") == "private" and e.get("to") == "free"
        for e in no_edge
    ):
        errors.append("no_direct_edge must forbid the private->free edge")

    mem = spec.get("memory_protection", {})
    if mem.get("cipher") != "aes_ctr_per_line_counter":
        errors.append("memory_protection.cipher must be aes_ctr_per_line_counter")
    if mem.get("forbidden_cipher") != "aes_xts":
        errors.append("memory_protection.forbidden_cipher must be aes_xts (TEE.fail)")
    if "counter_integrity_tree" not in str(mem.get("integrity", "")):
        errors.append("memory_protection.integrity must be a counter integrity tree")
    if mem.get("tree_root_location") != "on_die_sram":
        errors.append("memory_protection.tree_root_location must be on_die_sram")
    if mem.get("status") != "blocked":
        errors.append("memory_protection.status must be blocked (LPDDR PHY dependency)")

    claims = spec.get("forbidden_claims_until_evidence", [])
    claim_ids = {c.get("claim") for c in claims if isinstance(c, dict)}
    missing_claims = sorted(REQUIRED_FORBIDDEN_CLAIMS.difference(claim_ids))
    if missing_claims:
        errors.append(f"forbidden_claims_until_evidence missing: {', '.join(missing_claims)}")
    for claim in claims:
        if not isinstance(claim, dict):
            continue
        ev = claim.get("required_evidence")
        if not isinstance(ev, list) or not ev:
            errors.append(f"forbidden claim {claim.get('claim')} must list required_evidence")

    return errors


def main() -> int:
    spec = load_yaml_object(TARGET)
    errors = validate(spec)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "schema": "eliza.tee_core_target_check.v1",
                "status": "tee_core_target_release_blocked",
                "generated_utc": utc_now(),
                "claim_boundary": (
                    "CoVE/AP-TEE core target spec contract only; not confidential-VM "
                    "isolation, not memory encryption, not measured launch, not a "
                    "signed quote, not silicon."
                ),
                "target": TARGET.relative_to(ROOT).as_posix(),
                "errors": errors,
                "false_claim_flags": FALSE_CLAIM_FLAGS,
                "findings": [
                    {
                        "code": "tee_core_target_release_blocked",
                        "message": (
                            "TEE core target spec is structurally valid but does not prove "
                            "confidential-VM isolation, memory encryption, measured launch, signed quote, or silicon evidence."
                        ),
                        "next_step": "bind the target spec to real TEE implementation and attestation evidence",
                        "severity": "blocker",
                    }
                ],
                "summary": {
                    "release_claim_allowed": False,
                    "false_claim_flags": FALSE_CLAIM_FLAGS,
                },
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )

    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print(f"PASS: TEE core target spec valid + release-blocked: {TARGET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
