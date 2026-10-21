/**
 * Registry failures must not read as "no agents matched".
 *
 * `UAIDResolver.search()` is the read path for agent discovery against the HOL
 * registry. A transport failure, a timeout, an error status, or an unparseable
 * body all used to be flattened into the same `[]` a genuinely empty registry
 * returns, so a caller could not tell "nobody matched" from "the registry is
 * down / the API key was rejected / we are rate limited". `resolve()` already
 * reports the same conditions through its `error` field; `search()` now rejects
 * with a typed error and keeps `[]` only for a real empty result.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { UAIDRegistryError, UAIDResolver } from "./uaid.js";

const BROKER = "https://registry.example.test/api/v1";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UAIDResolver.search", () => {
  it("returns an empty array for a genuinely empty registry result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { agents: [] })),
    );
    const resolver = new UAIDResolver({ brokerUrl: BROKER });

    await expect(resolver.search("nobody")).resolves.toEqual([]);
  });

  it("rejects when the registry answers with an error status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(503, { error: "unavailable" })),
    );
    const resolver = new UAIDResolver({ brokerUrl: BROKER });

    await expect(resolver.search("erc8004")).rejects.toThrow(
      /HOL registry search failed with 503/,
    );
  });

  it("reports the registry status on the typed error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { error: "bad api key" })),
    );
    const resolver = new UAIDResolver({ brokerUrl: BROKER });

    const failure = await resolver.search("erc8004").catch((error) => error);
    expect(failure).toBeInstanceOf(UAIDRegistryError);
    expect((failure as UAIDRegistryError).status).toBe(401);
  });

  it("rejects when the registry request fails in transport", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const resolver = new UAIDResolver({ brokerUrl: BROKER });

    await expect(resolver.search("erc8004")).rejects.toBeInstanceOf(
      UAIDRegistryError,
    );
  });

  it("rejects when the registry body is not a JSON object", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>oops</html>", { status: 200 })),
    );
    const resolver = new UAIDResolver({ brokerUrl: BROKER });

    await expect(resolver.search("erc8004")).rejects.toThrow(/HOL registry/);
  });
});
