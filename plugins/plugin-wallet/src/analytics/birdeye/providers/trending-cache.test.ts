import { describe, expect, it, vi } from "vitest";

vi.mock("../utils.ts", () => ({
  formatJsonScalar: (v: unknown) => String(v),
  formatJsonTable: (rows: unknown[]) => JSON.stringify(rows),
}));

const { getCacheTimed } = await import("./providers/trending.ts");

function makeRuntime(cacheValue: unknown) {
  return {
    getCache: vi.fn(async () => cacheValue),
    logger: {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as never;
}

describe("getCacheTimed", () => {
  it("returns false when no cached wrapper exists", async () => {
    const runtime = makeRuntime(undefined);
    const result = await getCacheTimed(runtime, "missing-key");
    expect(result).toBe(false);
  });

  it("returns cached data when no freshness bound is given", async () => {
    const data = { address: "0xabc" };
    const runtime = makeRuntime({ data, setAt: Date.now() - 60_000 });
    const result = await getCacheTimed(runtime, "key");
    expect(result).toEqual(data);
  });

  it("returns data when it is fresh enough", async () => {
    const data = { symbol: "SOL" };
    const runtime = makeRuntime({ data, setAt: Date.now() - 5_000 });
    const result = await getCacheTimed(runtime, "key", {
      notOlderThan: 60_000,
    });
    expect(result).toEqual(data);
  });

  it("returns false when the cached entry is older than the bound", async () => {
    const data = { symbol: "SOL" };
    const runtime = makeRuntime({ data, setAt: Date.now() - 120_000 });
    const result = await getCacheTimed(runtime, "key", {
      notOlderThan: 60_000,
    });
    expect(result).toBe(false);
  });

  it("treats an entry exactly at the bound as fresh (strictly newer required to expire)", async () => {
    const data = { symbol: "SOL" };
    // setAt exactly 60_000 ms in the past → diff === bound → NOT expired
    const runtime = makeRuntime({ data, setAt: Date.now() - 60_000 });
    const result = await getCacheTimed(runtime, "key", {
      notOlderThan: 60_000,
    });
    expect(result).toEqual(data);
  });

  it("returns data when notOlderThan is 0 (only strict expiration matters)", async () => {
    const data = { symbol: "BTC" };
    const runtime = makeRuntime({ data, setAt: Date.now() - 1 });
    const result = await getCacheTimed(runtime, "key", { notOlderThan: 0 });
    expect(result).toEqual(data);
  });
});
