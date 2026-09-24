/**
 * Covers the Electrobun BrowserWindow construction helper: the whole point of
 * the wrapper is that `icon` and `partition` reach the runtime constructor even
 * though the published 1.18 constructor type omits them, so the assertions pin
 * the exact options object handed to `new BrowserWindow(...)`. The
 * `electrobun/bun` module is replaced with a constructible class mock because
 * the real one is a native Bun module and the lane's `__stubs__` replacement
 * exports a plain object that cannot be constructed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const electrobunMock = vi.hoisted(() => {
  const constructorCalls: unknown[][] = [];
  class MockBrowserWindow {
    public readonly options: unknown;
    constructor(...args: unknown[]) {
      constructorCalls.push(args);
      this.options = args[0];
    }
  }
  return { constructorCalls, MockBrowserWindow };
});

vi.mock("electrobun/bun", () => ({
  BrowserWindow: electrobunMock.MockBrowserWindow,
}));

import { createElectrobunBrowserWindow } from "./electrobun-window-options";

describe("createElectrobunBrowserWindow", () => {
  beforeEach(() => {
    electrobunMock.constructorCalls.length = 0;
  });

  it("constructs a BrowserWindow with the given options and returns it", () => {
    const options = { title: "Main", icon: "app.png" };

    const win = createElectrobunBrowserWindow(options);

    expect(electrobunMock.constructorCalls).toHaveLength(1);
    expect(electrobunMock.constructorCalls[0]).toEqual([options]);
    expect(win).toBeInstanceOf(electrobunMock.MockBrowserWindow);
  });

  it("passes the extended icon and partition fields straight through", () => {
    const options = {
      title: "Secondary",
      partition: "persist:x",
      icon: "i.png",
    };

    createElectrobunBrowserWindow(options);

    const passed = electrobunMock.constructorCalls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(passed).toEqual(options);
    expect(passed?.icon).toBe("i.png");
    expect(passed?.partition).toBe("persist:x");
  });

  it("forwards a null partition instead of dropping the field", () => {
    createElectrobunBrowserWindow({ title: "Null partition", partition: null });

    const passed = electrobunMock.constructorCalls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(passed).toEqual({ title: "Null partition", partition: null });
    expect(passed && "partition" in passed).toBe(true);
  });
});
