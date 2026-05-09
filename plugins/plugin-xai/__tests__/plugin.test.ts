import { ModelType } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { XAIPlugin } from "../index";

function createRuntime(settings: Record<string, string> = {}) {
  return {
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => settings[key] ?? null),
  };
}

describe("XAIPlugin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("declares the xai plugin name", () => {
    expect(XAIPlugin.name).toBe("xai");
  });

  it("registers the three Grok model handlers", () => {
    expect(XAIPlugin.models).toBeDefined();
    expect(XAIPlugin.models?.[ModelType.TEXT_SMALL]).toBeTypeOf("function");
    expect(XAIPlugin.models?.[ModelType.TEXT_LARGE]).toBeTypeOf("function");
    expect(XAIPlugin.models?.[ModelType.TEXT_EMBEDDING]).toBeTypeOf("function");
  });

  it("does not register actions, services, or providers (Grok-only scope)", () => {
    expect(XAIPlugin.actions ?? []).toHaveLength(0);
    expect(XAIPlugin.services ?? []).toHaveLength(0);
    expect(XAIPlugin.providers ?? []).toHaveLength(0);
  });

  it("emits MODEL_USED usage for text and embedding calls", async () => {
    const runtime = createRuntime({
      XAI_API_KEY: "xai-test",
      XAI_SMALL_MODEL: "grok-small-test",
      XAI_MODEL: "grok-large-test",
      XAI_EMBEDDING_MODEL: "grok-embed-test",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        const body = init?.body ? JSON.parse(String(init.body)) : {};

        if (href.endsWith("/chat/completions")) {
          return new Response(
            JSON.stringify({
              id: "chatcmpl-test",
              object: "chat.completion",
              created: 1,
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: `${body.model} response`,
                  },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: body.model === "grok-small-test" ? 9 : 11,
                completion_tokens: body.model === "grok-small-test" ? 3 : 4,
                total_tokens: body.model === "grok-small-test" ? 12 : 15,
              },
            }),
            { status: 200 },
          );
        }

        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
            model: body.model,
            usage: { prompt_tokens: 5, total_tokens: 5 },
          }),
          { status: 200 },
        );
      }),
    );

    await XAIPlugin.models?.[ModelType.TEXT_SMALL]?.(runtime as never, {
      prompt: "small prompt",
    });
    await XAIPlugin.models?.[ModelType.TEXT_LARGE]?.(runtime as never, {
      prompt: "large prompt",
    });
    await XAIPlugin.models?.[ModelType.TEXT_EMBEDDING]?.(runtime as never, {
      text: "embed prompt",
    });

    expect(runtime.emitEvent).toHaveBeenNthCalledWith(
      1,
      "MODEL_USED",
      expect.objectContaining({
        source: "xai",
        type: "TEXT_SMALL",
        model: "grok-small-test",
        tokens: { prompt: 9, completion: 3, total: 12 },
      }),
    );
    expect(runtime.emitEvent).toHaveBeenNthCalledWith(
      2,
      "MODEL_USED",
      expect.objectContaining({
        source: "xai",
        type: "TEXT_LARGE",
        model: "grok-large-test",
        tokens: { prompt: 11, completion: 4, total: 15 },
      }),
    );
    expect(runtime.emitEvent).toHaveBeenNthCalledWith(
      3,
      "MODEL_USED",
      expect.objectContaining({
        source: "xai",
        type: "TEXT_EMBEDDING",
        model: "grok-embed-test",
        tokens: { prompt: 5, completion: 0, total: 5 },
      }),
    );
  });
});
