import { logger } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type LifeOpsAppState,
  loadLifeOpsAppState,
  saveLifeOpsAppState,
} from "./app-state";

type CacheLike = {
  getCache: ReturnType<typeof vi.fn>;
  setCache: ReturnType<typeof vi.fn>;
};

function cacheRuntime(cached: unknown): CacheLike {
  return {
    getCache: vi.fn(async () => cached),
    setCache: vi.fn(async () => true),
  };
}

describe("loadLifeOpsAppState", () => {
  it("returns defaults when no runtime cache is available", async () => {
    await expect(loadLifeOpsAppState(null)).resolves.toEqual({
      enabled: true,
      priorityScoring: { enabled: true, model: null },
    });
  });

  it("returns defaults when nothing is cached", async () => {
    await expect(loadLifeOpsAppState(cacheRuntime(null))).resolves.toEqual({
      enabled: true,
      priorityScoring: { enabled: true, model: null },
    });
  });

  it("hydrates legacy payloads that only carry enabled", async () => {
    const state = await loadLifeOpsAppState(cacheRuntime({ enabled: false }));
    expect(state).toEqual({
      enabled: false,
      priorityScoring: { enabled: true, model: null },
    });
  });

  it("trims whitespace from a persisted model id", async () => {
    const state = await loadLifeOpsAppState(
      cacheRuntime({
        enabled: true,
        priorityScoring: { enabled: true, model: "  gpt-4o  " },
      }),
    );
    expect(state.priorityScoring.model).toBe("gpt-4o");
  });

  it("normalizes a whitespace-only model id to null", async () => {
    const state = await loadLifeOpsAppState(
      cacheRuntime({
        enabled: true,
        priorityScoring: { enabled: true, model: "   " },
      }),
    );
    expect(state.priorityScoring.model).toBeNull();
  });

  it("rejects a non-boolean enabled flag instead of trusting it", async () => {
    await expect(
      loadLifeOpsAppState(cacheRuntime({ enabled: "yes" })),
    ).rejects.toThrow(/invalid cached app state/);
    await expect(
      loadLifeOpsAppState(cacheRuntime({ enabled: 1 })),
    ).rejects.toThrow(/invalid cached app state/);
  });

  it("rejects a non-object priorityScoring payload", async () => {
    await expect(
      loadLifeOpsAppState(
        cacheRuntime({ enabled: true, priorityScoring: "off" }),
      ),
    ).rejects.toThrow(/invalid cached app state/);
  });

  it("rejects a non-boolean priorityScoring.enabled flag", async () => {
    await expect(
      loadLifeOpsAppState(
        cacheRuntime({
          enabled: true,
          priorityScoring: { enabled: "yes", model: null },
        }),
      ),
    ).rejects.toThrow(/invalid cached app state/);
  });

  it("rejects a non-string priorityScoring model", async () => {
    await expect(
      loadLifeOpsAppState(
        cacheRuntime({
          enabled: true,
          priorityScoring: { enabled: true, model: 42 },
        }),
      ),
    ).rejects.toThrow(/invalid cached app state/);
  });

  it("rejects array payloads", async () => {
    await expect(loadLifeOpsAppState(cacheRuntime([]))).rejects.toThrow(
      /invalid cached app state/,
    );
  });
});

describe("saveLifeOpsAppState", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  it("hydrates before persisting and returns the normalized state", async () => {
    const runtime = cacheRuntime(null);
    const saved = await saveLifeOpsAppState(runtime, {
      enabled: "yes",
      priorityScoring: { enabled: "on", model: "  x  " },
    } as unknown as LifeOpsAppState);
    expect(saved).toEqual({
      enabled: false,
      priorityScoring: { enabled: false, model: "x" },
    });
    expect(runtime.setCache).toHaveBeenCalledWith(
      "eliza:lifeops-app-state",
      saved,
    );
  });

  it("hydrates missing priorityScoring with defaults on save", async () => {
    const runtime = cacheRuntime(null);
    const saved = await saveLifeOpsAppState(runtime, {
      enabled: true,
    } as unknown as LifeOpsAppState);
    expect(saved.priorityScoring).toEqual({ enabled: true, model: null });
  });

  it("warns and rethrows when persistence fails (fail loud, not silent)", async () => {
    const persistError = new Error("cache down");
    const runtime: CacheLike = {
      getCache: vi.fn(),
      setCache: vi.fn(async () => {
        throw persistError;
      }),
    };
    await expect(
      saveLifeOpsAppState(runtime, { enabled: true } as LifeOpsAppState),
    ).rejects.toBe(persistError);
    expect(warnSpy).toHaveBeenCalled();
  });
});
