/**
 * Route-level e2e for plugin-elizamaker (issue #8802).
 *
 * Boots the plugin's declared `Route[]` (`elizaMakerRoutes`, all `rawPath`)
 * through the real production dispatcher (`tryHandleRuntimePluginRoute`) over a
 * loopback `http.createServer` — exercising the real auth gate, JSON body
 * parsing, query parsing, and handler dispatch — with the `DropService` faked
 * via the plugin's own module-level singleton (`setElizaMakerDropService`,
 * the exact seam `handleDropRoutes` reads through `getElizaMakerDropService()`).
 *
 * No mocked `json`/`error` helpers and no shape-only checks: every assertion is
 * on a real HTTP response read back over the loopback socket. No live backends
 * are contacted (the only external surfaces — FxTwitter and on-chain RPC — are
 * never reached by the routes exercised here).
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRuntime, Route } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";

import { tryHandleRuntimePluginRoute } from "../../../../packages/agent/src/api/runtime-plugin-routes.ts";
import type { DropService, DropStatus, MintResult } from "../drop-service.ts";
import {
  getElizaMakerDropService,
  setElizaMakerDropService,
} from "../drop-service-registry.ts";
import { elizaMakerPlugin } from "../plugin.ts";

const servers: http.Server[] = [];

afterEach(async () => {
  // Restore the singleton so tests cannot leak a fake service into each other.
  setElizaMakerDropService(null);
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
  servers.length = 0;
});

const STATUS: DropStatus = {
  dropEnabled: true,
  publicMintOpen: true,
  whitelistMintOpen: false,
  mintedOut: false,
  currentSupply: 42,
  maxSupply: 2138,
  shinyPrice: "0.1",
  userHasMinted: false,
};

const MINT: MintResult = {
  agentId: 7,
  mintNumber: 43,
  txHash: "0xdeadbeef",
  isShiny: false,
};

interface FakeServiceState {
  calls: string[];
}

function makeFakeDropService(state: FakeServiceState): DropService {
  const service = {
    getStatus: async () => {
      state.calls.push("getStatus");
      return STATUS;
    },
    mint: async (name: string, endpoint: string) => {
      state.calls.push(`mint:${name}:${endpoint}`);
      return MINT;
    },
    mintShiny: async (name: string, endpoint: string) => {
      state.calls.push(`mintShiny:${name}:${endpoint}`);
      return { ...MINT, isShiny: true };
    },
  };
  return service as unknown as DropService;
}

function makeRuntime(): AgentRuntime {
  return {
    routes: elizaMakerPlugin.routes as Route[],
    character: { name: "Eliza" },
    getService: () => null,
  } as unknown as AgentRuntime;
}

async function startServer(
  runtime: AgentRuntime,
  isAuthorized: () => boolean = () => true,
): Promise<string> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      method: req.method ?? "GET",
      pathname: url.pathname,
      url,
      runtime,
      isAuthorized,
    });
    if (!handled && !res.headersSent) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function postJson(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("plugin-elizamaker routes (real dispatch)", () => {
  it("declares exactly the 8 expected routes, all rawPath, none public", () => {
    const routes = (elizaMakerPlugin.routes ?? []) as Route[];
    const sig = routes
      .map((r) => `${r.type} ${r.path}`)
      .sort()
      .join("\n");
    expect(sig).toBe(
      [
        "GET /api/drop/status",
        "GET /api/whitelist/merkle/proof",
        "GET /api/whitelist/merkle/root",
        "GET /api/whitelist/status",
        "POST /api/drop/mint",
        "POST /api/drop/mint-whitelist",
        "POST /api/whitelist/twitter/message",
        "POST /api/whitelist/twitter/verify",
      ].join("\n"),
    );
    // The plugin gates these behind the runtime auth layer (no `public: true`).
    expect(routes.every((r) => r.public !== true)).toBe(true);
    expect(routes.every((r) => r.rawPath === true)).toBe(true);
  });

  it("returns the live drop status when the service is configured", async () => {
    const state: FakeServiceState = { calls: [] };
    setElizaMakerDropService(makeFakeDropService(state));
    expect(getElizaMakerDropService()).not.toBeNull();

    const base = await startServer(makeRuntime());
    const res = await fetch(`${base}/api/drop/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DropStatus;
    expect(body.dropEnabled).toBe(true);
    expect(body.currentSupply).toBe(42);
    expect(body.shinyPrice).toBe("0.1");
    expect(state.calls).toContain("getStatus");
  });

  it("returns a disabled-drop default (200) when no service is configured", async () => {
    // /api/drop/status is intentionally tolerant: it serves a default payload
    // (not 503) while the deferred service is still booting / unconfigured.
    setElizaMakerDropService(null);
    const base = await startServer(makeRuntime());
    const res = await fetch(`${base}/api/drop/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DropStatus;
    expect(body.dropEnabled).toBe(false);
    expect(body.maxSupply).toBe(2138);
  });

  it("mints through the service on POST /api/drop/mint", async () => {
    const state: FakeServiceState = { calls: [] };
    setElizaMakerDropService(makeFakeDropService(state));
    const base = await startServer(makeRuntime());

    const res = await postJson(base, "/api/drop/mint", {
      name: "Agent Smith",
      endpoint: "https://agent.example",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MintResult;
    expect(body.agentId).toBe(7);
    expect(body.mintNumber).toBe(43);
    expect(body.isShiny).toBe(false);
    expect(state.calls).toContain("mint:Agent Smith:https://agent.example");

    // shiny:true routes to mintShiny on the same endpoint.
    const shinyRes = await postJson(base, "/api/drop/mint", {
      name: "Sparkle",
      endpoint: "https://s.example",
      shiny: true,
    });
    expect(shinyRes.status).toBe(200);
    expect(((await shinyRes.json()) as MintResult).isShiny).toBe(true);
    expect(state.calls).toContain("mintShiny:Sparkle:https://s.example");
  });

  it("returns 503 on POST /api/drop/mint when the service is unavailable", async () => {
    setElizaMakerDropService(null);
    const base = await startServer(makeRuntime());
    const res = await postJson(base, "/api/drop/mint", { name: "X" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain(
      "Drop service not configured",
    );
  });

  it("returns 503 on POST /api/drop/mint-whitelist when the service is unavailable", async () => {
    setElizaMakerDropService(null);
    const base = await startServer(makeRuntime());
    const res = await postJson(base, "/api/drop/mint-whitelist", {
      name: "X",
      proof: ["0xabc"],
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain(
      "Drop service not configured",
    );
  });

  it("enforces the auth gate on every non-public route (401)", async () => {
    const state: FakeServiceState = { calls: [] };
    setElizaMakerDropService(makeFakeDropService(state));
    const base = await startServer(makeRuntime(), () => false);

    const get = await fetch(`${base}/api/drop/status`);
    expect(get.status).toBe(401);

    const post = await postJson(base, "/api/drop/mint", { name: "X" });
    expect(post.status).toBe(401);

    const whitelist = await fetch(`${base}/api/whitelist/status`);
    expect(whitelist.status).toBe(401);

    // Auth is rejected before the handler runs: the service is never touched.
    expect(state.calls).toEqual([]);
  });

  it("validates the missing tweetUrl on POST /api/whitelist/twitter/verify (400)", async () => {
    const base = await startServer(makeRuntime());
    const res = await postJson(base, "/api/whitelist/twitter/verify", {});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "tweetUrl is required",
    );
  });

  it("validates the missing address query on GET /api/whitelist/merkle/proof (400)", async () => {
    const base = await startServer(makeRuntime());
    const res = await fetch(`${base}/api/whitelist/merkle/proof`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "address query parameter is required",
    );
  });

  it("serves the merkle root over a real response on GET /api/whitelist/merkle/root", async () => {
    const base = await startServer(makeRuntime());
    const res = await fetch(`${base}/api/whitelist/merkle/root`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      root: string;
      addressCount: number;
      proofReady: boolean;
    };
    // Empty (no whitelist file in the test state dir) → zero root, no addresses.
    expect(typeof body.root).toBe("string");
    expect(body.root.startsWith("0x")).toBe(true);
    expect(body.addressCount).toBe(0);
    expect(body.proofReady).toBe(true);
  });

  it("returns 404 for an unmatched path so dispatch is exclusive", async () => {
    const base = await startServer(makeRuntime());
    const res = await fetch(`${base}/api/drop/does-not-exist`);
    expect(res.status).toBe(404);
  });
});
