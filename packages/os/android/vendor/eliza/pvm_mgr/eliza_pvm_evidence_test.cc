// SPDX-License-Identifier: Apache-2.0
//
// Host unit tests for the eliza_pvm_mgr bring-up TeeEvidence assembly. These
// validate the same shape that upstreams/research/chip/scripts/check_aosp_tee_contract.py
// validates, with no Android/hardware dependency:
//   - golden measurements parse out of the tee-measurements.json schema,
//   - assembled evidence carries the contracted (non-simulated) kind/provider,
//     integer securityVersion, sha256 measurements, freshness, and exactly the
//     non-confidentiality claims (debugDisabled/secureBoot),
//   - the serialized JSON marks the quote unavailable and emits NO
//     confidentiality claims (memoryEncrypted/ioProtected/npuProtected),
//   - assembly fails closed on a non-sha256 measurement, an empty nonce, and a
//     below-floor securityVersion.
//
// Build (Soong): cc_test "eliza_pvm_mgr_evidence_test", host_supported.
//   atest eliza_pvm_mgr_evidence_test   (or m eliza_pvm_mgr_evidence_test)

#include "eliza_pvm_evidence.h"

#include <gtest/gtest.h>

#include <string>

namespace eliza {
namespace pvm_mgr {
namespace {

const char kGoldenJson[] = R"({
  "schemaVersion": 1,
  "generatedBy": "packages/os/scripts/generate-tee-measurements.mjs",
  "confidentialityBlocked": true,
  "measurements": {
    "boot": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    "os": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    "agent": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    "policy": "sha256:4444444444444444444444444444444444444444444444444444444444444444"
  }
})";

EvidenceInputs ValidInputs() {
  EvidenceInputs inputs;
  inputs.measurements.boot =
      "sha256:1111111111111111111111111111111111111111111111111111111111111111";
  inputs.measurements.os =
      "sha256:2222222222222222222222222222222222222222222222222222222222222222";
  inputs.measurements.agent =
      "sha256:3333333333333333333333333333333333333333333333333333333333333333";
  inputs.measurements.policy =
      "sha256:4444444444444444444444444444444444444444444444444444444444444444";
  inputs.security_version = 1;
  inputs.freshness_nonce = "bringup-deadbeefdeadbeef";
  inputs.freshness_timestamp = "2026-05-22T00:00:00Z";
  return inputs;
}

TEST(IsSha256Digest, AcceptsLowercaseHex) {
  EXPECT_TRUE(IsSha256Digest(
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"));
}

TEST(IsSha256Digest, RejectsUppercaseShortAndUnprefixed) {
  EXPECT_FALSE(IsSha256Digest(
      "sha256:ABCDEF0000000000000000000000000000000000000000000000000000000000"));
  EXPECT_FALSE(IsSha256Digest("sha256:dead"));
  EXPECT_FALSE(IsSha256Digest(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"));
}

TEST(ParseGoldenMeasurements, ExtractsAllFourFromSchema) {
  std::string error;
  auto golden = ParseGoldenMeasurements(kGoldenJson, &error);
  ASSERT_TRUE(golden.has_value()) << error;
  EXPECT_EQ(golden->boot,
            "sha256:1111111111111111111111111111111111111111111111111111111111111111");
  EXPECT_EQ(golden->os,
            "sha256:2222222222222222222222222222222222222222222222222222222222222222");
  EXPECT_EQ(golden->agent,
            "sha256:3333333333333333333333333333333333333333333333333333333333333333");
  EXPECT_EQ(golden->policy,
            "sha256:4444444444444444444444444444444444444444444444444444444444444444");
}

TEST(ParseGoldenMeasurements, FailsClosedOnMissingMeasurement) {
  std::string error;
  auto golden = ParseGoldenMeasurements(R"({"measurements":{"boot":"sha256:1111111111111111111111111111111111111111111111111111111111111111"}})",
                                        &error);
  EXPECT_FALSE(golden.has_value());
  EXPECT_NE(error.find("os"), std::string::npos);
}

TEST(AssembleBringupEvidence, ProducesContractedShape) {
  std::string error;
  auto evidence = AssembleBringupEvidence(ValidInputs(), &error);
  ASSERT_TRUE(evidence.has_value()) << error;
  // Contracted, non-simulated kind/provider.
  EXPECT_EQ(evidence->kind, "pkvm");
  EXPECT_EQ(evidence->provider, "eliza-pvm-mgr");
  EXPECT_EQ(evidence->hardware_vendor, "eliza");
  EXPECT_EQ(evidence->security_version, 1);
  EXPECT_TRUE(IsSha256Digest(evidence->measurements.boot));
  EXPECT_TRUE(IsSha256Digest(evidence->measurements.policy));
  EXPECT_FALSE(evidence->freshness_nonce.empty());
  // Posture claims are present; confidentiality claims are absent by design.
  EXPECT_TRUE(evidence->claim_debug_disabled);
  EXPECT_TRUE(evidence->claim_secure_boot);
}

TEST(SerializeEvidence, EmitsNoConfidentialityClaimsAndMarksQuoteUnavailable) {
  std::string error;
  auto evidence = AssembleBringupEvidence(ValidInputs(), &error);
  ASSERT_TRUE(evidence.has_value()) << error;
  const std::string json = SerializeEvidence(*evidence);

  // Contract: the bring-up shape must NOT assert BLOCKED confidentiality claims.
  EXPECT_EQ(json.find("memoryEncrypted"), std::string::npos);
  EXPECT_EQ(json.find("ioProtected"), std::string::npos);
  EXPECT_EQ(json.find("npuProtected"), std::string::npos);
  // The quote is unavailable, not fabricated: there must be no "quote" field,
  // and the unavailability must be stated.
  EXPECT_EQ(json.find("\"quote\":"), std::string::npos);
  EXPECT_NE(json.find("quoteUnavailable"), std::string::npos);
  EXPECT_NE(json.find("BLOCKED"), std::string::npos);
  // The agent-consumed fields are present.
  EXPECT_NE(json.find("\"kind\": \"pkvm\""), std::string::npos);
  EXPECT_NE(json.find("\"securityVersion\": 1"), std::string::npos);
}

TEST(AssembleBringupEvidence, FailsClosedOnNonSha256Measurement) {
  EvidenceInputs inputs = ValidInputs();
  inputs.measurements.os = "not-a-digest";
  std::string error;
  auto evidence = AssembleBringupEvidence(inputs, &error);
  EXPECT_FALSE(evidence.has_value());
  EXPECT_NE(error.find("os"), std::string::npos);
}

TEST(AssembleBringupEvidence, FailsClosedOnEmptyNonce) {
  EvidenceInputs inputs = ValidInputs();
  inputs.freshness_nonce.clear();
  std::string error;
  auto evidence = AssembleBringupEvidence(inputs, &error);
  EXPECT_FALSE(evidence.has_value());
  EXPECT_NE(error.find("nonce"), std::string::npos);
}

TEST(AssembleBringupEvidence, FailsClosedBelowSecurityVersionFloor) {
  EvidenceInputs inputs = ValidInputs();
  inputs.security_version = 0;
  std::string error;
  auto evidence = AssembleBringupEvidence(inputs, &error);
  EXPECT_FALSE(evidence.has_value());
  EXPECT_NE(error.find("anti-rollback"), std::string::npos);
}

}  // namespace
}  // namespace pvm_mgr
}  // namespace eliza
