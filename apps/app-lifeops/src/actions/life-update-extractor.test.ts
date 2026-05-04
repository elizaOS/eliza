import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { extractUpdateFieldsWithLlm } from "./life-update-extractor.js";

const BASE_ARGS = {
  intent: "change workout to 6am",
  currentTitle: "Workout",
  currentCadenceKind: "daily",
  currentWindows: [] as string[],
};

describe("extractUpdateFieldsWithLlm", () => {
  it("returns the empty update object when runtime.useModel is unavailable", async () => {
    const result = await extractUpdateFieldsWithLlm({
      runtime: {} as IAgentRuntime,
      ...BASE_ARGS,
    });

    expect(result).toEqual({
      title: null,
      cadenceKind: null,
      windows: null,
      weekdays: null,
      timeOfDay: null,
      everyMinutes: null,
      priority: null,
      description: null,
    });
  });

  it("returns parsed update fields from a valid first-pass JSON response", async () => {
    const useModel = vi.fn(async () => '{"timeOfDay":"06:00"}');
    const result = await extractUpdateFieldsWithLlm({
      runtime: { useModel } as unknown as IAgentRuntime,
      ...BASE_ARGS,
    });

    expect(result.timeOfDay).toBe("06:00");
    expect(result.title).toBeNull();
    expect(useModel).toHaveBeenCalledTimes(1);
  });

  it("issues a repair pass when the first response is unparseable", async () => {
    const calls: string[] = [];
    const useModel = vi.fn(
      async (_type: string, opts: { prompt: string }) => {
        calls.push(opts.prompt);
        return calls.length === 1 ? "garbage" : '{"cadenceKind":"weekly"}';
      },
    );

    const result = await extractUpdateFieldsWithLlm({
      runtime: { useModel } as unknown as IAgentRuntime,
      ...BASE_ARGS,
    });

    expect(result.cadenceKind).toBe("weekly");
    expect(useModel).toHaveBeenCalledTimes(2);
    expect(calls[1]).toContain("Your last reply for the LifeOps update extractor was invalid");
  });
});
