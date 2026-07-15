/**
 * Offline unit coverage for the user reasoning-effort pin
 * (`ELIZAOS_CLOUD_REASONING_EFFORT`) on the native `/chat/completions` path —
 * the seam `/model … effort=…` persists for cloud-routed chat. The pin must
 * reach the wire only for the Cerebras-served reasoning trio (other proxied
 * models 400 on an unexpected `reasoning_effort`), invalid values are ignored
 * with a warning, and the thinking-off suppression still wins over the pin.
 *
 * The fetch is mocked: we capture the outgoing request body and return a
 * canned chat-completions response.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateNativeChatCompletion } from "../../src/models/text";

function runtime(settings: Record<string, string | undefined>): IAgentRuntime {
  const fixture = {
    character: { name: "Eliza", bio: [] },
    getSetting: (key: string) => settings[key],
    emitEvent: vi.fn(),
  };
  return fixture as unknown as IAgentRuntime;
}

function cannedResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

async function captureBody(
  modelName: string,
  settings: Record<string, string | undefined>,
  params: Record<string, unknown> = {}
): Promise<Record<string, unknown> | null> {
  let captured: Record<string, unknown> | null = null;
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === "string") {
        captured = JSON.parse(init.body) as Record<string, unknown>;
      }
      return cannedResponse();
    }
  );

  await generateNativeChatCompletion(
    runtime({ ELIZAOS_CLOUD_API_KEY: "eliza_test_key", ...settings }),
    "TEXT_LARGE",
    { prompt: "hi", ...params } as never,
    { modelName, prompt: "hi" }
  );

  return captured;
}

describe("ELIZAOS_CLOUD_REASONING_EFFORT user pin", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    "gemma-4-31b",
    "zai-glm-4.7",
    "gpt-oss-120b",
    "openai/gpt-oss-120b",
  ])("forwards a valid pin as reasoning_effort for %s", async (modelName) => {
    const body = await captureBody(modelName, {
      ELIZAOS_CLOUD_REASONING_EFFORT: "high",
    });
    expect(body?.reasoning_effort).toBe("high");
  });

  it("omits reasoning_effort when no pin is set", async () => {
    const body = await captureBody("zai-glm-4.7", {});
    expect(body?.reasoning_effort).toBeUndefined();
  });

  it("does not attach the pin to non-Cerebras proxied models", async () => {
    const body = await captureBody("gpt-4o-mini", {
      ELIZAOS_CLOUD_REASONING_EFFORT: "high",
    });
    expect(body?.reasoning_effort).toBeUndefined();
  });

  it("ignores an invalid pin value", async () => {
    const body = await captureBody("zai-glm-4.7", {
      ELIZAOS_CLOUD_REASONING_EFFORT: "ultra",
    });
    expect(body?.reasoning_effort).toBeUndefined();
  });

  it("lets the thinking-off suppression win over the pin", async () => {
    const body = await captureBody(
      "zai-glm-4.7",
      { ELIZAOS_CLOUD_REASONING_EFFORT: "high" },
      { providerOptions: { eliza: { thinking: "off" } } }
    );
    expect(body?.reasoning_effort).toBe("none");
  });
});
