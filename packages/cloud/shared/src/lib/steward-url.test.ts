/** Exercises Steward URL resolution with deterministic browser-host fixtures. */
import { afterEach, describe, expect, test } from "bun:test";
import { ELIZA_DOMAIN_CONTRACTS } from "@elizaos/shared/elizacloud";
import { resolveBrowserStewardApiUrl, resolveServerStewardApiUrlFromEnv } from "./steward-url";

const originalLocation = globalThis.location;

function setLocation(hostname: string, origin = `https://${hostname}`): void {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { hostname, origin },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: originalLocation,
  });
});

describe("resolveBrowserStewardApiUrl", () => {
  test("routes staging cloud host to the staging API worker", () => {
    const contract = ELIZA_DOMAIN_CONTRACTS.staging;
    setLocation(new URL(contract.cloudAppOrigin).hostname);

    expect(resolveBrowserStewardApiUrl()).toBe(`${contract.cloudApiOrigin}/steward`);
  });

  test("routes production cloud host to the production API worker", () => {
    const contract = ELIZA_DOMAIN_CONTRACTS.production;
    setLocation(new URL(contract.cloudAppOrigin).hostname);

    expect(resolveBrowserStewardApiUrl()).toBe(`${contract.cloudApiOrigin}/steward`);
  });

  test("falls back to same-origin steward mount for unknown hosts", () => {
    setLocation("example.pages.dev", "https://example.pages.dev");

    expect(resolveBrowserStewardApiUrl()).toBe("https://example.pages.dev/steward");
  });
});

describe("owned server login routing", () => {
  test("uses the owned service when a legacy upstream remains configured", () => {
    expect(
      resolveServerStewardApiUrlFromEnv({
        LOGIN_API_URL: "https://login.example.test/",
        STEWARD_API_URL: "https://legacy.example.test",
      }),
    ).toBe("https://login.example.test");
  });

  test.each(["", "not a URL", "ftp://login.example.test", 123])(
    "rejects invalid authoritative configuration %j without legacy fallback",
    (value) => {
      expect(() =>
        resolveServerStewardApiUrlFromEnv({
          LOGIN_API_URL: value,
          STEWARD_API_URL: "https://legacy.example.test",
        }),
      ).toThrow(expect.objectContaining({ code: "LOGIN_UPSTREAM_URL_INVALID" }));
    },
  );
});
