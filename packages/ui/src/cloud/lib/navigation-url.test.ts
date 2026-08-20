/**
 * Compat coverage for the cloud/lib import path: the navigation scheme
 * allowlist lives in `utils/navigation-url` (so the platform-level navigation
 * helpers can enforce it) and this module re-exports it for existing cloud
 * consumers. The full contract is tested in `utils/navigation-url.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { isSafeNavigationUrl as canonical } from "../../utils/navigation-url";
import { isSafeNavigationUrl } from "./navigation-url";

describe("cloud/lib/navigation-url compat re-export", () => {
  it("re-exports the canonical guard", () => {
    expect(isSafeNavigationUrl).toBe(canonical);
    expect(isSafeNavigationUrl("https://checkout.stripe.com/c/pay_123")).toBe(
      true,
    );
    expect(isSafeNavigationUrl("javascript:alert(1)")).toBe(false);
  });
});
