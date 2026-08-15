/** Verifies that real-runtime provider selection cannot leak environment state. */
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createProcessEnvMutationScope,
  createRealTestRuntime,
} from "./real-runtime";

describe("real-runtime process environment scope", () => {
  it("restores overwritten, deleted, and newly added provider keys exactly", () => {
    const environment: NodeJS.ProcessEnv = {
      CEREBRAS_API_KEY: "ambient-cerebras",
      OPENAI_API_KEY: "ambient-openai",
      LOCAL_EMBEDDING_DIMENSIONS: "768",
    };
    const originalEnvironment = { ...environment };
    const scope = createProcessEnvMutationScope(environment);

    scope.unset("CEREBRAS_API_KEY");
    scope.set("OPENAI_API_KEY", "temporary-zai-compat-key");
    scope.set("ZAI_API_KEY", "temporary-zai-key");
    scope.set("EMBEDDING_DIMENSION", "384");

    expect(environment).toEqual({
      OPENAI_API_KEY: "temporary-zai-compat-key",
      LOCAL_EMBEDDING_DIMENSIONS: "768",
      ZAI_API_KEY: "temporary-zai-key",
      EMBEDDING_DIMENSION: "384",
    });

    scope.restore();

    expect(environment).toEqual(originalEnvironment);
    expect(() => scope.set("ZAI_API_KEY", "late-mutation")).toThrow(
      "Cannot mutate a restored process environment scope",
    );
    scope.restore();
    expect(environment).toEqual(originalEnvironment);
  });

  it("restores process env and window when early filesystem setup throws", async () => {
    const originalPgliteDir = process.env.PGLITE_DATA_DIR;
    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "window",
    );
    const windowMarker = { marker: "real-runtime-window" };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: windowMarker,
    });
    vi.stubEnv("PGLITE_DATA_DIR", "ambient-pglite-dir");
    vi.stubEnv("WEBSITE_BLOCKER_HOSTS_FILE_PATH", "");
    vi.stubEnv("SELFCONTROL_HOSTS_FILE_PATH", "");
    const setupError = new Error("synthetic early setup failure");
    const mkdtemp = vi.spyOn(fs, "mkdtempSync").mockImplementationOnce(() => {
      throw setupError;
    });

    try {
      await expect(
        createRealTestRuntime({
          pgliteDir: "/tmp/eliza-real-runtime-env-failure-test",
          removePgliteDirOnCleanup: false,
        }),
      ).rejects.toBe(setupError);

      expect(process.env.PGLITE_DATA_DIR).toBe("ambient-pglite-dir");
      expect(process.env.WEBSITE_BLOCKER_HOSTS_FILE_PATH).toBe("");
      expect(process.env.SELFCONTROL_HOSTS_FILE_PATH).toBe("");
      expect((globalThis as { window?: unknown }).window).toBe(windowMarker);
    } finally {
      mkdtemp.mockRestore();
      vi.unstubAllEnvs();
      if (originalPgliteDir === undefined) {
        delete process.env.PGLITE_DATA_DIR;
      } else {
        process.env.PGLITE_DATA_DIR = originalPgliteDir;
      }
      if (originalWindowDescriptor) {
        Object.defineProperty(globalThis, "window", originalWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });
});
