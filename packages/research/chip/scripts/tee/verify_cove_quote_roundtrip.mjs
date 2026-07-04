#!/usr/bin/env bun
/**
 * Cross-language round-trip proof for the E1 CoVE attestation-quote firmware.
 *
 * Builds the host KAT (fw/dice/test_cove_quote), captures the canonical
 * CoVE-quote JSON it emits, and feeds it to the AGENT verifier
 * (packages/agent/src/services/cove-quote.ts, `verifyCoveQuote`) with
 * trustedRotPublicKey set to the DeviceID public key the firmware emitted.
 *
 * This is the byte-exactness proof: verifyCoveQuote only returns verified:true
 * when the firmware's canonical-JSON serialization and real Ed25519 signatures
 * match what the verifier independently canonicalizes and checks. It also flips
 * one measurement byte and asserts the tamper is rejected (signature no longer
 * covers the mutated body), and confirms the verified body maps into the
 * normalized TeeEvidence shape via coveQuoteToTeeEvidence.
 *
 * Must be run with `bun` so the TS verifier imports directly (no build step).
 * Run `source packages/research/chip/tools/env.sh` first for the native toolchain.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHIP_ROOT = resolve(HERE, "../..");
const REPO_ROOT = resolve(CHIP_ROOT, "../..");
const COVE_BIN = resolve(CHIP_ROOT, "build/dice/test_cove_quote");
const VERIFIER = resolve(
  REPO_ROOT,
  "packages/agent/src/services/cove-quote.ts",
);

function fail(msg) {
  console.error(`FAIL ${msg}`);
  process.exit(1);
}

// 1. Build the host KAT via the dice Makefile.
try {
  execFileSync("make", ["-C", resolve(CHIP_ROOT, "fw/dice"), "cove"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
} catch (err) {
  fail(`could not build host KAT: ${err.message}`);
}
if (!existsSync(COVE_BIN)) {
  fail(`host KAT binary missing after build: ${COVE_BIN}`);
}

// 2. Run the KAT: JSON on stdout, the DeviceID pubkey via the --pubkey mode.
let quoteJson;
let rotPubKey;
try {
  quoteJson = execFileSync(COVE_BIN, [], { encoding: "utf8" }).trim();
  rotPubKey = execFileSync(COVE_BIN, ["--pubkey"], { encoding: "utf8" }).trim();
} catch (err) {
  fail(`host KAT execution failed: ${err.message}`);
}

let quote;
try {
  quote = JSON.parse(quoteJson);
} catch (err) {
  fail(`firmware did not emit valid JSON: ${err.message}`);
}

// 3. Import the agent verifier and verify the real firmware output.
const { verifyCoveQuote, coveQuoteToTeeEvidence } = await import(VERIFIER);

const nowMs = Date.parse(quote.body.timestamp);
const result = verifyCoveQuote(quote, {
  trustedRotPublicKey: rotPubKey,
  nowMs,
  minSecurityVersion: 1,
});

if (!result.verified) {
  console.error("Quote JSON the firmware emitted:");
  console.error(quoteJson);
  fail(
    `verifyCoveQuote rejected real firmware output: ${result.reason} — ${result.detail}`,
  );
}
console.log(
  "PASS verifyCoveQuote accepts real firmware output (verified:true)",
);
console.log(`  trustedRotPublicKey (DeviceID): ${rotPubKey}`);
console.log(`  aliasPublicKey:                 ${result.aliasPublicKey}`);

// 4. The verified body must map into the normalized TeeEvidence shape.
const evidence = coveQuoteToTeeEvidence(result);
if (evidence.kind !== "cove" || evidence.provider !== "eliza-riscv") {
  fail(
    `coveQuoteToTeeEvidence produced an unexpected shape: ${JSON.stringify(evidence)}`,
  );
}
for (const m of ["boot", "monitor", "os", "policy", "device", "agent"]) {
  if (typeof evidence.measurements[m] !== "string") {
    fail(`normalized evidence missing measurement: ${m}`);
  }
}
console.log(
  "PASS coveQuoteToTeeEvidence maps the verified body to TeeEvidence",
);

// 5. Tamper proof: flip one nibble of a measurement; verification must fail.
const tampered = JSON.parse(quoteJson);
const original = tampered.body.measurements.boot;
const hex = original.slice("sha256:".length);
const flippedNibble = hex[0] === "0" ? "1" : "0";
tampered.body.measurements.boot = `sha256:${flippedNibble}${hex.slice(1)}`;
if (tampered.body.measurements.boot === original) {
  fail("tamper mutation was a no-op");
}
const tamperedResult = verifyCoveQuote(tampered, {
  trustedRotPublicKey: rotPubKey,
  nowMs,
  minSecurityVersion: 1,
});
if (tamperedResult.verified) {
  fail("verifyCoveQuote accepted a quote with a flipped measurement byte");
}
console.log(
  `PASS flipped measurement byte is rejected (reason: ${tamperedResult.reason})`,
);

// 6. Wrong anchor proof: a different RoT key must not anchor the chain.
const wrongAnchor = result.aliasPublicKey; // valid key, but not the DeviceID
const wrongResult = verifyCoveQuote(quote, {
  trustedRotPublicKey: wrongAnchor,
  nowMs,
  minSecurityVersion: 1,
});
if (wrongResult.verified) {
  fail("verifyCoveQuote accepted the quote under the wrong trust anchor");
}
console.log(
  `PASS wrong trust anchor is rejected (reason: ${wrongResult.reason})`,
);

console.log(
  "\nCoVE quote round-trip PROVEN: real C firmware -> verifyCoveQuote(verified:true)",
);
console.log(`canonical quote length: ${quoteJson.length} bytes`);
