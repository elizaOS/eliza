/**
 * Covers `resolveRuntimeImageUrl` — how runtime-relative icon/hero paths resolve
 * to fetchable URLs. The api client and asset-url resolvers are mocked so URL
 * routing is asserted without a running server.
 */

import { describe, expect, it, vi } from "vitest";

const clientMock = vi.hoisted(() => ({
  getBaseUrl: vi.fn(() => "http://127.0.0.1:31337"),
}));

vi.mock("../../api", () => ({
  client: clientMock,
}));

vi.mock("../../utils/asset-url", () => ({
  resolveApiUrl: (path: string) => `api:${path}`,
  resolveAppAssetUrl: (path: string) => `asset:${path}`,
}));

import { resolveRuntimeImageUrl } from "./app-identity.helpers";

describe("resolveRuntimeImageUrl", () => {
  it("resolves API-served images against full app-shell runtimes", () => {
    clientMock.getBaseUrl.mockReturnValue("http://127.0.0.1:31337");

    expect(resolveRuntimeImageUrl("/api/apps/hero/steward")).toBe(
      "api:/api/apps/hero/steward",
    );
  });

  it("skips API-served image probes for dedicated cloud chat agents", () => {
    clientMock.getBaseUrl.mockReturnValue(
      "https://23766030-c096-4a14-932a-a4e43c562432.elizacloud.ai",
    );

    expect(resolveRuntimeImageUrl("/api/apps/hero/steward")).toBe("");
  });

  it("skips already-resolved API image URLs from dedicated cloud chat agents", () => {
    expect(
      resolveRuntimeImageUrl(
        "https://23766030-c096-4a14-932a-a4e43c562432.elizacloud.ai/api/apps/hero/steward",
      ),
    ).toBe("");
  });

  it("still resolves static app assets for dedicated cloud chat agents", () => {
    clientMock.getBaseUrl.mockReturnValue(
      "https://23766030-c096-4a14-932a-a4e43c562432.elizacloud.ai",
    );

    expect(resolveRuntimeImageUrl("/app-heroes/steward.png")).toBe(
      "asset:/app-heroes/steward.png",
    );
  });
});
