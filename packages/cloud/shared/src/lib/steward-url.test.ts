// Exercises steward url behavior with deterministic cloud-shared lib fixtures.
import { afterEach, describe, expect, test } from "bun:test";
import { resolveBrowserStewardApiUrl } from "./steward-url";

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
    setLocation("staging.elizacloud.ai");

    expect(resolveBrowserStewardApiUrl()).toBe("https://api-staging.elizacloud.ai/steward");
  });

  test("routes production cloud host to the production API worker", () => {
    setLocation("elizacloud.ai");

    expect(resolveBrowserStewardApiUrl()).toBe("https://api.elizacloud.ai/steward");
  });

  test("falls back to same-origin steward mount for unknown hosts", () => {
    setLocation("example.pages.dev", "https://example.pages.dev");

    expect(resolveBrowserStewardApiUrl()).toBe("https://example.pages.dev/steward");
  });
});
