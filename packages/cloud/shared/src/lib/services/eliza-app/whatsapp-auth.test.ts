/**
 * Verify-token handshake contract for the eliza-app WhatsApp webhook: the
 * subscription GET must accept the exact configured token and reject
 * mismatches (including prefix near-misses and nulls) through the
 * constant-time comparison. Deterministic — config is env-driven; only the
 * logger is mocked.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const VERIFY_TOKEN = "meta-verify-token-0123456789";
const ENV_KEY = "ELIZA_APP_WHATSAPP_VERIFY_TOKEN";

mock.module("../../utils/logger", () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
  redact: { id: (v: string) => v, orgId: (v: string) => v, userId: (v: string) => v },
}));

const { whatsAppAuthService } = await import("./whatsapp-auth");

describe("WhatsAppAuthService.verifyWebhookSubscription", () => {
  let savedToken: string | undefined;

  beforeEach(() => {
    savedToken = process.env[ENV_KEY];
    process.env[ENV_KEY] = VERIFY_TOKEN;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedToken;
  });

  test("returns the challenge for the exact configured token", () => {
    expect(
      whatsAppAuthService.verifyWebhookSubscription("subscribe", VERIFY_TOKEN, "challenge-1"),
    ).toBe("challenge-1");
  });

  test("rejects a wrong token, a prefix near-miss, and null", () => {
    expect(
      whatsAppAuthService.verifyWebhookSubscription("subscribe", "wrong-token", "c"),
    ).toBeNull();
    // Length-mismatched near-miss: constant-time compare must still reject.
    expect(
      whatsAppAuthService.verifyWebhookSubscription("subscribe", VERIFY_TOKEN.slice(0, -1), "c"),
    ).toBeNull();
    expect(whatsAppAuthService.verifyWebhookSubscription("subscribe", null, "c")).toBeNull();
  });

  test("rejects a non-subscribe mode and a missing challenge", () => {
    expect(
      whatsAppAuthService.verifyWebhookSubscription("unsubscribe", VERIFY_TOKEN, "c"),
    ).toBeNull();
    expect(
      whatsAppAuthService.verifyWebhookSubscription("subscribe", VERIFY_TOKEN, null),
    ).toBeNull();
  });

  test("fails closed when no verify token is configured", () => {
    delete process.env[ENV_KEY];
    expect(
      whatsAppAuthService.verifyWebhookSubscription("subscribe", VERIFY_TOKEN, "c"),
    ).toBeNull();
  });
});
