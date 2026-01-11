import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, type Mock, vi } from "vitest";
import { plugin } from "../../index.browser";

describe("plugin-sql browser entrypoint", () => {
  it("skips adapter registration when runtime is ready", async () => {
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000000" as UUID,
      isReady: vi.fn(() => Promise.resolve(true)),
      registerDatabaseAdapter: vi.fn(() => {}),
    } as Partial<IAgentRuntime> as IAgentRuntime;

    await plugin.init?.({}, runtime);

    expect(runtime.isReady).toHaveBeenCalledTimes(1);
    expect(runtime.registerDatabaseAdapter).not.toHaveBeenCalled();
  });

  it("registers PGlite adapter when readiness check fails", async () => {
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001" as UUID,
      isReady: vi.fn(() => Promise.reject(new Error("no adapter"))),
      registerDatabaseAdapter: vi.fn(() => {}),
    } as Partial<IAgentRuntime> as IAgentRuntime;

    await plugin.init?.({}, runtime);

    expect(runtime.isReady).toHaveBeenCalledTimes(1);
    expect(runtime.registerDatabaseAdapter).toHaveBeenCalledTimes(1);
    // Ensure an object resembling an adapter is passed
    const arg = (runtime.registerDatabaseAdapter as Mock).mock.calls[0][0];
    expect(arg).toBeDefined();
    expect(typeof arg.init).toBe("function");
    expect(typeof arg.isReady).toBe("function");
  });
});
