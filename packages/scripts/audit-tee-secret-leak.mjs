#!/usr/bin/env node

/**
 * audit-tee-secret-leak — repo-wide CI gate that fails when an off-device
 * crash / telemetry / env-dump serializer, or a TEE confidential module, would
 * emit a TEE secret to a sink that leaves the confidential process boundary.
 *
 * This promotes the in-lane checks in
 * `packages/agent/src/services/tee-secret-hygiene.test.ts` (plan §4.4 / A9) into
 * a standalone repo-wide gate that runs outside the agent's vitest lane, so a
 * later edit anywhere in the scanned set fails CI immediately — even in a config
 * where the agent test suite is not run.
 *
 * Two scans, mirroring the in-lane test:
 *
 *   1. CONFIDENTIAL MODULES — the modules that hold cleartext secret *material*
 *      (decrypted weights, raw key material, KDF master secret, derived wrap key,
 *      ECDH shared secret). They must never pass that material to an off-domain
 *      SINK (console / logger / JSON.stringify / process.stdout|stderr.write).
 *      Matches secret *material* identifiers, not scope labels: logging the id
 *      string "model-key" is fine; logging `keyMaterialHex` or the `weights`
 *      buffer is not.
 *
 *   2. OFF-DEVICE SERIALIZERS — the crash/bug/telemetry/redaction serializers
 *      that ship startup context, logs, and error detail OFF the device (to
 *      GitHub / remote intake) or persist them to disk. None of them may
 *      reference a TEE secret-*scope* identifier as code (field access / payload
 *      key). String/comment mentions are stripped before matching, so a label
 *      like the message "model-key blocked" does not trip the gate.
 *
 * Commandment 9 + the TEE contract: decrypted weights/keys stay in process
 * memory and never leak to logs, env dumps, or crash reports.
 *
 *   node packages/scripts/audit-tee-secret-leak.mjs            # gate
 *   node packages/scripts/audit-tee-secret-leak.mjs --json     # machine output
 *   node packages/scripts/audit-tee-secret-leak.mjs --self-test
 */

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const selfTest = args.has("--self-test");

const SERVICES_DIR = path.join("packages", "agent", "src", "services");

// Modules that hold cleartext secret material inside the confidential domain.
const CONFIDENTIAL_MODULES = [
  path.join(SERVICES_DIR, "tee-confidential-inference.ts"),
  path.join(SERVICES_DIR, "tee-key-release.ts"),
  path.join(SERVICES_DIR, "tee-sealed-volume.ts"),
];

// Off-device crash/telemetry/env-dump/redaction serializers. These ship or
// persist context OFF the confidential boundary.
const OFF_DEVICE_SERIALIZERS = [
  path.join("packages", "agent", "src", "api", "bug-report-routes.ts"),
  path.join(
    "packages",
    "agent",
    "src",
    "runtime",
    "tool-call-cache",
    "redact.ts",
  ),
];

// Off-domain sinks: anything that serializes or emits a value outside the
// confidential process boundary.
const SINK =
  /\b(?:console\.\w+|logger\.\w+|JSON\.stringify|process\.stdout\.write|process\.stderr\.write)\s*\(/;

// Names that hold cleartext secret material inside the domain.
const SECRET_MATERIAL =
  /\b(?:keyMaterial|keyMaterialHex|masterSecret|wrapKey|sharedSecret|decryptedWeights|plaintextWeights)\b|\bweights\b/;

// TEE secret-scope identifiers (key ids / scope labels / sealed handles).
const SECRET_SCOPE =
  /\b(?:model-key|modelKey|state-volume|stateVolume|keyMaterial|keyMaterialHex|masterSecret|privateKey|sealedWeights|wrapKey|sharedSecret)\b|\bweights\b/;

/** Drop a `// ...` line comment. */
function stripLineComment(line) {
  return line.replace(/\/\/.*$/, "");
}

/** Drop line comments, then string/template literals (keep only code). */
function stripCommentsAndStrings(line) {
  return stripLineComment(line)
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

/**
 * Scan a confidential-module source for a SINK that also references secret
 * MATERIAL on the same line. Line comments are ignored; string literals are
 * NOT stripped here because emitting a secret via a template string IS a leak.
 * @returns {{line:number, text:string}[]}
 */
function scanConfidentialModule(source) {
  const offenders = [];
  source.split("\n").forEach((line, index) => {
    const code = stripLineComment(line);
    if (SINK.test(code) && SECRET_MATERIAL.test(code)) {
      offenders.push({ line: index + 1, text: line.trim() });
    }
  });
  return offenders;
}

/**
 * Scan an off-device serializer source for any TEE secret-scope identifier
 * referenced as code (comments + string/template literals stripped first).
 * @returns {{line:number, text:string}[]}
 */
function scanSerializer(source) {
  const offenders = [];
  source.split("\n").forEach((line, index) => {
    const code = stripCommentsAndStrings(line);
    if (SECRET_SCOPE.test(code)) {
      offenders.push({ line: index + 1, text: line.trim() });
    }
  });
  return offenders;
}

function readSource(relPath) {
  const abs = path.join(repoRoot, relPath);
  if (!fs.existsSync(abs)) {
    return null;
  }
  return fs.readFileSync(abs, "utf8");
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------
function runSelfTest() {
  let failed = 0;
  const check = (label, actual, expected) => {
    if (actual === expected) {
      console.log(`OK ${label}`);
    } else {
      failed++;
      console.error(`FAIL ${label}: expected ${expected}, got ${actual}`);
    }
  };

  // Confidential-module scan: secret material to a sink is a leak.
  check(
    "logger.info(keyMaterialHex) flagged",
    scanConfidentialModule("logger.info({ keyMaterialHex });").length,
    1,
  );
  check(
    "console.log(weights) flagged",
    scanConfidentialModule("console.log(weights);").length,
    1,
  );
  check(
    "JSON.stringify(masterSecret) flagged",
    scanConfidentialModule("const s = JSON.stringify(masterSecret);").length,
    1,
  );
  check(
    "logger.info(model-key id label) NOT flagged",
    scanConfidentialModule('logger.info("releasing model-key");').length,
    0,
  );
  check(
    "comment mentioning weights NOT flagged",
    scanConfidentialModule("// never logger.info(weights) here").length,
    0,
  );
  check(
    "sink without material NOT flagged",
    scanConfidentialModule("logger.info({ keyId, agentId });").length,
    0,
  );

  // Serializer scan: secret scope as code is a leak; as a string/comment it is not.
  check(
    "serializer emits ctx.keyMaterial flagged",
    scanSerializer("body.detail = ctx.keyMaterial;").length,
    1,
  );
  check(
    "serializer emits payload.weights flagged",
    scanSerializer("payload.weights = buf;").length,
    1,
  );
  check(
    "serializer string label NOT flagged",
    scanSerializer('logger.warn("model-key withheld");').length,
    0,
  );
  check(
    "serializer comment NOT flagged",
    scanSerializer("// privateKey must never appear below").length,
    0,
  );

  if (failed) {
    console.error(`\nself-test FAILED (${failed})`);
    process.exit(1);
  }
  console.log("\nself-test PASSED");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  if (selfTest) return runSelfTest();

  /** @type {{file:string, line:number, text:string, scan:string}[]} */
  const offenders = [];
  /** @type {string[]} */
  const missing = [];

  for (const relPath of CONFIDENTIAL_MODULES) {
    const source = readSource(relPath);
    if (source === null) {
      missing.push(relPath);
      continue;
    }
    for (const o of scanConfidentialModule(source)) {
      offenders.push({ file: relPath, ...o, scan: "confidential-material" });
    }
  }

  for (const relPath of OFF_DEVICE_SERIALIZERS) {
    const source = readSource(relPath);
    if (source === null) {
      missing.push(relPath);
      continue;
    }
    for (const o of scanSerializer(source)) {
      offenders.push({ file: relPath, ...o, scan: "serializer-scope" });
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ offenders, missing }, null, 2));
  }

  // A scanned file going missing (rename) is a regression: the gate would
  // silently pass. Fail closed.
  if (missing.length > 0) {
    console.error(
      "audit-tee-secret-leak: scanned file(s) not found (rename without updating the gate, or run from repo root in local mode):",
    );
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(2);
  }

  if (offenders.length > 0) {
    console.error(
      "audit-tee-secret-leak: TEE secret leak(s) detected — a secret must never reach an off-device sink (Commandment 9 / plan §4.4):",
    );
    for (const o of offenders) {
      console.error(`  [${o.scan}] ${o.file}:${o.line}: ${o.text}`);
    }
    process.exit(1);
  }

  console.log(
    `audit-tee-secret-leak: PASS — ${CONFIDENTIAL_MODULES.length} confidential module(s) + ${OFF_DEVICE_SERIALIZERS.length} off-device serializer(s) clean.`,
  );
}

main();
