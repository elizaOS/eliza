import { afterEach, describe, expect, it, vi } from "vitest";
import { ProxyClient } from "./proxy-client";

describe("ProxyClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects insecure proxy URLs", () => {
    expect(
      () =>
        new ProxyClient({
          id: "main",
          apiKey: "main-key",
          proxyUrl: "http://127.0.0.1:8787",
          deviceType: "ipad",
          webhookPort: 18790,
        }),
    ).toThrow("proxyUrl must use https://");
  });

  it("sends X-Device-Type header in requests", async () => {
    const client = new ProxyClient({
      id: "test-account",
      apiKey: "test-key",
      proxyUrl: "https://proxy.example.com",
      deviceType: "mac",
      webhookPort: 18790,
    });

    let capturedHeaders: Record<string, string> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({ code: 1000, data: { status: "logged_in" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await client.getStatus();

    expect(capturedHeaders["X-Device-Type"]).toBe("mac");
    expect(capturedHeaders["X-Account-ID"]).toBe("test-account");
    expect(capturedHeaders["X-API-Key"]).toBe("test-key");
  });
});
