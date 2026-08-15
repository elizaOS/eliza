/**
 * Exercises the research task boundary with a deterministic runtime stub. The
 * suite proves that only the real RESEARCH slot can produce successful research.
 */
import { type IAgentRuntime, ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { ResearchTaskExecutor } from "./research-task-executor.ts";

const spec = {
  id: "research-1",
  type: "research",
  description: "Research current browser security guidance",
};

function runtimeWith(useModel: unknown): IAgentRuntime {
  return { useModel } as IAgentRuntime;
}

describe("ResearchTaskExecutor", () => {
  it("returns the real RESEARCH provider report", async () => {
    const useModel = vi.fn(
      async (_modelType: string, _params: unknown) => "Cited research report",
    );

    const result = await new ResearchTaskExecutor().execute(
      spec,
      runtimeWith(useModel),
    );

    expect(result).toMatchObject({
      success: true,
      output: "Cited research report",
    });
    expect(useModel).toHaveBeenCalledTimes(1);
    expect(useModel).toHaveBeenCalledWith(
      ModelType.RESEARCH,
      expect.objectContaining({ input: spec.description }),
    );
  });

  it("exposes provider rejection and never falls back to TEXT_LARGE", async () => {
    const useModel = vi.fn(async (_modelType: string, _params: unknown) => {
      throw new Error("no RESEARCH model registered");
    });

    const result = await new ResearchTaskExecutor().execute(
      spec,
      runtimeWith(useModel),
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: "RESEARCH_PROVIDER_FAILED",
      error:
        "The configured research provider failed: no RESEARCH model registered",
    });
    expect(useModel).toHaveBeenCalledTimes(1);
    expect(useModel.mock.calls[0]?.[0]).toBe(ModelType.RESEARCH);
  });

  it("rejects an empty provider response as an explicit failure", async () => {
    const useModel = vi.fn(
      async (_modelType: string, _params: unknown) => "   ",
    );

    const result = await new ResearchTaskExecutor().execute(
      spec,
      runtimeWith(useModel),
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: "RESEARCH_EMPTY_RESULT",
      error: "The research provider returned no report",
    });
    expect(useModel).toHaveBeenCalledTimes(1);
  });
});
