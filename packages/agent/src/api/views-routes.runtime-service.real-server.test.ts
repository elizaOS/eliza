/**
 * Proves every server-side view interaction reaches the service owned by the
 * request's runtime. A real loopback HTTP server drives direct and activation
 * routes, while the planner action uses the same registered stateful view.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Action, type IAgentRuntime, Service } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearActiveViewContext } from "../runtime/view-action-affinity.ts";
import {
  __resetViewScopedActionRegistryForTests,
  buildViewScopedAction,
} from "../runtime/view-scoped-actions.ts";
import {
  registerPluginViews,
  unregisterPluginViews,
} from "./views-registry.ts";
import {
  clearCurrentViewState,
  handleViewsRoutes,
  setViewsBroadcastWs,
} from "./views-routes.ts";

const TEST_PLUGIN = "@test/runtime-owned-view";
const VIEW_ID = "runtime-owned-records";
const SERVICE_TYPE = "runtime-owned-records";

class RuntimeOwnedRecordsService extends Service {
  static override serviceType = SERVICE_TYPE;
  override capabilityDescription = "Stores records for a runtime-owned view.";

  readonly records = new Map<string, string>();
  activeRecordId: string | null = null;

  override async stop(): Promise<void> {}

  create(id: string, value: string): void {
    this.records.set(id, value);
    this.activeRecordId = id;
  }

  update(id: string, value: string): void {
    if (!this.records.has(id)) throw new Error(`Record "${id}" not found.`);
    this.records.set(id, value);
  }

  delete(id: string): void {
    if (!this.records.delete(id)) throw new Error(`Record "${id}" not found.`);
    if (this.activeRecordId === id) this.activeRecordId = null;
  }
}

function requireService(context?: {
  runtime?: IAgentRuntime;
}): RuntimeOwnedRecordsService {
  const service =
    context?.runtime?.getService<RuntimeOwnedRecordsService>(SERVICE_TYPE);
  if (!service) throw new Error("Owning runtime service is unavailable.");
  return service;
}

function stringParam(
  params: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = params?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function jsonResponder(
  res: http.ServerResponse,
  data: unknown,
  status = 200,
): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function errorResponder(
  res: http.ServerResponse,
  message: string,
  status = 500,
): void {
  jsonResponder(res, { error: message }, status);
}

function makeRuntime(service: RuntimeOwnedRecordsService): IAgentRuntime {
  const actions: Action[] = [];
  return {
    agentId: "runtime-owner",
    actions,
    getService: (serviceType: string) =>
      serviceType === SERVICE_TYPE ? service : null,
    emitEvent: async () => {},
    registerAction: (action: Action) => {
      if (!actions.some((candidate) => candidate.name === action.name)) {
        actions.push(action);
      }
    },
    unregisterAction: (name: string) => {
      const index = actions.findIndex((action) => action.name === name);
      if (index < 0) return false;
      actions.splice(index, 1);
      return true;
    },
  } as unknown as IAgentRuntime;
}

async function startViewsServer(runtime: IAgentRuntime): Promise<{
  baseUrl: string;
  server: http.Server;
}> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await handleViewsRoutes({
      req,
      res,
      method: req.method ?? "GET",
      pathname: url.pathname,
      url,
      json: jsonResponder,
      error: errorResponder,
      broadcastWs: vi.fn(),
      runtime,
    });
    if (!handled && !res.headersSent) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, server };
}

async function postJson(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  expectedStatus = 200,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(expectedStatus);
  return (await response.json()) as Record<string, unknown>;
}

async function getJson(
  baseUrl: string,
  path: string,
  expectedStatus = 200,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${path}`);
  expect(response.status).toBe(expectedStatus);
  return (await response.json()) as Record<string, unknown>;
}

let server: http.Server | null = null;
let pluginRoot: string | null = null;

beforeEach(async () => {
  clearCurrentViewState();
  clearActiveViewContext();
  __resetViewScopedActionRegistryForTests();
  setViewsBroadcastWs(() => {});
});

afterEach(async () => {
  unregisterPluginViews(TEST_PLUGIN);
  clearCurrentViewState();
  clearActiveViewContext();
  setViewsBroadcastWs(null);
  __resetViewScopedActionRegistryForTests();
  vi.restoreAllMocks();
  if (server) {
    const activeServer = server;
    await new Promise<void>((resolve, reject) => {
      activeServer.close((error) => {
        if (
          error &&
          (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
        ) {
          reject(error);
          return;
        }
        resolve();
      });
      activeServer.closeIdleConnections?.();
      activeServer.closeAllConnections?.();
    });
    server = null;
  }
  if (pluginRoot) {
    await rm(pluginRoot, { recursive: true, force: true });
    pluginRoot = null;
  }
});

describe("runtime-owned view interactions over the real HTTP route", () => {
  it("rejects malformed asset encoding while preserving encoded asset names", async () => {
    const service = new RuntimeOwnedRecordsService();
    const runtime = makeRuntime(service);
    pluginRoot = await mkdtemp(path.join(tmpdir(), "eliza-view-assets-"));
    const bundleDir = path.join(pluginRoot, "dist", "views");
    await mkdir(bundleDir, { recursive: true });
    await mkdir(path.join(bundleDir, "chunks"), { recursive: true });
    await writeFile(path.join(bundleDir, "bundle.js"), "export {};\n");
    await writeFile(
      path.join(bundleDir, "chunk name.js"),
      "export const asset = true;\n",
    );
    await writeFile(
      path.join(bundleDir, "chunks", "nested.js"),
      "export const nested = true;\n",
    );
    await writeFile(
      path.join(bundleDir, "..safe.js"),
      "export const dotPrefixed = true;\n",
    );
    await writeFile(
      path.join(pluginRoot, "dist", "outside.js"),
      "must not escape the bundle directory\n",
    );
    if (process.platform !== "win32") {
      await symlink(
        path.join(pluginRoot, "dist"),
        path.join(bundleDir, "escape"),
      );
      await symlink("loop-b", path.join(bundleDir, "loop-a"));
      await symlink("loop-a", path.join(bundleDir, "loop-b"));
    }

    await registerPluginViews(
      {
        name: TEST_PLUGIN,
        description: "Static asset encoding fixture.",
        views: [
          {
            id: VIEW_ID,
            label: "Static asset encoding fixture",
            bundlePath: "dist/views/bundle.js",
          },
        ],
      },
      pluginRoot,
      runtime,
    );

    const started = await startViewsServer(runtime);
    server = started.server;

    const malformedMissingView = await getJson(
      started.baseUrl,
      "/api/views/missing-view/%E0%A4",
      400,
    );
    expect(malformedMissingView.error).toBe(
      "Invalid view asset path: malformed URL encoding",
    );

    const encodedAsset = await fetch(
      `${started.baseUrl}/api/views/${VIEW_ID}/chunk%20name.js`,
    );
    expect(encodedAsset.status).toBe(200);
    expect(await encodedAsset.text()).toBe("export const asset = true;\n");

    const encodedNestedAsset = await fetch(
      `${started.baseUrl}/api/views/${VIEW_ID}/chunks%2Fnested.js`,
    );
    expect(encodedNestedAsset.status).toBe(200);
    expect(await encodedNestedAsset.text()).toBe(
      "export const nested = true;\n",
    );

    const safeDotPrefixedAsset = await fetch(
      `${started.baseUrl}/api/views/${VIEW_ID}/..safe.js`,
    );
    expect(safeDotPrefixedAsset.status).toBe(200);
    expect(await safeDotPrefixedAsset.text()).toBe(
      "export const dotPrefixed = true;\n",
    );

    if (process.platform !== "win32") {
      const symlinkEscape = await getJson(
        started.baseUrl,
        `/api/views/${VIEW_ID}/escape%2Foutside.js`,
        400,
      );
      expect(symlinkEscape.error).toBe("Malformed view asset path");

      const symlinkLoop = await getJson(
        started.baseUrl,
        `/api/views/${VIEW_ID}/loop-a%2Fasset.js`,
        400,
      );
      expect(symlinkLoop.error).toBe("Malformed view asset path");
    }

    const malformedEncoding = await getJson(
      started.baseUrl,
      `/api/views/${VIEW_ID}/%E0%A4`,
      400,
    );
    expect(malformedEncoding.error).toBe(
      "Invalid view asset path: malformed URL encoding",
    );

    for (const adversarialPath of [
      "..%2Foutside.js",
      ".%2E%2Foutside.js",
      "chunks%2F.%2E%2Foutside.js",
      "%2Fetc%2Fpasswd",
      "%00",
      "%5C..%5Coutside.js",
    ]) {
      const rejected = await getJson(
        started.baseUrl,
        `/api/views/${VIEW_ID}/${adversarialPath}`,
        400,
      );
      expect(rejected.error).toBe("Malformed view asset path");
    }

    const doubleEncodedTraversal = await getJson(
      started.baseUrl,
      `/api/views/${VIEW_ID}/%252E%252E%252Foutside.js`,
      404,
    );
    expect(doubleEncodedTraversal.error).toBe(
      'View asset "%2E%2E%2Foutside.js" not found',
    );

    const malformedHead = await fetch(
      `${started.baseUrl}/api/views/${VIEW_ID}/%E0%A4`,
      { method: "HEAD" },
    );
    expect(malformedHead.status).toBe(400);
  });

  it("keeps CRUD on one runtime service across interact, activate, and planner paths", async () => {
    const service = new RuntimeOwnedRecordsService();
    const runtime = makeRuntime(service);
    const scopedAction = {
      name: "VIEW_RUNTIME_OWNED_RECORDS_DELETE_ACTIVE",
      description: "Delete the active runtime-owned record.",
      steps: [{ kind: "agent-click" as const, target: "delete-active" }],
    };

    await registerPluginViews(
      {
        name: TEST_PLUGIN,
        description: "Stateful view used to prove runtime service ownership.",
        views: [
          {
            id: VIEW_ID,
            label: "Runtime-owned records",
            path: "/runtime-owned-records",
            surface: { capabilities: ["agent-surface"] },
            capabilities: [
              { id: "create-record", description: "Create a record." },
              { id: "update-record", description: "Update a record." },
              { id: "delete-record", description: "Delete a record." },
            ],
            scopedActions: [scopedAction],
            serverInteract: async (capability, params, context) => {
              const owned = requireService(context);
              if (capability === "create-record") {
                owned.create(
                  stringParam(params, "id"),
                  stringParam(params, "value"),
                );
              } else if (capability === "update-record") {
                owned.update(
                  stringParam(params, "id"),
                  stringParam(params, "value"),
                );
              } else if (capability === "delete-record") {
                owned.delete(stringParam(params, "id"));
              } else if (capability === "click-element") {
                const id = owned.activeRecordId;
                if (!id) throw new Error("No active record.");
                owned.update(id, "activated");
              } else if (capability === "agent-click") {
                if (stringParam(params, "id") !== "delete-active") {
                  throw new Error("Unknown agent element.");
                }
                const id = owned.activeRecordId;
                if (!id) throw new Error("No active record.");
                owned.delete(id);
              }
              return {
                success: true,
                records: Object.fromEntries(owned.records),
              };
            },
          },
        ],
      },
      process.cwd(),
      runtime,
    );

    const started = await startViewsServer(runtime);
    server = started.server;

    const platform = await getJson(started.baseUrl, "/api/views/platform-info");
    expect(platform).toMatchObject({
      dynamicLoadingAllowed: true,
      prebuiltOnly: false,
    });

    const list = await getJson(started.baseUrl, "/api/views");
    expect(list.views).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: VIEW_ID, builtin: false }),
      ]),
    );

    const detail = await getJson(started.baseUrl, `/api/views/${VIEW_ID}`);
    expect(detail).toMatchObject({
      id: VIEW_ID,
      label: "Runtime-owned records",
    });

    const search = await getJson(
      started.baseUrl,
      "/api/views/search?q=runtime-owned&limit=1",
    );
    expect(search).toMatchObject({ query: "runtime-owned" });
    expect(search.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: VIEW_ID })]),
    );

    const missing = await getJson(
      started.baseUrl,
      "/api/views/missing-runtime-view",
      404,
    );
    expect(missing.error).toBe('View "missing-runtime-view" not found');

    const hero = await fetch(`${started.baseUrl}/api/views/${VIEW_ID}/hero`);
    expect(hero.status).toBe(200);
    expect(hero.headers.get("content-type")).toContain("image/svg+xml");
    expect(await hero.text()).toContain("Runtime-owned records");

    const broadcast = await postJson(
      started.baseUrl,
      "/api/views/events/broadcast",
      { type: "runtime-records:refresh", payload: { source: "test" } },
    );
    expect(broadcast).toEqual({
      ok: true,
      type: "runtime-records:refresh",
      payload: { source: "test" },
    });

    const invalidBroadcast = await postJson(
      started.baseUrl,
      "/api/views/events/broadcast",
      { payload: { source: "test" } },
      400,
    );
    expect(invalidBroadcast.error).toBe('Missing required field "type"');

    const emptySearch = await getJson(started.baseUrl, "/api/views/search?q=");
    expect(emptySearch).toEqual({ results: [], query: "" });

    const malformedView = await getJson(
      started.baseUrl,
      "/api/views/%E0%A4%A",
      400,
    );
    expect(malformedView.error).toBe("Malformed view id");

    const missingResultId = await postJson(
      started.baseUrl,
      "/api/views/interact-result",
      {},
      400,
    );
    expect(missingResultId.error).toBe(
      "Missing requestId in interact-result body",
    );

    const undeclared = await postJson(
      started.baseUrl,
      `/api/views/${VIEW_ID}/interact`,
      { capability: "undeclared-record-operation" },
      400,
    );
    expect(undeclared.error).toContain("is not declared");

    const missingUpdate = await postJson(
      started.baseUrl,
      `/api/views/${VIEW_ID}/interact`,
      {
        capability: "update-record",
        params: { id: "missing-record", value: "cannot-save" },
      },
    );
    expect(missingUpdate).toMatchObject({
      success: false,
      error: 'Record "missing-record" not found.',
      result: { success: false },
    });
    expect(service.records.size).toBe(0);

    const created = await postJson(
      started.baseUrl,
      `/api/views/${VIEW_ID}/interact`,
      {
        capability: "create-record",
        params: { id: "record-1", value: "draft" },
      },
    );
    expect(created.success).toBe(true);
    expect(service.records.get("record-1")).toBe("draft");

    await postJson(started.baseUrl, `/api/views/${VIEW_ID}/interact`, {
      capability: "update-record",
      params: { id: "record-1", value: "saved" },
    });
    expect(service.records.get("record-1")).toBe("saved");

    const navigated = await postJson(
      started.baseUrl,
      `/api/views/${VIEW_ID}/navigate`,
      { payload: { recordId: "record-1" } },
    );
    expect(navigated).toMatchObject({
      ok: true,
      viewId: VIEW_ID,
      payload: { recordId: "record-1" },
    });

    const current = await getJson(started.baseUrl, "/api/views/current");
    expect(current.currentView).toMatchObject({ viewId: VIEW_ID });
    expect(current.justSwitched).toBe(true);

    const elements = await postJson(
      started.baseUrl,
      `/api/views/${VIEW_ID}/elements`,
      {
        elements: [
          {
            id: "activate-current",
            role: "button",
            label: "Activate current record",
          },
        ],
      },
    );
    expect(elements).toMatchObject({ accepted: true, count: 1 });

    const activated = await postJson(
      started.baseUrl,
      `/api/views/${VIEW_ID}/activate`,
      { elementId: "activate-current" },
    );
    expect(activated).toMatchObject({
      ok: true,
      elementId: "activate-current",
      element: { label: "Activate current record" },
    });
    expect(service.records.get("record-1")).toBe("activated");

    const action = buildViewScopedAction(VIEW_ID, scopedAction);
    const deleted = await action.handler(runtime, {} as never);
    expect(deleted?.success).toBe(true);
    expect(service.records.size).toBe(0);

    await expect(action.handler(runtime, {} as never)).rejects.toThrow(
      "No active record.",
    );
  });
});
