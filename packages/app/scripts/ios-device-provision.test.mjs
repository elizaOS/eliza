import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parsePlist } from "./ios-device-lib.mjs";
import {
  capabilitiesForEntitlements,
  classifyEntitlementProvisioningRequirements,
  createAscJwt,
  developmentProfileName,
  discoverAppBundleIds,
  ensureBundleId,
  ensureDeviceRegistered,
  makeAscClient,
  mintDevelopmentProfile,
  profileCoversRequest,
  profileIsUsable,
  provision,
  reconcileBundleCapabilities,
  resolveAscCredentials,
  validateBundleIds,
  validateProvisioningEntitlements,
  writeProfile,
} from "./ios-device-provision.mjs";

// A P-256 key generated once for the JWT tests (PKCS8 PEM, same shape as a .p8).
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "P-256",
});
const P8 = privateKey.export({ type: "pkcs8", format: "pem" });

const b64urlJson = (seg) =>
  JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));

/**
 * A recording fetch double that routes by `METHOD /path` (query stripped) and
 * returns a Response-like object. `routes[key]` is `{ status?, body }` or a
 * function `(method, url, body) => {status?, body}`.
 */
function mockFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = init.method || "GET";
    const u = new URL(url);
    const key = `${method} ${u.pathname}`;
    calls.push({
      method,
      path: u.pathname,
      query: u.search,
      body: init.body ? JSON.parse(init.body) : undefined,
      auth: init.headers?.Authorization,
    });
    let route = routes[key];
    if (typeof route === "function") {
      route = route(method, u, init.body ? JSON.parse(init.body) : undefined);
    }
    if (!route) {
      return {
        ok: false,
        status: 404,
        text: async () =>
          JSON.stringify({ errors: [{ detail: `no route ${key}` }] }),
      };
    }
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(route.body ?? {}),
    };
  };
  impl.calls = calls;
  return impl;
}

const tmpDirs = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ios-prov-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

describe("resolveAscCredentials", () => {
  it("throws naming every missing credential", () => {
    expect(() => resolveAscCredentials({})).toThrow(
      /APP_STORE_API_KEY_ID.*APP_STORE_API_ISSUER_ID.*APP_STORE_API_KEY_P8/s,
    );
  });

  it("names only the missing one", () => {
    expect(() =>
      resolveAscCredentials({
        APP_STORE_API_KEY_ID: "k",
        APP_STORE_API_ISSUER_ID: "i",
        APP_STORE_API_KEY_P8: "   ",
      }),
    ).toThrow(/Missing.*APP_STORE_API_KEY_P8/s);
  });

  it("accepts inline PEM and trims id/issuer", () => {
    const creds = resolveAscCredentials({
      APP_STORE_API_KEY_ID: " KID ",
      APP_STORE_API_ISSUER_ID: " ISS ",
      APP_STORE_API_KEY_P8: P8,
    });
    expect(creds).toMatchObject({ keyId: "KID", issuerId: "ISS" });
    expect(creds.privateKeyPem).toContain("BEGIN");
  });

  it("reads the P8 from a file path when it is not inline PEM", () => {
    const dir = tmpDir();
    const keyFile = path.join(dir, "AuthKey_KID.p8");
    fs.writeFileSync(keyFile, P8);
    const creds = resolveAscCredentials({
      APP_STORE_API_KEY_ID: "KID",
      APP_STORE_API_ISSUER_ID: "ISS",
      APP_STORE_API_KEY_P8: keyFile,
    });
    expect(creds.privateKeyPem).toContain("BEGIN");
  });
});

describe("createAscJwt", () => {
  it("builds a valid ES256 token with the ASC claims and a verifiable signature", () => {
    const now = 1_700_000_000;
    const jwt = createAscJwt(
      { keyId: "KID", issuerId: "ISS", privateKeyPem: P8 },
      now,
    );
    const [h, p, s] = jwt.split(".");
    expect(b64urlJson(h)).toEqual({ alg: "ES256", kid: "KID", typ: "JWT" });
    expect(b64urlJson(p)).toEqual({
      iss: "ISS",
      iat: now,
      exp: now + 20 * 60,
      aud: "appstoreconnect-v1",
    });
    // The signature must verify against the public key (raw r||s / ieee-p1363).
    const ok = crypto.verify(
      "sha256",
      Buffer.from(`${h}.${p}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(s, "base64url"),
    );
    expect(ok).toBe(true);
  });

  it("rejects a non-EC key", () => {
    const rsa = crypto
      .generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" });
    expect(() =>
      createAscJwt({ keyId: "K", issuerId: "I", privateKeyPem: rsa }),
    ).toThrow(/EC \(P-256\)/);
  });
});

describe("makeAscClient", () => {
  it("surfaces ASC error bodies verbatim (fail fast, no swallow)", async () => {
    const fetchImpl = mockFetch({
      "GET /v1/devices": {
        status: 409,
        body: { errors: [{ detail: "boom" }] },
      },
    });
    const asc = makeAscClient({ jwt: "t", fetchImpl });
    await expect(asc("GET", "/v1/devices")).rejects.toThrow(/409: boom/);
  });
});

describe("ensureDeviceRegistered / ensureBundleId — idempotent", () => {
  it("reuses an existing device and does NOT POST", async () => {
    const fetchImpl = mockFetch({
      "GET /v1/devices": { body: { data: [{ id: "DEV1" }] } },
    });
    const asc = makeAscClient({ jwt: "t", fetchImpl });
    const r = await ensureDeviceRegistered(asc, { udid: "UDID" });
    expect(r).toEqual({ id: "DEV1", created: false });
    expect(fetchImpl.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("registers the device when absent", async () => {
    const fetchImpl = mockFetch({
      "GET /v1/devices": { body: { data: [] } },
      "POST /v1/devices": { status: 201, body: { data: { id: "DEV2" } } },
    });
    const asc = makeAscClient({ jwt: "t", fetchImpl });
    const r = await ensureDeviceRegistered(asc, { udid: "UDID", name: "lane" });
    expect(r).toEqual({ id: "DEV2", created: true });
    const post = fetchImpl.calls.find((c) => c.method === "POST");
    expect(post.body.data.attributes).toMatchObject({
      udid: "UDID",
      name: "lane",
    });
  });

  it("reuses an existing bundle id", async () => {
    const fetchImpl = mockFetch({
      "GET /v1/bundleIds": { body: { data: [{ id: "B1" }] } },
    });
    const asc = makeAscClient({ jwt: "t", fetchImpl });
    const r = await ensureBundleId(asc, { identifier: "ai.elizaos.app" });
    expect(r).toEqual({ id: "B1", created: false });
  });
});

describe("ASC capability and app-group reconciliation", () => {
  it("enables every missing ASC-supported target capability", async () => {
    const fetchImpl = mockFetch({
      "GET /v1/bundleIds/B1/bundleIdCapabilities": { body: { data: [] } },
      "POST /v1/bundleIdCapabilities": { status: 201, body: { data: {} } },
    });
    const asc = makeAscClient({ jwt: "t", fetchImpl });
    const enabled = await reconcileBundleCapabilities(asc, {
      bundleIdRef: "B1",
      entitlements: {
        "com.apple.developer.associated-domains": ["applinks:eliza.app"],
        "com.apple.security.application-groups": ["group.ai.elizaos.app"],
      },
    });
    expect(enabled).toEqual(["APP_GROUPS", "ASSOCIATED_DOMAINS"]);
    expect(
      fetchImpl.calls.filter((c) => c.path === "/v1/bundleIdCapabilities"),
    ).toHaveLength(2);
  });

  it("maps every maintained entitlement requiring ASC capability state", () => {
    expect(
      capabilitiesForEntitlements({
        "aps-environment": "development",
        "com.apple.developer.healthkit": true,
      }),
    ).toEqual(["HEALTHKIT", "PUSH_NOTIFICATIONS"]);
  });

  it("classifies every entitlement in the maintained app and appex targets", () => {
    const repoRelative = path.join(
      process.cwd(),
      "packages/app-core/platforms/ios/App/App",
    );
    const packageRelative = path.join(
      process.cwd(),
      "../app-core/platforms/ios/App/App",
    );
    const root = fs.existsSync(repoRelative) ? repoRelative : packageRelative;
    const files = [
      "App.entitlements",
      "WebsiteBlockerContentExtension/WebsiteBlockerContentExtension.entitlements",
      "DeviceActivityMonitorExtension/DeviceActivityMonitorExtension.entitlements",
      "DeviceActivityReportExtension/DeviceActivityReportExtension.entitlements",
      "ElizaWidgets/ElizaWidgets.entitlements",
      "ElizaKeyboard/ElizaKeyboard.entitlements",
    ];
    const keys = new Set();
    for (const file of files) {
      const parsed = parsePlist(fs.readFileSync(path.join(root, file), "utf8"));
      for (const key of Object.keys(parsed)) keys.add(key);
    }
    const classified = classifyEntitlementProvisioningRequirements(
      Object.fromEntries([...keys].map((key) => [key, true])),
    );
    expect(classified.unclassified).toEqual([]);
    expect(classified.supportedCapabilities).toEqual([
      "APP_GROUPS",
      "ASSOCIATED_DOMAINS",
      "HEALTHKIT",
      "PUSH_NOTIFICATIONS",
    ]);
    expect(classified.profileValidatedManaged.map((row) => row.key)).toEqual(
      expect.arrayContaining([
        "com.apple.developer.family-controls",
        "com.apple.developer.healthkit.background-delivery",
        "com.apple.developer.kernel.increased-memory-limit",
        "com.apple.developer.kernel.extended-virtual-addressing",
        "com.apple.security.application-groups",
      ]),
    );
  });
});

describe("profile entitlement validation", () => {
  it("accepts granted arrays and concrete build-variable values", () => {
    expect(() =>
      validateProvisioningEntitlements(
        {
          "aps-environment": "$(APS_ENVIRONMENT)",
          "com.apple.security.application-groups": ["group.ai.elizaos.app"],
        },
        {
          "aps-environment": "development",
          "com.apple.security.application-groups": ["group.ai.elizaos.app"],
        },
        "ai.elizaos.app",
      ),
    ).not.toThrow();
  });

  it("fails closed and names missing target entitlements", () => {
    expect(() =>
      validateProvisioningEntitlements(
        { "com.apple.developer.family-controls": true },
        {},
        "ai.elizaos.app",
      ),
    ).toThrow(/ai\.elizaos\.app.*family-controls.*Account Holder\/Admin/);
  });

  it("fails closed on target entitlements without an explicit policy", () => {
    expect(() =>
      validateProvisioningEntitlements(
        { "com.apple.developer.future-capability": true },
        { "com.apple.developer.future-capability": true },
        "ai.elizaos.app",
      ),
    ).toThrow(/unclassified target entitlements.*future-capability/);
  });
});

describe("mintDevelopmentProfile", () => {
  it("reuses a valid same-named profile without destructive refresh", async () => {
    const fetchImpl = mockFetch({
      "GET /v1/profiles": {
        body: {
          data: [
            {
              id: "EXISTING",
              attributes: { name: "n", uuid: "U", profileContent: "AA==" },
              relationships: {
                bundleId: { data: { type: "bundleIds", id: "B1" } },
                devices: { data: [{ type: "devices", id: "DEV1" }] },
                certificates: {
                  data: [{ type: "certificates", id: "C1" }],
                },
              },
            },
          ],
        },
      },
    });
    const asc = makeAscClient({ jwt: "t", fetchImpl });
    const p = await mintDevelopmentProfile(asc, {
      name: "n",
      bundleIdRef: "B1",
      deviceIds: ["DEV1"],
      certificateIds: ["C1"],
    });
    expect(p.id).toBe("EXISTING");
    expect(fetchImpl.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/profiles",
    ]);
  });

  it("fails closed when a same-named profile does not cover the request", async () => {
    const fetchImpl = mockFetch({
      "GET /v1/profiles": {
        body: {
          data: [
            {
              id: "OLD",
              attributes: { name: "n", uuid: "U", profileContent: "AA==" },
              relationships: {
                bundleId: { data: { type: "bundleIds", id: "B1" } },
                devices: { data: [{ type: "devices", id: "OTHER-DEVICE" }] },
                certificates: {
                  data: [{ type: "certificates", id: "C1" }],
                },
              },
            },
          ],
        },
      },
    });
    const asc = makeAscClient({ jwt: "t", fetchImpl });
    await expect(
      mintDevelopmentProfile(asc, {
        name: "n",
        bundleIdRef: "B1",
        deviceIds: ["DEV1"],
        certificateIds: ["C1"],
      }),
    ).rejects.toThrow(/Refusing to delete/);
    expect(fetchImpl.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/profiles",
    ]);
  });

  it("fails closed when a same-named profile is expired even if it covers the request", async () => {
    const fetchImpl = mockFetch({
      "GET /v1/profiles": {
        body: {
          data: [
            {
              id: "OLD",
              attributes: {
                name: "n",
                uuid: "U",
                profileContent: "AA==",
                profileState: "EXPIRED",
                expirationDate: "2026-01-01T00:00:00.000Z",
              },
              relationships: {
                bundleId: { data: { type: "bundleIds", id: "B1" } },
                devices: { data: [{ type: "devices", id: "DEV1" }] },
                certificates: {
                  data: [{ type: "certificates", id: "C1" }],
                },
              },
            },
          ],
        },
      },
    });
    const asc = makeAscClient({ jwt: "t", fetchImpl });
    await expect(
      mintDevelopmentProfile(asc, {
        name: "n",
        bundleIdRef: "B1",
        deviceIds: ["DEV1"],
        certificateIds: ["C1"],
      }),
    ).rejects.toThrow(/expired or inactive/);
    expect(fetchImpl.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/profiles",
    ]);
  });

  it("mints a new development profile when no same-named profile exists", async () => {
    const fetchImpl = mockFetch({
      "GET /v1/profiles": { body: { data: [] } },
      "POST /v1/profiles": {
        status: 201,
        body: {
          data: {
            id: "NEW",
            attributes: { name: "n", uuid: "U", profileContent: "AA==" },
          },
        },
      },
    });
    const asc = makeAscClient({ jwt: "t", fetchImpl });
    const p = await mintDevelopmentProfile(asc, {
      name: "n",
      bundleIdRef: "B1",
      deviceIds: ["DEV1"],
      certificateIds: ["C1"],
    });
    expect(p.id).toBe("NEW");
    expect(fetchImpl.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/profiles",
      "POST /v1/profiles",
    ]);
    const post = fetchImpl.calls.find((c) => c.method === "POST");
    expect(post.body.data.attributes.profileType).toBe("IOS_APP_DEVELOPMENT");
    expect(post.body.data.relationships.devices.data).toEqual([
      { type: "devices", id: "DEV1" },
    ]);
  });
});

describe("profileCoversRequest", () => {
  it("requires bundle, requested device, and every requested certificate", () => {
    const profile = {
      relationships: {
        bundleId: { data: { id: "B1" } },
        devices: { data: [{ id: "DEV1" }, { id: "DEV2" }] },
        certificates: { data: [{ id: "C1" }, { id: "C2" }] },
      },
    };

    expect(
      profileCoversRequest(profile, {
        bundleIdRef: "B1",
        deviceIds: ["DEV1"],
        certificateIds: ["C1", "C2"],
      }),
    ).toBe(true);
    expect(
      profileCoversRequest(profile, {
        bundleIdRef: "B2",
        deviceIds: ["DEV1"],
        certificateIds: ["C1", "C2"],
      }),
    ).toBe(false);
    expect(
      profileCoversRequest(profile, {
        bundleIdRef: "B1",
        deviceIds: ["DEV3"],
        certificateIds: ["C1", "C2"],
      }),
    ).toBe(false);
    expect(
      profileCoversRequest(profile, {
        bundleIdRef: "B1",
        deviceIds: ["DEV1"],
        certificateIds: ["C1", "C3"],
      }),
    ).toBe(false);
  });
});

describe("profileIsUsable", () => {
  it("accepts active unexpired profiles and rejects inactive or expired ones", () => {
    const now = new Date("2026-07-05T00:00:00.000Z");
    expect(
      profileIsUsable(
        {
          attributes: {
            profileState: "ACTIVE",
            expirationDate: "2026-07-06T00:00:00.000Z",
          },
        },
        now,
      ),
    ).toBe(true);
    expect(
      profileIsUsable({ attributes: { profileState: "EXPIRED" } }, now),
    ).toBe(false);
    expect(
      profileIsUsable(
        { attributes: { expirationDate: "2026-07-04T00:00:00.000Z" } },
        now,
      ),
    ).toBe(false);
  });
});

describe("developmentProfileName", () => {
  it("scopes profile refresh names by device so one device cannot delete another", () => {
    const first = developmentProfileName("ai.elizaos.app", "DEVICE-A");
    const second = developmentProfileName("ai.elizaos.app", "DEVICE-B");

    expect(first).toMatch(/^Eliza Dev - ai\.elizaos\.app - [a-f0-9]{12}$/);
    expect(second).toMatch(/^Eliza Dev - ai\.elizaos\.app - [a-f0-9]{12}$/);
    expect(first).not.toBe(second);
    expect(developmentProfileName("ai.elizaos.app", "DEVICE-A")).toBe(first);
  });
});

describe("writeProfile", () => {
  it("decodes profileContent to <uuid>.mobileprovision", () => {
    const dir = tmpDir();
    const file = writeProfile(
      {
        id: "P",
        attributes: {
          uuid: "ABC",
          profileContent: Buffer.from("hello").toString("base64"),
        },
      },
      dir,
    );
    expect(file).toBe(path.join(dir, "ABC.mobileprovision"));
    expect(fs.readFileSync(file, "utf8")).toBe("hello");
  });

  it("throws when the profile has no content", () => {
    expect(() =>
      writeProfile({ id: "P", attributes: { name: "n" } }, tmpDir()),
    ).toThrow(/no profileContent/);
  });
});

describe("discoverAppBundleIds", () => {
  it("reads the app + each appex CFBundleIdentifier, de-duped", () => {
    const dir = tmpDir();
    const app = path.join(dir, "App.app");
    fs.mkdirSync(path.join(app, "PlugIns", "Widgets.appex"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(app, "Info.plist"), "x");
    fs.writeFileSync(
      path.join(app, "PlugIns", "Widgets.appex", "Info.plist"),
      "x",
    );
    const ids = {
      [path.join(app, "Info.plist")]: "ai.elizaos.app",
      [path.join(app, "PlugIns", "Widgets.appex", "Info.plist")]:
        "ai.elizaos.app.widgets",
    };
    const out = discoverAppBundleIds(app, {
      runPlutil: (p) => ids[p],
      readTargetEntitlements: (name) => ({ target: name }),
    });
    expect(out).toEqual([
      {
        identifier: "ai.elizaos.app",
        name: "App",
        entitlements: { target: "App" },
      },
      {
        identifier: "ai.elizaos.app.widgets",
        name: "Widgets",
        entitlements: { target: "Widgets" },
      },
    ]);
  });
});

describe("validateBundleIds", () => {
  it("fails the non-mutating proof when no bundle ids resolve", () => {
    expect(() => validateBundleIds([], "ios:device:provision")).toThrow(
      /ios:device:provision: no bundle ids resolved/,
    );
  });

  it("rejects empty bundle identifiers", () => {
    expect(() =>
      validateBundleIds([{ identifier: "   " }], "ios:device:provision"),
    ).toThrow(/empty bundle identifier/);
  });
});

describe("provision — full idempotent flow", () => {
  it("registers device, ensures bundles, mints + writes a profile per bundle id", async () => {
    const dir = tmpDir();
    const content = Buffer.from("profile-bytes").toString("base64");
    const expectedProfileName = developmentProfileName("ai.elizaos.app", "DEV");
    const fetchImpl = mockFetch({
      "GET /v1/devices": { body: { data: [] } },
      "POST /v1/devices": { status: 201, body: { data: { id: "DEV" } } },
      "GET /v1/certificates": { body: { data: [{ id: "CERT" }] } },
      "GET /v1/bundleIds": { body: { data: [] } },
      "POST /v1/bundleIds": { status: 201, body: { data: { id: "BID" } } },
      "GET /v1/bundleIds/BID/bundleIdCapabilities": {
        body: { data: [] },
      },
      "GET /v1/profiles": { body: { data: [] } },
      "POST /v1/profiles": {
        status: 201,
        body: {
          data: {
            id: "PROF",
            attributes: {
              name: expectedProfileName,
              uuid: "UUID",
              profileContent: content,
            },
          },
        },
      },
    });
    const result = await provision({
      creds: { keyId: "K", issuerId: "I", privateKeyPem: P8 },
      udid: "UDID",
      bundleIds: [{ identifier: "ai.elizaos.app", name: "App" }],
      fetchImpl,
      dir,
      now: 1_700_000_000,
      decodeProfile: () => ({ Entitlements: {} }),
    });
    expect(result.device).toEqual({ id: "DEV", created: true });
    expect(result.certificateIds).toEqual(["CERT"]);
    expect(result.results).toEqual([
      {
        identifier: "ai.elizaos.app",
        bundleCreated: true,
        profile: expectedProfileName,
        file: path.join(dir, "UUID.mobileprovision"),
      },
    ]);
    expect(
      fs.readFileSync(path.join(dir, "UUID.mobileprovision"), "utf8"),
    ).toBe("profile-bytes");
    const profilePost = fetchImpl.calls.find(
      (c) => c.method === "POST" && c.path === "/v1/profiles",
    );
    expect(profilePost.body.data.attributes.name).toBe(expectedProfileName);
    // Every request carried the bearer JWT.
    expect(fetchImpl.calls.every((c) => c.auth?.startsWith("Bearer "))).toBe(
      true,
    );
  });

  it("throws when no development certificate exists", async () => {
    const fetchImpl = mockFetch({
      "GET /v1/devices": { body: { data: [{ id: "DEV" }] } },
      "GET /v1/certificates": { body: { data: [] } },
    });
    await expect(
      provision({
        creds: { keyId: "K", issuerId: "I", privateKeyPem: P8 },
        udid: "UDID",
        bundleIds: [{ identifier: "ai.elizaos.app" }],
        fetchImpl,
        dir: tmpDir(),
      }),
    ).rejects.toThrow(/No DEVELOPMENT certificate/);
  });

  it("requires a udid and at least one bundle id", async () => {
    const creds = { keyId: "K", issuerId: "I", privateKeyPem: P8 };
    await expect(
      provision({ creds, udid: "", bundleIds: [{ identifier: "x" }] }),
    ).rejects.toThrow(/UDID is required/);
    await expect(
      provision({ creds, udid: "U", bundleIds: [] }),
    ).rejects.toThrow(/no bundle ids/);
  });
});
