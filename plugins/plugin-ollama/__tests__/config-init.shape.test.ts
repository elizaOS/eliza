import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { shouldEnable } from "../auto-enable";
import { ollamaPlugin } from "../plugin";
import { getApiBase, getBaseURL } from "../utils/config";

function runtime(settings: Record<string, string | undefined> = {}): IAgentRuntime {
  return {
    getSetting: vi.fn((key: string) => settings[key] ?? null),
  } as unknown as IAgentRuntime;
}

describe("Ollama config and init plumbing", () => {
  it("uses OLLAMA_BASE_URL consistently with auto-enable", () => {
    expect(shouldEnable({ env: { OLLAMA_BASE_URL: "http://remote:11434" } })).toBe(true);
    expect(getBaseURL(runtime({ OLLAMA_BASE_URL: "http://remote:11434" }))).toBe(
      "http://remote:11434/api"
    );
    expect(getApiBase(runtime({ OLLAMA_BASE_URL: "http://remote:11434/api" }))).toBe(
      "http://remote:11434"
    );
  });

  it("keeps endpoint precedence over base URL", () => {
    expect(
      getBaseURL(
        runtime({
          OLLAMA_API_ENDPOINT: "http://endpoint:11434/api",
          OLLAMA_API_URL: "http://api-url:11434",
          OLLAMA_BASE_URL: "http://base-url:11434",
        })
      )
    ).toBe("http://endpoint:11434/api");
  });

  it("uses runtime.fetch for init validation", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ models: [] })));
    const initRuntime = {
      ...runtime({ OLLAMA_BASE_URL: "http://remote:11434" }),
      fetch: fetchMock,
    } as unknown as IAgentRuntime & { fetch: typeof fetch };

    await expect(ollamaPlugin.init?.({}, initRuntime)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith("http://remote:11434/api/tags", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
  });
});
