import { describe, expect, it, vi } from "vitest";

import { handleCommandsRoutes } from "./commands-routes.ts";

const res = {} as never;

function makeUrl(path: string): URL {
  return new URL(`http://localhost${path}`);
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
});
