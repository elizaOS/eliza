import type { Action, IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { runDirectBinanceSkillDispatch } from "./direct-dispatch";
import { binanceSkillPreHandler } from "./pre-handler";

// The plugin's global test setup stubs @elizaos/core; restore the real module
// here so ModelType and friends resolve to their actual values.
vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return actual;
});

const { ModelType } = await import("@elizaos/core");

function makeRuntime(): IAgentRuntime {
  const action: Action = {
    name: "USE_SKILL",
    description: "Use a skill",
    validate: vi.fn(async () => true),
    handler: vi.fn(async (_runtime, _message, _state, _options, callback) => {
      await callback?.({
        text: 'Script executed successfully: {"symbol":"EXMPL","score":99}',
      });
      return { success: true };
    }),
  } as Action;
  return {
    actions: [action],
    character: { name: "Example" },
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
      expect(String((params as { prompt?: string }).prompt)).toContain("EXMPL");
      return JSON.stringify({
        response: 'Here is the raw payload: {"symbol":"EXMPL","score":99}',
      });
    }),
  } as unknown as IAgentRuntime;
}

function makeMessage(text: string): Memory {
  return { content: { text, source: "test" } } as Memory;
}

describe("runDirectBinanceSkillDispatch", () => {
  it("wraps explicitly raw direct skill payloads through TEXT_SMALL", async () => {
    const runtime = makeRuntime();
    const message = makeMessage("raw binance-meme-rush");
    const appended: string[] = [];
    let replaced = "";

    const result = await runDirectBinanceSkillDispatch(
      runtime,
      message,
      (incoming) => appended.push(incoming),
      (text) => {
        replaced = text;
      },
    );

    expect(appended).toEqual(["Fetching meme tokens from Binance..."]);
    expect(replaced).toBe(
      'Here is the raw payload: {"symbol":"EXMPL","score":99}',
    );
    expect(result).toBe(replaced);
    expect(runtime.useModel).toHaveBeenCalledWith(
      ModelType.TEXT_SMALL,
      expect.any(Object),
    );
  });

  it("passes through (returns null) for a non-Binance message", async () => {
    const runtime = makeRuntime();
    const message = makeMessage("what's the weather today?");
    const appended: string[] = [];

    const result = await runDirectBinanceSkillDispatch(
      runtime,
      message,
      (incoming) => appended.push(incoming),
      () => {},
    );

    expect(result).toBeNull();
    expect(appended).toEqual([]);
    expect(runtime.useModel).not.toHaveBeenCalled();
  });
});

describe("binanceSkillPreHandler", () => {
  it("dispatches a Binance trigger and returns the voiced result", async () => {
    const runtime = makeRuntime();
    const message = makeMessage("raw binance-meme-rush");
    const appended: string[] = [];
    let replaced = "";

    const result = await binanceSkillPreHandler.tryHandle({
      runtime,
      message,
      appendText: (incoming) => appended.push(incoming),
      replaceText: (text) => {
        replaced = text;
      },
    });

    expect(result).toEqual({
      responseText: 'Here is the raw payload: {"symbol":"EXMPL","score":99}',
    });
    expect(replaced).toBe(
      'Here is the raw payload: {"symbol":"EXMPL","score":99}',
    );
    expect(appended).toEqual(["Fetching meme tokens from Binance..."]);
  });

  it("returns null (pass-through) when the message is not a Binance trigger", async () => {
    const runtime = makeRuntime();
    const message = makeMessage("please summarize my unread emails");

    const result = await binanceSkillPreHandler.tryHandle({
      runtime,
      message,
      appendText: () => {},
      replaceText: () => {},
    });

    expect(result).toBeNull();
    expect(runtime.useModel).not.toHaveBeenCalled();
  });
});
