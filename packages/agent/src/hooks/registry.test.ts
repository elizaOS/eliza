/**
 * Hook Registry — Unit Tests
 *
 * Tests for:
 * - registerHook (registration by event key)
 * - clearHooks (clearing the registry)
 * - triggerHook (dispatching to specific and general handlers)
 * - createHookEvent (factory for HookEvent objects)
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearHooks,
  createHookEvent,
  registerHook,
  triggerHook,
} from "./registry";

// ---------------------------------------------------------------------------
// mocks
// ---------------------------------------------------------------------------

vi.mock("@elizaos/core", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

afterEach(() => {
  clearHooks();
});

// ============================================================================
//  1. registerHook
// ============================================================================

describe("registerHook", () => {
  it("registers a handler for a specific event key", async () => {
    const handler = vi.fn();
    registerHook("command:new", handler);

    const event = createHookEvent("command", "new", "sess-1");
    await triggerHook(event);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("registers multiple handlers for the same key", async () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    registerHook("command:new", handler1);
    registerHook("command:new", handler2);

    await triggerHook(createHookEvent("command", "new", "sess-1"));

    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
  });
});

// ============================================================================
//  2. clearHooks
// ============================================================================

describe("clearHooks", () => {
  it("removes all registered handlers", async () => {
    const handler = vi.fn();
    registerHook("command:new", handler);
    clearHooks();

    await triggerHook(createHookEvent("command", "new", "sess-1"));

    expect(handler).not.toHaveBeenCalled();
  });
});

// ============================================================================
//  3. triggerHook
// ============================================================================

describe("triggerHook", () => {
  it("dispatches to specific key handlers first then general", async () => {
    const order: string[] = [];
    registerHook("command:new", () => {
      order.push("specific");
    });
    registerHook("command", () => {
      order.push("general");
    });

    await triggerHook(createHookEvent("command", "new", "sess-1"));

    expect(order).toEqual(["specific", "general"]);
  });

  it("dispatches only to general handler when no specific match", async () => {
    const general = vi.fn();
    registerHook("command", general);

    await triggerHook(createHookEvent("command", "reset", "sess-1"));

    expect(general).toHaveBeenCalledOnce();
  });

  it("does nothing when no handlers are registered", async () => {
    // No assertion — just ensures no error is thrown
    await triggerHook(createHookEvent("session", "start", "sess-1"));
  });

  it("catches handler errors without propagating", async () => {
    const errorHandler = vi.fn().mockRejectedValue(new Error("boom"));
    const nextHandler = vi.fn();
    registerHook("agent:start", errorHandler);
    registerHook("agent:start", nextHandler);

    await triggerHook(createHookEvent("agent", "start", "sess-1"));

    expect(errorHandler).toHaveBeenCalledOnce();
    expect(nextHandler).toHaveBeenCalledOnce();
  });

  it("passes the event object to each handler", async () => {
    const handler = vi.fn();
    registerHook("gateway", handler);

    const event = createHookEvent("gateway", "connect", "sess-1", {
      url: "wss://example.com",
    });
    await triggerHook(event);

    expect(handler).toHaveBeenCalledWith(event);
    expect(handler.mock.calls[0][0].context.url).toBe("wss://example.com");
  });
});

// ============================================================================
//  4. createHookEvent
// ============================================================================

describe("createHookEvent", () => {
  it("creates an event with correct fields", () => {
    const event = createHookEvent("command", "new", "sess-1");

    expect(event.type).toBe("command");
    expect(event.action).toBe("new");
    expect(event.sessionKey).toBe("sess-1");
    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.messages).toEqual([]);
    expect(event.context).toEqual({});
  });

  it("includes custom context when provided", () => {
    const event = createHookEvent("session", "end", "sess-2", {
      reason: "timeout",
    });

    expect(event.context.reason).toBe("timeout");
  });

  it("defaults to empty context when omitted", () => {
    const event = createHookEvent("agent", "stop", "sess-3");

    expect(event.context).toEqual({});
  });
});
