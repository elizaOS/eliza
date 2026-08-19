/**
 * Deterministic contract tests for App Store Connect provisioning, entitlement
 * reconciliation, stale-profile replacement, and quarantined profile install.
 */
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
  ProvisioningProfileValidationError,
  profileCoversRequest,
  profileIsUsable,
  provision,
  reconcileBundleCapabilities,
  replacementDevelopmentProfileName,
  resolveAscCredentials,
  validateAndInstallProfile,
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

function decodedDevelopmentProfile({
  bundleIdentifier = "ai.elizaos.app",
  udid = "UDID",
  uuid = "UUID",
  expirationDate = new Date("2099-01-01T00:00:00.000Z"),
  getTaskAllow = true,
  entitlements = {},
} = {}) {
  const team = "TEAM123456";
  return {
    UUID: uuid,
    TeamIdentifier: [team],
    ApplicationIdentifierPrefix: [team],
    ExpirationDate: expirationDate,
    ProvisionedDevices: [udid],
    Entitlements: {
      "application-identifier": `${team}.${bundleIdentifier}`,
      "com.apple.developer.team-identifier": team,
      "get-task-allow": getTaskAllow,
      "keychain-access-groups": [`${team}.*`],
      ...entitlements,
    },
  };
}

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

  it("preserves and replaces a same-named profile that does not cover the request", async () => {
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
      "POST /v1/profiles": {
        status: 201,
        body: {
          data: {
            id: "REPLACEMENT",
            attributes: { name: "replacement", profileContent: "AA==" },
          },
        },
      },
    });
    const asc = makeAscClient({ jwt: "t", fetchImpl });
    const profile = await mintDevelopmentProfile(asc, {
      name: "n",
      bundleIdRef: "B1",
      deviceIds: ["DEV1"],
      certificateIds: ["C1"],
      replacementNameFactory: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
    expect(profile.id).toBe("REPLACEMENT");
    expect(fetchImpl.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/profiles",
      "POST /v1/profiles",
    ]);
    expect(fetchImpl.calls.some((call) => call.method === "DELETE")).toBe(
      false,
    );
    expect(fetchImpl.calls.at(-1).body.data.attributes.name).toBe(
      "n - refresh-aaaaaaaabbbb",
    );
  });

  it("preserves and replaces an expired same-named profile", async () => {
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
      "POST /v1/profiles": {
        status: 201,
        body: {
          data: {
            id: "REPLACEMENT",
            attributes: { name: "replacement", profileContent: "AA==" },
          },
        },
      },
    });
    const asc = makeAscClient({ jwt: "t", fetchImpl });
    const profile = await mintDevelopmentProfile(asc, {
      name: "n",
      bundleIdRef: "B1",
      deviceIds: ["DEV1"],
      certificateIds: ["C1"],
      replacementNameFactory: () => "ffffffff-1111-2222-3333-444444444444",
    });
    expect(profile.id).toBe("REPLACEMENT");
    expect(fetchImpl.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/profiles",
      "POST /v1/profiles",
    ]);
    expect(fetchImpl.calls.some((call) => call.method === "DELETE")).toBe(
      false,
    );
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

  it("uses a collision-resistant suffix for preserved-profile replacements", () => {
    expect(
      replacementDevelopmentProfileName(
        "Eliza Dev - ai.elizaos.app - abc",
        () => "12345678-90ab-cdef-1234-567890abcdef",
      ),
    ).toBe("Eliza Dev - ai.elizaos.app - abc - refresh-1234567890ab");
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

  it("rejects ASC profile ids that could escape the destination directory", () => {
    const root = tmpDir();
    const dir = path.join(root, "profiles");
    expect(() =>
      writeProfile(
        {
          id: "P",
          attributes: {
            uuid: "../escaped",
            profileContent: Buffer.from("untrusted").toString("base64"),
          },
        },
        dir,
      ),
    ).toThrow(/unsafe uuid\/id/);
    expect(fs.existsSync(path.join(root, "escaped.mobileprovision"))).toBe(
      false,
    );
  });
});

describe("validateAndInstallProfile", () => {
  it("never installs rejected bytes and cleans its quarantine", () => {
    const dir = tmpDir();
    const profile = {
      id: "P",
      attributes: {
        uuid: "REJECTED",
        profileContent: Buffer.from("bad-profile").toString("base64"),
      },
    };
    expect(() =>
      validateAndInstallProfile(profile, {
        dir,
        bundleIdentifier: "ai.elizaos.app",
        requiredEntitlements: {
          "com.apple.security.application-groups": ["group.ai.elizaos.app"],
        },
        decodeProfile: () =>
          decodedDevelopmentProfile({ uuid: "REJECTED", entitlements: {} }),
      }),
    ).toThrow(/does not grant target entitlements/);
    expect(fs.existsSync(path.join(dir, "REJECTED.mobileprovision"))).toBe(
      false,
    );
    expect(
      fs.readdirSync(dir).filter((name) => name.includes("quarantine")),
    ).toEqual([]);
  });

  it("keeps install failures distinct from rejected profile content", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "COLLIDE.mobileprovision"));
    let failure;
    try {
      validateAndInstallProfile(
        {
          id: "P",
          attributes: {
            uuid: "COLLIDE",
            profileContent: Buffer.from("valid-profile").toString("base64"),
          },
        },
        {
          dir,
          bundleIdentifier: "ai.elizaos.app",
          decodeProfile: () => decodedDevelopmentProfile({ uuid: "COLLIDE" }),
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ProvisioningProfileValidationError);
    expect(
      fs.readdirSync(dir).filter((name) => name.includes("quarantine")),
    ).toEqual([]);
  });

  it.each([
    [
      "another bundle",
      { bundleIdentifier: "com.attacker.other", uuid: "PROFILE" },
    ],
    ["another device", { udid: "OTHER-DEVICE", uuid: "PROFILE" }],
    [
      "an expired profile",
      {
        expirationDate: new Date("2020-01-01T00:00:00.000Z"),
        uuid: "PROFILE",
      },
    ],
    ["a non-development profile", { getTaskAllow: false, uuid: "PROFILE" }],
    ["a mismatched content UUID", { uuid: "OTHER-UUID" }],
  ])("does not install decoded content for %s", (_label, decodedOverrides) => {
    const dir = tmpDir();
    expect(() =>
      validateAndInstallProfile(
        {
          id: "P",
          attributes: {
            uuid: "PROFILE",
            profileContent: Buffer.from("untrusted").toString("base64"),
          },
        },
        {
          dir,
          bundleIdentifier: "ai.elizaos.app",
          deviceUdid: "UDID",
          decodeProfile: () => decodedDevelopmentProfile(decodedOverrides),
        },
      ),
    ).toThrow(ProvisioningProfileValidationError);
    expect(fs.existsSync(path.join(dir, "PROFILE.mobileprovision"))).toBe(
      false,
    );
    expect(
      fs.readdirSync(dir).filter((name) => name.includes("quarantine")),
    ).toEqual([]);
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
      "GET /v1/bundleIds/BID/profiles": { body: { data: [] } },
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
      decodeProfile: () => decodedDevelopmentProfile(),
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

  it("creates a replacement after capability reconciliation invalidates the stable profile", async () => {
    const dir = tmpDir();
    const stableName = developmentProfileName("ai.elizaos.app", "DEV");
    let stableProfileState = "ACTIVE";
    const goodContent = Buffer.from("good-grants").toString("base64");
    const fetchImpl = mockFetch({
      "GET /v1/devices": { body: { data: [{ id: "DEV" }] } },
      "GET /v1/certificates": { body: { data: [{ id: "CERT" }] } },
      "GET /v1/bundleIds": { body: { data: [{ id: "BID" }] } },
      "GET /v1/bundleIds/BID/bundleIdCapabilities": {
        body: { data: [] },
      },
      "POST /v1/bundleIdCapabilities": () => {
        // Apple invalidates profiles that use an App ID whose capabilities
        // changed. The following profile lookup must observe that transition.
        stableProfileState = "INVALID";
        return { status: 201, body: { data: {} } };
      },
      "GET /v1/bundleIds/BID/profiles": () => ({
        body: {
          data: [
            {
              id: "STABLE",
              attributes: {
                name: stableName,
                profileType: "IOS_APP_DEVELOPMENT",
                profileState: stableProfileState,
              },
            },
          ],
        },
      }),
      "POST /v1/profiles": (_method, _url, body) => ({
        status: 201,
        body: {
          data: {
            id: "REPLACEMENT",
            attributes: {
              name: body.data.attributes.name,
              uuid: "REPLACEMENT-UUID",
              profileContent: goodContent,
            },
          },
        },
      }),
    });

    const result = await provision({
      creds: { keyId: "K", issuerId: "I", privateKeyPem: P8 },
      udid: "UDID",
      bundleIds: [
        {
          identifier: "ai.elizaos.app",
          name: "App",
          entitlements: {
            "com.apple.security.application-groups": ["group.ai.elizaos.app"],
          },
        },
      ],
      fetchImpl,
      dir,
      now: 1_700_000_000,
      decodeProfile: (file) =>
        decodedDevelopmentProfile({
          uuid: path.basename(file, ".mobileprovision"),
          entitlements: fs.readFileSync(file, "utf8").includes("good-grants")
            ? {
                "com.apple.security.application-groups": [
                  "group.ai.elizaos.app",
                ],
              }
            : {},
        }),
      replacementNameFactory: () => "11111111-2222-3333-4444-555555555555",
    });

    expect(result.results[0].profile).toBe(
      `${stableName} - refresh-111111112222`,
    );
    expect(fetchImpl.calls.some((call) => call.method === "DELETE")).toBe(
      false,
    );
    expect(
      fetchImpl.calls.map((call) => `${call.method} ${call.path}`),
    ).toEqual(
      expect.arrayContaining([
        "POST /v1/bundleIdCapabilities",
        "GET /v1/bundleIds/BID/profiles",
        "POST /v1/profiles",
      ]),
    );
  });

  it("recovers on rerun after an admin corrects a stale App Group grant", async () => {
    const dir = tmpDir();
    const stableName = developmentProfileName("ai.elizaos.app", "DEV");
    const staleContent = Buffer.from("stale-grants").toString("base64");
    const goodContent = Buffer.from("good-grants").toString("base64");
    let adminAssignedGroup = false;
    let replacementCount = 0;
    const replacements = [];
    const replacementUuids = [
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "ffffffff-1111-2222-3333-444444444444",
    ];
    const fetchImpl = mockFetch({
      "GET /v1/devices": { body: { data: [{ id: "DEV" }] } },
      "GET /v1/certificates": { body: { data: [{ id: "CERT" }] } },
      "GET /v1/bundleIds": { body: { data: [{ id: "BID" }] } },
      "GET /v1/bundleIds/BID/bundleIdCapabilities": {
        body: {
          data: [{ attributes: { capabilityType: "APP_GROUPS" } }],
        },
      },
      "GET /v1/bundleIds/BID/profiles": () => ({
        body: {
          data: [
            {
              id: "STABLE",
              attributes: {
                name: stableName,
                profileType: "IOS_APP_DEVELOPMENT",
                profileState: "ACTIVE",
                createdDate: "2026-08-17T00:00:00Z",
              },
            },
            ...replacements.map((profile) => ({
              id: profile.id,
              attributes: {
                name: profile.attributes.name,
                profileType: "IOS_APP_DEVELOPMENT",
                profileState: "ACTIVE",
                createdDate: profile.attributes.createdDate,
              },
            })),
          ],
        },
      }),
      "GET /v1/profiles/STABLE": {
        body: {
          data: {
            id: "STABLE",
            attributes: {
              name: stableName,
              uuid: "STABLE-UUID",
              profileState: "ACTIVE",
              profileContent: staleContent,
            },
            relationships: {
              bundleId: { data: { id: "BID" } },
              devices: { data: [{ id: "DEV" }] },
              certificates: { data: [{ id: "CERT" }] },
            },
          },
        },
      },
      "GET /v1/profiles/REPLACEMENT-1": () => ({
        body: { data: replacements[0] },
      }),
      "GET /v1/profiles/REPLACEMENT-2": () => ({
        body: { data: replacements[1] },
      }),
      "POST /v1/profiles": (_method, _url, body) => {
        replacementCount += 1;
        const profile = {
          id: `REPLACEMENT-${replacementCount}`,
          attributes: {
            name: body.data.attributes.name,
            uuid: `REPLACEMENT-UUID-${replacementCount}`,
            createdDate: `2026-08-17T00:0${replacementCount}:00Z`,
            profileState: "ACTIVE",
            profileContent: adminAssignedGroup ? goodContent : staleContent,
          },
          relationships: {
            bundleId: { data: { id: "BID" } },
            devices: { data: [{ id: "DEV" }] },
            certificates: { data: [{ id: "CERT" }] },
          },
        };
        replacements.push(profile);
        return {
          status: 201,
          body: { data: profile },
        };
      },
    });
    const request = {
      creds: { keyId: "K", issuerId: "I", privateKeyPem: P8 },
      udid: "UDID",
      bundleIds: [
        {
          identifier: "ai.elizaos.app",
          name: "App",
          entitlements: {
            "com.apple.security.application-groups": ["group.ai.elizaos.app"],
          },
        },
      ],
      fetchImpl,
      dir,
      now: 1_700_000_000,
      decodeProfile: (file) =>
        decodedDevelopmentProfile({
          uuid: path.basename(file, ".mobileprovision"),
          entitlements: fs.readFileSync(file, "utf8").includes("good-grants")
            ? {
                "com.apple.security.application-groups": [
                  "group.ai.elizaos.app",
                ],
              }
            : {},
        }),
      replacementNameFactory: () => replacementUuids.shift(),
    };

    await expect(provision(request)).rejects.toThrow(
      /does not grant target entitlements.*application-groups/,
    );
    adminAssignedGroup = true;
    const recovered = await provision(request);
    const recoveredAgain = await provision(request);

    expect(recovered.results[0].profile).toBe(
      `${stableName} - refresh-ffffffff1111`,
    );
    expect(recoveredAgain.results[0].profile).toBe(
      recovered.results[0].profile,
    );
    const profilePosts = fetchImpl.calls.filter(
      (call) => call.method === "POST" && call.path === "/v1/profiles",
    );
    expect(profilePosts.map((call) => call.body.data.attributes.name)).toEqual([
      `${stableName} - refresh-aaaaaaaabbbb`,
      `${stableName} - refresh-ffffffff1111`,
    ]);
    expect(profilePosts).toHaveLength(2);
    expect(fetchImpl.calls.some((call) => call.method === "DELETE")).toBe(
      false,
    );
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
