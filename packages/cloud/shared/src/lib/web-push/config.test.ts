/**
 * VAPID config resolution for public boot config and private sender config.
 * Worker env bags may contain non-string resource bindings, which must be
 * ignored rather than coerced into secret values.
 */
import { describe, expect, test } from "vitest";
import {
  getWebPushPublicKey,
  getWebPushVapidConfig,
  isWebPushConfigured,
  WEB_PUSH_PRIVATE_KEY_ENV,
  WEB_PUSH_PUBLIC_KEY_ENV,
  WEB_PUSH_SUBJECT_ENV,
} from "./config";

describe("getWebPushPublicKey", () => {
  test("returns the trimmed public key when set", () => {
    expect(getWebPushPublicKey({ [WEB_PUSH_PUBLIC_KEY_ENV]: "  ABC  " })).toBe("ABC");
  });
  test("returns undefined when unset or blank", () => {
    expect(getWebPushPublicKey({})).toBeUndefined();
    expect(getWebPushPublicKey({ [WEB_PUSH_PUBLIC_KEY_ENV]: "   " })).toBeUndefined();
  });

  test("ignores non-string Worker resource bindings", () => {
    expect(getWebPushPublicKey({ [WEB_PUSH_PUBLIC_KEY_ENV]: {} })).toBeUndefined();
  });
});

describe("getWebPushVapidConfig", () => {
  test("returns null when the private key is missing (public-only)", () => {
    expect(getWebPushVapidConfig({ [WEB_PUSH_PUBLIC_KEY_ENV]: "PUB" })).toBeNull();
  });

  test("returns null when the public key is missing", () => {
    expect(getWebPushVapidConfig({ [WEB_PUSH_PRIVATE_KEY_ENV]: "PRIV" })).toBeNull();
  });

  test("resolves the full config when both keys present, with default subject", () => {
    const cfg = getWebPushVapidConfig({
      [WEB_PUSH_PUBLIC_KEY_ENV]: "PUB",
      [WEB_PUSH_PRIVATE_KEY_ENV]: "PRIV",
    });
    expect(cfg).toEqual({
      publicKey: "PUB",
      privateKey: "PRIV",
      subject: "mailto:push@elizacloud.ai",
    });
  });

  test("honors a custom subject", () => {
    const cfg = getWebPushVapidConfig({
      [WEB_PUSH_PUBLIC_KEY_ENV]: "PUB",
      [WEB_PUSH_PRIVATE_KEY_ENV]: "PRIV",
      [WEB_PUSH_SUBJECT_ENV]: "mailto:ops@example.com",
    });
    expect(cfg?.subject).toBe("mailto:ops@example.com");
  });
});

describe("isWebPushConfigured", () => {
  test("true only when both keys present", () => {
    expect(isWebPushConfigured({})).toBe(false);
    expect(
      isWebPushConfigured({
        [WEB_PUSH_PUBLIC_KEY_ENV]: "PUB",
        [WEB_PUSH_PRIVATE_KEY_ENV]: "PRIV",
      }),
    ).toBe(true);
  });
});
