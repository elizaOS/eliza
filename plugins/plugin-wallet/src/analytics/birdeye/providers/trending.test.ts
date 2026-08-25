import { describe, expect, it, vi } from "vitest";
import { getCacheTimed } from "./trending";

function makeRuntime(getCache: ReturnType<typeof vi.fn>) {
  return { getCache } as never;
}

describe("getCacheTimed freshness boundary", () => {
  it("returns false on cache miss (no wrapper)", async () => {
    const runtime = makeRuntime(vi.fn().mockResolvedValue(undefined));
    await expect(getCacheTimed(runtime, "k")).resolves.toBe(false);
    await expect(
      getCacheTimed(runtime, "k", { notOlderThan: 5000 }),
    ).resolves.toBe(false);
  });

  it("returns data without notOlderThan regardless of age", async () => {
    const runtime = makeRuntime(
      vi.fn().mockResolvedValue({ data: { x: 1 }, setAt: 0 }),
    );
    await expect(getCacheTimed(runtime, "k")).resolves.toEqual({ x: 1 });
  });

  it("returns data while within the freshness window", async () => {
    const runtime = makeRuntime(
      vi.fn().mockResolvedValue({ data: "fresh", setAt: Date.now() - 1000 }),
    );
    await expect(
      getCacheTimed(runtime, "k", { notOlderThan: 5000 }),
    ).resolves.toBe("fresh");
  });

  it("treats diff === notOlderThan as fresh (inclusive bound)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000_000_000);
      const runtime = makeRuntime(
        vi.fn().mockResolvedValue({
          data: "edge",
          setAt: 1_000_000_000_000 - 5000,
        }),
      );
      await expect(
        getCacheTimed(runtime, "k", { notOlderThan: 5000 }),
      ).resolves.toBe("edge");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns false when older than the window", async () => {
    const runtime = makeRuntime(
      vi.fn().mockResolvedValue({ data: "stale", setAt: Date.now() - 5001 }),
    );
    await expect(
      getCacheTimed(runtime, "k", { notOlderThan: 5000 }),
    ).resolves.toBe(false);
  });

  it("serves corrupt wrappers missing setAt as fresh (NaN diff never expires)", async () => {
    // A wrapper without a numeric setAt yields NaN; NaN > notOlderThan is
    // false, so corrupt payloads are indistinguishable from fresh ones.
    // Pins the degenerate case so a future fix is a deliberate change.
    const runtime = makeRuntime(
      vi.fn().mockResolvedValue({ data: "corrupt", setAt: undefined }),
    );
    await expect(
      getCacheTimed(runtime, "k", { notOlderThan: 5000 }),
    ).resolves.toBe("corrupt");
  });

  it("serves future-dated wrappers (clock skew) as fresh forever", async () => {
    const future = Date.now() + 60_000;
    const runtime = makeRuntime(
      vi.fn().mockResolvedValue({ data: "skewed", setAt: future }),
    );
    await expect(
      getCacheTimed(runtime, "k", { notOlderThan: 5000 }),
    ).resolves.toBe("skewed");
  });
});
