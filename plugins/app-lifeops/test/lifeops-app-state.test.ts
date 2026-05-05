import { describe, expect, test } from "vitest";
import {
  loadLifeOpsAppState,
  saveLifeOpsAppState,
} from "../src/lifeops/app-state.js";

type RuntimeCacheLike = NonNullable<Parameters<typeof loadLifeOpsAppState>[0]>;

const defaultAppState = {
  enabled: true,
  priorityScoring: {
    enabled: true,
    model: null,
  },
};

describe("lifeops app state", () => {
  test("defaults to enabled when nothing is cached", async () => {
    const runtime: RuntimeCacheLike = {
      async getCache<_T>() {
        return null;
      },
      async setCache<_T>() {
        throw new Error("should not be called");
      },
    };

    await expect(loadLifeOpsAppState(runtime)).resolves.toEqual(
      defaultAppState,
    );
  });

  test("respects explicit disabled state in cache", async () => {
    const runtime: RuntimeCacheLike = {
      async getCache<T>() {
        return { enabled: false } as T;
      },
      async setCache<_T>() {
        throw new Error("should not be called");
      },
    };

    await expect(loadLifeOpsAppState(runtime)).resolves.toEqual({
      enabled: false,
      priorityScoring: {
        enabled: true,
        model: null,
      },
    });
  });

  test("persists enabled state through the runtime cache", async () => {
    let cachedValue: unknown = null;
    const runtime: RuntimeCacheLike = {
      async getCache<T>() {
        return cachedValue as T;
      },
      async setCache<T>(_key: string, value: T) {
        cachedValue = value;
      },
    };

    await expect(
      saveLifeOpsAppState(runtime, defaultAppState),
    ).resolves.toEqual(defaultAppState);

    await expect(loadLifeOpsAppState(runtime)).resolves.toEqual({
      enabled: true,
      priorityScoring: {
        enabled: true,
        model: null,
      },
    });
  });

  test("rejects malformed cached state instead of treating it as enabled", async () => {
    const runtime: RuntimeCacheLike = {
      async getCache<T>() {
        return { enabled: "false" } as T;
      },
      async setCache<_T>() {
        throw new Error("should not be called");
      },
    };

    await expect(loadLifeOpsAppState(runtime)).rejects.toThrow(
      /invalid cached app state/,
    );
  });

  test("surfaces cache read failures", async () => {
    const runtime: RuntimeCacheLike = {
      async getCache<_T>() {
        throw new Error("cache offline");
      },
      async setCache<_T>() {
        throw new Error("should not be called");
      },
    };

    await expect(loadLifeOpsAppState(runtime)).rejects.toThrow("cache offline");
  });
});
