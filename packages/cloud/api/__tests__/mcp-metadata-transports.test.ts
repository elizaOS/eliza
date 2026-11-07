/**
 * Built-in MCP catalog transport proof.
 *
 * Harness: real Hono handlers — the `/api/mcps/<provider>` metadata apps and
 * the shared `/api/mcps/<provider>/:transport` gateway mounted exactly as the
 * generated router mounts them. No server, no module mocks, no network: the
 * JSON-RPC probes stop at `initialize`, which the built-in gateway answers
 * in-process.
 *
 * Contract: a catalog may advertise only transports the gateway serves. The
 * gateway mounts Streamable HTTP at `mcp` and `streamable-http` and answers
 * 404 `unsupported_transport` for anything else, so an advertised `sse`
 * transport would send a trusting client to a dead endpoint.
 */
import { describe, expect, test } from "bun:test";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import cryptoMetadata from "../mcps/crypto/route";
import timeMetadata from "../mcps/time/route";
import weatherMetadata from "../mcps/weather/route";
import { createMcpsTransportApp } from "../src/lib/mcp/mcps-transport-gateway";

type MetadataApp = typeof timeMetadata;

interface CatalogMetadata {
  endpoint?: string;
  transport?: string[];
}

const BUILTIN_CATALOGS = [
  { provider: "time", metadata: timeMetadata },
  { provider: "weather", metadata: weatherMetadata },
  { provider: "crypto", metadata: cryptoMetadata },
] as const;

/** Transports the shared gateway mounts for every built-in provider. */
const SERVED_TRANSPORTS = ["mcp", "streamable-http"] as const;

async function metadataPayload(app: MetadataApp): Promise<CatalogMetadata> {
  const res = await new Hono<AppEnv>()
    .route("/api/mcps/builtin", app)
    .request("/api/mcps/builtin");
  expect(res.status).toBe(200);
  return (await res.json()) as CatalogMetadata;
}

/** Mirrors the generated router mount: mcps/<provider>/[transport]. */
function mountGateway(provider: string): Hono<AppEnv> {
  return new Hono<AppEnv>().route(
    `/api/mcps/${provider}`,
    new Hono<AppEnv>().route(":transport", createMcpsTransportApp(provider)),
  );
}

describe("built-in MCP catalogs advertise only served transports", () => {
  test("weather and crypto list Streamable HTTP only, like the time catalog", async () => {
    expect((await metadataPayload(weatherMetadata)).transport).toEqual([
      "http",
    ]);
    expect((await metadataPayload(cryptoMetadata)).transport).toEqual(["http"]);
    expect((await metadataPayload(timeMetadata)).transport).toEqual(["http"]);
  });

  for (const { provider, metadata } of BUILTIN_CATALOGS) {
    test(`${provider}: the advertised endpoint answers JSON-RPC on the real gateway`, async () => {
      const { endpoint } = await metadataPayload(metadata);
      expect(endpoint).toBeTruthy();
      const res = await mountGateway(provider).request(
        endpoint ?? "",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {},
          }),
        },
        {},
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        jsonrpc?: string;
        result?: { serverInfo?: { name?: string } };
      };
      expect(body.jsonrpc).toBe("2.0");
      expect(body.result?.serverInfo?.name).toBe(`eliza-cloud-${provider}`);
    });

    test(`${provider}: a legacy sse path is 404 unsupported_transport`, async () => {
      const res = await mountGateway(provider).request(
        `/api/mcps/${provider}/sse`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
        },
        {},
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: string; allowed?: string[] };
      expect(body.error).toBe("unsupported_transport");
      expect(body.allowed).toEqual([...SERVED_TRANSPORTS]);
    });
  }
});
