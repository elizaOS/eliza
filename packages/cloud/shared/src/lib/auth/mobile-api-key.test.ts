/** Tests native credential recognition and non-secret ingress identities. */

import { describe, expect, test } from "bun:test";
import { getPresentedMobileApiKeySecret, mobileApiKeyIngressRateLimitKey } from "./mobile-api-key";

const MOBILE_A = `eliza_mobile_${"a".repeat(64)}`;
const MOBILE_B = `eliza_mobile_${"b".repeat(64)}`;

describe("mobile API key ingress identity", () => {
  test("the same credential is stable while different credentials remain isolated", () => {
    const first = mobileApiKeyIngressRateLimitKey(MOBILE_A);
    expect(mobileApiKeyIngressRateLimitKey(MOBILE_A)).toBe(first);
    expect(mobileApiKeyIngressRateLimitKey(MOBILE_B)).not.toBe(first);
    expect(first).toMatch(/^mobile-api-key-ingress:sha256:[0-9a-f]{64}$/);
    expect(first).not.toContain(MOBILE_A);
  });

  test("recognizes X-API-Key and Bearer header credentials", () => {
    expect(
      getPresentedMobileApiKeySecret(
        new Request("https://api.example.test", {
          headers: { "x-api-key": MOBILE_A },
        }),
      ),
    ).toBe(MOBILE_A);
    expect(
      getPresentedMobileApiKeySecret(
        new Request("https://api.example.test", {
          headers: { authorization: `Bearer ${MOBILE_A}` },
        }),
      ),
    ).toBe(MOBILE_A);
  });

  test("matches auth precedence when an ordinary X-API-Key shadows a mobile bearer", () => {
    expect(
      getPresentedMobileApiKeySecret(
        new Request("https://agent.example.test/ws", {
          headers: {
            "x-api-key": "eliza_ordinary-cloud-token",
            authorization: `Bearer ${MOBILE_A}`,
          },
        }),
      ),
    ).toBeNull();
  });
});
