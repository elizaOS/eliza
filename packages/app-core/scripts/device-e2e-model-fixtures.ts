/**
 * Deterministic model responses used by the real device-e2e host agent.
 * Matches only the conversation-title side call and the real response-handler
 * turn so new model calls fail closed instead of silently fabricating output.
 */

import type { Plugin } from "@elizaos/core";
import type {
  DeterministicModelCall,
  DeterministicModelResponse,
} from "@elizaos/core/testing";

const DEVICE_E2E_EMBEDDING_DIMENSIONS = 384;

/**
 * Supplies the real runtime's recall pipeline without downloading a model.
 * Device E2E starts from an empty isolated database, so a stable unit vector is
 * sufficient while still exercising the runtime's normal embedding boundary.
 */
export const deviceE2eEmbeddingPlugin: Plugin = {
  name: "device-e2e-embedding-fixture",
  description: "Deterministic embedding boundary for real device E2E hosts.",
  models: {
    TEXT_EMBEDDING: async () => [
      1,
      ...new Array(DEVICE_E2E_EMBEDDING_DIMENSIONS - 1).fill(0),
    ],
  },
};

export const STREAM_E2E_REPLY =
  "STREAM_E2E_OK The dashboard receives this reply through the real model callback, runtime message loop, HTTP SSE route, browser parser, and React transcript. " +
  "Each chunk is intentionally small and evenly paced so the browser lane can measure token-to-paint latency, frame cadence, layout stability, and DOM identity while the visible answer grows.";

const CONVERSATION_TITLE_PROMPT =
  "generate a very short, concise title (max 4-5 words) for the conversation";

export function resolveDeviceE2eModelCall(
  call: DeterministicModelCall,
  workflowJourney = false,
): DeterministicModelResponse | null {
  if (
    call.modelType === "TEXT_SMALL" &&
    call.latestUserText.includes(CONVERSATION_TITLE_PROMPT)
  ) {
    return "Device E2E chat";
  }
  if (workflowJourney && call.modelType === "TEXT_LARGE") {
    return { message: "Digest ready" };
  }
  if (call.modelType !== "RESPONSE_HANDLER") return null;
  return {
    shouldRespond: "RESPOND",
    contexts: ["simple"],
    intents: ["chat"],
    replyText: STREAM_E2E_REPLY,
    candidateActionNames: [],
    facts: [],
    relationships: [],
    addressedTo: [],
    emotion: "none",
  };
}
