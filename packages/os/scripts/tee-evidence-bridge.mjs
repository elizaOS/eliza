#!/usr/bin/env node
// OS-side runtime-evidence exposure bridge (plan OS-2, contract "Runtime
// Evidence Bridge"). Transforms a platform quote into the normalized TeeEvidence
// document consumed by packages/agent/src/services/dstack-tee-provider.ts and
// exposes it via ELIZA_TEE_EVIDENCE_PATH / ELIZA_TEE_EVIDENCE_URL.
//
// Real hardware quote collection (tappd get_quote on a TDX host, CoVE evidence
// on E1) is BLOCKED. With --quote-source mock the bridge emits a checked-in mock
// fixture so the agent provider can be exercised locally; it always asserts the
// runtime measurements equal the signed golden tee-measurements.json before
// emitting, so the mock cannot mask a measurement mismatch.
import {
  optionalTeeMeasurementNames,
  parseArgs,
  readJson,
  requiredTeeMeasurementNames,
  writeJson,
} from "./os-release-lib.mjs";

const KNOWN_MEASUREMENT_NAMES = new Set([
  ...requiredTeeMeasurementNames,
  ...optionalTeeMeasurementNames,
]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function normalizeDigest(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : value;
}

// Extract golden digests from either a release manifest (tee.measurements) or a
// standalone tee-measurements.json (measurements).
export function goldenMeasurementsOf(source) {
  const measurements = source?.tee?.measurements ?? source?.measurements;
  if (!measurements || typeof measurements !== "object") {
    throw new Error("golden source has no measurements block");
  }
  return measurements;
}

// Build the normalized TeeEvidence document and assert it binds to the golden
// measurement set. Fails closed (throws) on any required-digest absence, unknown
// measurement name, malformed digest, or runtime-vs-golden mismatch.
export function buildBoundEvidence(evidence, golden) {
  if (!evidence || typeof evidence !== "object") {
    throw new Error("evidence must be an object");
  }
  if (typeof evidence.kind !== "string" || evidence.kind.trim().length === 0) {
    throw new Error("evidence.kind must be a non-empty string");
  }
  const runtime = evidence.measurements;
  if (!runtime || typeof runtime !== "object") {
    throw new Error("evidence.measurements must be an object");
  }

  for (const name of Object.keys(runtime)) {
    if (!KNOWN_MEASUREMENT_NAMES.has(name)) {
      throw new Error(`unknown runtime measurement name: ${name}`);
    }
    if (!DIGEST_PATTERN.test(String(runtime[name]).toLowerCase())) {
      throw new Error(`runtime measurement ${name} is not a sha256 digest`);
    }
  }

  for (const name of requiredTeeMeasurementNames) {
    if (!DIGEST_PATTERN.test(String(runtime[name] ?? "").toLowerCase())) {
      throw new Error(`runtime measurement ${name} is missing or malformed`);
    }
  }

  // Binding check: every golden digest must equal the runtime digest.
  for (const [name, goldenDigest] of Object.entries(golden)) {
    if (normalizeDigest(runtime[name]) !== normalizeDigest(goldenDigest)) {
      throw new Error(
        `measurement-mismatch: runtime ${name} does not equal golden`,
      );
    }
  }

  return {
    kind: evidence.kind,
    provider: evidence.provider ?? evidence.kind,
    ...(evidence.hardwareVendor
      ? { hardwareVendor: evidence.hardwareVendor }
      : {}),
    ...(evidence.platformVersion
      ? { platformVersion: evidence.platformVersion }
      : {}),
    ...(Number.isInteger(evidence.securityVersion)
      ? { securityVersion: evidence.securityVersion }
      : {}),
    measurements: { ...runtime },
    ...(evidence.freshness ? { freshness: evidence.freshness } : {}),
    ...(evidence.claims ? { claims: evidence.claims } : {}),
    ...(evidence.quote ? { quote: evidence.quote } : {}),
    ...(evidence.certificatePem
      ? { certificatePem: evidence.certificatePem }
      : {}),
    ...(evidence.reportData ? { reportData: evidence.reportData } : {}),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const quoteSource =
    typeof args["quote-source"] === "string" ? args["quote-source"] : "mock";

  if (quoteSource !== "mock") {
    // Fail closed: real quote collection needs hardware.
    console.error(
      "error: real quote collection is BLOCKED (gate tdx-cvm-boot-smoke / " +
        "confidential-gpu-attest). Needs a TDX host (and CC-GPU host for " +
        "gpuFirmware). Proving command once a host exists:\n" +
        "  node packages/os/scripts/tee-evidence-bridge.mjs --quote-source tappd " +
        "--socket /var/run/dstack.sock",
    );
    process.exit(2);
  }

  const goldenPath =
    typeof args.golden === "string"
      ? args.golden
      : "packages/os/release/confidential-2026-05-21/manifest.json";
  const evidencePath =
    typeof args.evidence === "string"
      ? args.evidence
      : "packages/os/release/schema/tee-evidence.mock.json";
  const output =
    typeof args.output === "string"
      ? args.output
      : "/run/elizaos/tee/evidence.json";

  const golden = goldenMeasurementsOf(await readJson(goldenPath));
  const evidence = await readJson(evidencePath);
  const bound = buildBoundEvidence(evidence, golden);
  await writeJson(output, bound);
  console.log(`TEE evidence (mock) written and bound to golden: ${output}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
