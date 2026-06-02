import type { Action, AgentRuntime } from "@elizaos/core";
import { createMessageMemory, ModelType, stringToUuid } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  executeFallbackParsedActions,
  maybeHandleDirectBinanceSkillRequest,
} from "./binance-skill-helpers.ts";

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
      character: { name: "Milady" },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      getService: vi.fn(() => ({
        getLoadedSkill: vi.fn(() => ({ slug: "binance-meme-rush" })),
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

describe("maybeHandleDirectBinanceSkillRequest", () => {
  it("wraps explicitly raw direct skill payloads through TEXT_SMALL", async () => {
    const action: Action = {
      name: "USE_SKILL",
      description: "Use a skill",
      validate: vi.fn(async () => true),
      handler: vi.fn(async (_runtime, _message, _state, _options, callback) => {
        await callback?.({
          text: 'Script executed successfully: {"symbol":"MILADY","score":99}',
        });
        return { success: true };
      }),
    } as Action;
    const runtime = {
      actions: [action],
      character: { name: "Milady" },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      getService: vi.fn(() => ({
        getLoadedSkill: vi.fn(() => ({ slug: "binance-meme-rush" })),
      })),
      useModel: vi.fn(async (modelType, params) => {
        expect(modelType).toBe(ModelType.TEXT_SMALL);
        expect(String((params as { prompt?: string }).prompt)).toContain(
          "MILADY",
        );
        return JSON.stringify({
          response: 'Here is the raw payload: {"symbol":"MILADY","score":99}',
        });
      }),
    } as unknown as AgentRuntime;
    const message = createMessageMemory({
      id: stringToUuid("direct-binance-message"),
      entityId: stringToUuid("direct-binance-user"),
      roomId: stringToUuid("direct-binance-room"),
      content: { text: "raw binance-meme-rush", source: "test" },
    });
    const appended: string[] = [];
    let replaced = "";

    const result = await maybeHandleDirectBinanceSkillRequest(
      runtime,
      message,
      (incoming) => appended.push(incoming),
      (text) => {
        replaced = text;
      },
    );

    expect(appended).toEqual(["Fetching meme tokens from Binance..."]);
    expect(replaced).toBe(
      'Here is the raw payload: {"symbol":"MILADY","score":99}',
    );
    expect(result).toBe(replaced);
    expect(runtime.useModel).toHaveBeenCalledWith(
      ModelType.TEXT_SMALL,
      expect.any(Object),
    );
  });
});
