import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleTranscription } from "../src/models/transcription";

function makeRuntime(): IAgentRuntime {
  return {
    getSetting: (key: string) => {
      if (key === "ELIZAOS_CLOUD_API_KEY") return "test-key";
      if (key === "ELIZAOS_CLOUD_BASE_URL") return "https://cloud.test.local/api/v1";
      return undefined;
    },
  } as unknown as IAgentRuntime;
}

describe("plugin-elizacloud TRANSCRIPTION contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts the cloud STT transcript response shape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ transcript: "hello from cloud", duration_ms: 42 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const text = await handleTranscription(makeRuntime(), Buffer.from("RIFF....WAVEfmt "));

    expect(text).toBe("hello from cloud");
  });

  it("keeps backward compatibility with text responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ text: "legacy text" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const text = await handleTranscription(makeRuntime(), Buffer.from("RIFF....WAVEfmt "));

    expect(text).toBe("legacy text");
  });
});
