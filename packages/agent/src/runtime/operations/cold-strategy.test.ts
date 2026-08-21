/**
 * Unit coverage for the cold reload strategy — restart closure delegation,
 * success/failure phase reporting, and intent description.
 */
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createColdStrategy } from "./cold-strategy.ts";
import type { OperationIntent, ReloadContext } from "./types.ts";

function makeRuntime(id: string): AgentRuntime {
  return { agentId: id } as AgentRuntime;
}

function makeCtx(
  intent: OperationIntent = { kind: "restart", reason: "manual" },
) {
  const reportPhase = vi.fn<ReloadContext["reportPhase"]>(async () => {});
  return {
    runtime: makeRuntime("current-runtime"),
    intent,
    reportPhase,
  } satisfies ReloadContext;
}

function restartWith(runtime: AgentRuntime | null) {
  return vi.fn<(reason: string) => Promise<AgentRuntime | null>>(
    async () => runtime,
  );
}

describe("createColdStrategy", () => {
  it("reports a succeeded phase and returns the new runtime", async () => {
    const newRuntime = makeRuntime("rt-2");
    const restartRuntime = restartWith(newRuntime);
    const ctx = makeCtx();
    const strategy = createColdStrategy({ restartRuntime });

    const result = await strategy.apply(ctx);

    expect(result).toBe(newRuntime);
    expect(restartRuntime).toHaveBeenCalledWith("manual");
    expect(ctx.reportPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "cold-restart",
        status: "succeeded",
      }),
    );
  });

  it("reports a failed phase and throws when restart returns null", async () => {
    const restartRuntime = restartWith(null);
    const ctx = makeCtx();
    const strategy = createColdStrategy({ restartRuntime });

    await expect(strategy.apply(ctx)).rejects.toThrow(
      "Cold restart returned null runtime",
    );
    expect(ctx.reportPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "cold-restart",
        status: "failed",
        error: expect.objectContaining({
          message: "Cold restart returned null runtime",
        }),
      }),
    );
  });

  it("describes a provider-switch intent in the restart reason", async () => {
    const restartRuntime = restartWith(makeRuntime("rt"));
    const ctx = makeCtx({ kind: "provider-switch", provider: "anthropic" });
    const strategy = createColdStrategy({ restartRuntime });
    await strategy.apply(ctx);
    expect(restartRuntime).toHaveBeenCalledWith("provider switch to anthropic");
  });

  it("describes config-reload intent", async () => {
    const restartRuntime = restartWith(makeRuntime("rt"));
    const ctx = makeCtx({ kind: "config-reload" });
    const strategy = createColdStrategy({ restartRuntime });
    await strategy.apply(ctx);
    expect(restartRuntime).toHaveBeenCalledWith("config reload");
  });

  it("describes plugin enable/disable intents", async () => {
    const restartRuntime = restartWith(makeRuntime("rt"));
    const strategy = createColdStrategy({ restartRuntime });
    await strategy.apply(makeCtx({ kind: "plugin-enable", pluginId: "p1" }));
    expect(restartRuntime).toHaveBeenLastCalledWith("plugin enable: p1");
    await strategy.apply(makeCtx({ kind: "plugin-disable", pluginId: "p2" }));
    expect(restartRuntime).toHaveBeenLastCalledWith("plugin disable: p2");
  });

  it("propagates restartRuntime rejection", async () => {
    const restartRuntime = vi.fn<
      (reason: string) => Promise<AgentRuntime | null>
    >(async () => {
      throw new Error("boot failed");
    });
    const ctx = makeCtx();
    const strategy = createColdStrategy({ restartRuntime });
    await expect(strategy.apply(ctx)).rejects.toThrow("boot failed");
  });

  it("has the cold tier", () => {
    const strategy = createColdStrategy({
      restartRuntime: vi.fn<(reason: string) => Promise<AgentRuntime | null>>(),
    });
    expect(strategy.tier).toBe("cold");
  });
});
