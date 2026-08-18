/**
 * Deterministic unit coverage for the real device-e2e host model boundary.
 * Proves title generation cannot abort the first chat turn while unrelated
 * model calls remain unmatched and therefore fail closed.
 */

import type { DeterministicModelCall } from "@elizaos/core/testing";
import { describe, expect, it } from "vitest";
import {
  deviceE2eEmbeddingPlugin,
  resolveDeviceE2eModelCall,
  STREAM_E2E_REPLY,
} from "./device-e2e-model-fixtures.ts";

function call(
  modelType: DeterministicModelCall["modelType"],
  latestUserText: string,
): DeterministicModelCall {
  return {
    modelType,
    latestUserText,
    params: { prompt: latestUserText },
    toolNames: [],
  };
}

describe("device-e2e host model fixtures", () => {
  it("provides the embedding boundary required by real-runtime recall", async () => {
    const handler = deviceE2eEmbeddingPlugin.models?.TEXT_EMBEDDING;
    expect(handler).toBeTypeOf("function");
    const embedding = await handler?.({} as never, null);
    expect(embedding).toHaveLength(384);
    expect(embedding?.[0]).toBe(1);
  });

  it("answers the conversation-title side call before the chat response", () => {
    expect(
      resolveDeviceE2eModelCall(
        call(
          "TEXT_SMALL",
          "Based on the user's first message, generate a very short, concise title (max 4-5 words) for the conversation.",
        ),
      ),
    ).toBe("Device E2E chat");
  });

  it("returns the marker from the response-handler turn", () => {
    expect(
      resolveDeviceE2eModelCall(call("RESPONSE_HANDLER", "Say hello.")),
    ).toMatchObject({ replyText: expect.stringContaining(STREAM_E2E_REPLY) });
  });

  it("leaves unrelated small-model calls unmatched", () => {
    expect(
      resolveDeviceE2eModelCall(
        call("TEXT_SMALL", "Invent an unrelated answer"),
      ),
    ).toBeNull();
  });
});
