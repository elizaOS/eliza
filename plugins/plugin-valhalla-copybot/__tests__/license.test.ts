import { describe, expect, it } from "vitest";
import { checkoutLink, LEMON_PRODUCT_ID } from "../src/checkout.ts";
import {
  classifyLicenseBody,
  DEFAULT_PRODUCT,
  decidePro,
  loadProductConfig,
  tailKey,
} from "../src/license.ts";

const day = 24 * 60 * 60 * 1000;

describe("Valhalla Pro license", () => {
  it("reads the launch price and the live checkout url", () => {
    const config = loadProductConfig();
    expect(config.PRO_PRICE).toBe("$9.99/mo launch price");
    expect(config.LEMONSQUEEZY_CHECKOUT_URL).toContain("valhalla.lemonsqueezy.com/checkout/buy/");
    expect(DEFAULT_PRODUCT.PRO_PRICE).toBe("$9.99/mo launch price");
    const link = checkoutLink(
      config.LEMONSQUEEZY_CHECKOUT_URL,
      "website",
      "buyer@valhalla-app.xyz"
    );
    expect(link).toContain("checkout%5Bemail%5D=buyer%40valhalla-app.xyz");
    expect(link).toContain("checkout%5Bcustom%5D%5Bsource%5D=website");
    expect(checkoutLink(config.LEMONSQUEEZY_CHECKOUT_URL, "android")).not.toContain(
      "checkout%5Bemail%5D"
    );
  });

  it("accepts an active license and rejects a disabled one", () => {
    const active = classifyLicenseBody(200, {
      activated: true,
      license_key: { status: "active", expires_at: null },
      instance: { id: "inst-1" },
      meta: { product_id: LEMON_PRODUCT_ID },
    });
    expect(active.online).toBe("ok");
    expect(active.instanceId).toBe("inst-1");
    const disabled = classifyLicenseBody(200, {
      valid: false,
      license_key: { status: "disabled", expires_at: null },
    });
    expect(disabled.online).toBe("invalid");
    const other = classifyLicenseBody(200, {
      activated: true,
      license_key: { status: "active", expires_at: null },
      meta: { product_id: 1 },
    });
    expect(other.online).toBe("invalid");
  });

  it("keeps Pro during a network miss and drops it after the grace window", () => {
    const now = Date.parse("2026-11-03T12:00:00Z");
    const record = { status: "active" as const, validatedAt: now - 2 * day, expiresAt: null };
    expect(decidePro(record, "down", now, 7 * day)).toBe(true);
    expect(decidePro(record, "down", now, 1 * day)).toBe(false);
    expect(decidePro(record, "invalid", now, 7 * day)).toBe(false);
  });

  it("shows only the end of a license key", () => {
    expect(tailKey("FULL-LICENSE-KEY-1234")).toBe("••••1234");
    expect(tailKey("FULL-LICENSE-KEY-1234")).not.toContain("FULL");
  });
});
