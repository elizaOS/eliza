/**
 * Each serving-truth lookup failure in `resolveActiveChat` withholds serving
 * proof and reaches the runtime's error channel from its own catch. Uses a real
 * `AgentRuntime` with a real registered text handler; a failure case makes one
 * runtime lookup throw, and reports are read back from the runtime itself.
 */
import { AgentRuntime, ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import { resolveActiveChat } from "./model-config-routes.ts";

const directConfig = (backend: "openai" | "cerebras"): ElizaConfig => ({
  serviceRouting: { llmText: { transport: "direct", backend } },
});

function servingRuntime(): AgentRuntime {
  const runtime = new AgentRuntime({
    character: {
      name: "ServingTruth",
      bio: ["Resolves which provider serves chat"],
      settings: { secrets: { OPENAI_API_KEY: "sk-serving-truth" } },
    },
    logLevel: "fatal",
  });
  runtime.registerModel(ModelType.TEXT_SMALL, async () => "ok", "openai");
  return runtime;
}

function throwOnSetting(runtime: AgentRuntime, failingKey: string): Error {
  const failure = new Error(`${failingKey} lookup unavailable`);
  const getSetting = runtime.getSetting.bind(runtime);
  runtime.getSetting = (key) => {
    if (key === failingKey) throw failure;
    return getSetting(key);
  };
  return failure;
}

function servingTruthReports(runtime: AgentRuntime) {
  return runtime
    .getRecentReportedErrors()
    .filter((report) => report.scope === "model-config.serving-truth")
    .map(({ message, context }) => ({ message, context }));
}

describe("resolveActiveChat serving truth", () => {
  it("reports openai as serving when its handler and credential resolve", () => {
    const runtime = servingRuntime();

    expect(resolveActiveChat(directConfig("openai"), {}, runtime)).toEqual({
      provider: "openai",
      family: "OPENAI",
      endpoint: "api.openai.com",
    });
    expect(servingTruthReports(runtime)).toEqual([]);
  });

  it("reports a failed model-registration lookup", () => {
    const runtime = servingRuntime();
    runtime.getModelRegistrations = () => {
      throw new Error("registry unavailable");
    };

    expect(resolveActiveChat(directConfig("openai"), {}, runtime)).toBeNull();
    expect(servingTruthReports(runtime)).toEqual([
      { message: "registry unavailable", context: undefined },
    ]);
  });

  it("reports a failed lookup inside the cerebras-mode gate", () => {
    const runtime = servingRuntime();
    const failure = throwOnSetting(runtime, "ELIZA_PROVIDER");

    expect(resolveActiveChat(directConfig("cerebras"), {}, runtime)).toBeNull();
    expect(servingTruthReports(runtime)).toEqual([
      { message: failure.message, context: undefined },
    ]);
  });

  it("reports a failed credential lookup with the credential it was reading", () => {
    const runtime = servingRuntime();
    const failure = throwOnSetting(runtime, "OPENAI_API_KEY");

    expect(resolveActiveChat(directConfig("openai"), {}, runtime)).toBeNull();
    expect(servingTruthReports(runtime)).toEqual([
      {
        message: failure.message,
        context: { credentialKey: "OPENAI_API_KEY" },
      },
    ]);
  });
});
