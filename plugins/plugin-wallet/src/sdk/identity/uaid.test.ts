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

  it("rejects when a successful body omits the agents field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { total: 0 })),
    );
    const resolver = new UAIDResolver({ brokerUrl: BROKER });

    await expect(resolver.search("erc8004")).rejects.toBeInstanceOf(
      UAIDRegistryError,
    );
  });

  it("rejects a null entry instead of throwing a raw TypeError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { agents: [null] })),
    );
    const resolver = new UAIDResolver({ brokerUrl: BROKER });

    const failure = await resolver.search("erc8004").catch((error) => error);
    expect(failure).toBeInstanceOf(UAIDRegistryError);
    expect(failure).not.toBeInstanceOf(TypeError);
  });

  it("rejects a primitive entry instead of resolving a hollow match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { agents: ["erc8004"] })),
    );
    const resolver = new UAIDResolver({ brokerUrl: BROKER });

    await expect(resolver.search("erc8004")).rejects.toBeInstanceOf(
      UAIDRegistryError,
    );
  });

  it("rejects an entry without a uaid instead of resolving an empty match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { agents: [{ protocol: "a2a" }] })),
    );
    const resolver = new UAIDResolver({ brokerUrl: BROKER });

    await expect(resolver.search("a2a")).rejects.toBeInstanceOf(
      UAIDRegistryError,
    );
  });

  it("still maps a well-formed entry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          agents: [
            {
              uaid: "uaid:aid:eip155:8453;uid=7;proto=erc8004",
              agentId: "7",
              protocol: "erc8004",
              chain: "base",
              trustScore: 91,
              verified: true,
            },
          ],
        }),
      ),
    );
    const resolver = new UAIDResolver({ brokerUrl: BROKER });

    await expect(resolver.search("erc8004")).resolves.toEqual([
      {
        resolved: true,
        uaid: "uaid:aid:eip155:8453;uid=7;proto=erc8004",
        identity: {
          agentId: "7",
          owner: "",
          agentURI: "",
          paymentAddress: "",
          registrationFile: null,
          protocol: "erc8004",
          chain: "base",
          uaid: "uaid:aid:eip155:8453;uid=7;proto=erc8004",
        },
        protocol: "erc8004",
        chain: "base",
        trustScore: 91,
        registryVerified: true,
      },
    ]);
  });
});
