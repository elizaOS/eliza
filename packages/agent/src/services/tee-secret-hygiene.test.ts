import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A9 (plan §4.4): a static gate proving the confidential modules never route
 * in-domain secret *material* (decrypted weights, raw key material, the KDF
 * master secret, the derived wrap key, the ECDH shared secret) to an
 * off-domain sink — a logger that ships off-device, `console`, `JSON.stringify`,
 * or a telemetry/crash serializer. Commandment 9 + the TEE contract require
 * that decrypted weights/keys stay in process memory and never leak to logs,
 * env dumps, or crash reports. This runs in the normal `bun test` lane so a
 * later edit that logs a secret fails CI immediately.
 *
 * It deliberately matches secret *material* identifiers, not scope labels:
 * logging the string "model-key" (the key id) is fine; logging the decrypted
 * `weights` buffer or `keyMaterialHex` is not.
 */

const CONFIDENTIAL_MODULES = [
  "tee-confidential-inference.ts",
  "tee-key-release.ts",
  "tee-sealed-volume.ts",
] as const;

// Off-domain sinks: anything that serializes or emits a value outside the
// confidential process boundary.
const SINK =
  /\b(?:console\.\w+|logger\.\w+|JSON\.stringify|process\.stdout\.write|process\.stderr\.write)\s*\(/;

// Names that hold cleartext secret material inside the domain.
const SECRET_MATERIAL =
  /\b(?:keyMaterial|keyMaterialHex|masterSecret|wrapKey|sharedSecret|decryptedWeights|plaintextWeights)\b|\bweights\b/;

function moduleSource(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./${name}`, import.meta.url)),
    "utf8",
  );
}

describe("TEE confidential-module secret hygiene (A9)", () => {
  it.each(
    CONFIDENTIAL_MODULES,
  )("%s never emits secret material to an off-domain sink", (moduleName) => {
    const source = moduleSource(moduleName);
    const offenders: string[] = [];
    source.split("\n").forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, ""); // ignore line comments
      if (SINK.test(code) && SECRET_MATERIAL.test(code)) {
        offenders.push(`${moduleName}:${index + 1}: ${line.trim()}`);
      }
    });
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the scanned modules still exist (guards against silent skips on rename)", () => {
    for (const moduleName of CONFIDENTIAL_MODULES) {
      expect(moduleSource(moduleName).length).toBeGreaterThan(0);
    }
  });
});

/**
 * A9 (plan §4.4) part 2: scan the off-device crash/telemetry/env-dump
 * serializers — the modules that ship startup context, logs, and error detail
 * OFF the device (to GitHub / remote bug intake) or persist them to disk — and
 * fail if any of them references a TEE *secret-scope* identifier in its
 * serialized output. The unseal/key-release scopes (`model-key`,
 * `state-volume`, `keyMaterial`, `masterSecret`, `privateKey`, `weights`, …)
 * must never appear as a field these serializers emit. Today none do; this is a
 * regression gate so a later edit that pipes a secret scope into a crash report
 * or telemetry payload fails CI immediately.
 *
 * Like the part-1 scan it matches code, not comments: a doc-comment mentioning
 * "weights" is fine; a serialized `weights` field is not.
 */
const OFF_DEVICE_SERIALIZERS = [
  // Crash/bug serializer: formatIssueBody + submitToRemoteBugIntake ship
  // startup context + logs to GitHub / remote intake.
  "../api/bug-report-routes.ts",
  // Tool-call-cache privacy redactor: walks and persists serialized tool I/O.
  "../runtime/tool-call-cache/redact.ts",
] as const;

// TEE secret-scope identifiers. Word-boundary anchored so substrings inside
// unrelated identifiers (e.g. `keyword`, `weightsTable` would still match
// `weights` here intentionally — these scopes must not leak under any field).
const SECRET_SCOPE =
  /\b(?:model-key|modelKey|state-volume|stateVolume|keyMaterial|keyMaterialHex|masterSecret|privateKey|sealedWeights|wrapKey|sharedSecret)\b|\bweights\b/;

function relativeSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
}

function stripCommentsAndStrings(line: string): string {
  // Drop line comments, then string/template literals so a serializer that
  // merely mentions a scope in a message/label does not trip the gate. We only
  // care about identifiers referenced as code (field access, payload keys).
  return line
    .replace(/\/\/.*$/, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

describe("TEE off-device serializer secret-scope hygiene (A9)", () => {
  it.each(
    OFF_DEVICE_SERIALIZERS,
  )("%s never references a TEE secret scope", (relativePath) => {
    const source = relativeSource(relativePath);
    const offenders: string[] = [];
    source.split("\n").forEach((line, index) => {
      const code = stripCommentsAndStrings(line);
      if (SECRET_SCOPE.test(code)) {
        offenders.push(`${relativePath}:${index + 1}: ${line.trim()}`);
      }
    });
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the scanned serializer modules still exist (guards against silent skips on rename)", () => {
    for (const relativePath of OFF_DEVICE_SERIALIZERS) {
      expect(relativeSource(relativePath).length).toBeGreaterThan(0);
    }
  });
});
