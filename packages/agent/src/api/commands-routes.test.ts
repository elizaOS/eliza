/**
 * Unit coverage for `handleCommandsRoutes` (the GET /api/commands catalog),
 * driving the real handler with stubbed req/res and json/error spies — no HTTP
 * server, deterministic, runtime null or a bare `{ agentId }` stub. Pins surface
 * scoping, gui-only exclusion, auth/dynamic-choice pass-through, and #8798
 * view-scoped command visibility.
 */
import { describe, expect, it, vi } from "vitest";

import { handleCommandsRoutes } from "./commands-routes.ts";

const res = {} as never;

function makeUrl(path: string): URL {
  return new URL(`http://localhost${path}`);
}

interface ServedArg {
  name: string;
  required?: boolean;
  choices?: string[];
  dynamicChoices?: string;
}

interface ServedCommand {
  key: string;
  requiresAuth: boolean;
  requiresElevated: boolean;
  target: { kind: string };
  args: ServedArg[];
}

interface ServedPayload {
  commands: ServedCommand[];
  surface: string | null;
  activeViewId: string | null;
  agentId: string | null;
  generatedAt: string;
}

/** Drive the handler for a GET against the catalog and return the served payload. */
async function fetchCatalog(query = ""): Promise<ServedPayload> {
  const json = vi.fn();
  const error = vi.fn();
  const handled = await handleCommandsRoutes({
    req: {} as never,
    res,
    method: "GET",
    pathname: "/api/commands",
    url: makeUrl(`/api/commands${query}`),
    json,
    error,
    runtime: null,
  });
  expect(handled).toBe(true);
  expect(error).not.toHaveBeenCalled();
  return json.mock.calls[0][1] as ServedPayload;
}

describe("handleCommandsRoutes", () => {
  it("ignores non-matching paths without responding", async () => {
    const json = vi.fn();
    const error = vi.fn();
    const handled = await handleCommandsRoutes({
      req: {} as never,
      res,
      method: "GET",
      pathname: "/api/other",
      url: makeUrl("/api/other"),
      json,
      error,
      runtime: null,
    });
    expect(handled).toBe(false);
    expect(json).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("405s a non-GET method", async () => {
    const json = vi.fn();
    const error = vi.fn();
    const handled = await handleCommandsRoutes({
      req: {} as never,
      res,
      method: "POST",
      pathname: "/api/commands",
      url: makeUrl("/api/commands"),
      json,
      error,
      runtime: null,
    });
    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(res, "Method not allowed", 405);
  });

  it("serves the full catalog when there is no runtime", async () => {
    const json = vi.fn();
    const error = vi.fn();
    const handled = await handleCommandsRoutes({
      req: {} as never,
      res,
      method: "GET",
      pathname: "/api/commands",
      url: makeUrl("/api/commands"),
      json,
      error,
      runtime: null,
    });
    expect(handled).toBe(true);
    const payload = json.mock.calls[0][1] as {
      commands: Array<{ key: string; target: { kind: string } }>;
      surface: string | null;
      agentId: string | null;
      generatedAt: string;
    };
    expect(Array.isArray(payload.commands)).toBe(true);
    expect(payload.commands.length).toBeGreaterThan(0);
    expect(payload.surface).toBeNull();
    expect(payload.agentId).toBeNull();
    expect(typeof payload.generatedAt).toBe("string");
    // The navigation commands are present and tagged.
    const settings = payload.commands.find((c) => c.key === "settings");
    expect(settings?.target.kind).toBe("navigate");
    // Response is plain JSON (no functions leaked through).
    expect(() => JSON.stringify(payload)).not.toThrow();
  });

  it("scopes the catalog to a valid surface and excludes gui-only commands", async () => {
    const json = vi.fn();
    const error = vi.fn();
    await handleCommandsRoutes({
      req: {} as never,
      res,
      method: "GET",
      pathname: "/api/commands",
      url: makeUrl("/api/commands?surface=discord"),
      json,
      error,
      runtime: null,
    });
    const payload = json.mock.calls[0][1] as {
      commands: Array<{ key: string }>;
      surface: string | null;
    };
    expect(payload.surface).toBe("discord");
    const keys = new Set(payload.commands.map((c) => c.key));
    expect(keys.has("fullscreen")).toBe(false); // gui-only
    expect(keys.has("settings")).toBe(true); // all-surface
  });

  it("ignores an invalid surface and serves the unscoped catalog", async () => {
    const json = vi.fn();
    const error = vi.fn();
    await handleCommandsRoutes({
      req: {} as never,
      res,
      method: "GET",
      pathname: "/api/commands",
      url: makeUrl("/api/commands?surface=bogus"),
      json,
      error,
      runtime: null,
    });
    const payload = json.mock.calls[0][1] as { surface: string | null };
    expect(payload.surface).toBeNull();
  });

  it("scopes the store to the runtime's agent id when present", async () => {
    const json = vi.fn();
    const error = vi.fn();
    const runtime = { agentId: "agent-xyz" } as never;
    await handleCommandsRoutes({
      req: {} as never,
      res,
      method: "GET",
      pathname: "/api/commands",
      url: makeUrl("/api/commands"),
      json,
      error,
      runtime,
    });
    const payload = json.mock.calls[0][1] as { agentId: string | null };
    expect(payload.agentId).toBe("agent-xyz");
  });

  describe("surface filtering", () => {
    it("includes client-only commands on the gui surface", async () => {
      const payload = await fetchCatalog("?surface=gui");
      expect(payload.surface).toBe("gui");
      const keys = new Set(payload.commands.map((c) => c.key));
      expect(keys.has("clear")).toBe(true);
      expect(keys.has("fullscreen")).toBe(true);
    });

    it("excludes client-only commands on discord but keeps navigation", async () => {
      const payload = await fetchCatalog("?surface=discord");
      expect(payload.surface).toBe("discord");
      const keys = new Set(payload.commands.map((c) => c.key));
      expect(keys.has("clear")).toBe(false);
      expect(keys.has("fullscreen")).toBe(false);
      expect(keys.has("settings")).toBe(true);
    });

    it("excludes client-only commands on telegram too", async () => {
      const payload = await fetchCatalog("?surface=telegram");
      expect(payload.surface).toBe("telegram");
      const keys = new Set(payload.commands.map((c) => c.key));
      expect(keys.has("clear")).toBe(false);
      expect(keys.has("fullscreen")).toBe(false);
      expect(keys.has("settings")).toBe(true);
    });
  });

  describe("auth pass-through", () => {
    it("preserves requiresAuth from the definition (not hardcoded false)", async () => {
      const payload = await fetchCatalog();
      const restart = payload.commands.find((c) => c.key === "restart");
      expect(restart).toBeDefined();
      // `restart` is auth-required in the registry; the route must not flatten it.
      expect(restart?.requiresAuth).toBe(true);
      const compact = payload.commands.find((c) => c.key === "compact");
      expect(compact?.requiresAuth).toBe(true);
      // A non-auth command stays false so the flag is genuinely sourced, not constant.
      const help = payload.commands.find((c) => c.key === "help");
      expect(help?.requiresAuth).toBe(false);
    });
  });

  describe("dynamic-choice emission", () => {
    it("emits the settings section arg's dynamicChoices source", async () => {
      const payload = await fetchCatalog();
      const settings = payload.commands.find((c) => c.key === "settings");
      const section = settings?.args.find((a) => a.name === "section");
      expect(section?.dynamicChoices).toBe("settings-sections");
    });

    it("emits the views view arg's dynamicChoices source", async () => {
      const payload = await fetchCatalog();
      const views = payload.commands.find((c) => c.key === "views");
      const viewArg = views?.args.find((a) => a.name === "view");
      expect(viewArg?.dynamicChoices).toBe("views");
    });

    it("emits the model arg's dynamicChoices source", async () => {
      const payload = await fetchCatalog();
      const model = payload.commands.find((c) => c.key === "model");
      const modelArg = model?.args.find((a) => a.name === "model");
      expect(modelArg?.dynamicChoices).toBe("models");
    });
  });

  it("echoes the surface and includes activeViewId/agentId in the response", async () => {
    const json = vi.fn();
    const error = vi.fn();
    await handleCommandsRoutes({
      req: {} as never,
      res,
      method: "GET",
      pathname: "/api/commands",
      url: makeUrl("/api/commands?surface=tui"),
      json,
      error,
      runtime: { agentId: "agent-echo" } as never,
    });
    const payload = json.mock.calls[0][1] as ServedPayload;
    expect(payload.surface).toBe("tui");
    expect(payload.agentId).toBe("agent-echo");
    // No view set on the server and none passed → activeViewId is null.
    expect(payload.activeViewId).toBeNull();
  });

  // #8798: view-dependent commands surface through /api/commands only when their
  // view is the active one (passed via ?view= or resolved server-side).
  describe("view-scoped command catalog (#8798)", () => {
    it("surfaces a view's scoped command only when ?view matches", async () => {
      const calendar = await fetchCatalog("?surface=gui&view=calendar");
      expect(calendar.activeViewId).toBe("calendar");
      const calKeys = new Set(calendar.commands.map((c) => c.key));
      expect(calKeys.has("calendar-add")).toBe(true);
      expect(calKeys.has("todos-add")).toBe(false);

      const todos = await fetchCatalog("?surface=gui&view=todos");
      const todoKeys = new Set(todos.commands.map((c) => c.key));
      expect(todoKeys.has("todos-add")).toBe(true);
      expect(todoKeys.has("todos-done")).toBe(true);
      expect(todoKeys.has("calendar-add")).toBe(false);
    });

    it("hides view-scoped commands when no view is active", async () => {
      const none = await fetchCatalog("?surface=gui");
      const keys = new Set(none.commands.map((c) => c.key));
      expect(keys.has("calendar-add")).toBe(false);
      expect(keys.has("todos-add")).toBe(false);
      // Global navigation commands stay available.
      expect(keys.has("settings")).toBe(true);
    });
  });
});
