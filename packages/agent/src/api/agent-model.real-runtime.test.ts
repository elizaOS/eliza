/**
 * Exercises the #20045 R1/R2 model-reporting path against a real
 * `AgentRuntime` — real `registerModel`, real `useModel`, real
 * last-resolved-provider bookkeeping — rather than a hand-built runtime stub.
 * Only the database adapter is stubbed, because `useModel` logs through it.
 *
 * Reproduces the shipped first-run state: cloud-proxy routing with a character
 * `model` pinned to elizacloud, no signed-in account, so plugin-elizacloud
 * registers no text handler and local inference is the only path that can
 * serve. `/api/status` used to report "elizacloud" here.
 */
import { AgentRuntime, ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { detectRuntimeModel } from "./agent-model.ts";

const cloudProxyConfig = {
  serviceRouting: {
    llmText: {
      backend: "elizacloud",
      transport: "cloud-proxy" as const,
      accountId: "elizacloud",
    },
  },
};

function makeRealRuntime() {
  return new AgentRuntime({
    character: {
      name: "Repro",
      // The first-run default pin that made /api/status claim elizacloud.
      model: "elizacloud",
      bio: [],
    } as never,
  });
}

describe("#20045 R1/R2 on a real AgentRuntime", () => {
  it("reports the provider that really served, not the cloud-proxy config", async () => {
    const runtime = makeRealRuntime();
    // Unsigned Cloud: plugin-elizacloud registers NO text handler. Only local does.
    runtime.registerModel(
      ModelType.TEXT_SMALL,
      async () => "hello from local",
      "eliza-local-inference",
      0,
    );
    // useModel logs through the adapter; a no-op stub keeps the real
    // provider-resolution path intact without standing up a database.
    (runtime as unknown as { adapter: unknown }).adapter = {
      createLogs: async () => undefined,
      log: async () => undefined,
    };
    await runtime.useModel(ModelType.TEXT_SMALL, { prompt: "hi" });

    const model = detectRuntimeModel(runtime, cloudProxyConfig);
    expect(model).toBe("eliza-local-inference");
    expect(model).not.toBe("elizacloud");
  });
});
