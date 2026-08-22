/**
 * Verifies the cloud-only desktop API trust seam with canonical shared Cloud
 * origins and adversarial protocol and hostname inputs.
 */
import { describe, expect, it } from "vitest";
import { isTrustedCloudOnlyApiBaseUrl } from "./url-trust-policy";

describe("isTrustedCloudOnlyApiBaseUrl", () => {
  it.each([
    "https://api.eliza.app",
    "https://api-staging.eliza.app",
    "https://eliza.app",
    "https://cloud.eliza.app",
  ])("accepts canonical HTTPS Cloud origin %s", (value) => {
    expect(isTrustedCloudOnlyApiBaseUrl(new URL(value), true)).toBe(true);
  });

  it.each([
    "http://api.eliza.app",
    "https://api.eliza.app.attacker.test",
    "https://attacker.test",
  ])("rejects untrusted Cloud lookalike %s", (value) => {
    expect(isTrustedCloudOnlyApiBaseUrl(new URL(value), true)).toBe(false);
  });

  it("does not widen the normal desktop trust policy", () => {
    expect(
      isTrustedCloudOnlyApiBaseUrl(new URL("https://api.eliza.app"), false),
    ).toBe(false);
  });
});
