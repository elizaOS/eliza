import { describe, expect, it, vi } from "vitest";
import { cachedDynamicImport } from "./app-module-cache.js";

describe("cachedDynamicImport", () => {
  it("dedupes loader per key and returns same promise", async () => {
    const loader = vi.fn(async () => "ns-" + Math.random());
    const key = "app-module-cache-key-" + Date.now();
    const p1 = cachedDynamicImport(key, loader);
    const p2 = cachedDynamicImport(key, loader);
    expect(p1).toBe(p2);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(await p1).toBe(await p2);
  });

  it("calls different loaders for different keys", async () => {
    const a = vi.fn(async () => "a");
    const b = vi.fn(async () => "b");
    const k1 = "pkg-" + Math.random();
    const k2 = k1 + "/register";
    expect(await cachedDynamicImport(k1, a)).toBe("a");
    expect(await cachedDynamicImport(k2, b)).toBe("b");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
