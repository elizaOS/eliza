/** Verifies resolveDirectCloudWebBase through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Unit coverage for `resolveDirectCloudWebBase`: the WEB origin used to build
 * browser-navigated auth URLs (the /auth/cli-login handoff, the first-run
 * OAuth card's authorizationUrl) and the distinct managed Cloud app origin.
 * Every known cloud host — API, www, app ingress, dev, and the staging pairs —
 * must map to its canonical product origin: the
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

import {
  resolveDirectCloudAppBase,
  resolveDirectCloudWebBase,
} from "./client-cloud";

describe("resolveDirectCloudWebBase", () => {
  it.each([
    // API hosts: JSON-for-every-path workers — never navigable.
    ["https://api.elizacloud.ai", "https://eliza.app"],
    ["https://api-staging.elizacloud.ai", "https://staging.eliza.app"],
    // www adds a redirect hop; app/dev serve non-console surfaces.
    ["https://www.elizacloud.ai", "https://eliza.app"],
    ["https://app.elizacloud.ai", "https://eliza.app"],
    ["https://dev.elizacloud.ai", "https://eliza.app"],
    ["https://app-staging.elizacloud.ai", "https://staging.eliza.app"],
    // Apex origins are already the web origin.
    ["https://elizacloud.ai", "https://eliza.app"],
    ["https://staging.elizacloud.ai", "https://staging.eliza.app"],
  ])("maps %s -> %s", (input, expected) => {
    expect(resolveDirectCloudWebBase(input)).toBe(expected);
  });

  it("strips trailing slashes before matching", () => {
    expect(resolveDirectCloudWebBase("https://api.elizacloud.ai///")).toBe(
      "https://eliza.app",
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

describe("resolveDirectCloudAppBase", () => {
  it.each([
    ["https://api.eliza.app", "https://cloud.eliza.app"],
    ["https://eliza.app", "https://cloud.eliza.app"],
    ["https://app.elizacloud.ai", "https://cloud.eliza.app"],
    ["https://api.elizacloud.ai", "https://cloud.eliza.app"],
    ["https://api-staging.eliza.app", "https://cloud-staging.eliza.app"],
    ["https://app-staging.elizacloud.ai", "https://cloud-staging.eliza.app"],
  ])("maps management input %s -> %s", (input, expected) => {
    expect(resolveDirectCloudAppBase(input)).toBe(expected);
  });

  it("passes unknown self-hosted bases through unchanged", () => {
    expect(resolveDirectCloudAppBase("http://localhost:3000/")).toBe(
      "http://localhost:3000",
    );
  });
});
