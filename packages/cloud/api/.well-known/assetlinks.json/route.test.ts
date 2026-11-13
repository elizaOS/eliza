import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mobileAppAuthClientsRepository } from "@elizaos/cloud-shared/db/repositories/mobile-app-auth-clients";
import { parseAndroidAssetLinksConfig } from "@elizaos/cloud-shared/lib/auth/android-asset-links";
import route from "./route";

let spy: ReturnType<typeof spyOn>;
beforeAll(() => {
  spy = spyOn(
    mobileAppAuthClientsRepository,
    "listActiveAndroidAssetLinks",
  ).mockResolvedValue([]);
});
afterAll(() => {
  spy?.mockRestore();
});

const RELEASE = Array.from({ length: 32 }, (_, index) =>
  index.toString(16).padStart(2, "0").toUpperCase(),
).join(":");
const DEBUG = Array.from({ length: 32 }, () => "AB").join(":");

describe("GET /.well-known/assetlinks.json", () => {
  test("serves database statements as direct, cacheable JSON", async () => {
    spy?.mockRestore();
    spy = spyOn(
      mobileAppAuthClientsRepository,
      "listActiveAndroidAssetLinks",
    ).mockResolvedValue([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "ai.alphacompute.alphaphone",
          sha256_cert_fingerprints: [RELEASE, DEBUG],
        },
      },
    ]);
    const response = await route.request("/", {}, {});
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(response.headers.get("Location")).toBeNull();
    const body = await response.json();
    expect(body).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "ai.alphacompute.alphaphone",
          sha256_cert_fingerprints: [RELEASE, DEBUG],
        },
      },
    ]);
  });

  test("returns empty list when no clients are registered", async () => {
    spy?.mockRestore();
    spy = spyOn(
      mobileAppAuthClientsRepository,
      "listActiveAndroidAssetLinks",
    ).mockResolvedValue([]);
    const response = await route.request("/", {}, {});
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual([]);
  });

  test("database outage fails closed (500)", async () => {
    spy?.mockRestore();
    spy = spyOn(
      mobileAppAuthClientsRepository,
      "listActiveAndroidAssetLinks",
    ).mockRejectedValue(new Error("Connection refused"));
    const response = await route.request("/", {}, {});
    expect(response.status).toBe(500);
  });
});

describe("parseAndroidAssetLinksConfig", () => {
  const entry = (overrides: Record<string, unknown>) =>
    JSON.stringify([
      {
        package_name: "ai.alphacompute.alphaphone",
        sha256_cert_fingerprints: [RELEASE],
        ...overrides,
      },
    ]);

  test("accepts the optional login-credential relation for passkeys", () => {
    const parsed = parseAndroidAssetLinksConfig(
      entry({
        relations: [
          "delegate_permission/common.handle_all_urls",
          "delegate_permission/common.get_login_creds",
        ],
      }),
    );
    expect(parsed.ok && parsed.statements[0]?.relation).toEqual([
      "delegate_permission/common.handle_all_urls",
      "delegate_permission/common.get_login_creds",
    ]);
  });

  test.each([
    [
      "lowercase fingerprint",
      { sha256_cert_fingerprints: [RELEASE.toLowerCase()] },
      "invalid_fingerprint",
    ],
    [
      "short fingerprint",
      { sha256_cert_fingerprints: ["AB:CD"] },
      "invalid_fingerprint",
    ],
    [
      "no fingerprints",
      { sha256_cert_fingerprints: [] },
      "invalid_fingerprint",
    ],
    [
      "duplicate fingerprints",
      { sha256_cert_fingerprints: [RELEASE, RELEASE] },
      "invalid_fingerprint",
    ],
    [
      "single-segment package",
      { package_name: "alphaphone" },
      "invalid_package_name",
    ],
    [
      "package with slash",
      { package_name: "ai.eliza/app" },
      "invalid_package_name",
    ],
    [
      "unknown relation",
      { relations: ["delegate_permission/common.anything"] },
      "invalid_relation",
    ],
    ["empty relations", { relations: [] }, "invalid_relation"],
    ["unknown key", { namespace: "web" }, "invalid_entry"],
  ])("rejects %s", (_name, overrides, reason) => {
    expect(parseAndroidAssetLinksConfig(entry(overrides))).toEqual({
      ok: false,
      reason: reason as never,
    });
  });

  test("rejects duplicate packages and oversized or non-array config", () => {
    const one = {
      package_name: "ai.alphacompute.alphaphone",
      sha256_cert_fingerprints: [RELEASE],
    };
    expect(parseAndroidAssetLinksConfig(JSON.stringify([one, one]))).toEqual({
      ok: false,
      reason: "duplicate_package",
    });
    expect(parseAndroidAssetLinksConfig(JSON.stringify(one))).toEqual({
      ok: false,
      reason: "not_an_array",
    });
    expect(parseAndroidAssetLinksConfig("x".repeat(20_000))).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(parseAndroidAssetLinksConfig("   ")).toEqual({
      ok: true,
      statements: [],
    });
  });
});
