/**
 * End-to-end tests for the counter app's runtime plugin. Exercises every
 * action against an isolated temp-dir state store and verifies the value
 * persists across handler calls and a fresh store instance.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCounterPlugin,
  createDecrementAction,
  createGetCountAction,
  createIncrementAction,
  createResetCountAction,
} from "../src/plugin.js";
import { CounterStore } from "../src/state.js";

let tmpDir: string;
let store: CounterStore;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "app-counter-"));
  store = new CounterStore(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("CounterStore", () => {
  it("starts at 0 when no state file exists", () => {
    expect(store.get()).toBe(0);
  });

  it("increments and persists across instances", () => {
    expect(store.increment()).toBe(1);
    expect(store.increment(4)).toBe(5);
    const fresh = new CounterStore(tmpDir);
    expect(fresh.get()).toBe(5);
  });

  it("decrements past zero into negatives", () => {
    expect(store.decrement()).toBe(-1);
    expect(store.decrement(2)).toBe(-3);
  });

  it("reset clears to 0", () => {
    store.increment(7);
    expect(store.reset()).toBe(0);
  });

  it("recovers gracefully from corrupt state", () => {
    store.increment(3);
    const file = path.join(tmpDir, "app-counter.json");
    writeFileSync(file, "{not json", "utf8");
    expect(store.get()).toBe(0);
  });
});

describe("counter plugin actions", () => {
  it("plugin advertises four actions with the expected names", () => {
    const plugin = createCounterPlugin({ store });
    expect(plugin.name).toBe("app-counter");
    expect(plugin.actions?.map((a) => a.name)).toEqual([
      "INCREMENT_COUNTER",
      "DECREMENT_COUNTER",
      "GET_COUNTER",
      "RESET_COUNTER",
    ]);
  });

  it("INCREMENT handler updates the store and returns the new count", async () => {
    const action = createIncrementAction({ store });
    // biome-ignore lint/suspicious/noExplicitAny: smoke-test runtime/message
    const result = await action.handler({} as any, {} as any, undefined, { by: 3 }, undefined);
    expect(result).toMatchObject({ success: true, data: { count: 3 } });
    expect(store.get()).toBe(3);
  });

  it("DECREMENT handler drops the value", async () => {
    store.set(10);
    const action = createDecrementAction({ store });
    // biome-ignore lint/suspicious/noExplicitAny: smoke-test runtime/message
    const result = await action.handler({} as any, {} as any, undefined, { by: 4 }, undefined);
    expect(result).toMatchObject({ success: true, data: { count: 6 } });
  });

  it("GET handler reads without mutating", async () => {
    store.set(42);
    const action = createGetCountAction({ store });
    // biome-ignore lint/suspicious/noExplicitAny: smoke-test runtime/message
    const result = await action.handler({} as any, {} as any, undefined, undefined, undefined);
    expect(result).toMatchObject({ success: true, data: { count: 42 } });
    expect(store.get()).toBe(42);
  });

  it("RESET handler zeroes the value", async () => {
    store.set(99);
    const action = createResetCountAction({ store });
    // biome-ignore lint/suspicious/noExplicitAny: smoke-test runtime/message
    const result = await action.handler({} as any, {} as any, undefined, undefined, undefined);
    expect(result).toMatchObject({ success: true, data: { count: 0 } });
  });

  it("validate matches natural-language phrasing for each action", async () => {
    const inc = createIncrementAction({ store });
    const dec = createDecrementAction({ store });
    const get = createGetCountAction({ store });
    const reset = createResetCountAction({ store });
    const msg = (text: string) =>
      // biome-ignore lint/suspicious/noExplicitAny: smoke-test message
      ({ content: { text } }) as any;

    expect(await inc.validate({} as never, msg("bump the counter please"))).toBe(true);
    expect(await dec.validate({} as never, msg("lower the counter by 5"))).toBe(true);
    expect(await get.validate({} as never, msg("what is the counter?"))).toBe(true);
    expect(await reset.validate({} as never, msg("reset the counter"))).toBe(true);
    expect(await inc.validate({} as never, msg("hello there"))).toBe(false);
  });

  it("multiple action handlers share a single store via the plugin factory", async () => {
    const plugin = createCounterPlugin({ store });
    const [inc, , get] = plugin.actions ?? [];
    if (!inc || !get) throw new Error("missing actions");
    // biome-ignore lint/suspicious/noExplicitAny: smoke-test
    await inc.handler({} as any, {} as any, undefined, { by: 5 }, undefined);
    // biome-ignore lint/suspicious/noExplicitAny: smoke-test
    const read = await get.handler({} as any, {} as any, undefined, undefined, undefined);
    expect(read).toMatchObject({ success: true, data: { count: 5 } });
  });
});
