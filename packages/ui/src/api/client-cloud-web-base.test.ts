// @vitest-environment jsdom

/**
 * Unit coverage for `resolveDirectCloudWebBase`: the WEB origin used to build
 * browser-navigated cloud URLs (the /auth/cli-login handoff, the first-run
 * OAuth card's authorizationUrl). Every known cloud host — API, www, app
 * ingress, dev, and the staging pairs — must map to its apex web origin: the
 * API worker answers `application/json` for its root and every unknown path,
 * which iOS Safari downloads as `document.txt` instead of rendering (#15143).
 * Pure function, no network.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
  },
  CapacitorHttp: {
    get: vi.fn(),
    post: vi.fn(),
    request: vi.fn(),
  },
}));

import { resolveDirectCloudWebBase } from "./client-cloud";

describe("resolveDirectCloudWebBase", () => {
  it.each([
    // API hosts: JSON-for-every-path workers — never navigable.
    ["https://api.elizacloud.ai", "https://elizacloud.ai"],
    ["https://api-staging.elizacloud.ai", "https://staging.elizacloud.ai"],
    // www adds a redirect hop; app/dev serve non-console surfaces.
    ["https://www.elizacloud.ai", "https://elizacloud.ai"],
    ["https://app.elizacloud.ai", "https://elizacloud.ai"],
    ["https://dev.elizacloud.ai", "https://elizacloud.ai"],
    ["https://app-staging.elizacloud.ai", "https://staging.elizacloud.ai"],
    // Apex origins are already the web origin.
    ["https://elizacloud.ai", "https://elizacloud.ai"],
    ["https://staging.elizacloud.ai", "https://staging.elizacloud.ai"],
  ])("maps %s -> %s", (input, expected) => {
    expect(resolveDirectCloudWebBase(input)).toBe(expected);
  });

  it("strips trailing slashes before matching", () => {
    expect(resolveDirectCloudWebBase("https://api.elizacloud.ai///")).toBe(
      "https://elizacloud.ai",
    );
  });

  it("passes unknown hosts through unchanged (self-hosted/dev bases)", () => {
    expect(resolveDirectCloudWebBase("http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
    expect(resolveDirectCloudWebBase("https://cloud.example.test")).toBe(
      "https://cloud.example.test",
    );
  });
});
