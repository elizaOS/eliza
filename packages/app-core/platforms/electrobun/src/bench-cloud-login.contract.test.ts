/**
 * Guards the desktop cloud-login benchmark's posted session identifier.
 * This source contract is deterministic and does not contact the cloud API.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const benchmarkSource = readFileSync(
  new URL("../scripts/bench-cloud-login.mjs", import.meta.url),
  "utf8",
);

describe("cloud-login benchmark session identity", () => {
  it("uses cryptographic UUIDs without a Math.random downgrade", () => {
    expect(benchmarkSource).toContain('import crypto from "node:crypto"');
    expect(benchmarkSource).toContain("crypto.randomUUID()");
    expect(benchmarkSource).not.toContain("Math.random");
  });
});
