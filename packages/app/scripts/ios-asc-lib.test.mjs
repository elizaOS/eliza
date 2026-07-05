/**
 * Unit tests for the pure decision logic behind ios-mint-profiles.mjs — the
 * App Store Connect development-profile minting for the iOS device lane. Runs in
 * the packages/app vitest suite (`bun run --cwd packages/app test`). No Apple
 * account and no network: the JWT signer is exercised against a locally-generated
 * EC P-256 key and verified with the matching public key, so ES256/ieee-p1363
 * correctness is proven deterministically without a real .p8 or a live token.
 */
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APP_BUNDLE_ID,
  APPEX_SUFFIXES,
  ASC_API_BASE,
  ASC_JWT_AUDIENCE,
  ASC_JWT_MAX_LIFETIME_SECONDS,
  appexSuffixesFromPlugIns,
  base64url,
  buildAscJwtClaims,
  buildCreateBundleIdRequest,
  buildCreateProfileRequest,
  buildDeleteProfileRequest,
  buildFindBundleIdRequest,
  buildFindDeviceRequest,
  buildFindProfileRequest,
  buildListCertificatesRequest,
  buildRegisterDeviceRequest,
  bundleIdToName,
  decodeProfileContent,
  enumerateBundleIds,
  firstResource,
  formatAscErrors,
  isPlausibleUdid,
  parseMintArgs,
  profileNameForBundleId,
  resolveAscCredentials,
  resourceIdsFromListResponse,
  signAscJwt,
} from "./ios-asc-lib.mjs";

/** Generate a throwaway EC P-256 keypair whose private PEM stands in for a .p8. */
function makeEcKeypair() {
  return crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

function b64urlDecodeJson(segment) {
  const b64 = segment.replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

describe("base64url", () => {
  it("uses the URL alphabet and strips padding", () => {
    // 0xFB 0xFF encodes to "+/8=" in std base64 → "-_8" url-safe, no pad.
    expect(base64url(Buffer.from([0xfb, 0xff]))).toBe("-_8");
    expect(base64url("")).toBe("");
    expect(base64url("hello")).toBe("aGVsbG8");
  });

  it("accepts a string or a Buffer identically", () => {
    expect(base64url("abc")).toBe(base64url(Buffer.from("abc")));
  });
});

describe("buildAscJwtClaims", () => {
  it("builds the fixed ES256 header and the required audience claim", () => {
    const { header, payload } = buildAscJwtClaims({
      keyId: "KID123",
      issuerId: "ISS-abc",
      issuedAt: 1_000_000,
      lifetimeSeconds: 600,
    });
    expect(header).toEqual({ alg: "ES256", kid: "KID123", typ: "JWT" });
    expect(payload).toEqual({
      iss: "ISS-abc",
      iat: 1_000_000,
      exp: 1_000_600,
      aud: ASC_JWT_AUDIENCE,
    });
  });

  it("clamps the lifetime to Apple's 20-minute cap", () => {
    const { payload } = buildAscJwtClaims({
      keyId: "k",
      issuerId: "i",
      issuedAt: 0,
      lifetimeSeconds: 60 * 60,
    });
    expect(payload.exp).toBe(ASC_JWT_MAX_LIFETIME_SECONDS);
  });

  it("floors a fractional lifetime and never drops below 1 second", () => {
    expect(
      buildAscJwtClaims({
        keyId: "k",
        issuerId: "i",
        issuedAt: 0,
        lifetimeSeconds: 0,
      }).payload.exp,
    ).toBe(1);
    expect(
      buildAscJwtClaims({
        keyId: "k",
        issuerId: "i",
        issuedAt: 0,
        lifetimeSeconds: 5.9,
      }).payload.exp,
    ).toBe(5);
  });

  it("rejects a missing keyId, issuerId, or non-integer issuedAt", () => {
    expect(() => buildAscJwtClaims({ issuerId: "i" })).toThrow(/keyId/);
    expect(() => buildAscJwtClaims({ keyId: "k" })).toThrow(/issuerId/);
    expect(() =>
      buildAscJwtClaims({ keyId: "k", issuerId: "i", issuedAt: 1.5 }),
    ).toThrow(/issuedAt/);
  });
});

describe("signAscJwt", () => {
  it("produces a verifiable ES256 JWT with a 64-byte P1363 signature", () => {
    const { publicKey, privateKey } = makeEcKeypair();
    const claims = buildAscJwtClaims({
      keyId: "KID",
      issuerId: "ISS",
      issuedAt: 42,
    });
    const jwt = signAscJwt(claims, privateKey);

    const [h, p, s] = jwt.split(".");
    expect(b64urlDecodeJson(h)).toEqual(claims.header);
    expect(b64urlDecodeJson(p)).toEqual(claims.payload);

    const sig = Buffer.from(
      s.replaceAll("-", "+").replaceAll("_", "/"),
      "base64",
    );
    // ES256 over JOSE is raw r‖s for P-256 → exactly 64 bytes (not ASN.1/DER).
    expect(sig.length).toBe(64);

    const ok = crypto.verify(
      "sha256",
      Buffer.from(`${h}.${p}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      sig,
    );
    expect(ok).toBe(true);
  });

  it("rejects a token when the signing input is tampered", () => {
    const { publicKey, privateKey } = makeEcKeypair();
    const jwt = signAscJwt(
      buildAscJwtClaims({ keyId: "K", issuerId: "I", issuedAt: 1 }),
      privateKey,
    );
    const [h, p, s] = jwt.split(".");
    const sig = Buffer.from(
      s.replaceAll("-", "+").replaceAll("_", "/"),
      "base64",
    );
    const ok = crypto.verify(
      "sha256",
      Buffer.from(`${h}.${p}tampered`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      sig,
    );
    expect(ok).toBe(false);
  });
});

describe("enumerateBundleIds", () => {
  it("emits the app first then one entry per appex suffix, in order", () => {
    const entries = enumerateBundleIds();
    expect(entries[0]).toEqual({
      bundleId: APP_BUNDLE_ID,
      kind: "app",
      name: "App",
    });
    expect(entries).toHaveLength(1 + APPEX_SUFFIXES.length);
    for (let i = 0; i < APPEX_SUFFIXES.length; i += 1) {
      expect(entries[i + 1]).toEqual({
        bundleId: `${APP_BUNDLE_ID}.${APPEX_SUFFIXES[i]}`,
        kind: "appex",
        name: APPEX_SUFFIXES[i],
      });
    }
  });

  it("honors explicit app id and discovered suffixes", () => {
    const entries = enumerateBundleIds({
      appBundleId: "com.example.thing",
      appexSuffixes: ["Widgets"],
    });
    expect(entries).toEqual([
      { bundleId: "com.example.thing", kind: "app", name: "App" },
      { bundleId: "com.example.thing.Widgets", kind: "appex", name: "Widgets" },
    ]);
  });
});

describe("appexSuffixesFromPlugIns", () => {
  it("keeps only .appex entries, strips the extension, and sorts", () => {
    expect(
      appexSuffixesFromPlugIns([
        "ElizaWidgets.appex",
        "README.txt",
        "ElizaKeyboard.appex",
        ".DS_Store",
      ]),
    ).toEqual(["ElizaKeyboard", "ElizaWidgets"]);
  });

  it("returns empty for a product with no plug-ins", () => {
    expect(appexSuffixesFromPlugIns([])).toEqual([]);
  });
});

describe("bundleIdToName", () => {
  it("replaces dots with spaces so ASC accepts the name", () => {
    expect(bundleIdToName("ai.elizaos.app")).toBe("ai elizaos app");
    expect(bundleIdToName("ai.elizaos.app.ElizaKeyboard")).toBe(
      "ai elizaos app ElizaKeyboard",
    );
  });

  it("collapses runs of separators and trims", () => {
    expect(bundleIdToName("a__b..c")).toBe("a b c");
  });
});

describe("ASC request builders", () => {
  it("finds a bundle id by identifier filter", () => {
    const req = buildFindBundleIdRequest("ai.elizaos.app");
    expect(req.method).toBe("GET");
    expect(req.path).toContain("/bundleIds?");
    const q = new URLSearchParams(req.path.split("?")[1]);
    expect(q.get("filter[identifier]")).toBe("ai.elizaos.app");
    expect(q.get("limit")).toBe("200");
  });

  it("creates an iOS bundle id with a dot-free name", () => {
    expect(buildCreateBundleIdRequest("ai.elizaos.app.ElizaWidgets")).toEqual({
      method: "POST",
      path: "/bundleIds",
      body: {
        data: {
          type: "bundleIds",
          attributes: {
            identifier: "ai.elizaos.app.ElizaWidgets",
            name: "ai elizaos app ElizaWidgets",
            platform: "IOS",
          },
        },
      },
    });
  });

  it("finds and registers a device by UDID", () => {
    const find = buildFindDeviceRequest("00008140-0006491E2E90801C");
    expect(
      new URLSearchParams(find.path.split("?")[1]).get("filter[udid]"),
    ).toBe("00008140-0006491E2E90801C");

    const reg = buildRegisterDeviceRequest("00008140-0006491E2E90801C", {
      name: "lab-iphone",
    });
    expect(reg).toEqual({
      method: "POST",
      path: "/devices",
      body: {
        data: {
          type: "devices",
          attributes: {
            name: "lab-iphone",
            platform: "IOS",
            udid: "00008140-0006491E2E90801C",
          },
        },
      },
    });
  });

  it("defaults a device name when none is given", () => {
    const reg = buildRegisterDeviceRequest("DEAD", {});
    expect(reg.body.data.attributes.name).toBe("device-lane DEAD");
  });

  it("names profiles deterministically for find-then-refresh", () => {
    expect(profileNameForBundleId("ai.elizaos.app")).toBe(
      "eliza-device-lane ai.elizaos.app",
    );
    const find = buildFindProfileRequest(
      profileNameForBundleId("ai.elizaos.app"),
    );
    expect(
      new URLSearchParams(find.path.split("?")[1]).get("filter[name]"),
    ).toBe("eliza-device-lane ai.elizaos.app");
  });

  it("builds an IOS_APP_DEVELOPMENT profile linking bundle, certs, and devices", () => {
    const req = buildCreateProfileRequest({
      bundleId: "ai.elizaos.app",
      bundleIdResourceId: "BID1",
      certificateIds: ["CERT1", "CERT2"],
      deviceIds: ["DEV1"],
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/profiles");
    expect(req.body.data.attributes).toEqual({
      name: "eliza-device-lane ai.elizaos.app",
      profileType: "IOS_APP_DEVELOPMENT",
    });
    expect(req.body.data.relationships.bundleId.data).toEqual({
      type: "bundleIds",
      id: "BID1",
    });
    expect(req.body.data.relationships.certificates.data).toEqual([
      { type: "certificates", id: "CERT1" },
      { type: "certificates", id: "CERT2" },
    ]);
    expect(req.body.data.relationships.devices.data).toEqual([
      { type: "devices", id: "DEV1" },
    ]);
  });

  it("refuses to build a profile without a bundle, cert, or device", () => {
    expect(() =>
      buildCreateProfileRequest({ certificateIds: ["c"], deviceIds: ["d"] }),
    ).toThrow(/bundleIdResourceId/);
    expect(() =>
      buildCreateProfileRequest({
        bundleIdResourceId: "b",
        certificateIds: [],
        deviceIds: ["d"],
      }),
    ).toThrow(/certificateId/);
    expect(() =>
      buildCreateProfileRequest({
        bundleIdResourceId: "b",
        certificateIds: ["c"],
        deviceIds: [],
      }),
    ).toThrow(/deviceId/);
  });

  it("deletes a profile by resource id and lists development certificates", () => {
    expect(buildDeleteProfileRequest("PROF9")).toEqual({
      method: "DELETE",
      path: "/profiles/PROF9",
    });
    const certs = buildListCertificatesRequest();
    expect(
      new URLSearchParams(certs.path.split("?")[1]).get(
        "filter[certificateType]",
      ),
    ).toBe("DEVELOPMENT");
  });
});

describe("ASC response parsing", () => {
  it("returns the first resource or null for an empty list", () => {
    expect(firstResource({ data: [{ id: "a" }, { id: "b" }] })).toEqual({
      id: "a",
    });
    expect(firstResource({ data: [] })).toBeNull();
  });

  it("throws rather than fabricating a not-found on a malformed body", () => {
    expect(() => firstResource(null)).toThrow(/not an object/);
    expect(() => firstResource({})).toThrow(/no `data`/);
    expect(() => firstResource({ data: { id: "x" } })).toThrow(/not an array/);
  });

  it("extracts list resource ids without treating malformed responses as empty", () => {
    expect(
      resourceIdsFromListResponse(
        { data: [{ id: "CERT1" }, { id: "" }, {}, { id: "CERT2" }] },
        "certificates",
      ),
    ).toEqual(["CERT1", "CERT2"]);
    expect(resourceIdsFromListResponse({ data: [] }, "certificates")).toEqual(
      [],
    );
    expect(() => resourceIdsFromListResponse(null, "certificates")).toThrow(
      /not an object/,
    );
    expect(() => resourceIdsFromListResponse({}, "certificates")).toThrow(
      /no `data`/,
    );
    expect(() =>
      resourceIdsFromListResponse({ data: { id: "CERT1" } }, "certificates"),
    ).toThrow(/not an array/);
  });

  it("decodes profileContent to raw bytes and throws when absent", () => {
    const raw = Buffer.from("mobileprovision-bytes");
    const resource = { attributes: { profileContent: raw.toString("base64") } };
    expect(decodeProfileContent(resource).equals(raw)).toBe(true);
    expect(() => decodeProfileContent({ attributes: {} })).toThrow(
      /profileContent/,
    );
    expect(() => decodeProfileContent(null)).toThrow(/profileContent/);
  });

  it("formats ASC error arrays into one actionable line", () => {
    expect(
      formatAscErrors(
        {
          errors: [
            {
              status: "409",
              code: "ENTITY_ERROR",
              title: "Conflict",
              detail: "exists",
            },
          ],
        },
        409,
      ),
    ).toBe("409 — ENTITY_ERROR — Conflict — exists");
    expect(formatAscErrors({}, 500)).toBe(
      "ASC API returned HTTP 500 with no error detail",
    );
  });
});

describe("resolveAscCredentials", () => {
  it("names every missing var when the env is empty", () => {
    const { missing } = resolveAscCredentials({});
    expect(missing).toEqual([
      "APP_STORE_API_KEY_ID",
      "APP_STORE_API_ISSUER_ID",
      "APP_STORE_API_KEY_PATH or APP_STORE_API_KEY_P8",
    ]);
  });

  it("is satisfied by either the key path or the inline PEM", () => {
    const byPath = resolveAscCredentials({
      APP_STORE_API_KEY_ID: "K",
      APP_STORE_API_ISSUER_ID: "I",
      APP_STORE_API_KEY_PATH: "/tmp/AuthKey.p8",
    });
    expect(byPath.missing).toEqual([]);
    expect(byPath.keyPath).toBe("/tmp/AuthKey.p8");

    const byPem = resolveAscCredentials({
      APP_STORE_API_KEY_ID: "K",
      APP_STORE_API_ISSUER_ID: "I",
      APP_STORE_API_KEY_P8: "-----BEGIN PRIVATE KEY-----",
    });
    expect(byPem.missing).toEqual([]);
    expect(byPem.keyPem).toBe("-----BEGIN PRIVATE KEY-----");
  });

  it("treats whitespace-only values as absent", () => {
    const { missing } = resolveAscCredentials({
      APP_STORE_API_KEY_ID: "   ",
      APP_STORE_API_ISSUER_ID: "\t",
      APP_STORE_API_KEY_P8: "",
    });
    expect(missing).toContain("APP_STORE_API_KEY_ID");
    expect(missing).toContain("APP_STORE_API_ISSUER_ID");
  });
});

describe("parseMintArgs", () => {
  it("parses space- and equals-form flags", () => {
    expect(
      parseMintArgs(["--device", "ABCD", "--device-name", "lab"]),
    ).toMatchObject({
      device: "ABCD",
      deviceName: "lab",
    });
    expect(
      parseMintArgs(["--device=ABCD", "--product=/x/App.app"]),
    ).toMatchObject({
      device: "ABCD",
      product: "/x/App.app",
    });
  });

  it("treats --check-only and --dry-run as the same offline flag", () => {
    expect(parseMintArgs(["--check-only"]).checkOnly).toBe(true);
    expect(parseMintArgs(["--dry-run"]).checkOnly).toBe(true);
    expect(parseMintArgs([]).checkOnly).toBe(false);
  });

  it("falls back to the device env vars in priority order", () => {
    expect(
      parseMintArgs([], {
        ELIZA_IOS_DEVICE_UDID: "FROM_UDID",
        ELIZA_IOS_DEVICE_ID: "FROM_ID",
      }).device,
    ).toBe("FROM_UDID");
    expect(parseMintArgs([], { ELIZA_IOS_DEVICE_ID: "FROM_ID" }).device).toBe(
      "FROM_ID",
    );
    // An explicit flag always wins over the env fallback.
    expect(
      parseMintArgs(["--device", "FLAG"], { ELIZA_IOS_DEVICE_UDID: "ENV" })
        .device,
    ).toBe("FLAG");
  });

  it("ignores unknown tokens so wrapper flags pass through", () => {
    expect(parseMintArgs(["--device", "X", "--verbose"]).device).toBe("X");
  });
});

describe("isPlausibleUdid", () => {
  it("accepts both the 40-hex and 8-16 hex device forms", () => {
    expect(isPlausibleUdid("0123456789abcdef0123456789abcdef01234567")).toBe(
      true,
    );
    expect(isPlausibleUdid("00008140-0006491E2E90801C")).toBe(true);
  });

  it("rejects malformed or non-string input", () => {
    expect(isPlausibleUdid("not-a-udid")).toBe(false);
    expect(isPlausibleUdid("00008140-0006491E2E90801")).toBe(false); // 15 hex tail
    expect(isPlausibleUdid("")).toBe(false);
    expect(isPlausibleUdid(null)).toBe(false);
    expect(isPlausibleUdid(42)).toBe(false);
  });
});

describe("constants", () => {
  it("targets the ASC v1 API and the elizaOS app bundle", () => {
    expect(ASC_API_BASE).toBe("https://api.appstoreconnect.apple.com/v1");
    expect(APP_BUNDLE_ID).toBe("ai.elizaos.app");
    expect(APPEX_SUFFIXES).toContain("ElizaKeyboard");
    expect(Object.isFrozen(APPEX_SUFFIXES)).toBe(true);
  });
});
