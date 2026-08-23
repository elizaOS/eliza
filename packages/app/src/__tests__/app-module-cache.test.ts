import { describe, expect, it, vi } from "vitest";
import { cachedDynamicImport } from "../app-module-cache.ts";

describe("cachedDynamicImport", () => {
  it("invokes the loader once per key", async () => {
    const loader = vi.fn(async () => "ns");
    const p1 = cachedDynamicImport("pkg", loader);
    const p2 = cachedDynamicImport("pkg", loader);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(await p1).toBe("ns");
    expect(await p2).toBe("ns");
  });

  it("keys by full key including suffixes", async () => {
    const loaderA = vi.fn(async () => "a");
    const loaderB = vi.fn(async () => "b");
    const p1 = cachedDynamicImport("pkg-2", loaderA);
    const p2 = cachedDynamicImport("pkg-2/register", loaderB);
    expect(loaderA).toHaveBeenCalledTimes(1);
    expect(loaderB).toHaveBeenCalledTimes(1);
    expect(await p1).toBe("a");
    expect(await p2).toBe("b");
  });

  it("returns the same promise for concurrent requests", () => {
    const loader = vi.fn(async () => "x");
    const p1 = cachedDynamicImport("k", loader);
    const p2 = cachedDynamicImport("k", loader);
    expect(p1).toBe(p2);
  });
});
