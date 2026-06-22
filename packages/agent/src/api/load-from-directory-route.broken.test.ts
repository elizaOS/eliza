/**
 * Domain H (HIGH) — broken-reload recovery proven at the HTTP route level.
 *
 * The sibling unit test `runtime/load-plugin-from-directory-reload.test.ts`
 * already pins the rollback guarantee at the FUNCTION level (calling
 * `loadPluginFromDirectory` directly). What was missing — and what the
 * mocked-chat-text assertions never actually exercised — is the real
 * `POST /api/plugins/load-from-directory` route: that a genuinely broken plugin
 * directory POSTed over the wire returns the route's error status (HTTP 422)
 * AND leaves the running runtime with ZERO partial registration (its actions,
 * providers, and registered views are byte-for-byte unchanged).
 *
 * Fidelity: the route body lives inline inside the non-exported `handleRequest`
 * in `server.ts` (it is not an exported handler like `handleCommandsRoutes`),
 * so we cannot import it. Instead this test reconstructs the route over a real
 * `http.createServer` loopback using the EXACT same building blocks the server
 * uses — the real `isLocalCodeExecutionAllowed` guard, the real
 * `readJsonBody`/`sendJson`/`sendJsonError` primitives from `@elizaos/core`, the
 * real absolute-path validation, and the real `loadPluginFromDirectory` in the
 * same try/catch that maps any throw to a 422 `{ ok: false, error }` body
 * (mirrors server.ts:2503-2549). The plugin module is genuinely imported and
 * registration is attempted against a REAL `AgentRuntime` over a real socket —
 * no mocks of the load path. See the deviation note in the PR for why the inline
 * route is mirrored rather than imported.
 *
 * Deterministic: real AgentRuntime + real filesystem temp dirs + real loopback
 * fetch. No fake timers, no stubbed import/registration.
 */

import fsp from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  buildStoreVariantBlockedMessage,
  isLocalCodeExecutionAllowed,
  readJsonBody,
  sendJson,
  sendJsonError,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetLoadedDirectoryPluginsForTests,
  getLoadedDirectoryPlugins,
} from "../runtime/load-plugin-from-directory.ts";
import { listViews } from "./views-registry.ts";

let tmpDir: string;
const servers: http.Server[] = [];

beforeEach(async () => {
  _resetLoadedDirectoryPluginsForTests();
  tmpDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "agent-load-dir-route-broken-"),
  );
});

afterEach(async () => {
  _resetLoadedDirectoryPluginsForTests();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

/**
 * A faithful reconstruction of the inline `POST /api/plugins/load-from-directory`
 * route from `server.ts` (lines 2503-2549). Uses the real core primitives the
 * server uses, so the wire contract under test is the production contract.
 */
async function startLoadFromDirectoryServer(
  runtime: AgentRuntime,
): Promise<string> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    if (
      method === "POST" &&
      url.pathname === "/api/plugins/load-from-directory"
    ) {
      // Same store-variant guard as the real route.
      if (!isLocalCodeExecutionAllowed()) {
        sendJsonError(
          res,
          buildStoreVariantBlockedMessage("Local plugin loading"),
          403,
        );
        return;
      }
      if (!runtime) {
        sendJsonError(res, "Agent runtime is not available", 503);
        return;
      }
      const body = await readJsonBody<{ directory?: unknown; entry?: unknown }>(
        req,
        res,
      );
      if (body === null) return;
      const directory =
        typeof body.directory === "string" ? body.directory.trim() : "";
      if (!directory || !path.isAbsolute(directory)) {
        sendJsonError(res, "'directory' must be an absolute path", 400);
        return;
      }
      const entry = typeof body.entry === "string" ? body.entry : undefined;
      try {
        // Real loader, real dynamic import, real runtime.registerPlugin.
        const { loadPluginFromDirectory } = await import(
          "../runtime/load-plugin-from-directory.ts"
        );
        const result = await loadPluginFromDirectory({
          runtime,
          directory,
          ...(entry ? { entry } : {}),
        });
        sendJson(res, { ok: true, ...result });
      } catch (err) {
        sendJson(
          res,
          {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          },
          422,
        );
      }
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function scaffold(
  dir: string,
  pkg: Record<string, unknown>,
  files: Record<string, string>,
): Promise<string> {
  const root = path.join(tmpDir, dir);
  await fsp.mkdir(root, { recursive: true });
  await fsp.writeFile(
    path.join(root, "package.json"),
    JSON.stringify(pkg, null, 2),
  );
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content);
  }
  return root;
}

/** A healthy control plugin so "unchanged" is a meaningful, non-empty baseline. */
const HEALTHY_PLUGIN_JS = `
export default {
  name: "route-broken-control-plugin",
  description: "healthy baseline plugin",
  actions: [
    {
      name: "ROUTE_CONTROL_PING",
      description: "pong",
      examples: [],
      similes: [],
      validate: async () => true,
      handler: async () => ({ pong: true }),
    },
  ],
  providers: [
    {
      name: "ROUTE_CONTROL_PROVIDER",
      get: async () => ({ text: "control" }),
    },
  ],
};
`;

interface RouteResult {
  ok: boolean;
  error?: string;
  pluginName?: string;
  loaded?: boolean;
}

async function postDirectory(
  baseUrl: string,
  directory: string,
  entry?: string,
): Promise<{ status: number; body: RouteResult }> {
  const response = await fetch(`${baseUrl}/api/plugins/load-from-directory`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ directory, ...(entry ? { entry } : {}) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as RouteResult,
  };
}

/** Snapshot of every runtime registration surface, for an exact "unchanged" diff. */
function registrationSnapshot(runtime: AgentRuntime): {
  actions: string[];
  providers: string[];
  views: string[];
} {
  return {
    actions: runtime.actions.map((a) => a.name).sort(),
    providers: runtime.providers.map((p) => p.name).sort(),
    views: listViews({ developerMode: true })
      .map((v) => v.id)
      .sort(),
  };
}

describe("POST /api/plugins/load-from-directory — broken plugin (Domain H)", () => {
  it("returns 422 and leaves registration untouched when the module throws at import time", async () => {
    const runtime = new AgentRuntime({ logLevel: "fatal" });
    const baseUrl = await startLoadFromDirectoryServer(runtime);

    // Load a healthy control plugin first so the rollback assertion is real.
    const healthyDir = await scaffold(
      "plugin-healthy-control-1",
      { name: "@local/plugin-healthy-control-1", main: "dist/index.js" },
      { "dist/index.js": HEALTHY_PLUGIN_JS },
    );
    const healthy = await postDirectory(baseUrl, healthyDir);
    expect(healthy.status).toBe(200);
    expect(healthy.body.ok).toBe(true);
    expect(healthy.body.pluginName).toBe("route-broken-control-plugin");
    expect(runtime.actions.some((a) => a.name === "ROUTE_CONTROL_PING")).toBe(
      true,
    );

    const before = registrationSnapshot(runtime);
    const trackedBefore = getLoadedDirectoryPlugins().map((e) => e.pluginName);

    // A genuinely broken plugin: throws at module top level (IMPORT time),
    // before runtime.registerPlugin can run.
    const brokenDir = await scaffold(
      "plugin-broken-import",
      { name: "@local/plugin-broken-import", main: "dist/index.js" },
      {
        "dist/index.js": `throw new Error("import-time boom from broken plugin");\n`,
      },
    );

    const broken = await postDirectory(baseUrl, brokenDir);

    // Route maps the throw to HTTP 422 with a structured error body.
    expect(broken.status).toBe(422);
    expect(broken.body.ok).toBe(false);
    expect(broken.body.error).toMatch(/import-time boom/);

    // No partial registration: actions, providers, and views are unchanged,
    // and the control plugin is still fully live.
    expect(registrationSnapshot(runtime)).toEqual(before);
    expect(runtime.actions.some((a) => a.name === "ROUTE_CONTROL_PING")).toBe(
      true,
    );
    // The broken plugin name never entered the loaded-directory tracking map.
    expect(getLoadedDirectoryPlugins().map((e) => e.pluginName)).toEqual(
      trackedBefore,
    );
    expect(
      getLoadedDirectoryPlugins().some(
        (e) => e.pluginName === "@local/plugin-broken-import",
      ),
    ).toBe(false);
  });

  it("returns 422 and leaves registration untouched when the export is an invalid plugin shape", async () => {
    const runtime = new AgentRuntime({ logLevel: "fatal" });
    const baseUrl = await startLoadFromDirectoryServer(runtime);

    const healthyDir = await scaffold(
      "plugin-healthy-control-2",
      { name: "@local/plugin-healthy-control-2", main: "dist/index.js" },
      { "dist/index.js": HEALTHY_PLUGIN_JS },
    );
    const healthy = await postDirectory(baseUrl, healthyDir);
    expect(healthy.status).toBe(200);
    expect(healthy.body.ok).toBe(true);

    const before = registrationSnapshot(runtime);

    // Imports cleanly but exports an INVALID plugin shape: no string `name`,
    // yet it carries an action+view that MUST NOT leak into the runtime. This is
    // the partial-registration trap — the loader must reject the whole module.
    const invalidDir = await scaffold(
      "plugin-invalid-shape",
      { name: "@local/plugin-invalid-shape", main: "dist/index.js" },
      {
        "dist/index.js": `export default {
  description: "no name field => invalid plugin shape",
  actions: [
    {
      name: "ROUTE_BROKEN_LEAKED_ACTION",
      description: "must never register",
      examples: [],
      similes: [],
      validate: async () => true,
      handler: async () => ({}),
    },
  ],
  views: [
    {
      id: "route-broken-leaked-view",
      label: "Leaked",
      path: "/route-broken-leaked",
      bundlePath: "dist/views/bundle.js",
      componentExport: "Leaked",
    },
  ],
};
`,
      },
    );

    const invalid = await postDirectory(baseUrl, invalidDir);

    expect(invalid.status).toBe(422);
    expect(invalid.body.ok).toBe(false);
    expect(invalid.body.error).toMatch(/no valid plugin export/);

    // No partial registration whatsoever.
    expect(registrationSnapshot(runtime)).toEqual(before);
    expect(
      runtime.actions.some((a) => a.name === "ROUTE_BROKEN_LEAKED_ACTION"),
    ).toBe(false);
    expect(
      listViews({ developerMode: true }).some(
        (v) => v.id === "route-broken-leaked-view",
      ),
    ).toBe(false);
  });

  it("rejects a non-absolute directory with HTTP 400 (and never touches the runtime)", async () => {
    const runtime = new AgentRuntime({ logLevel: "fatal" });
    const baseUrl = await startLoadFromDirectoryServer(runtime);
    const before = registrationSnapshot(runtime);

    const response = await fetch(`${baseUrl}/api/plugins/load-from-directory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: "relative/not/absolute" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/absolute path/);
    expect(registrationSnapshot(runtime)).toEqual(before);
  });
});
