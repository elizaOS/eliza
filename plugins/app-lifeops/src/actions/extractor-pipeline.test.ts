import type { IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { runExtractorPipeline } from "./extractor-pipeline.js";

function buildRuntime(useModel: unknown): IAgentRuntime {
  return { useModel } as unknown as IAgentRuntime;
}

describe("runExtractorPipeline", () => {
  it("returns an empty result when runtime.useModel is unavailable", async () => {
    const result = await runExtractorPipeline({
      runtime: {} as IAgentRuntime,
      prompt: "anything",
      parser: () => "parsed",
    });

    expect(result).toEqual({ parsed: null, raw: "", repaired: false });
  });

  it("returns the first-pass parse when it succeeds", async () => {
    const useModel = vi.fn(async () => '{"value":"ok"}');
    const result = await runExtractorPipeline({
      runtime: buildRuntime(useModel),
      prompt: "extract",
      parser: (raw) => (raw.includes("ok") ? { value: "ok" } : null),
      buildRepairPrompt: () => "repair",
    });

    expect(result.parsed).toEqual({ value: "ok" });
    expect(result.raw).toBe('{"value":"ok"}');
    expect(result.repaired).toBe(false);
    expect(useModel).toHaveBeenCalledTimes(1);
    expect(useModel).toHaveBeenCalledWith(ModelType.TEXT_LARGE, {
      prompt: "extract",
    });
  });

  it("invokes the repair prompt when the first parse returns null", async () => {
    const calls: string[] = [];
    const useModel = vi.fn(async (_type: string, opts: { prompt: string }) => {
      calls.push(opts.prompt);
      return calls.length === 1 ? "garbage" : '{"ok":true}';
    });
    const buildRepairPrompt = vi.fn((raw: string) => `repair after: ${raw}`);

    const result = await runExtractorPipeline({
      runtime: buildRuntime(useModel),
      prompt: "first",
      parser: (raw) => (raw.includes('"ok":true') ? { ok: true } : null),
      buildRepairPrompt,
    });

    expect(result.parsed).toEqual({ ok: true });
    expect(result.raw).toBe('{"ok":true}');
    expect(result.repaired).toBe(true);
    expect(buildRepairPrompt).toHaveBeenCalledWith("garbage");
    expect(useModel).toHaveBeenCalledTimes(2);
  });

  it("skips the repair pass when no buildRepairPrompt is provided", async () => {
    const useModel = vi.fn(async () => "garbage");
    const result = await runExtractorPipeline({
      runtime: buildRuntime(useModel),
      prompt: "first",
      parser: () => null,
    });

    expect(result).toEqual({ parsed: null, raw: "garbage", repaired: false });
    expect(useModel).toHaveBeenCalledTimes(1);
  });

  it("returns null parsed when the repair pass also fails to parse", async () => {
    const useModel = vi.fn(async () => "still garbage");
    const result = await runExtractorPipeline({
      runtime: buildRuntime(useModel),
      prompt: "first",
      parser: () => null,
      buildRepairPrompt: () => "repair",
    });

    expect(result.parsed).toBeNull();
    expect(result.raw).toBe("still garbage");
    expect(result.repaired).toBe(true);
    expect(useModel).toHaveBeenCalledTimes(2);
  });

  it("respects the requested model type", async () => {
    const useModel = vi.fn(async () => "{}");
    await runExtractorPipeline({
      runtime: buildRuntime(useModel),
      prompt: "p",
      parser: () => ({}),
      modelType: ModelType.TEXT_SMALL,
    });

    expect(useModel).toHaveBeenCalledWith(ModelType.TEXT_SMALL, {
      prompt: "p",
    });
  });

  it("returns an empty result and logs when useModel throws", async () => {
    const warn = vi.fn();
    const useModel = vi.fn(async () => {
      throw new Error("boom");
    });
    const runtime = {
      useModel,
      logger: { warn },
    } as unknown as IAgentRuntime;

    const result = await runExtractorPipeline({
      runtime,
      prompt: "p",
      parser: () => null,
      buildRepairPrompt: () => "repair",
    });

    expect(result).toEqual({ parsed: null, raw: "", repaired: false });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("coerces non-string model output to an empty string before parsing", async () => {
    const useModel = vi.fn(async () => ({ not: "a string" }));
    const parser = vi.fn(() => null);
    const result = await runExtractorPipeline({
      runtime: buildRuntime(useModel),
      prompt: "p",
      parser,
    });

    expect(parser).toHaveBeenCalledWith("");
    expect(result.raw).toBe("");
    expect(result.parsed).toBeNull();
  });
});
