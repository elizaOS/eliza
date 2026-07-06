/**
 * Locks the repo's committed certification trust anchor to its documented
 * fingerprint. The develop→main promotion gate trusts exactly one Ed25519
 * public key — .github/certification/certification-public-key.pem on the
 * base branch — so a silent pem swap must fail the suite, not just review.
 * Key rotation legitimately changes both the pem and the fingerprint
 * recorded in .github/certification/README.md; update this constant in the
 * same PR (that PR is the act of trusting the new key).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fingerprintPublicKey } from "./keys.ts";

const TRUSTED_FINGERPRINT = "3ac9e3e625a9ed2f";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../../..");
const pemPath = resolve(
  repoRoot,
  ".github/certification/certification-public-key.pem",
);

describe("committed certification trust anchor", () => {
  it("exists in the repo (not swallowed by the *.pem gitignore rule)", () => {
    expect(() => readFileSync(pemPath, "utf8")).not.toThrow();
  });

  it(`matches the documented fingerprint ${TRUSTED_FINGERPRINT}`, () => {
    const pem = readFileSync(pemPath, "utf8");
    expect(fingerprintPublicKey(pem)).toBe(TRUSTED_FINGERPRINT);
  });

  it("is an Ed25519 SPKI public key in PEM form", () => {
    const pem = readFileSync(pemPath, "utf8");
    expect(pem.startsWith("-----BEGIN PUBLIC KEY-----")).toBe(true);
    expect(pem.trimEnd().endsWith("-----END PUBLIC KEY-----")).toBe(true);
  });
});
