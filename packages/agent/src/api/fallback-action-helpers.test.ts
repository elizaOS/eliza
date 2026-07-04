/**
 * Unit coverage for `executeFallbackParsedActions`: when the runtime parses
 * fallback tool calls out of a model response, each action's raw callback text
 * is rewritten through a TEXT_SMALL model pass into a natural reply before it is
 * appended. Deterministic — the runtime, services, and `useModel` are vitest
 * mocks; no live model.
 */
import type { Action, AgentRuntime } from "@elizaos/core";
import { createMessageMemory, ModelType, stringToUuid } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { executeFallbackParsedActions } from "./fallback-action-helpers.ts";

describe("executeFallbackParsedActions", () => {
  it("rewrites fallback action callback text through TEXT_SMALL before appending", async () => {
    const action: Action = {
      name: "CUSTOM_FALLBACK",
      description: "Block a site",
      validate: vi.fn(async () => true),
      handler: vi.fn(async (_runtime, _message, _state, _options, callback) => {
        await callback?.({ text: "stdout: block active for example.com" });
        return { success: true };
      }),
    } as Action;
    const runtime = {
      actions: [action],
      character: { name: "Example" },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      getService: vi.fn(() => ({
        getLoadedSkill: vi.fn(() => ({ slug: "example-skill" })),
      })),
      useModel: vi.fn(async (modelType, params) => {
        expect(modelType).toBe(ModelType.TEXT_SMALL);
        expect(String((params as { prompt?: string }).prompt)).toContain(
          "stdout: block active for example.com",
        );
        return JSON.stringify({
          response: "I turned on the block for example.com.",
        });
      }),
    } as unknown as AgentRuntime;
    const message = createMessageMemory({
      id: stringToUuid("fallback-message"),
      entityId: stringToUuid("fallback-user"),
      roomId: stringToUuid("fallback-room"),
      content: { text: "block example.com", source: "test" },
    });
    const appended: string[] = [];
    const callbacks: Array<{ actionTag: string; hasText: boolean }> = [];

    await executeFallbackParsedActions(
      runtime,
      message,
      [{ name: "CUSTOM_FALLBACK", parameters: { target: "example.com" } }],
      (incoming) => appended.push(incoming),
      (actionTag, hasText) => callbacks.push({ actionTag, hasText }),
    );

    expect(appended).toEqual(["I turned on the block for example.com."]);
    expect(callbacks).toEqual([
      { actionTag: "CUSTOM_FALLBACK", hasText: true },
    ]);
    expect(runtime.useModel).toHaveBeenCalledWith(
      ModelType.TEXT_SMALL,
      expect.any(Object),
    );
  });
});
