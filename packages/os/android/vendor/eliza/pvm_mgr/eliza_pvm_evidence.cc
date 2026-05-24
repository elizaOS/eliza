// SPDX-License-Identifier: Apache-2.0
//
// Bring-up TeeEvidence assembly implementation. Pure C++; no Android, binder,
// vsock, or third-party JSON dependency so it host-compiles and host-tests.
// See eliza_pvm_evidence.h for the contract.

#include "eliza_pvm_evidence.h"

#include <cctype>
#include <sstream>

namespace eliza {
namespace pvm_mgr {

namespace {

constexpr int kSecurityVersionFloor = 1;

bool IsLowerHex(char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
}

// Emit a JSON string literal with the minimal escaping the evidence fields
// need (quote, backslash, control chars). The evidence fields are all
// machine-generated ASCII, so this is sufficient and keeps the producer
// dependency-free.
std::string JsonString(const std::string& value) {
  std::string out = "\"";
  for (char c : value) {
    switch (c) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        out += c;
    }
  }
  out += "\"";
  return out;
}

// Extract the string value of "<key>": "<value>" nested inside the
// "measurements" object of a tee-measurements.json document. Returns false when
// the key is absent. This is a deliberately narrow scanner for the known,
// machine-generated schema (generate-tee-measurements.mjs), not a general JSON
// parser; it fails closed by returning false on anything it does not recognize.
bool ExtractMeasurement(const std::string& measurements_block,
                        const std::string& key, std::string* out) {
  const std::string needle = "\"" + key + "\"";
  size_t pos = measurements_block.find(needle);
  if (pos == std::string::npos) {
    return false;
  }
  pos = measurements_block.find(':', pos + needle.size());
  if (pos == std::string::npos) {
    return false;
  }
  pos = measurements_block.find('"', pos);
  if (pos == std::string::npos) {
    return false;
  }
  size_t end = measurements_block.find('"', pos + 1);
  if (end == std::string::npos) {
    return false;
  }
  *out = measurements_block.substr(pos + 1, end - pos - 1);
  return true;
}

}  // namespace

bool IsSha256Digest(const std::string& value) {
  const std::string prefix = "sha256:";
  if (value.size() != prefix.size() + 64) {
    return false;
  }
  if (value.compare(0, prefix.size(), prefix) != 0) {
    return false;
  }
  for (size_t i = prefix.size(); i < value.size(); ++i) {
    if (!IsLowerHex(value[i])) {
      return false;
    }
  }
  return true;
}

std::optional<BringupEvidence> AssembleBringupEvidence(
    const EvidenceInputs& inputs, std::string* error) {
  auto fail = [&](const std::string& message) -> std::optional<BringupEvidence> {
    if (error != nullptr) {
      *error = message;
    }
    return std::nullopt;
  };

  if (inputs.security_version < kSecurityVersionFloor) {
    return fail("securityVersion below anti-rollback floor (1)");
  }
  if (inputs.freshness_nonce.empty()) {
    return fail("freshness nonce is empty (replay defense required)");
  }
  if (inputs.freshness_timestamp.empty()) {
    return fail("freshness timestamp is empty");
  }

  const std::array<std::pair<const char*, const std::string*>, 4> required = {{
      {"boot", &inputs.measurements.boot},
      {"os", &inputs.measurements.os},
      {"agent", &inputs.measurements.agent},
      {"policy", &inputs.measurements.policy},
  }};
  for (const auto& [name, digest] : required) {
    if (digest->empty()) {
      return fail(std::string("required measurement ") + name + " is empty");
    }
    if (!IsSha256Digest(*digest)) {
      return fail(std::string("measurement ") + name +
                  " is not sha256:<64 lowercase hex>");
    }
  }

  BringupEvidence evidence;
  evidence.security_version = inputs.security_version;
  evidence.measurements = inputs.measurements;
  evidence.freshness_nonce = inputs.freshness_nonce;
  evidence.freshness_timestamp = inputs.freshness_timestamp;
  return evidence;
}

std::string SerializeEvidence(const BringupEvidence& evidence) {
  std::ostringstream out;
  out << "{\n";
  out << "  \"_comment\": "
      << JsonString(
             "pVM -> normalized TeeEvidence export emitted by eliza_pvm_mgr on "
             "the AOSP bring-up track. Confidentiality claims are intentionally "
             "ABSENT (BLOCKED on riscv64). The measured-launch quote is "
             "unavailable; see quoteUnavailable.")
      << ",\n";
  out << "  \"kind\": " << JsonString(evidence.kind) << ",\n";
  out << "  \"provider\": " << JsonString(evidence.provider) << ",\n";
  out << "  \"hardwareVendor\": " << JsonString(evidence.hardware_vendor)
      << ",\n";
  out << "  \"platformVersion\": " << JsonString(evidence.platform_version)
      << ",\n";
  out << "  \"securityVersion\": " << evidence.security_version << ",\n";
  out << "  \"measurements\": {\n";
  out << "    \"boot\": " << JsonString(evidence.measurements.boot) << ",\n";
  out << "    \"os\": " << JsonString(evidence.measurements.os) << ",\n";
  out << "    \"agent\": " << JsonString(evidence.measurements.agent) << ",\n";
  out << "    \"policy\": " << JsonString(evidence.measurements.policy) << "\n";
  out << "  },\n";
  out << "  \"freshness\": {\n";
  out << "    \"nonce\": " << JsonString(evidence.freshness_nonce) << ",\n";
  out << "    \"timestamp\": " << JsonString(evidence.freshness_timestamp)
      << ",\n";
  out << "    \"verifier\": " << JsonString(evidence.freshness_verifier)
      << "\n";
  out << "  },\n";
  out << "  \"claims\": {\n";
  out << "    \"debugDisabled\": "
      << (evidence.claim_debug_disabled ? "true" : "false") << ",\n";
  out << "    \"secureBoot\": "
      << (evidence.claim_secure_boot ? "true" : "false") << "\n";
  out << "  },\n";
  // The quote is BLOCKED: emit a reason, never a fabricated quote field.
  out << "  \"quoteUnavailable\": "
      << JsonString(evidence.quote_unavailable_reason) << "\n";
  out << "}\n";
  return out.str();
}

std::optional<GoldenMeasurements> ParseGoldenMeasurements(
    const std::string& measurements_json, std::string* error) {
  auto fail = [&](const std::string& message)
      -> std::optional<GoldenMeasurements> {
    if (error != nullptr) {
      *error = message;
    }
    return std::nullopt;
  };

  const std::string key = "\"measurements\"";
  size_t block_start = measurements_json.find(key);
  if (block_start == std::string::npos) {
    return fail("no \"measurements\" object in tee-measurements.json");
  }
  size_t open = measurements_json.find('{', block_start);
  if (open == std::string::npos) {
    return fail("malformed \"measurements\" object");
  }
  size_t close = measurements_json.find('}', open);
  if (close == std::string::npos) {
    return fail("unterminated \"measurements\" object");
  }
  const std::string block =
      measurements_json.substr(open, close - open + 1);

  GoldenMeasurements golden;
  const std::array<std::pair<const char*, std::string*>, 4> fields = {{
      {"boot", &golden.boot},
      {"os", &golden.os},
      {"agent", &golden.agent},
      {"policy", &golden.policy},
  }};
  for (const auto& [name, slot] : fields) {
    if (!ExtractMeasurement(block, name, slot)) {
      return fail(std::string("missing required measurement: ") + name);
    }
    if (!IsSha256Digest(*slot)) {
      return fail(std::string("measurement ") + name +
                  " is not sha256:<64 lowercase hex>");
    }
  }
  return golden;
}

}  // namespace pvm_mgr
}  // namespace eliza
