/**
 * Unit coverage for the cold reload strategy — restart closure delegation,
 * success/failure phase reporting, and intent description.
 */
import { describe, expect, it, vi } from "vitest";
import { createColdStrategy } from "./cold-strategy.ts";

function makeCtx(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    intent: { kind: "restart", reason: "manual" },
    reportPhase: vi.fn(),
    ...overrides,
  } as never;
}

describe("createColdStrategy", () => {
  it("reports a succeeded phase and returns the new runtime", async () => {
    const newRuntime = { id: "rt-2" };
    const restartRuntime = vi.fn(async () => newRuntime);
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
    const restartRuntime = vi.fn(async () => null);
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
    const restartRuntime = vi.fn(async () => ({ id: "rt" }));
    const ctx = makeCtx({
      intent: { kind: "provider-switch", provider: "anthropic" },
    });
    const strategy = createColdStrategy({ restartRuntime });
    await strategy.apply(ctx);
    expect(restartRuntime).toHaveBeenCalledWith("provider switch to anthropic");
  });

  it("describes config-reload intent", async () => {
    const restartRuntime = vi.fn(async () => ({ id: "rt" }));
    const ctx = makeCtx({ intent: { kind: "config-reload" } });
    const strategy = createColdStrategy({ restartRuntime });
    await strategy.apply(ctx);
    expect(restartRuntime).toHaveBeenCalledWith("config reload");
  });

  it("describes plugin enable/disable intents", async () => {
    const restartRuntime = vi.fn(async () => ({ id: "rt" }));
    const strategy = createColdStrategy({ restartRuntime });
    await strategy.apply(
      makeCtx({ intent: { kind: "plugin-enable", pluginId: "p1" } }),
    );
    expect(restartRuntime).toHaveBeenLastCalledWith("plugin enable: p1");
    await strategy.apply(
      makeCtx({ intent: { kind: "plugin-disable", pluginId: "p2" } }),
    );
    expect(restartRuntime).toHaveBeenLastCalledWith("plugin disable: p2");
  });

  it("propagates restartRuntime rejection", async () => {
    const restartRuntime = vi.fn(async () => {
      throw new Error("boot failed");
    });
    const ctx = makeCtx();
    const strategy = createColdStrategy({ restartRuntime });
    await expect(strategy.apply(ctx)).rejects.toThrow("boot failed");
  });

  it("has the cold tier", () => {
    const strategy = createColdStrategy({ restartRuntime: vi.fn() });
    expect(strategy.tier).toBe("cold");
  });
});
