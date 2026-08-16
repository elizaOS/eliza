/**
 * Exercises the research task boundary with a deterministic runtime stub. The
 * suite proves that only the real RESEARCH slot can produce successful research.
 */
import {
  type IAgentRuntime,
  ModelType,
  type ResearchResult,
} from "@elizaos/core";
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

function researchResult(
  overrides: Partial<ResearchResult> = {},
): ResearchResult {
  return {
    id: "research-response-1",
    text: "Cited research report",
    annotations: [],
    outputItems: [],
    status: "completed",
    ...overrides,
  };
}

describe("ResearchTaskExecutor", () => {
  it("returns the real RESEARCH provider report", async () => {
    const useModel = vi.fn(async (_modelType: string, _params: unknown) =>
      researchResult(),
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
      expect.objectContaining({
        input: spec.description,
        background: false,
      }),
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

  it("rejects a terminal provider failure", async () => {
    const useModel = vi.fn(async (_modelType: string, _params: unknown) =>
      researchResult({ status: "failed", text: "" }),
    );

    const result = await new ResearchTaskExecutor().execute(
      spec,
      runtimeWith(useModel),
    );

    expect(result).toMatchObject({
      success: false,
      errorCode: "RESEARCH_FAILED_RESULT",
      error: "The research provider reported a terminal failure",
    });
    expect(useModel).toHaveBeenCalledTimes(1);
    expect(useModel.mock.calls[0]?.[0]).toBe(ModelType.RESEARCH);
  });

  it.each(["queued", "in_progress"] as const)(
    "rejects a %s acknowledgement even when it carries partial text",
    async (status) => {
      const useModel = vi.fn(async (_modelType: string, _params: unknown) =>
        researchResult({ status, text: "Partial non-terminal report" }),
      );

      const result = await new ResearchTaskExecutor().execute(
        spec,
        runtimeWith(useModel),
      );

      expect(result).toMatchObject({
        success: false,
        errorCode: "RESEARCH_NON_TERMINAL_RESULT",
        error: `The research provider returned a non-terminal ${status} result`,
      });
      expect(useModel).toHaveBeenCalledTimes(1);
      expect(useModel.mock.calls[0]?.[0]).toBe(ModelType.RESEARCH);
    },
  );

  it("rejects an empty completed response as an explicit failure", async () => {
    const useModel = vi.fn(async (_modelType: string, _params: unknown) =>
      researchResult({ text: "   " }),
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
