import { expect, test } from "bun:test";
import {
  canonicalSignedPayload,
  generateCodeChallenge,
  generatePKCE,
  hmacSha256Hex,
} from "../../contracts/index";
import { verifyWebhookSignature } from "../webhook-verify";

test("shared PKCE challenge matches RFC 7636 and generates a URL-safe verifier", async () => {
  expect(
    await generateCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
  ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  const { verifier, challenge } = await generatePKCE();
  expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(challenge).toBe(await generateCodeChallenge(verifier));
});

test("shared HMAC matches RFC 4231", async () => {
  expect(await hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  );
});

test("webhook encoding is shared with SDK verification without ambiguous field boundaries", async () => {
  const body = "a.b";
  const canonical = canonicalSignedPayload(
    "1000",
    "delivery",
    "event.name",
    body,
  );
  expect(canonical).toBe("v2:1000.8:delivery.10:event.name.a.b");
  const signature = `v2=${await hmacSha256Hex("secret", canonical)}`;
  expect(
    await verifyWebhookSignature(body, signature, "secret", "1000", {
      nowSec: 1000,
      deliveryId: "delivery",
      eventType: "event.name",
    }),
  ).toMatchObject({ valid: true });
  expect(
    await verifyWebhookSignature("name.a.b", signature, "secret", "1000", {
      nowSec: 1000,
      deliveryId: "delivery",
      eventType: "event",
    }),
  ).toMatchObject({ valid: false });
});
