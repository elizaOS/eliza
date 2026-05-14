/**
 * Tests for `GET /api/cloud/voices`.
 *
 * The route delegates to `fetchCloudVoiceCatalog` (in plugin-elizacloud,
 * tested separately) and to `ensureRouteAuthorized` (tested via the auth
 * tests). Here we cover the route-layer behaviour:
 *
 *   - 200 + the catalog payload when everything's fine
 *   - 200 + empty list when no runtime is up
 *   - 200 + empty list when the catalog throws unexpectedly
 *   - 405 on non-GET
 *   - false (passthrough) when the path doesn't match
 *   - 401 propagation when auth fails
 *
 * Both dependencies are injected via the `deps` parameter on
 * `handleCloudVoiceRoutes`, so the tests never touch the real plugin or
 * the real auth subsystem. The runtime, when present, is opaque — the
 * route never calls into it directly.
 */
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";

import {
  type CloudVoiceRouteDeps,
  handleCloudVoiceRoutes,
} from "./cloud-voice-routes";
import type { CompatRuntimeState } from "./compat-route-shared";

interface CapturedResponse {
  status?: number;
  headers: Record<string, string>;
  body?: string;
  headersSent: boolean;
}

function makeReqRes(opts: { url?: string; method?: string } = {}): {
  req: import("node:http").IncomingMessage;
  res: import("node:http").ServerResponse;
  captured: CapturedResponse;
} {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  Object.defineProperty(socket, "localPort", {
    value: 31337,
    configurable: true,
  });
  const req = {
    method: opts.method ?? "GET",
    url: opts.url ?? "/api/cloud/voices",
    headers: { host: "127.0.0.1:31337" },
    socket,
  } as unknown as import("node:http").IncomingMessage;

  const captured: CapturedResponse = { headers: {}, headersSent: false };
  const res = {
    statusCode: 200,
    get headersSent() {
      return captured.headersSent;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      if (headers) Object.assign(captured.headers, headers);
      return res;
    },
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
    },
    end(body?: string) {
      if (body !== undefined) captured.body = body;
      captured.status ??= res.statusCode;
      captured.headersSent = true;
    },
  } as unknown as import("node:http").ServerResponse & { statusCode: number };

  return { req, res, captured };
}

function stateWithoutRuntime(): CompatRuntimeState {
  return {
    current: null,
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
}

function stateWithRuntime(): CompatRuntimeState {
  return {
    current: {
      getService: () => null,
    } as unknown as CompatRuntimeState["current"],
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
}

interface CallCounts {
  fetchCatalog: number;
  ensureAuthorized: number;
}

function makeDeps(
  overrides: {
    catalog?: unknown[];
    catalogError?: Error;
    authResult?: boolean;
  } = {},
): { deps: CloudVoiceRouteDeps; counts: CallCounts } {
  const counts: CallCounts = { fetchCatalog: 0, ensureAuthorized: 0 };
  const deps: CloudVoiceRouteDeps = {
    fetchCatalog: (async () => {
      counts.fetchCatalog += 1;
      if (overrides.catalogError) throw overrides.catalogError;
      return (overrides.catalog ?? []) as never;
    }) as CloudVoiceRouteDeps["fetchCatalog"],
    ensureAuthorized: async (_req, res) => {
      counts.ensureAuthorized += 1;
      if (overrides.authResult === false) {
        // Emulate the real implementation sending a 401.
        res.statusCode = 401;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return false;
      }
      return true;
    },
  };
  return { deps, counts };
}

describe("GET /api/cloud/voices", () => {
  it("returns the cloud catalog when the runtime is up and authorized", async () => {
    const payload = [
      { id: "v-1", name: "Voice One" },
      { id: "v-2", name: "Voice Two", gender: "female", category: "premade" },
    ];
    const { deps, counts } = makeDeps({ catalog: payload });
    const { req, res, captured } = makeReqRes();

    const handled = await handleCloudVoiceRoutes(
      req,
      res,
      stateWithRuntime(),
      deps,
    );

    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body ?? "{}")).toEqual({ voices: payload });
    expect(counts.fetchCatalog).toBe(1);
    expect(counts.ensureAuthorized).toBe(1);
  });

  it("returns 200 + empty list when no runtime is up (catalog never called)", async () => {
    const { deps, counts } = makeDeps({
      catalog: [{ id: "should-not-appear", name: "x" }],
    });
    const { req, res, captured } = makeReqRes();
    const handled = await handleCloudVoiceRoutes(
      req,
      res,
      stateWithoutRuntime(),
      deps,
    );
    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body ?? "{}")).toEqual({ voices: [] });
    expect(counts.fetchCatalog).toBe(0);
  });

  it("returns 200 + empty list when the catalog unexpectedly throws", async () => {
    const { deps } = makeDeps({ catalogError: new Error("boom") });
    const { req, res, captured } = makeReqRes();
    const handled = await handleCloudVoiceRoutes(
      req,
      res,
      stateWithRuntime(),
      deps,
    );
    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body ?? "{}")).toEqual({ voices: [] });
  });

  it("returns 405 on POST/PUT/DELETE/PATCH (auth + catalog never called)", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const { deps, counts } = makeDeps({
        catalog: [{ id: "v", name: "v" }],
      });
      const { req, res, captured } = makeReqRes({ method });
      const handled = await handleCloudVoiceRoutes(
        req,
        res,
        stateWithRuntime(),
        deps,
      );
      expect(handled, `method=${method}`).toBe(true);
      expect(captured.status, `method=${method}`).toBe(405);
      expect(counts.ensureAuthorized, `method=${method}`).toBe(0);
      expect(counts.fetchCatalog, `method=${method}`).toBe(0);
    }
  });

  it("returns false (passthrough) for an unrelated path", async () => {
    const { deps, counts } = makeDeps({ catalog: [] });
    const { req, res, captured } = makeReqRes({ url: "/api/cloud/other" });
    const handled = await handleCloudVoiceRoutes(
      req,
      res,
      stateWithRuntime(),
      deps,
    );
    expect(handled).toBe(false);
    expect(captured.status).toBeUndefined();
    expect(counts.ensureAuthorized).toBe(0);
    expect(counts.fetchCatalog).toBe(0);
  });

  it("propagates 401 when the auth gate rejects (catalog never called)", async () => {
    const { deps, counts } = makeDeps({
      authResult: false,
      catalog: [{ id: "v", name: "v" }],
    });
    const { req, res, captured } = makeReqRes();
    const handled = await handleCloudVoiceRoutes(
      req,
      res,
      stateWithRuntime(),
      deps,
    );
    expect(handled).toBe(true);
    expect(captured.status).toBe(401);
    expect(JSON.parse(captured.body ?? "{}")).toEqual({ error: "Unauthorized" });
    expect(counts.fetchCatalog).toBe(0);
  });
});
