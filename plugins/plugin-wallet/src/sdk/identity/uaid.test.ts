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
 *
 * Every case below drives the resolver over a real loopback socket against a
 * real `node:http` server: no `fetch` stub, no module mock. The status code,
 * the body bytes and (for the transport case) the refused connection are
 * produced by the network stack, so the assertions describe observed behavior.
 */
import { type AddressInfo, createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { UAIDRegistryError, UAIDResolver } from "./uaid.js";

const openServers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((close) => close()));
});

/** Start a real HTTP server and return the broker URL that reaches it. */
async function serve(
  handler: (res: ServerResponse) => void,
): Promise<{ brokerUrl: string; requests: URL[] }> {
  const requests: URL[] = [];
  const server = createServer((req, res) => {
    requests.push(new URL(req.url ?? "/", "http://127.0.0.1"));
    handler(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  openServers.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return { brokerUrl: `http://127.0.0.1:${port}/api/v1`, requests };
}

/** A loopback URL that is guaranteed to refuse connections. */
async function refusedBrokerUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/api/v1`;
}

function reply(status: number, body: string, contentType = "application/json") {
  return (res: ServerResponse) => {
    res.writeHead(status, { "Content-Type": contentType });
    res.end(body);
  };
}

describe("UAIDResolver.search", () => {
  it("returns an empty array for a genuinely empty registry result", async () => {
    const { brokerUrl } = await serve(
      reply(200, JSON.stringify({ agents: [] })),
    );
    const resolver = new UAIDResolver({ brokerUrl });

    await expect(resolver.search("nobody")).resolves.toEqual([]);
  });

  it("rejects when the registry answers with an error status", async () => {
    const { brokerUrl } = await serve(
      reply(503, JSON.stringify({ error: "unavailable" })),
    );
    const resolver = new UAIDResolver({ brokerUrl });

    await expect(resolver.search("erc8004")).rejects.toThrow(
      /HOL registry search failed with 503/,
    );
  });

  it("reports the registry status on the typed error", async () => {
    const { brokerUrl } = await serve(
      reply(401, JSON.stringify({ error: "bad api key" })),
    );
    const resolver = new UAIDResolver({ brokerUrl });

    const failure = await resolver.search("erc8004").catch((error) => error);
    expect(failure).toBeInstanceOf(UAIDRegistryError);
    expect((failure as UAIDRegistryError).status).toBe(401);
  });

  it("rejects when the registry request fails in transport", async () => {
    const brokerUrl = await refusedBrokerUrl();
    const resolver = new UAIDResolver({ brokerUrl });

    const failure = await resolver.search("erc8004").catch((error) => error);
    expect(failure).toBeInstanceOf(UAIDRegistryError);
    expect(failure).not.toBeInstanceOf(TypeError);
  });

  it("rejects when the registry body is not a JSON object", async () => {
    const { brokerUrl } = await serve(
      reply(200, "<html>oops</html>", "text/html"),
    );
    const resolver = new UAIDResolver({ brokerUrl });

    await expect(resolver.search("erc8004")).rejects.toThrow(/HOL registry/);
  });

  it("rejects when a successful body omits the agents field", async () => {
    const { brokerUrl } = await serve(reply(200, JSON.stringify({ total: 0 })));
    const resolver = new UAIDResolver({ brokerUrl });

    await expect(resolver.search("erc8004")).rejects.toBeInstanceOf(
      UAIDRegistryError,
    );
  });

  it("rejects a null entry instead of throwing a raw TypeError", async () => {
    const { brokerUrl } = await serve(
      reply(200, JSON.stringify({ agents: [null] })),
    );
    const resolver = new UAIDResolver({ brokerUrl });

    const failure = await resolver.search("erc8004").catch((error) => error);
    expect(failure).toBeInstanceOf(UAIDRegistryError);
    expect(failure).not.toBeInstanceOf(TypeError);
  });

  it("rejects a primitive entry instead of resolving a hollow match", async () => {
    const { brokerUrl } = await serve(
      reply(200, JSON.stringify({ agents: ["erc8004"] })),
    );
    const resolver = new UAIDResolver({ brokerUrl });

    await expect(resolver.search("erc8004")).rejects.toBeInstanceOf(
      UAIDRegistryError,
    );
  });

  it("rejects an entry without a uaid instead of resolving an empty match", async () => {
    const { brokerUrl } = await serve(
      reply(200, JSON.stringify({ agents: [{ protocol: "a2a" }] })),
    );
    const resolver = new UAIDResolver({ brokerUrl });

    await expect(resolver.search("a2a")).rejects.toBeInstanceOf(
      UAIDRegistryError,
    );
  });

  it("still maps a well-formed entry and queries the documented endpoint", async () => {
    const { brokerUrl, requests } = await serve(
      reply(
        200,
        JSON.stringify({
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
    const resolver = new UAIDResolver({ brokerUrl });

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
    expect(requests).toHaveLength(1);
    expect(requests[0].pathname).toBe("/api/v1/agents/search");
    expect(requests[0].searchParams.get("q")).toBe("erc8004");
  });
});
