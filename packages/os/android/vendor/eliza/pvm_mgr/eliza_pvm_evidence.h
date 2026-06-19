// SPDX-License-Identifier: Apache-2.0
//
// Bring-up TeeEvidence assembly for the AOSP protected-VM management service
// (plan §5 "AOSP / pKVM path"; measured-boot contract "AOSP Path").
//
// eliza_pvm_mgr is the single privileged on-device domain (sepolicy gated, see
// vendor/eliza/sepolicy/eliza_pvm_mgr.te) permitted to reach the protected-VM
// (pVM / AVF) management binder + vsock control channel and to export the
// normalized TeeEvidence document the agent consumes
// (packages/agent/src/services/tee-evidence.ts).
//
// CONFIDENTIALITY IS BLOCKED on this track. The real measured-launch QUOTE
// SOURCE (a pKVM/AVF/CoVE attestation quote bound to the launch measurements)
// requires CoVE-capable riscv64 KVM/crosvm (absent) and the 16 KB-page
// IOPMP/measurement validation (not done). This module emits the contracted
// bring-up evidence SHAPE with the quote explicitly marked unavailable and with
// NO confidentiality claims (memoryEncrypted / ioProtected / npuProtected) so
// it cannot over-claim. The shape is what is validated locally by
// packages/chip/scripts/check_aosp_tee_contract.py.
//
// The assembly logic here is pure (no Android/binder/vsock dependencies) so it
// is host-compilable and host-testable; the service binary
// (eliza_pvm_mgr_main.cc) wires it to the on-device golden measurements +
// evidence path.

#ifndef ELIZA_PVM_MGR_EVIDENCE_H_
#define ELIZA_PVM_MGR_EVIDENCE_H_

#include <array>
#include <map>
#include <optional>
#include <string>

namespace eliza {
namespace pvm_mgr {

// The four golden measurements pinned by the AOSP TEE contract
// (REQUIRED_MEASUREMENTS in check_aosp_tee_contract.py and
// requiredTeeMeasurementNames in os-release-lib.mjs). Each value is the
// sha256:<64 hex> golden digest read from the signed
// /product/etc/eliza/tee-measurements.json placed by the OS product layer.
struct GoldenMeasurements {
  std::string boot;
  std::string os;
  std::string agent;
  std::string policy;
};

// Inputs the service collects on-device before assembling evidence.
struct EvidenceInputs {
  GoldenMeasurements measurements;
  // Anti-rollback floor. Integer per the contract (an int securityVersion).
  int security_version = 1;
  // Fresh per-boot replay nonce + RFC3339 timestamp. On the bring-up track the
  // service generates these; a real quote would bind report_data to the nonce.
  std::string freshness_nonce;
  std::string freshness_timestamp;
};

// Assembled bring-up evidence, ready to serialize. Mirrors the agent's
// TeeEvidence shape and the checked-in contract fixture
// (packages/chip/sw/aosp-device/fixtures/tee/pvm-tee-evidence.bringup.json).
struct BringupEvidence {
  // pVM kind. "pkvm" is in the contracted ALLOWED_PVM_KINDS and is NOT a
  // simulated token (mock/sim/fake/debug), so the production policy accepts the
  // shape on this bring-up track.
  std::string kind = "pkvm";
  std::string provider = "eliza-pvm-mgr";
  std::string hardware_vendor = "eliza";
  std::string platform_version = "avf-pkvm-bringup-riscv64";
  int security_version = 1;
  GoldenMeasurements measurements;
  std::string freshness_nonce;
  std::string freshness_timestamp;
  std::string freshness_verifier = "eliza-pvm-mgr-bringup";
  // Only non-confidentiality claims. debugDisabled + secureBoot describe the
  // verified-boot posture (AVB) and are not BLOCKED confidentiality claims.
  bool claim_debug_disabled = true;
  bool claim_secure_boot = true;
  // The measured-launch quote: BLOCKED on hardware. Held as a reason string,
  // never a fabricated quote, so the export cannot masquerade as attested.
  std::string quote_unavailable_reason =
      "BLOCKED: real pKVM/AVF/CoVE measured-launch quote requires "
      "CoVE-capable riscv64 KVM/crosvm and 16KB-page IOPMP/measurement "
      "validation; bring-up track exports the management/export contract shape "
      "only.";
};

// sha256:<64 lowercase hex> validator matching the contract's SHA256 regex.
bool IsSha256Digest(const std::string& value);

// Assemble bring-up evidence from collected inputs. Returns nullopt and sets
// *error when an input violates the contract (a measurement is not a sha256
// digest, a required measurement is empty, the nonce/timestamp is empty, or the
// security version is below the anti-rollback floor of 1) — fail closed: the
// service must not emit an out-of-contract document.
std::optional<BringupEvidence> AssembleBringupEvidence(
    const EvidenceInputs& inputs, std::string* error);

// Serialize assembled evidence to the JSON the agent + contract checker accept.
// Confidentiality claims are intentionally omitted; the quote is emitted as
// "quoteUnavailable" with the BLOCKED reason, never as a fake "quote".
std::string SerializeEvidence(const BringupEvidence& evidence);

// Parse the golden measurements out of the signed
// /product/etc/eliza/tee-measurements.json contents (the
// generate-tee-measurements.mjs schema: a top-level "measurements" object).
// Returns nullopt and sets *error on malformed JSON or a missing/!sha256
// required digest — fail closed.
std::optional<GoldenMeasurements> ParseGoldenMeasurements(
    const std::string& measurements_json, std::string* error);

}  // namespace pvm_mgr
}  // namespace eliza

#endif  // ELIZA_PVM_MGR_EVIDENCE_H_
