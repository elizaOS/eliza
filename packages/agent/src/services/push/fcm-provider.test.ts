/**
 * Covers the FCM push provider: config gating from a service-account JSON env
 * var, RS256 OAuth-assertion JWT construction (header, iss/scope/aud/iat/exp),
 * and the FCM v1 message body shape (string-coerced data). Crypto is real — a
 * throwaway RSA key pair is generated per test and the assertion signature is
 * verified against the public key; no network calls to Google.
 */
import { createVerify, generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FcmProvider, readServiceAccount } from "./fcm-provider.ts";

/** Generate a throwaway RSA key pair (PEM private, KeyObject public). */
function makeRsaKey(): { privatePem: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey,
  };
}

function decodeSegment(segment: string): Record<string, unknown> {
  const json = Buffer.from(
    segment.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  ).toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

function serviceAccountJson(privatePem: string): string {
  return JSON.stringify({
    type: "service_account",
    project_id: "eliza-demo-project",
    private_key: privatePem,
    client_email: "pusher@eliza-demo-project.iam.gserviceaccount.com",
    token_uri: "https://oauth2.googleapis.com/token",
  });
}

const envWith = (privatePem: string): NodeJS.ProcessEnv => ({
  ELIZA_FCM_SERVICE_ACCOUNT: serviceAccountJson(privatePem),
});

describe("FcmProvider", () => {
  describe("isConfigured gating", () => {
    it("is false with no service account", () => {
      expect(new FcmProvider({}).isConfigured()).toBe(false);
      expect(readServiceAccount({})).toBeNull();
    });

    it("is false for malformed JSON", () => {
      expect(
        new FcmProvider({
          ELIZA_FCM_SERVICE_ACCOUNT: "{ not json",
        }).isConfigured(),
      ).toBe(false);
    });

    it("is false when client_email / private_key / project_id is missing", () => {
      const { privatePem } = makeRsaKey();
      const variants = [
        { project_id: "p", private_key: privatePem }, // no client_email
        { client_email: "a@b.com", project_id: "p" }, // no private_key
        { client_email: "a@b.com", private_key: privatePem }, // no project_id
      ];
      for (const partial of variants) {
        expect(
          new FcmProvider({
            ELIZA_FCM_SERVICE_ACCOUNT: JSON.stringify(partial),
          }).isConfigured(),
        ).toBe(false);
      }
    });

    it("is true with a valid service account", () => {
      const { privatePem } = makeRsaKey();
      expect(new FcmProvider(envWith(privatePem)).isConfigured()).toBe(true);
    });
  });

  describe("buildAssertion (RS256 OAuth assertion JWT)", () => {
    it("produces an RS256 JWT header", () => {
      const { privatePem } = makeRsaKey();
      const jwt = new FcmProvider(envWith(privatePem)).buildAssertion(
        1_700_000_000_000,
      );
      const header = decodeSegment(jwt.split(".")[0]);
      expect(header.alg).toBe("RS256");
      expect(header.typ).toBe("JWT");
    });

    it("sets iss, scope, aud and a valid iat/exp window", () => {
      const { privatePem } = makeRsaKey();
      const now = 1_700_000_000_000;
      const jwt = new FcmProvider(envWith(privatePem)).buildAssertion(now);
      const claims = decodeSegment(jwt.split(".")[1]);
      expect(claims.iss).toBe(
        "pusher@eliza-demo-project.iam.gserviceaccount.com",
      );
      expect(claims.scope).toBe(
        "https://www.googleapis.com/auth/firebase.messaging",
      );
      expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
      expect(claims.iat).toBe(Math.floor(now / 1000));
      expect(claims.exp).toBe(Math.floor(now / 1000) + 3600);
    });

    it("signs an RS256 signature that verifies against the public key", () => {
      const { privatePem, publicKey } = makeRsaKey();
      const jwt = new FcmProvider(envWith(privatePem)).buildAssertion();
      const [h, p, sig] = jwt.split(".");
      const signature = Buffer.from(
        sig.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      );
      const ok = createVerify("RSA-SHA256")
        .update(`${h}.${p}`)
        .verify(publicKey, signature);
      expect(ok).toBe(true);
    });
  });

  describe("buildMessageBody (FCM v1 message shape)", () => {
    it("nests token + notification and stringifies data values", () => {
      const { privatePem } = makeRsaKey();
      const provider = new FcmProvider(envWith(privatePem));
      const body = JSON.parse(
        provider.buildMessageBody("device-token-xyz", {
          title: "Reminder",
          body: "Stand up meeting",
          data: { notificationId: "n-9", count: 3, deepLink: "/calendar" },
        }),
      );
      expect(body.message.token).toBe("device-token-xyz");
      expect(body.message.notification).toEqual({
        title: "Reminder",
        body: "Stand up meeting",
      });
      // FCM data is string→string; non-strings are JSON-stringified.
      expect(body.message.data.notificationId).toBe("n-9");
      expect(body.message.data.count).toBe("3");
      expect(body.message.data.deepLink).toBe("/calendar");
    });

    it("omits notification.body and data when absent", () => {
      const { privatePem } = makeRsaKey();
      const provider = new FcmProvider(envWith(privatePem));
      const body = JSON.parse(provider.buildMessageBody("t", { title: "Hi" }));
      expect(body.message.notification).toEqual({ title: "Hi" });
      expect(body.message.data).toBeUndefined();
    });
  });
});
