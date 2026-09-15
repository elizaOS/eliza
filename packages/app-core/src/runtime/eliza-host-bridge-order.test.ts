/** Proves app-core installs host-owned HTTP capabilities before either upstream boot entry executes. */

import {
  _resetAgentHostBridge,
  getAgentHostBridge,
} from "@elizaos/agent/runtime/host-bridge";
import { afterEach, describe, expect, it, vi } from "vitest";

const { upstreamBoot, upstreamStart } = vi.hoisted(() => ({
  upstreamBoot: vi.fn(async () => null),
  upstreamStart: vi.fn(async () => null),
}));

vi.mock("@elizaos/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/agent")>()),
  bootElizaRuntime: upstreamBoot,
  startEliza: upstreamStart,
}));

vi.mock("./startup/local-model-warmup.js", () => ({
  ensureDefaultEmbeddingDimension: () => undefined,
  prepareLocalEmbeddingWarmup: () => undefined,
  startDeferredLocalEmbeddingWarmup: () => undefined,
}));

vi.mock("./bundled-fused-lib.js", () => ({
  ensureBundledFusedLibDir: () => undefined,
}));

import { bootElizaRuntime, startEliza } from "./eliza";

describe("app-core host bridge boot ordering", () => {
  afterEach(() => {
    _resetAgentHostBridge();
    upstreamBoot.mockClear();
    upstreamStart.mockClear();
  });

  it("installs desktop routes before the direct runtime boot", async () => {
    upstreamBoot.mockImplementationOnce(async () => {
      expect(typeof getAgentHostBridge().handleDesktopAuthBootstrapRoute).toBe(
        "function",
      );
      return null;
    });
    await expect(bootElizaRuntime()).resolves.toBeNull();
    expect(upstreamBoot).toHaveBeenCalledOnce();
  });

  it("installs desktop routes before the normal runtime boot", async () => {
    upstreamStart.mockImplementationOnce(async () => {
      expect(typeof getAgentHostBridge().handleDesktopAuthBootstrapRoute).toBe(
        "function",
      );
      return null;
    });
    await expect(startEliza()).resolves.toBeNull();
    expect(upstreamStart).toHaveBeenCalledOnce();
  });
});
