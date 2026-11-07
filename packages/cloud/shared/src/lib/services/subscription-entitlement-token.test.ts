/**
 * Signs entitlements with real P-256 keys and verifies them the way the Alpha
 * Phone client does: WebCrypto ECDSA over the compact JWS signing input with a
 * key from the published set, then header and claim checks.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  __resetEntitlementSigningCacheForTests,
  ENTITLEMENT_AUDIENCE,
  ENTITLEMENT_FORMAT_VERSION,
  ENTITLEMENT_TYPE,
  EntitlementSigningUnavailableError,
  entitlementStatusForSubscription,
  publishedEntitlementKeys,
  signSubscriptionEntitlement,
} from "./subscription-entitlement-token";

const ISSUER = "https://api.eliza.app";
const USER = "71000000-0000-4000-8000-000000000001";
const ORG = "72000000-0000-4000-8000-000000000001";

async function generateKey(): Promise<{ privateKey: string; publicKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return {
    privateKey: Buffer.from(pkcs8).toString("base64"),
    publicKey: Buffer.from(spki).toString("base64"),
  };
}

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

/** Mirrors verifyEntitlement in the Alpha client (apps/app/src/runtime/subscription-entitlement.ts). */
async function clientVerify(token: string, keys: JsonWebKey[]) {
  const [header, payload, signature] = token.split(".") as [string, string, string];
  const decodedHeader = decode(header);
  const key = keys.find((row) => (row as { kid?: string }).kid === decodedHeader.kid);
  if (!key) throw new Error("unknown-key");
  expect(key.d).toBeUndefined();
  const imported = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: key.x, y: key.y, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const bytes = Buffer.from(signature, "base64url");
  expect(bytes.length).toBe(64);
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    imported,
    bytes,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  if (!valid) throw new Error("signature");
  return { header: decodedHeader, claims: decode(payload) };
}

let current: { privateKey: string; publicKey: string };
let previous: { privateKey: string; publicKey: string };
let next: { privateKey: string; publicKey: string };

beforeEach(async () => {
  __resetEntitlementSigningCacheForTests();
  current ??= await generateKey();
  previous ??= await generateKey();
  next ??= await generateKey();
});

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ELIZA_ENTITLEMENT_SIGNING_KEY: current.privateKey,
    ELIZA_ENTITLEMENT_SIGNING_KEY_ID: "ent-2026-10",
    ELIZA_ENTITLEMENT_ISSUER: ISSUER,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

const activeGrant = {
  plan: { id: "plus_monthly", name: "Plus", status: "active" as const },
  source: "grant" as const,
  effectiveUntil: new Date("2027-04-14T00:00:00Z"),
};

describe("subscription entitlement JWS", () => {
  test("verifies with the published key and carries the client contract claims", async () => {
    const now = Date.parse("2026-10-13T12:00:00Z");
    const token = await signSubscriptionEntitlement(
      { userId: USER, organizationId: ORG, summary: activeGrant, now, jti: "jti-1" },
      env(),
    );
    const { keys } = await publishedEntitlementKeys(env());
    expect(keys).toHaveLength(1);
    const { header, claims } = await clientVerify(token, keys as JsonWebKey[]);
    expect(header).toEqual({ alg: "ES256", typ: ENTITLEMENT_TYPE, kid: "ent-2026-10" });
    expect(header.crit).toBeUndefined();
    const iat = now / 1000;
    expect(claims).toEqual({
      ver: 2,
      iss: ISSUER,
      aud: ENTITLEMENT_AUDIENCE,
      sub: USER,
      org: ORG,
      jti: "jti-1",
      iat,
      exp: iat + 1800,
      rfa: iat + 900,
      plan: { id: "plus_monthly", name: "Plus", status: "active" },
      services: ["inference"],
    });
    expect(token.length).toBeLessThan(8192);
  });

  test("expires with the plan window and never exceeds the 60-minute client ceiling", async () => {
    const now = Date.parse("2027-04-13T23:50:00Z");
    const token = await signSubscriptionEntitlement(
      { userId: USER, organizationId: ORG, summary: activeGrant, now },
      env(),
    );
    const { claims } = await clientVerify(
      token,
      (await publishedEntitlementKeys(env())).keys as JsonWebKey[],
    );
    const iat = now / 1000;
    expect(claims.exp).toBe(Date.parse("2027-04-14T00:00:00Z") / 1000);
    expect((claims.exp as number) - iat).toBeLessThanOrEqual(3600);
    expect(claims.rfa as number).toBeGreaterThan(iat);
    expect(claims.rfa as number).toBeLessThan(claims.exp as number);
  });

  test("v2 carries the allowance period in micro-dollars and expires when it resets", async () => {
    expect(ENTITLEMENT_FORMAT_VERSION).toBe(2);
    const now = Date.parse("2026-10-31T23:50:00Z");
    const token = await signSubscriptionEntitlement(
      {
        userId: USER,
        organizationId: ORG,
        now,
        summary: {
          ...activeGrant,
          allowance: {
            unit: "usd_micros",
            granted: 25_000_000,
            remaining: 12_345_678,
            periodStart: new Date("2026-10-01T00:00:00Z"),
            resetsAt: new Date("2026-11-01T00:00:00Z"),
          },
        },
      },
      env(),
    );
    const { claims } = await clientVerify(
      token,
      (await publishedEntitlementKeys(env())).keys as JsonWebKey[],
    );
    expect(claims.ver).toBe(2);
    expect(claims.plan_allowance).toEqual({
      unit: "usd_micros",
      granted: 25_000_000,
      remaining: 12_345_678,
      periodStart: Date.parse("2026-10-01T00:00:00Z") / 1000,
      resetsAt: Date.parse("2026-11-01T00:00:00Z") / 1000,
    });
    // v1 clients reject an `allowance` claim in an unknown unit; v2 never sends one.
    expect(claims.allowance).toBeUndefined();
    expect(claims.exp).toBe(Date.parse("2026-11-01T00:00:00Z") / 1000);
  });

  test("an organization-less user omits org", async () => {
    const token = await signSubscriptionEntitlement(
      {
        userId: USER,
        organizationId: null,
        summary: {
          plan: { id: "free", name: "Free", status: "none" },
          source: "none",
          effectiveUntil: null,
        },
      },
      env(),
    );
    expect(decode(token.split(".")[1]!).org).toBeUndefined();
  });

  test("rotation publishes current and previous keys; tokens from either verify", async () => {
    const before = await signSubscriptionEntitlement(
      { userId: USER, organizationId: ORG, summary: activeGrant },
      env({
        ELIZA_ENTITLEMENT_SIGNING_KEY: previous.privateKey,
        ELIZA_ENTITLEMENT_SIGNING_KEY_ID: "ent-old",
      }),
    );
    __resetEntitlementSigningCacheForTests();
    const rotated = env({
      ELIZA_ENTITLEMENT_PREVIOUS_PUBLIC_KEY: previous.publicKey,
      ELIZA_ENTITLEMENT_PREVIOUS_KEY_ID: "ent-old",
    });
    const after = await signSubscriptionEntitlement(
      { userId: USER, organizationId: ORG, summary: activeGrant },
      rotated,
    );
    const { keys } = await publishedEntitlementKeys(rotated);
    expect(keys.map((key) => key.kid)).toEqual(["ent-2026-10", "ent-old"]);
    for (const key of keys) {
      expect(key).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
      expect(key.d).toBeUndefined();
    }
    expect((await clientVerify(before, keys as JsonWebKey[])).header.kid).toBe("ent-old");
    expect((await clientVerify(after, keys as JsonWebKey[])).header.kid).toBe("ent-2026-10");
    // A token signed by a retired key no longer verifies once it leaves the set.
    await expect(
      clientVerify(before, (await publishedEntitlementKeys(env())).keys as JsonWebKey[]),
    ).rejects.toThrow("unknown-key");
  });

  test("a next key is published before it signs, so cached key sets verify its first tokens", async () => {
    const prePublished = env({
      ELIZA_ENTITLEMENT_NEXT_PUBLIC_KEY: next.publicKey,
      ELIZA_ENTITLEMENT_NEXT_KEY_ID: "ent-next",
    });
    // A client caches this set before the rotation.
    const cached = (await publishedEntitlementKeys(prePublished)).keys;
    expect(cached.map((key) => key.kid)).toEqual(["ent-2026-10", "ent-next"]);
    const stillCurrent = await signSubscriptionEntitlement(
      { userId: USER, organizationId: ORG, summary: activeGrant },
      prePublished,
    );
    expect(decode(stillCurrent.split(".")[0]!).kid).toBe("ent-2026-10");
    __resetEntitlementSigningCacheForTests();
    const rotated = env({
      ELIZA_ENTITLEMENT_SIGNING_KEY: next.privateKey,
      ELIZA_ENTITLEMENT_SIGNING_KEY_ID: "ent-next",
      ELIZA_ENTITLEMENT_PREVIOUS_PUBLIC_KEY: current.publicKey,
      ELIZA_ENTITLEMENT_PREVIOUS_KEY_ID: "ent-2026-10",
    });
    const first = await signSubscriptionEntitlement(
      { userId: USER, organizationId: ORG, summary: activeGrant },
      rotated,
    );
    expect((await clientVerify(first, cached as JsonWebKey[])).header.kid).toBe("ent-next");
  });

  test("a token never outlives the plan window it reports", async () => {
    const now = Date.parse("2027-04-13T23:59:30Z");
    const token = await signSubscriptionEntitlement(
      { userId: USER, organizationId: ORG, summary: activeGrant, now },
      env(),
    );
    const claims = decode(token.split(".")[1]!);
    expect(claims.exp).toBe(Date.parse("2027-04-14T00:00:00Z") / 1000);
    expect(claims.exp as number).toBeGreaterThan(claims.iat as number);
  });

  test("fails closed without complete signing configuration", async () => {
    for (const overrides of [
      { ELIZA_ENTITLEMENT_SIGNING_KEY: undefined },
      { ELIZA_ENTITLEMENT_SIGNING_KEY_ID: undefined },
      { ELIZA_ENTITLEMENT_ISSUER: undefined },
      { ELIZA_ENTITLEMENT_ISSUER: "https://api.eliza.app/v1" },
      // Base64 text that is not key material, built at runtime.
      { ELIZA_ENTITLEMENT_SIGNING_KEY: Buffer.from("not a key").toString("base64") },
      { ELIZA_ENTITLEMENT_PREVIOUS_KEY_ID: "ent-old" },
      { ELIZA_ENTITLEMENT_NEXT_KEY_ID: "ent-next" },
      {
        ELIZA_ENTITLEMENT_PREVIOUS_PUBLIC_KEY: previous.publicKey,
        ELIZA_ENTITLEMENT_PREVIOUS_KEY_ID: "ent-2026-10",
      },
    ]) {
      __resetEntitlementSigningCacheForTests();
      await expect(publishedEntitlementKeys(env(overrides))).rejects.toBeInstanceOf(
        EntitlementSigningUnavailableError,
      );
    }
  });
});

describe("plan status mapping", () => {
  test("maps subscription lifecycle to the client enum", () => {
    expect(entitlementStatusForSubscription("active", true)).toBe("active");
    expect(entitlementStatusForSubscription("active", false)).toBe("past_due");
    expect(entitlementStatusForSubscription("trialing", true)).toBe("trialing");
    expect(entitlementStatusForSubscription("grace", true)).toBe("past_due");
    expect(entitlementStatusForSubscription("past_due", false)).toBe("past_due");
    expect(entitlementStatusForSubscription("unpaid", false)).toBe("canceled");
    expect(entitlementStatusForSubscription("canceled", false)).toBe("canceled");
    expect(entitlementStatusForSubscription("incomplete_expired", false)).toBe("canceled");
    expect(entitlementStatusForSubscription("incomplete", false)).toBe("none");
  });
});

test("deployment audiences are signed with real keys and do not reuse another cached audience", async () => {
  for (const audience of ["independent-app", "another-service", "independent-app"]) {
    const configured = env({ ELIZA_ENTITLEMENT_AUDIENCE: audience });
    const token = await signSubscriptionEntitlement(
      { userId: USER, organizationId: ORG, summary: activeGrant },
      configured,
    );
    const { keys } = await publishedEntitlementKeys(configured);
    const { claims } = await clientVerify(token, keys as JsonWebKey[]);
    expect(claims.aud).toBe(audience);
  }
  for (const audience of ["", "invalid audience", "x".repeat(129)]) {
    await expect(
      signSubscriptionEntitlement(
        { userId: USER, organizationId: ORG, summary: activeGrant },
        env({ ELIZA_ENTITLEMENT_AUDIENCE: audience }),
      ),
    ).rejects.toBeInstanceOf(EntitlementSigningUnavailableError);
  }
});
