import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { canAutoCreateWaifuBridgeOrg } from "@/lib/auth/waifu-bridge";

const mutableEnv = process.env as Record<string, string | undefined>;

describe("waifu bridge auth policy", () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedAutoCreate = process.env.WAIFU_BRIDGE_ALLOW_ORG_AUTO_CREATE;

  beforeEach(() => {
    delete process.env.WAIFU_BRIDGE_ALLOW_ORG_AUTO_CREATE;
  });

  afterEach(() => {
    mutableEnv.NODE_ENV = savedNodeEnv;
    if (savedAutoCreate === undefined) {
      delete process.env.WAIFU_BRIDGE_ALLOW_ORG_AUTO_CREATE;
    } else {
      process.env.WAIFU_BRIDGE_ALLOW_ORG_AUTO_CREATE = savedAutoCreate;
    }
  });

  test("disables auto-creating orgs in production by default", () => {
    mutableEnv.NODE_ENV = "production";
    expect(canAutoCreateWaifuBridgeOrg()).toBe(false);
  });

  test("disables auto-creating orgs in development by default (no longer relies on NODE_ENV)", () => {
    mutableEnv.NODE_ENV = "development";
    expect(canAutoCreateWaifuBridgeOrg()).toBe(false);
  });

  test("disables auto-creating orgs in preview/staging by default", () => {
    mutableEnv.NODE_ENV = "test";
    expect(canAutoCreateWaifuBridgeOrg()).toBe(false);
  });

  test("allows explicit opt-in for org auto-creation regardless of NODE_ENV", () => {
    mutableEnv.NODE_ENV = "production";
    process.env.WAIFU_BRIDGE_ALLOW_ORG_AUTO_CREATE = "true";
    expect(canAutoCreateWaifuBridgeOrg()).toBe(true);

    mutableEnv.NODE_ENV = "development";
    expect(canAutoCreateWaifuBridgeOrg()).toBe(true);
  });

  test("rejects non-true values for WAIFU_BRIDGE_ALLOW_ORG_AUTO_CREATE", () => {
    process.env.WAIFU_BRIDGE_ALLOW_ORG_AUTO_CREATE = "yes";
    expect(canAutoCreateWaifuBridgeOrg()).toBe(false);

    process.env.WAIFU_BRIDGE_ALLOW_ORG_AUTO_CREATE = "1";
    expect(canAutoCreateWaifuBridgeOrg()).toBe(false);
  });
});

describe("waifu bridge service identity helpers", () => {
  function slugFromUserId(userId: string): string {
    const base = userId
      .replace(/[^a-zA-Z0-9-]/g, "-")
      .toLowerCase()
      .slice(0, 40);
    const hash = crypto.createHash("sha256").update(userId).digest("hex").slice(0, 16);
    return `${base}-${hash}`;
  }

  test("derives stable organization slugs from service user ids", () => {
    const userId = "waifu:0xABCDEF1234567890abcdef1234567890abcdef12";
    expect(slugFromUserId(userId)).toBe(slugFromUserId(userId));
  });

  test("keeps slug suffix deterministic and bounded", () => {
    const slug = slugFromUserId("waifu:" + "a".repeat(100));
    const hashPart = slug.split("-").at(-1);

    expect(slug.length).toBeLessThanOrEqual(57);
    expect(hashPart).toMatch(/^[0-9a-f]{16}$/);
  });

  test("normalizes special characters out of the slug base", () => {
    const slug = slugFromUserId("waifu:user@domain.com/path");
    const base = slug.slice(0, slug.lastIndexOf("-"));
    expect(base).not.toMatch(/[@./]/);
  });
});

describe("waifu bridge disabled auth", () => {
  const savedSecret = process.env.ELIZA_SERVICE_JWT_SECRET;

  beforeEach(() => {
    delete process.env.ELIZA_SERVICE_JWT_SECRET;
  });

  afterEach(() => {
    if (savedSecret === undefined) {
      delete process.env.ELIZA_SERVICE_JWT_SECRET;
    } else {
      process.env.ELIZA_SERVICE_JWT_SECRET = savedSecret;
    }
  });

  test("returns null instead of throwing when service JWT secret is unset", async () => {
    const { authenticateWaifuBridge } = await import(
      new URL(`../../lib/auth/waifu-bridge.ts?t=${Date.now()}`, import.meta.url).href
    );

    const result = await authenticateWaifuBridge(
      new Request("https://example.test", {
        headers: { authorization: "Bearer fake" },
      }),
    );
    expect(result).toBeNull();
  });
});
