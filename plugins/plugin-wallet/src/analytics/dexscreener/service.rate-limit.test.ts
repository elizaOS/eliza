/**
 * Exercises DexScreener rate-limit configuration through the production
 * service initializer with a deterministic runtime settings stub.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { DexScreenerService } from "./service";

vi.mock("@elizaos/core", () => ({
  formatError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  Service: class Service {
    runtime: unknown;

    constructor(runtime: unknown) {
      this.runtime = runtime;
    }
  },
}));

function runtimeWithDelay(delay: unknown): IAgentRuntime {
  return {
    getSetting(key: string) {
      if (key === "DEXSCREENER_API_URL") return "https://dex.example.test";
      if (key === "DEXSCREENER_RATE_LIMIT_DELAY") return delay;
      return undefined;
    },
  } as unknown as IAgentRuntime;
}

async function configuredDelay(delay: unknown): Promise<number | undefined> {
  const service = await DexScreenerService.start(runtimeWithDelay(delay));
  return (
    service as unknown as {
      dexConfig: { rateLimitDelay?: number };
    }
  ).dexConfig.rateLimitDelay;
}

describe("DexScreenerService rate-limit configuration", () => {
  it.each([
    [undefined, 100],
    ["", 100],
    ["abc", 100],
    ["100ms", 100],
    ["12.5", 100],
    ["-1000", 0],
    [-25, 0],
    ["250", 250],
    [250, 250],
    ["999999999", 5000],
  ])("maps %j to %i ms", async (raw, expected) => {
    await expect(configuredDelay(raw)).resolves.toBe(expected);
  });
});
