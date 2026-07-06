/**
 * POST /api/interactions/* → runtime interaction event contract.
 *
 * The client-keyboard half of the interaction-reporting seam (the view-switch
 * half is views-routes.proactive-emit.test.ts). A user-fired shortcut must reach
 * the agent as a SHORTCUT_FIRED event (initiatedBy "user") the proactive decider
 * can react to. Composer lifecycle reports must reach the runtime as draft
 * metadata only (#14679). Malformed/oversized reports must be rejected, never
 * emit, and never throw.
 */
import type http from "node:http";
import { Readable } from "node:stream";
import { type AgentRuntime, EventType } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleInteractionsRoutes,
  type InteractionsRouteContext,
  parseComposerBody,
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

function composerCalls(emitEvent: ReturnType<typeof vi.fn>) {
  return emitEvent.mock.calls.filter(
    (call) =>
      call[0] === EventType.USER_TYPING_STARTED ||
      call[0] === EventType.USER_TYPING_PAUSED ||
      call[0] === EventType.USER_DRAFT_ABANDONED,
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

describe("parseComposerBody", () => {
  it("accepts composer metadata without draft text", () => {
    expect(
      parseComposerBody(
        JSON.stringify({
          activity: "typing_paused",
          surface: "continuous_chat_overlay",
          conversationId: "conversation-1",
          draftLength: 14,
          idleForMs: 2000,
          occurredAt: "2026-06-01T12:00:00.000Z",
        }),
      ),
    ).toEqual({
      activity: "typing_paused",
      surface: "continuous_chat_overlay",
      conversationId: "conversation-1",
      draftLength: 14,
      idleForMs: 2000,
      occurredAt: "2026-06-01T12:00:00.000Z",
    });
  });

  it("rejects malformed composer lifecycle reports", () => {
    expect(parseComposerBody("")).toBeNull();
    expect(parseComposerBody("not json")).toBeNull();
    expect(parseComposerBody("[]")).toBeNull();
    expect(
      parseComposerBody(
        JSON.stringify({
          activity: "typing_paused",
          surface: "continuous_chat_overlay",
          draftLength: 4,
        }),
      ),
    ).toBeNull();
    expect(
      parseComposerBody(
        JSON.stringify({
          activity: "typing_started",
          surface: "Continuous Chat",
          draftLength: 4,
        }),
      ),
    ).toBeNull();
    expect(
      parseComposerBody(
        JSON.stringify({
          activity: "typing_started",
          surface: "continuous_chat_overlay",
          draftLength: -1,
        }),
      ),
    ).toBeNull();
    expect(
      parseComposerBody(
        JSON.stringify({
          activity: "typing_started",
          surface: "continuous_chat_overlay",
          draftLength: 4,
          occurredAt: "not-a-date",
        }),
      ),
    ).toBeNull();
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

describe("handleInteractionsRoutes — composer lifecycle (#14679)", () => {
  it("emits USER_TYPING_STARTED for a valid composer report", async () => {
    const { ctx, emitEvent, json } = makeCtx(
      {
        activity: "typing_started",
        surface: "continuous_chat_overlay",
        conversationId: "conversation-1",
        draftLength: 5,
        occurredAt: "2026-06-01T12:00:00.000Z",
      },
      "POST",
      "/api/interactions/composer",
    );

    await expect(handleInteractionsRoutes(ctx)).resolves.toBe(true);

    const calls = composerCalls(emitEvent);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(EventType.USER_TYPING_STARTED);
    expect(calls[0][1]).toEqual(
      expect.objectContaining({
        activity: "typing_started",
        surface: "continuous_chat_overlay",
        conversationId: "conversation-1",
        draftLength: 5,
        occurredAt: "2026-06-01T12:00:00.000Z",
        initiatedBy: "user",
        source: "composer-interaction",
      }),
    );
    expect(calls[0][1]).not.toHaveProperty("text");
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({ ok: true, activity: "typing_started" }),
    );
  });

  it("emits USER_TYPING_PAUSED with idle age", async () => {
    const { ctx, emitEvent } = makeCtx(
      {
        activity: "typing_paused",
        surface: "continuous_chat_overlay",
        draftLength: 5,
        idleForMs: 2000,
        occurredAt: "2026-06-01T12:00:02.000Z",
      },
      "POST",
      "/api/interactions/composer",
    );

    await expect(handleInteractionsRoutes(ctx)).resolves.toBe(true);

    const calls = composerCalls(emitEvent);
    expect(calls[0][0]).toBe(EventType.USER_TYPING_PAUSED);
    expect(calls[0][1]).toEqual(
      expect.objectContaining({
        activity: "typing_paused",
        idleForMs: 2000,
      }),
    );
  });

  it("emits USER_DRAFT_ABANDONED for a cleared draft", async () => {
    const { ctx, emitEvent } = makeCtx(
      {
        activity: "draft_abandoned",
        surface: "continuous_chat_overlay",
        draftLength: 0,
        reason: "cleared",
        occurredAt: "2026-06-01T12:00:03.000Z",
      },
      "POST",
      "/api/interactions/composer",
    );

    await expect(handleInteractionsRoutes(ctx)).resolves.toBe(true);

    const calls = composerCalls(emitEvent);
    expect(calls[0][0]).toBe(EventType.USER_DRAFT_ABANDONED);
    expect(calls[0][1]).toEqual(
      expect.objectContaining({
        activity: "draft_abandoned",
        reason: "cleared",
      }),
    );
  });

  it("rejects malformed composer bodies without emitting", async () => {
    const { ctx, emitEvent, error } = makeCtx(
      {
        activity: "typing_paused",
        surface: "continuous_chat_overlay",
        draftLength: 5,
      },
      "POST",
      "/api/interactions/composer",
    );

    await expect(handleInteractionsRoutes(ctx)).resolves.toBe(true);
    expect(composerCalls(emitEvent)).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(ctx.res, expect.any(String), 400);
  });
});
