/**
 * Verifies the documents-service loader's bounded startup wait, including a
 * real Bun subprocess that catches referenced timers left after fast startup.
 */
import { spawnSync } from "node:child_process";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type DocumentsServiceLike,
  getDocumentsService,
} from "./documents-service-loader.ts";

const service = {} as DocumentsServiceLike;

function makeRuntime(options: {
  load: () => Promise<unknown>;
  registerAfterLoad?: boolean;
}): IAgentRuntime {
  let registered = false;
  return {
    getService: vi.fn(() => (registered ? service : null)),
    getServiceLoadPromise: vi.fn(async () => {
      await options.load();
      registered = options.registerAfterLoad === true;
    }),
  } as unknown as IAgentRuntime;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("getDocumentsService", () => {
  it("clears the losing timeout after the service registers", async () => {
    vi.useFakeTimers();
    vi.stubEnv("DOCUMENTS_SERVICE_TIMEOUT_MS", "60000");
    const runtime = makeRuntime({
      load: async () => undefined,
      registerAfterLoad: true,
    });

    await expect(getDocumentsService(runtime)).resolves.toEqual({ service });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timeout when loading settles without registration", async () => {
    vi.useFakeTimers();
    vi.stubEnv("DOCUMENTS_SERVICE_TIMEOUT_MS", "60000");
    const runtime = makeRuntime({ load: async () => undefined });

    await expect(getDocumentsService(runtime)).resolves.toEqual({
      service: null,
      reason: "not_registered",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timeout after a rejected service load", async () => {
    vi.useFakeTimers();
    vi.stubEnv("DOCUMENTS_SERVICE_TIMEOUT_MS", "60000");
    const runtime = makeRuntime({
      load: async () => {
        throw new Error("documents plugin failed to start");
      },
    });

    await expect(getDocumentsService(runtime)).resolves.toEqual({
      service: null,
      reason: "timeout",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a never-settling load bounded by the configured timeout", async () => {
    vi.useFakeTimers();
    vi.stubEnv("DOCUMENTS_SERVICE_TIMEOUT_MS", "25");
    const runtime = makeRuntime({
      load: () => new Promise<never>(() => undefined),
    });

    const loading = getDocumentsService(runtime);
    await vi.advanceTimersByTimeAsync(25);

    await expect(loading).resolves.toEqual({
      service: null,
      reason: "timeout",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("documents-service loader process lifecycle", () => {
  function runLoader(caseName: "fast" | "timeout") {
    const moduleUrl = new URL("./documents-service-loader.ts", import.meta.url)
      .href;
    const script = `
      const { getDocumentsService } = await import(${JSON.stringify(moduleUrl)});
      const mode = process.env.DOCUMENTS_LOADER_CASE;
      let registered = false;
      const service = {};
      const runtime = {
        getService: () => registered ? service : null,
        getServiceLoadPromise: () => mode === "fast"
          ? Promise.resolve().then(() => { registered = true; })
          : new Promise(() => {}),
      };
      const result = await getDocumentsService(runtime);
      console.log(JSON.stringify({ hasService: result.service === service, reason: result.reason ?? null }));
    `;
    const startedAt = performance.now();
    const result = spawnSync(
      "bun",
      ["--conditions=eliza-source", "--eval", script],
      {
        cwd: new URL("../../..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          DOCUMENTS_LOADER_CASE: caseName,
          DOCUMENTS_SERVICE_TIMEOUT_MS: caseName === "fast" ? "60000" : "25",
        },
        timeout: 5_000,
      },
    );
    return { durationMs: performance.now() - startedAt, result };
  }

  it("exits promptly after fast loading instead of waiting 60 seconds", () => {
    const { durationMs, result } = runLoader("fast");

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      hasService: true,
      reason: null,
    });
    expect(durationMs).toBeLessThan(5_000);
  });

  it("retains the referenced timer long enough to settle a hung load", () => {
    const { durationMs, result } = runLoader("timeout");

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      hasService: false,
      reason: "timeout",
    });
    expect(durationMs).toBeGreaterThanOrEqual(20);
  });
});
