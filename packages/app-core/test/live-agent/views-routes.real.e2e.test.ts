/**
 * Keyless real-runtime HTTP coverage for the View Registry routes.
 *
 * Boots a REAL AgentRuntime + the REAL app-core HTTP stack via
 * {@link startLiveRuntimeServer}, then exercises the views API over real HTTP.
 * No provider keys: none of these routes call a model.
 *
 * Routes + shapes grounded in packages/agent/src/api/views-routes.ts:
 *   - GET  /api/views                  :366  → { views: [{ id, label, path, builtin, … }] }
 *   - GET  /api/views/current          :389  → { currentView: null | CurrentViewState }
 *   - POST /api/views/:id/navigate     :756  → { ok: true, viewId, viewPath, viewType, … }
 *                                              and updates currentViewState
 *   - POST /api/views/events/broadcast :396  → requires { type }, returns { ok, type, payload }
 * Built-in view ids (always registered): packages/agent/src/api/builtin-views.ts
 *   (chat, character, automations, plugins-page, settings, …).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { req } from "../helpers/http.ts";
import {
  type RuntimeHarness,
  startLiveRuntimeServer,
} from "../helpers/live-runtime-server.ts";

interface ViewEntry {
  id: string;
  label: string;
  path?: string;
  builtin?: boolean;
}

describe("views routes real coverage", () => {
  let harness: RuntimeHarness | null = null;

  beforeAll(async () => {
    harness = await startLiveRuntimeServer({
      tempPrefix: "views-routes-real-",
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  });

  function port(): number {
    if (!harness) {
      throw new Error("Live runtime harness was not started");
    }
    return harness.port;
  }

  it("GET /api/views lists the built-in shell views", async () => {
    const { status, data } = await req(port(), "GET", "/api/views");
    expect(status).toBe(200);
    const views = data.views as ViewEntry[];
    expect(Array.isArray(views)).toBe(true);
    expect(views.length).toBeGreaterThan(0);

    const ids = new Set(views.map((v) => v.id));
    // These ids come from BUILTIN_VIEWS and must always be present.
    for (const builtinId of ["chat", "character", "settings"]) {
      expect(ids.has(builtinId)).toBe(true);
    }

    const chat = views.find((v) => v.id === "chat");
    expect(chat).toBeDefined();
    expect(chat?.builtin).toBe(true);
    expect(chat?.path).toBe("/chat");
  });

  it("GET /api/views/current returns no active view before navigation", async () => {
    const { status, data } = await req(port(), "GET", "/api/views/current");
    expect(status).toBe(200);
    expect("currentView" in data).toBe(true);
  });

  it("POST /api/views/:id/navigate sets the current view and acknowledges", async () => {
    const navigate = await req(
      port(),
      "POST",
      "/api/views/settings/navigate",
      {},
    );
    expect(navigate.status).toBe(200);
    expect(navigate.data.ok).toBe(true);
    expect(navigate.data.viewId).toBe("settings");
    expect(navigate.data.viewPath).toBe("/settings");
    expect(typeof navigate.data.viewType).toBe("string");

    // The navigation is reflected by GET /api/views/current.
    const current = await req(port(), "GET", "/api/views/current");
    expect(current.status).toBe(200);
    const currentView = current.data.currentView as {
      viewId: string;
      viewPath: string;
    } | null;
    expect(currentView).not.toBeNull();
    expect(currentView?.viewId).toBe("settings");
    expect(currentView?.viewPath).toBe("/settings");
  });

  it("POST /api/views/events/broadcast requires a type and echoes the payload", async () => {
    // Missing type → 400.
    const missing = await req(
      port(),
      "POST",
      "/api/views/events/broadcast",
      {},
    );
    expect(missing.status).toBe(400);

    // Valid broadcast → ok with the type + payload echoed back.
    const broadcast = await req(port(), "POST", "/api/views/events/broadcast", {
      type: "live-test-event",
      payload: { marker: "deterministic" },
    });
    expect(broadcast.status).toBe(200);
    expect(broadcast.data.ok).toBe(true);
    expect(broadcast.data.type).toBe("live-test-event");
    expect((broadcast.data.payload as Record<string, unknown>).marker).toBe(
      "deterministic",
    );
  });
});
