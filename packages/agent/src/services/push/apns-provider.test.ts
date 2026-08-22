/**
 * Covers the APNs push provider: config gating from env credentials, ES256
 * provider-JWT minting (header alg/kid, claims, TTL caching), and the APNs
 * alert payload shape. Crypto is real — a throwaway P-256 key pair is generated
 * per test and the minted signature is verified against the public key; no
 * network calls to Apple.
 */
import { createVerify, generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApnsProvider, readApnsConfig } from "./apns-provider.ts";

/** Generate a throwaway P-256 EC key pair (PEM private, KeyObject public). */
function makeEcKey(): { privatePem: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
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

const baseEnv = (privatePem: string): NodeJS.ProcessEnv => ({
  ELIZA_APNS_KEY: privatePem,
  ELIZA_APNS_KEY_ID: "ABC123KEYID",
  ELIZA_APNS_TEAM_ID: "TEAM987654",
  ELIZA_APNS_TOPIC: "ai.elizaos.app",
});

describe("ApnsProvider", () => {
  describe("isConfigured gating", () => {
    it("is false with no credentials", () => {
      expect(new ApnsProvider({}).isConfigured()).toBe(false);
      expect(readApnsConfig({})).toBeNull();
    });

    it("is false when any required field is missing", () => {
      const { privatePem } = makeEcKey();
      const full = baseEnv(privatePem);
      for (const key of [
        "ELIZA_APNS_KEY",
        "ELIZA_APNS_KEY_ID",
        "ELIZA_APNS_TEAM_ID",
        "ELIZA_APNS_TOPIC",
      ]) {
        const partial = { ...full };
        delete partial[key];
        expect(new ApnsProvider(partial).isConfigured()).toBe(false);
      }
    });

    it("is true with the full credential set", () => {
      const { privatePem } = makeEcKey();
      expect(new ApnsProvider(baseEnv(privatePem)).isConfigured()).toBe(true);
    });
  });

  describe("mintToken (ES256 provider JWT)", () => {
    it("produces a header with alg ES256 and the kid", () => {
      const { privatePem } = makeEcKey();
      const provider = new ApnsProvider(baseEnv(privatePem));
      const jwt = provider.mintToken(1_700_000_000_000);
      const [headerSeg] = jwt.split(".");
      const header = decodeSegment(headerSeg);
      expect(header.alg).toBe("ES256");
      expect(header.kid).toBe("ABC123KEYID");
    });

    it("produces claims with iss=teamId and a numeric iat", () => {
      const { privatePem } = makeEcKey();
      const provider = new ApnsProvider(baseEnv(privatePem));
      const now = 1_700_000_000_000;
      const jwt = provider.mintToken(now);
      const claims = decodeSegment(jwt.split(".")[1]);
      expect(claims.iss).toBe("TEAM987654");
      expect(typeof claims.iat).toBe("number");
      expect(claims.iat).toBe(Math.floor(now / 1000));
    });

    it("signs a JOSE (P1363) signature that verifies against the public key", () => {
      const { privatePem, publicKey } = makeEcKey();
      const provider = new ApnsProvider(baseEnv(privatePem));
      const jwt = provider.mintToken();
      const [h, p, sig] = jwt.split(".");
      const signature = Buffer.from(
        sig.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      );
      const ok = createVerify("SHA256")
        .update(`${h}.${p}`)
        .verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
      expect(ok).toBe(true);
    });

    it("caches the token within its TTL", () => {
      const { privatePem } = makeEcKey();
      const provider = new ApnsProvider(baseEnv(privatePem));
      const now = 1_700_000_000_000;
      const first = provider.mintToken(now);
      const second = provider.mintToken(now + 60_000);
      expect(second).toBe(first);
      // Past the 50-minute TTL it re-mints (new iat → different token).
      const third = provider.mintToken(now + 51 * 60 * 1000);
      expect(third).not.toBe(first);
    });
  });

  describe("buildPayload (APNs alert shape)", () => {
    it("shapes aps.alert + sound and merges custom data", () => {
      const { privatePem } = makeEcKey();
      const provider = new ApnsProvider(baseEnv(privatePem));
      const payload = JSON.parse(
        provider.buildPayload({
          title: "Build done",
          body: "Deploy #42",
          data: { notificationId: "n-1", deepLink: "/tasks" },
        }),
      );
      expect(payload.aps.alert).toEqual({
        title: "Build done",
        body: "Deploy #42",
      });
      expect(payload.aps.sound).toBe("default");
      expect(payload.notificationId).toBe("n-1");
      expect(payload.deepLink).toBe("/tasks");
    });

    it("omits the body line when absent", () => {
      const { privatePem } = makeEcKey();
      const provider = new ApnsProvider(baseEnv(privatePem));
      const payload = JSON.parse(provider.buildPayload({ title: "Ping" }));
      expect(payload.aps.alert).toEqual({ title: "Ping" });
    });
  });
});
