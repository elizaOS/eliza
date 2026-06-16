// @vitest-environment-options {"url":"https://staging.elizacloud.ai/login"}

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installApiFetchBridge } from "./api-fetch-bridge";

const originalFetch = window.fetch;

function resetBridge(): void {
  delete (window as Window & { __elizaApiFetchBridgeInstalled?: boolean })
    .__elizaApiFetchBridgeInstalled;
}

beforeEach(() => {
  resetBridge();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/login");
});

afterEach(() => {
  resetBridge();
  window.fetch = originalFetch;
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("installApiFetchBridge", () => {
  it("rewrites absolute same-origin staging Steward URLs to the staging API worker", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    window.fetch = fetchMock as unknown as typeof window.fetch;

    installApiFetchBridge();

    await fetch("https://staging.elizacloud.ai/steward/auth/providers");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api-staging.elizacloud.ai/steward/auth/providers",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("rewrites absolute same-origin staging Steward requests and preserves auth headers", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    window.fetch = fetchMock as unknown as typeof window.fetch;
    window.localStorage.setItem(STEWARD_TOKEN_KEY, "jwt");

    installApiFetchBridge();

    await fetch(
      new Request("https://staging.elizacloud.ai/steward/tenants/config", {
        headers: { "x-request-id": "test" },
      }),
    );

    const calls = fetchMock.mock.calls as unknown as Array<
      [RequestInfo | URL, RequestInit | undefined]
    >;
    const [request, init] = calls[0];
    expect(request).toBeInstanceOf(Request);
    expect((request as Request).url).toBe(
      "https://api-staging.elizacloud.ai/steward/tenants/config",
    );
    expect(init?.credentials).toBe("include");
    expect(init?.headers).toBeInstanceOf(Headers);
    const headers = init?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer jwt");
    expect(headers.get("x-request-id")).toBe("test");
  });
});
