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
 * future edit that logs a secret fails CI immediately.
 *
 * It deliberately matches secret *material* identifiers, not scope labels:
 * logging the string "model-key" (the key id) is fine; logging the decrypted
 * `weights` buffer or `keyMaterialHex` is not.
 */

const CONFIDENTIAL_MODULES = [
  "tee-confidential-inference.ts",
  "tee-key-release.ts",
] as const;

// Off-domain sinks: anything that serializes or emits a value outside the
// confidential process boundary.
const SINK = /\b(?:console\.\w+|logger\.\w+|JSON\.stringify|process\.stdout\.write|process\.stderr\.write)\s*\(/;

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
  it.each(CONFIDENTIAL_MODULES)(
    "%s never emits secret material to an off-domain sink",
    (moduleName) => {
      const source = moduleSource(moduleName);
      const offenders: string[] = [];
      source.split("\n").forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, ""); // ignore line comments
        if (SINK.test(code) && SECRET_MATERIAL.test(code)) {
          offenders.push(`${moduleName}:${index + 1}: ${line.trim()}`);
        }
      });
      expect(offenders, offenders.join("\n")).toEqual([]);
    },
  );

  it("the scanned modules still exist (guards against silent skips on rename)", () => {
    for (const moduleName of CONFIDENTIAL_MODULES) {
      expect(moduleSource(moduleName).length).toBeGreaterThan(0);
    }
  });
});
