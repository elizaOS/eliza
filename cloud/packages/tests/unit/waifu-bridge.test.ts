import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
