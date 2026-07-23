/**
 * Exercises plugin-view navigation and interaction through the real registry
 * and route dispatcher. A synthetic GUI declaration keeps routing semantics
 * under test without coupling correctness to the repository's view inventory.
 */

import { EventEmitter } from "node:events";
import type http from "node:http";
import type { Plugin } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerPluginViews,
  unregisterPluginViews,
} from "../api/views-registry.js";
import {
  clearCurrentViewState,
  handleViewsRoutes,
  resolveViewInteractResult,
  type ViewsRouteContext,
} from "../api/views-routes.js";

const PLUGIN_NAME = "test:plugin-view-routing";
const VIEW_ID = "fixture-view";
const VIEW_PATH = "/fixture";

function makeCtx(
  method: string,
  pathname: string,
  broadcastWs?: (payload: object) => void,
  body?: unknown,
  json?: (res: http.ServerResponse, body: unknown) => void,
  error?: (res: http.ServerResponse, message: string, status?: number) => void,
): ViewsRouteContext {
  const url = new URL(`http://localhost${pathname}`);
  const req = new EventEmitter() as http.IncomingMessage;
  req.headers = { "x-elizaos-client-id": "plugin-view-routing-client" };
  if (body !== undefined) {
    const chunk = Buffer.from(JSON.stringify(body));
    process.nextTick(() => {
      req.emit("data", chunk);
      req.emit("end");
    });
  } else if (method === "POST") {
    process.nextTick(() => req.emit("end"));
  }
  return {
    req,
    res: {} as http.ServerResponse,
    method,
    pathname: url.pathname,
    url,
    json: json ?? (() => {}),
    error: error ?? (() => {}),
    broadcastWs,
    broadcastWsToClientId: (_clientId, payload) => {
      broadcastWs?.(payload);
      return broadcastWs ? 1 : 0;
    },
  };
}

describe("plugin view routing", () => {
  beforeEach(async () => {
    await registerPluginViews(
      {
        name: PLUGIN_NAME,
        description: "Plugin view routing fixture",
        actions: [],
        views: [
          {
            id: VIEW_ID,
            label: "Fixture view",
            path: VIEW_PATH,
            viewType: "gui",
            bundlePath: "/fixture-view.js",
            componentExport: "FixtureView",
            visibleInManager: true,
          },
        ],
      } satisfies Plugin,
      undefined,
    );
  });

  afterEach(() => {
    unregisterPluginViews(PLUGIN_NAME);
    clearCurrentViewState();
  });

  it("routes a GUI navigation through the registered declaration", async () => {
    const broadcasts: object[] = [];
    let resultBody: unknown = null;
    let errorBody: unknown = null;

    await handleViewsRoutes(
      makeCtx(
        "POST",
        `/api/views/${VIEW_ID}/navigate?viewType=gui`,
        (payload) => broadcasts.push(payload),
        undefined,
        (_res, body) => {
          resultBody = body;
        },
        (_res, message, status) => {
          errorBody = { message, status };
        },
      ),
    );

    expect(errorBody).toBeNull();
    expect(broadcasts[0]).toMatchObject({
      type: "shell:navigate:view",
      viewId: VIEW_ID,
      viewType: "gui",
      viewPath: VIEW_PATH,
    });
    expect(resultBody).toMatchObject({
      ok: true,
      viewId: VIEW_ID,
      viewType: "gui",
    });
  });

  it("dispatches a GUI interaction and returns the client result", async () => {
    const broadcasts: object[] = [];
    let resultBody: unknown = null;
    let errorBody: unknown = null;

    await handleViewsRoutes(
      makeCtx(
        "POST",
        `/api/views/${VIEW_ID}/interact?viewType=gui`,
        (payload) => {
          broadcasts.push(payload);
          const event = payload as {
            type?: string;
            requestId?: string;
            viewId?: string;
            viewType?: string;
          };
          if (
            event.type === "view:interact" &&
            typeof event.requestId === "string"
          ) {
            resolveViewInteractResult({
              requestId: event.requestId,
              success: true,
              result: {
                viewId: event.viewId,
                viewType: event.viewType,
                state: "ok",
              },
            });
          }
        },
        { capability: "get-state", timeoutMs: 1_000 },
        (_res, body) => {
          resultBody = body;
        },
        (_res, message, status) => {
          errorBody = { message, status };
        },
      ),
    );

    expect(errorBody).toBeNull();
    expect(broadcasts[0]).toMatchObject({
      type: "view:interact",
      viewId: VIEW_ID,
      viewType: "gui",
      capability: "get-state",
    });
    expect(resultBody).toMatchObject({
      success: true,
      result: { viewId: VIEW_ID, viewType: "gui", state: "ok" },
    });
  });

  it.each(["tui", "xr"] as const)(
    "falls back from a %s request to the registered GUI declaration",
    async (requestedViewType) => {
      const broadcasts: object[] = [];
      let resultBody: unknown = null;
      let errorBody: unknown = null;

      await handleViewsRoutes(
        makeCtx(
          "POST",
          `/api/views/${VIEW_ID}/navigate?viewType=${requestedViewType}`,
          (payload) => broadcasts.push(payload),
          undefined,
          (_res, body) => {
            resultBody = body;
          },
          (_res, message, status) => {
            errorBody = { message, status };
          },
        ),
      );

      expect(errorBody).toBeNull();
      expect(broadcasts[0]).toMatchObject({
        type: "shell:navigate:view",
        viewId: VIEW_ID,
        viewType: "gui",
      });
      expect(resultBody).toMatchObject({
        ok: true,
        viewId: VIEW_ID,
        viewType: "gui",
      });
    },
  );

  it.each(["tui", "xr"] as const)(
    "returns 404 for an unknown %s interaction target",
    async (requestedViewType) => {
      let resultBody: unknown = null;
      let errorBody: unknown = null;

      await handleViewsRoutes(
        makeCtx(
          "POST",
          `/api/views/does-not-exist/interact?viewType=${requestedViewType}`,
          undefined,
          { capability: "get-state", timeoutMs: 1_000 },
          (_res, body) => {
            resultBody = body;
          },
          (_res, message, status) => {
            errorBody = { message, status };
          },
        ),
      );

      expect(resultBody).toBeNull();
      expect(errorBody).toEqual({
        message: 'View "does-not-exist" not found',
        status: 404,
      });
    },
  );
});
