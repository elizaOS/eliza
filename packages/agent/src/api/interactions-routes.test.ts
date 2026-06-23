/**
 * POST /api/interactions/shortcut → EventType.SHORTCUT_FIRED contract (#8792).
 *
 * The client-keyboard half of the interaction-reporting seam (the view-switch
 * half is views-routes.proactive-emit.test.ts). A user-fired shortcut must reach
 * the agent as a SHORTCUT_FIRED event (initiatedBy "user") the proactive decider
 * can react to — and a malformed/oversized report must be rejected, never emit,
 * and never throw.
 */
import type http from "node:http";
import { Readable } from "node:stream";
import { type AgentRuntime, EventType } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleInteractionsRoutes,
  type InteractionsRouteContext,
  parseShortcutBody,
} from "./interactions-routes.ts";

function makeCtx(
  body: unknown,
  method = "POST",
  pathname = "/api/interactions/shortcut",
): {
  ctx: InteractionsRouteContext;
  emitEvent: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  ) as unknown as http.IncomingMessage;
  const emitEvent = vi.fn(async () => {});
  const json = vi.fn();
  const error = vi.fn();
  const ctx: InteractionsRouteContext = {
    req,
    res: {} as http.ServerResponse,
    method,
    pathname,
    json,
    error,
    runtime: {
      emitEvent,
      logger: { debug: vi.fn() },
    } as unknown as AgentRuntime,
  };
  return { ctx, emitEvent, json, error };
}

function shortcutCalls(emitEvent: ReturnType<typeof vi.fn>) {
  return emitEvent.mock.calls.filter(
    (call) => call[0] === EventType.SHORTCUT_FIRED,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("parseShortcutBody", () => {
  it("accepts a kebab-case shortcut id", () => {
    expect(parseShortcutBody('{"shortcutId":"open-command-palette"}')).toEqual({
      shortcutId: "open-command-palette",
    });
  });
  it("carries an optional context, trimmed + length-capped", () => {
    const r = parseShortcutBody(
      JSON.stringify({ shortcutId: "toggle-terminal", context: "  shell  " }),
    );
    expect(r).toEqual({ shortcutId: "toggle-terminal", context: "shell" });
    const long = parseShortcutBody(
      JSON.stringify({ shortcutId: "x-y", context: "a".repeat(500) }),
    );
    expect((long?.context ?? "").length).toBe(120);
  });
  it("rejects empty / non-kebab / oversized / malformed ids", () => {
    expect(parseShortcutBody("")).toBeNull();
    expect(parseShortcutBody("not json")).toBeNull();
    expect(parseShortcutBody("[]")).toBeNull();
    expect(parseShortcutBody('{"shortcutId":""}')).toBeNull();
    expect(parseShortcutBody('{"shortcutId":"Open Palette"}')).toBeNull();
    expect(parseShortcutBody('{"shortcutId":"UPPER"}')).toBeNull();
    expect(parseShortcutBody(`{"shortcutId":"${"a".repeat(60)}"}`)).toBeNull();
    expect(parseShortcutBody("{}")).toBeNull();
  });
});

describe("handleInteractionsRoutes — SHORTCUT_FIRED (#8792)", () => {
  it("emits SHORTCUT_FIRED (initiatedBy user) for a valid report", async () => {
    const { ctx, emitEvent, json } = makeCtx({
      shortcutId: "open-command-palette",
      context: "command-palette",
    });
    await expect(handleInteractionsRoutes(ctx)).resolves.toBe(true);

    const calls = shortcutCalls(emitEvent);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual(
      expect.objectContaining({
        shortcutId: "open-command-palette",
        context: "command-palette",
        initiatedBy: "user",
        source: "shortcut-interaction",
      }),
    );
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({ ok: true, shortcutId: "open-command-palette" }),
    );
  });

  it("rejects a malformed body with 400 and never emits", async () => {
    const { ctx, emitEvent, error } = makeCtx({ shortcutId: "Bad Id!" });
    await expect(handleInteractionsRoutes(ctx)).resolves.toBe(true);
    expect(shortcutCalls(emitEvent)).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(ctx.res, expect.any(String), 400);
  });

  it("returns 405 for non-POST", async () => {
    const { ctx, emitEvent, error } = makeCtx(undefined, "GET");
    await expect(handleInteractionsRoutes(ctx)).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith(ctx.res, expect.any(String), 405);
    expect(shortcutCalls(emitEvent)).toHaveLength(0);
  });

  it("does not claim a non-matching path", async () => {
    const { ctx } = makeCtx(
      { shortcutId: "x-y" },
      "POST",
      "/api/views/current",
    );
    await expect(handleInteractionsRoutes(ctx)).resolves.toBe(false);
  });

  it("does not throw when no runtime is bound (best-effort emission)", async () => {
    const { ctx, json } = makeCtx({ shortcutId: "show-keyboard-shortcuts" });
    ctx.runtime = null;
    await expect(handleInteractionsRoutes(ctx)).resolves.toBe(true);
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({ ok: true }),
    );
  });
});
