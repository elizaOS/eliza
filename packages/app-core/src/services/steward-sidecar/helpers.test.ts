/**
 * Tests sidecar helper contracts that feed the local Steward control-plane
 * bootstrap and tenant-token handshake.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  fingerprintRandomToken,
  generateApiKey,
  generateMasterPassword,
} from "./helpers";

describe("steward sidecar helpers", () => {
  it("fingerprints generated token strings with stable SHA-256 output", () => {
    const token = "stw_generated-token";
    expect(fingerprintRandomToken("stw_generated-token")).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
  });

  it("generates high-entropy hex secrets for bearer credentials", () => {
    const apiKey = generateApiKey();
    const masterPassword = generateMasterPassword();

    expect(apiKey).toMatch(/^stw_[a-f0-9]{64}$/);
    expect(masterPassword).toMatch(/^[a-f0-9]{64}$/);
    expect(apiKey.slice(4)).not.toBe(masterPassword);
  });
});
