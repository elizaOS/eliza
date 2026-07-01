/**
 * Ad-tag token (#10687) — the signed capability gating the public serve
 * endpoint. Pure unit tests: mint/verify roundtrip, scope binding (slot + app),
 * expiry, tampering, and the fail-closed no-secret posture.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mintAdTagToken, verifyAdTagToken } from "../ad-tag-token";

const SLOT = "11111111-1111-4111-8111-111111111111";
const APP = "22222222-2222-4222-8222-222222222222";

let originalSecret: string | undefined;

beforeEach(() => {
  originalSecret = process.env.ELIZA_AD_TAG_SECRET;
  process.env.ELIZA_AD_TAG_SECRET = "test-ad-tag-secret";
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.ELIZA_AD_TAG_SECRET;
  else process.env.ELIZA_AD_TAG_SECRET = originalSecret;
});

describe("ad-tag token", () => {
  test("mint + verify roundtrip for the exact slot/app", async () => {
    const token = await mintAdTagToken({ slotId: SLOT, appId: APP });
    expect(token).not.toBeNull();
    expect(token).toStartWith("v1.");
    expect(await verifyAdTagToken(token!, { slotId: SLOT, appId: APP })).toBe(true);
  });

  test("a token for one slot does not authorize another", async () => {
    const token = await mintAdTagToken({ slotId: SLOT, appId: APP });
    expect(
      await verifyAdTagToken(token!, {
        slotId: "33333333-3333-4333-8333-333333333333",
        appId: APP,
      }),
    ).toBe(false);
  });

  test("a token is bound to the app id too", async () => {
    const token = await mintAdTagToken({ slotId: SLOT, appId: APP });
    expect(
      await verifyAdTagToken(token!, {
        slotId: SLOT,
        appId: "44444444-4444-4444-8444-444444444444",
      }),
    ).toBe(false);
  });

  test("an expired token is rejected", async () => {
    const token = await mintAdTagToken({ slotId: SLOT, appId: APP, ttlSeconds: -10 });
    expect(await verifyAdTagToken(token!, { slotId: SLOT, appId: APP })).toBe(false);
  });

  test("tampering with the expiry or signature invalidates the token", async () => {
    const token = await mintAdTagToken({ slotId: SLOT, appId: APP });
    const [v, exp, sig] = token!.split(".");
    const laterExpiry = `${v}.${Number(exp) + 86_400}.${sig}`;
    expect(await verifyAdTagToken(laterExpiry, { slotId: SLOT, appId: APP })).toBe(false);
    const flipped = sig.endsWith("0") ? `${sig.slice(0, -1)}1` : `${sig.slice(0, -1)}0`;
    expect(await verifyAdTagToken(`${v}.${exp}.${flipped}`, { slotId: SLOT, appId: APP })).toBe(
      false,
    );
  });

  test("garbage tokens are rejected", async () => {
    for (const garbage of ["", "v1", "v1.abc.def", "v2.9999999999.00", "v1..", "a.b.c.d"]) {
      expect(await verifyAdTagToken(garbage, { slotId: SLOT, appId: APP })).toBe(false);
    }
  });

  test("fails closed without a configured secret: no minting, no verifying", async () => {
    const token = await mintAdTagToken({ slotId: SLOT, appId: APP });
    delete process.env.ELIZA_AD_TAG_SECRET;
    expect(await mintAdTagToken({ slotId: SLOT, appId: APP })).toBeNull();
    expect(await verifyAdTagToken(token!, { slotId: SLOT, appId: APP })).toBe(false);
  });
});
