import { describe, expect, test } from "vitest";
import {
  loadLifeOpsAppState,
  saveLifeOpsAppState,
} from "../src/lifeops/app-state.js";

describe("lifeops app state", () => {
  test("defaults to disabled when nothing is cached", async () => {
    const runtime = {
      async getCache() {
        return null;
      },
      async setCache() {
        throw new Error("should not be called");
      },
    };

    await expect(loadLifeOpsAppState(runtime)).resolves.toEqual({
      enabled: false,
    });
  });

  test("persists enabled state through the runtime cache", async () => {
    let cachedValue: unknown = null;
    const runtime = {
      async getCache() {
        return cachedValue;
      },
      async setCache(_key: string, value: unknown) {
        cachedValue = value;
      },
    };

    await expect(
      saveLifeOpsAppState(runtime, {
        enabled: true,
      }),
    ).resolves.toEqual({
      enabled: true,
    });

    await expect(loadLifeOpsAppState(runtime)).resolves.toEqual({
      enabled: true,
    });
  });
});
