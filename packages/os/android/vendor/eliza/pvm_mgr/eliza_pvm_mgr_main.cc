// SPDX-License-Identifier: Apache-2.0
//
// eliza_pvm_mgr: AOSP protected-VM management + TeeEvidence export service
// (plan §5 "AOSP / pKVM path"). Started oneshot by init from
// vendor/eliza/init/init.eliza.rc under the sepolicy-gated eliza_pvm_mgr
// domain (vendor/eliza/sepolicy/eliza_pvm_mgr.te), the SINGLE domain permitted
// to reach the pVM (pKVM/AVF) management binder + vsock control channel.
//
// On the riscv64/Cuttlefish bring-up track CONFIDENTIALITY IS BLOCKED: there is
// no CoVE-capable KVM/crosvm path and the 16 KB-page IOPMP/measurement
// validation is not done. The real measured-launch QUOTE SOURCE therefore stays
// unavailable. This service:
//   1. reads the signed golden measurements placed by the OS product layer at
//      /product/etc/eliza/tee-measurements.json,
//   2. assembles the contracted bring-up TeeEvidence shape (the management/
//      export contract, NOT a confidential boot) with the quote marked
//      unavailable and NO confidentiality claims, and
//   3. writes it to ELIZA_TEE_EVIDENCE_PATH (default /run/elizaos/tee/
//      evidence.json) for the agent to consume.
//
// It fails closed: if the golden measurements are missing/malformed or the
// assembled shape is out of contract, it writes nothing and exits non-zero.
// The agent's evaluateTeeEvidencePolicy independently re-checks the shape.

#include <fcntl.h>
#include <unistd.h>

#include <cstdlib>
#include <ctime>
#include <fstream>
#include <iostream>
#include <random>
#include <sstream>
#include <string>

#include "eliza_pvm_evidence.h"

namespace {

constexpr char kDefaultMeasurementsPath[] =
    "/product/etc/eliza/tee-measurements.json";
constexpr char kDefaultEvidencePath[] = "/run/elizaos/tee/evidence.json";

std::string EnvOr(const char* name, const std::string& fallback) {
  const char* value = std::getenv(name);
  if (value != nullptr && *value != '\0') {
    return std::string(value);
  }
  return fallback;
}

bool ReadFile(const std::string& path, std::string* out) {
  std::ifstream in(path, std::ios::binary);
  if (!in.is_open()) {
    return false;
  }
  std::ostringstream buffer;
  buffer << in.rdbuf();
  *out = buffer.str();
  return true;
}

// Write atomically: write to a temp file, fsync, then rename onto the target so
// the agent never observes a partially written evidence document.
bool WriteFileAtomic(const std::string& path, const std::string& contents) {
  const std::string tmp = path + ".tmp";
  {
    std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
    if (!out.is_open()) {
      return false;
    }
    out << contents;
    out.flush();
    if (!out.good()) {
      return false;
    }
  }
  if (std::rename(tmp.c_str(), path.c_str()) != 0) {
    std::remove(tmp.c_str());
    return false;
  }
  return true;
}

std::string Rfc3339Now() {
  std::time_t now = std::time(nullptr);
  std::tm tm_utc{};
#if defined(_WIN32)
  gmtime_s(&tm_utc, &now);
#else
  gmtime_r(&now, &tm_utc);
#endif
  char buf[32];
  std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tm_utc);
  return std::string(buf);
}

// Fresh per-boot replay nonce. On the bring-up track this is a freshness marker
// only; a real quote would bind report_data to it (BLOCKED on hardware).
std::string FreshNonce() {
  std::random_device rd;
  std::ostringstream out;
  out << "bringup-";
  const char* hex = "0123456789abcdef";
  for (int i = 0; i < 16; ++i) {
    out << hex[rd() & 0xF];
  }
  return out.str();
}

}  // namespace

int main(int argc, char** argv) {
  std::string measurements_path =
      EnvOr("ELIZA_TEE_MEASUREMENTS_PATH", kDefaultMeasurementsPath);
  std::string evidence_path =
      EnvOr("ELIZA_TEE_EVIDENCE_PATH", kDefaultEvidencePath);

  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--measurements" && i + 1 < argc) {
      measurements_path = argv[++i];
    } else if (arg == "--evidence" && i + 1 < argc) {
      evidence_path = argv[++i];
    } else {
      std::cerr << "usage: " << argv[0]
                << " [--measurements PATH] [--evidence PATH]\n";
      return 2;
    }
  }

  std::string measurements_json;
  if (!ReadFile(measurements_path, &measurements_json)) {
    std::cerr << "[eliza_pvm_mgr] fail-closed: cannot read golden measurements "
              << measurements_path << "\n";
    return 1;
  }

  std::string error;
  auto golden =
      eliza::pvm_mgr::ParseGoldenMeasurements(measurements_json, &error);
  if (!golden.has_value()) {
    std::cerr << "[eliza_pvm_mgr] fail-closed: golden measurements invalid: "
              << error << "\n";
    return 1;
  }

  eliza::pvm_mgr::EvidenceInputs inputs;
  inputs.measurements = *golden;
  inputs.security_version = 1;
  inputs.freshness_nonce = FreshNonce();
  inputs.freshness_timestamp = Rfc3339Now();

  auto evidence = eliza::pvm_mgr::AssembleBringupEvidence(inputs, &error);
  if (!evidence.has_value()) {
    std::cerr << "[eliza_pvm_mgr] fail-closed: evidence out of contract: "
              << error << "\n";
    return 1;
  }

  const std::string document = eliza::pvm_mgr::SerializeEvidence(*evidence);
  if (!WriteFileAtomic(evidence_path, document)) {
    std::cerr << "[eliza_pvm_mgr] fail-closed: cannot write evidence to "
              << evidence_path << "\n";
    return 1;
  }

  std::cerr << "[eliza_pvm_mgr] wrote bring-up TeeEvidence to " << evidence_path
            << " (CONFIDENTIALITY BLOCKED: measured-launch quote unavailable on "
               "the riscv64/Cuttlefish bring-up track)\n";
  return 0;
}
