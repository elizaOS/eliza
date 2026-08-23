/**
 * Covers the in-process hook registry and its dispatch.
 *
 * The two documented contracts are the ones worth pinning: dispatch order is
 * specific-first (`command:new`) then general (`command`), and a failing
 * handler is isolated and logged rather than thrown — one bad hook must not
 * abort the rest of the fan-out, or a single misbehaving plugin would silently
 * disable every other hook on the same event.
 *
 * Drives the real exported registry; each test clears it first. No runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearHooks,
  createHookEvent,
  registerHook,
  triggerHook,
} from "./registry.ts";
import type { HookEvent } from "./types.ts";

const event = (action: string): HookEvent =>
  createHookEvent("command" as HookEvent["type"], action, "session-1");

beforeEach(() => clearHooks());
afterEach(() => clearHooks());

describe("createHookEvent", () => {
  it("builds the payload with an empty default context", () => {
    const built = createHookEvent("command" as HookEvent["type"], "new", "s1");
    expect(built).toMatchObject({
      type: "command",
      action: "new",
      sessionKey: "s1",
      messages: [],
      context: {},
    });
    expect(built.timestamp).toBeInstanceOf(Date);
  });

  it("carries an explicit context through unchanged", () => {
    const context = { userId: "u1", nested: { a: 1 } };
    expect(
      createHookEvent("command" as HookEvent["type"], "new", "s1", context)
        .context,
    ).toEqual(context);
  });

  it("gives each event its own messages array", () => {
    const a = createHookEvent("command" as HookEvent["type"], "new", "s1");
    const b = createHookEvent("command" as HookEvent["type"], "new", "s1");
    expect(a.messages).not.toBe(b.messages);
  });
});

describe("triggerHook dispatch", () => {
  it("is a no-op when nothing is registered", async () => {
    await expect(triggerHook(event("new"))).resolves.toBeUndefined();
  });

  it("runs specific handlers before general ones", async () => {
    const order: string[] = [];
    registerHook("command", async () => {
      order.push("general");
    });
    registerHook("command:new", async () => {
      order.push("specific");
    });
    await triggerHook(event("new"));
    expect(order).toEqual(["specific", "general"]);
  });

  it("runs multiple handlers on one key in registration order", async () => {
    const order: string[] = [];
    registerHook("command", async () => {
      order.push("first");
    });
    registerHook("command", async () => {
      order.push("second");
    });
    await triggerHook(event("new"));
    expect(order).toEqual(["first", "second"]);
  });

  it("does not run a handler registered for a different action", async () => {
    const order: string[] = [];
    registerHook("command:reset", async () => {
      order.push("reset");
    });
    await triggerHook(event("new"));
    expect(order).toEqual([]);
  });

  it("passes the event through to the handler", async () => {
    const seen: HookEvent[] = [];
    registerHook("command:new", async (e) => {
      seen.push(e);
    });
    const dispatched = event("new");
    await triggerHook(dispatched);
    expect(seen).toEqual([dispatched]);
  });

  it("awaits an async handler before running the next", async () => {
    const order: string[] = [];
    registerHook("command", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("slow");
    });
    registerHook("command", async () => {
      order.push("fast");
    });
    await triggerHook(event("new"));
    expect(order).toEqual(["slow", "fast"]);
  });
});

describe("triggerHook failure isolation", () => {
  it("keeps running later handlers after one throws", async () => {
    const order: string[] = [];
    registerHook("command:new", async () => {
      throw new Error("boom");
    });
    registerHook("command", async () => {
      order.push("survivor");
    });
    await expect(triggerHook(event("new"))).resolves.toBeUndefined();
    expect(order).toEqual(["survivor"]);
  });

  it("does not reject even when every handler throws", async () => {
    registerHook("command", async () => {
      throw new Error("one");
    });
    registerHook("command", async () => {
      throw new Error("two");
    });
    await expect(triggerHook(event("new"))).resolves.toBeUndefined();
  });

  it("tolerates a handler that throws a non-Error value", async () => {
    const order: string[] = [];
    registerHook("command", async () => {
      throw "just a string";
    });
    registerHook("command", async () => {
      order.push("after");
    });
    await expect(triggerHook(event("new"))).resolves.toBeUndefined();
    expect(order).toEqual(["after"]);
  });

  it("tolerates a handler that throws synchronously", async () => {
    const order: string[] = [];
    registerHook("command", () => {
      throw new Error("sync boom");
    });
    registerHook("command", async () => {
      order.push("after");
    });
    await expect(triggerHook(event("new"))).resolves.toBeUndefined();
    expect(order).toEqual(["after"]);
  });
});

describe("clearHooks", () => {
  it("removes every registered handler", async () => {
    const order: string[] = [];
    registerHook("command", async () => {
      order.push("x");
    });
    clearHooks();
    await triggerHook(event("new"));
    expect(order).toEqual([]);
  });
});
