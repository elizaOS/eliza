import { afterEach, describe, expect, it, vi } from "vitest";
import { UAIDResolver } from "./uaid";

const BROKER = "https://registry.test/api/v1";

function resolver(): UAIDResolver {
  return new UAIDResolver({
    brokerUrl: BROKER,
    apiKey: "test-key",
    timeoutMs: 1_000,
  });
}

function stubFetch(impl: () => Promise<Response>): void {
  vi.stubGlobal("fetch", vi.fn(impl));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("UAIDResolver.search", () => {
  it("rejects when the registry answers with an error status", async () => {
    stubFetch(
      async () => new Response("upstream unavailable", { status: 503 }),
    );

    await expect(resolver().search("eliza")).rejects.toThrow(/503/);
  });

  it("rejects when the registry cannot be reached", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(resolver().search("eliza")).rejects.toThrow(/fetch failed/);
  });

  it("still resolves an empty list when the registry reports no matches", async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ agents: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(resolver().search("nobody")).resolves.toEqual([]);
  });
});
