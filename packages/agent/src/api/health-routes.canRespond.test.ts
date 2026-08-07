/** Exercises health route can-respond HTTP behavior with deterministic server test doubles. */
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { computeCanRespond, computeCanRespondAsync } from "./health-routes";

/**
 * computeCanRespond is the single source of truth for "first-turn capability
 * online" shared by GET /api/status AND the WS `status` broadcast. Locking the
 * contract here keeps the two readiness signals from drifting (the drift that
 * stuck the chat composer on "waking up").
 */
function makeRuntime(opts: { 
  hasTextHandler: boolean;
  hasOllama?: boolean;
  getModelRegistrations?: () => any[];
}): AgentRuntime {
  return {
    getModel: (key: string) =>
      opts.hasTextHandler && key === ModelType.TEXT_LARGE
        ? () => undefined
        : undefined,
    getModelRegistrations: opts.getModelRegistrations,
  } as unknown as AgentRuntime;
}

describe("computeCanRespond", () => {
  it("is false when there is no runtime", () => {
    expect(computeCanRespond(null, "running")).toBe(false);
  });

  it("is false when the agent is not running, even with a text handler", () => {
    expect(
      computeCanRespond(makeRuntime({ hasTextHandler: true }), "starting"),
    ).toBe(false);
  });

  it("is false when running but no TEXT generation handler is registered", () => {
    expect(
      computeCanRespond(makeRuntime({ hasTextHandler: false }), "running"),
    ).toBe(false);
  });

  it("is true once running with a registered TEXT generation handler", () => {
    expect(
      computeCanRespond(makeRuntime({ hasTextHandler: true }), "running"),
    ).toBe(true);
  });
});

describe("computeCanRespondAsync", () => {
  it("is false when there is no runtime", async () => {
    expect(await computeCanRespondAsync(null, "running")).toBe(false);
  });

  it("is false when the agent is not running, even with a text handler", async () => {
    expect(
      await computeCanRespondAsync(makeRuntime({ hasTextHandler: true }), "starting"),
    ).toBe(false);
  });

  it("is false when running but no TEXT generation handler is registered", async () => {
    expect(
      await computeCanRespondAsync(makeRuntime({ hasTextHandler: false }), "running"),
    ).toBe(false);
  });

  it("is true once running with a registered TEXT generation handler", async () => {
    expect(
      await computeCanRespondAsync(makeRuntime({ hasTextHandler: true }), "running"),
    ).toBe(true);
  });

  it("returns false for Ollama without OLLAMA_BASE_URL configured", async () => {
    const runtime = makeRuntime({
      hasTextHandler: true,
      getModelRegistrations: () => [
        { modelType: ModelType.TEXT_LARGE, provider: "ollama" },
      ],
    });
    
    // Ensure env vars are not set
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_API_BASE_URL;
    
    expect(await computeCanRespondAsync(runtime, "running")).toBe(false);
  });

  it("returns true for Ollama with OLLAMA_BASE_URL configured", async () => {
    const runtime = makeRuntime({
      hasTextHandler: true,
      getModelRegistrations: () => [
        { modelType: ModelType.TEXT_LARGE, provider: "ollama" },
      ],
    });
    
    process.env.OLLAMA_BASE_URL = "http://localhost:11434";
    
    expect(await computeCanRespondAsync(runtime, "running")).toBe(true);
    
    delete process.env.OLLAMA_BASE_URL;
  });

  it("returns true for non-Ollama providers", async () => {
    const runtime = makeRuntime({
      hasTextHandler: true,
      getModelRegistrations: () => [
        { modelType: ModelType.TEXT_LARGE, provider: "openai" },
      ],
    });
    
    expect(await computeCanRespondAsync(runtime, "running")).toBe(true);
  });
});
