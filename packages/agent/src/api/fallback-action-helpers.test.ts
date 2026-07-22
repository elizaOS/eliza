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

  it.each([
    ["unchanged", async () => JSON.stringify({ response: "Exact output." })],
    ["malformed", async () => "not json"],
    [
      "failed",
      async () => {
        throw new Error("formatter unavailable");
      },
    ],
  ])(
    "keeps original fallback output when rewriting is %s",
    async (_case, model) => {
      const action: Action = {
        name: "CUSTOM_FALLBACK",
        description: "Return an exact action result",
        validate: vi.fn(async () => true),
        handler: vi.fn(
          async (_runtime, _message, _state, _options, callback) => {
            await callback?.({ text: "Exact output." });
            return { success: true };
          },
        ),
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
        useModel: vi.fn(model),
      } as unknown as AgentRuntime;
      const message = createMessageMemory({
        id: stringToUuid(`fallback-${_case}`),
        entityId: stringToUuid("fallback-user"),
        roomId: stringToUuid("fallback-room"),
        content: { text: "run exact fallback", source: "test" },
      });
      const appended: string[] = [];

      await executeFallbackParsedActions(
        runtime,
        message,
        [{ name: "CUSTOM_FALLBACK", parameters: {} }],
        (incoming) => appended.push(incoming),
        () => undefined,
      );

      expect(appended).toEqual(["Exact output."]);
    },
  );

  it("preserves canonical callback text when the action opts out of voice rewriting", async () => {
    const action: Action = {
      name: "VIEWS",
      description: "Navigate views",
      preserveCallbackText: true,
      validate: vi.fn(async () => true),
      handler: vi.fn(async (_runtime, _message, _state, _options, callback) => {
        await callback?.({ text: "Navigated to Notes." });
        return { success: true };
      }),
    } as Action;
    const runtime = {
      actions: [action],
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      useModel: vi.fn(async () =>
        JSON.stringify({ response: "I opened Notes for you." }),
      ),
    } as unknown as AgentRuntime;
    const message = createMessageMemory({
      id: stringToUuid("fallback-views-message"),
      entityId: stringToUuid("fallback-user"),
      roomId: stringToUuid("fallback-room"),
      content: { text: "open notes", source: "test" },
    });
    const appended: string[] = [];

    await executeFallbackParsedActions(
      runtime,
      message,
      [{ name: "VIEWS", parameters: { action: "show", view: "notes" } }],
      (incoming) => appended.push(incoming),
      () => undefined,
    );

    expect(appended).toEqual(["Navigated to Notes."]);
    expect(runtime.useModel).not.toHaveBeenCalled();
  });
});
