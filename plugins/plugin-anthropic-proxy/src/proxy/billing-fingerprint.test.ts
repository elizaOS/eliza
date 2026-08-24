/**
 * Unit tests for billing fingerprint generator: validates hash derivation
 * and billing block string generation.
 */
import { describe, expect, it } from "vitest";
import { buildBillingBlock, computeBillingFingerprint } from "./billing-fingerprint.ts";

describe("billing-fingerprint", () => {
  it("computes 3-character hex billing fingerprint", () => {
    const fp = computeBillingFingerprint("Hello world, this is a test prompt!");
    expect(typeof fp).toBe("string");
    expect(fp.length).toBe(3);
    expect(/^[0-9a-f]{3}$/.test(fp)).toBe(true);
  });

  it("builds billing block containing cc_version and header", () => {
    const rawBody = '{"messages":[{"role":"user","content":"Hello world!"}]}';
    const block = buildBillingBlock(rawBody);
    expect(block).toContain("x-anthropic-billing-header");
    expect(block).toContain("cc_version=");
    expect(block).toContain("cc_entrypoint=cli");
  });
});
