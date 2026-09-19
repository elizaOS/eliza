/** Exercises benchmark admission through real provider composition and ordinary plugin registration. */

import { AgentRuntime, type Memory } from "@elizaos/core";
import { contextBenchProvider } from "@elizaos/testing";
import { initializeTestRuntime } from "@elizaos/testing/in-memory-adapter";
import { describe, expect, it } from "vitest";
import {
  composeResponseState,
  selectV5PlannerStateProviderNames,
} from "./message/provider-state.ts";

function message(content: Memory["content"] = { text: "answer this" }): Memory {
  return {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    entityId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    roomId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    content,
  };
}
describe("message service benchmark integration", () => {
  it("composes complete benchmark context only for the request carrying it", async () => {
    const runtime = new AgentRuntime({
      character: { name: "benchmark-contract", bio: [] },
    });
    await initializeTestRuntime(runtime, { skipMigrations: true });
    try {
      const context = "Complete benchmark evidence\n".repeat(1000).trim();
      runtime.registerProvider(contextBenchProvider);
      const inbound = { ...message(), entityId: runtime.agentId };
      inbound.metadata = { benchmarkContext: context };
      const stage1 = await composeResponseState(runtime, inbound, true);
      expect(stage1.text).not.toContain(context);
      const providers = selectV5PlannerStateProviderNames({
        runtime,
        message: inbound,
        selectedContexts: ["general"],
        userRoles: ["OWNER"],
      });
      const benchmark = await runtime.composeState(
        inbound,
        providers,
        true,
        true,
      );
      expect(benchmark.text).toContain(context);
      const ordinary = await runtime.composeState(
        {
          ...message(),
          entityId: runtime.agentId,
          id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
        },
        providers,
        true,
        true,
      );
      expect(ordinary.text).not.toContain(context);
    } finally {
      await runtime.stop();
    }
  });
});
