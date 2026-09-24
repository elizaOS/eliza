/**
 * Exercises the electrobun/bun Vitest stub that stands in for the native module.
 * Imports the stub file directly and records its no-op named-export contract.
 */

import { describe, expect, it } from "vitest";
import {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  BuildConfig,
  Electrobun,
  Updater,
  Utils,
  WGPU,
  webgpu,
} from "./electrobun-bun";

const EMPTY_NAMESPACE_EXPORTS = {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  BuildConfig,
  Updater,
  WGPU,
  webgpu,
} as const;

describe("electrobun/bun vitest stub", () => {
  it("exports exactly the named namespaces the alias is written to provide", async () => {
    const module = await import("./electrobun-bun");
    expect(Object.keys(module).sort()).toEqual([
      "ApplicationMenu",
      "BrowserView",
      "BrowserWindow",
      "BuildConfig",
      "Electrobun",
      "Updater",
      "Utils",
      "WGPU",
      "webgpu",
    ]);
  });

  it("exposes Utils.quit as a no-op that returns undefined on every call", () => {
    expect(Object.keys(Utils)).toEqual(["quit"]);
    expect(typeof Utils.quit).toBe("function");
    expect(Utils.quit()).toBeUndefined();
    expect(Utils.quit()).toBeUndefined();
  });

  it("exposes Electrobun.events.on as a no-op that never invokes a listener", () => {
    expect(Object.keys(Electrobun)).toEqual(["events"]);
    expect(Object.keys(Electrobun.events)).toEqual(["on"]);
    expect(typeof Electrobun.events.on).toBe("function");
    expect(Electrobun.events.on()).toBeUndefined();

    let invoked = false;
    const on = Electrobun.events.on as (
      event?: string,
      handler?: () => void,
    ) => unknown;
    expect(
      on("ready", () => {
        invoked = true;
      }),
    ).toBeUndefined();
    expect(invoked).toBe(false);
  });

  it("exports empty, distinct placeholder objects for the remaining namespaces", () => {
    const seen = new Set<object>();
    for (const [name, value] of Object.entries(EMPTY_NAMESPACE_EXPORTS)) {
      expect({ name, value }).toEqual({ name, value: {} });
      expect(Object.keys(value)).toEqual([]);
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      expect(seen.has(value)).toBe(false);
      seen.add(value);
    }
  });

  it("does not treat the empty namespace objects as constructors", () => {
    for (const value of Object.values(EMPTY_NAMESPACE_EXPORTS)) {
      const Ctor = value as unknown as new () => unknown;
      expect(() => new Ctor()).toThrow(TypeError);
    }
  });

  it("returns the same module instance on re-import", async () => {
    const again = await import("./electrobun-bun");
    expect(again.Utils).toBe(Utils);
    expect(again.Electrobun).toBe(Electrobun);
    expect(again.BrowserWindow).toBe(BrowserWindow);
    expect(again.webgpu).toBe(webgpu);
  });
});
