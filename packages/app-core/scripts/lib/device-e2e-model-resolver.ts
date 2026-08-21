/**
 * Resolves deterministic model calls made by the real device-e2e host agent.
 * The fixture covers both the chat response and the conversation-title side
 * call so the real API pipeline cannot fail after accepting a device message.
 */

type DeviceE2eModelCall = {
  modelType: string;
  latestUserText?: string | null;
};

type DeviceE2eModelResolverOptions = {
  workflowJourney?: boolean;
};

export const STREAM_E2E_REPLY =
  "STREAM_E2E_OK The dashboard receives this reply through the real model callback, runtime message loop, HTTP SSE route, browser parser, and React transcript. " +
  "Each chunk is intentionally small and evenly paced so the browser lane can measure token-to-paint latency, frame cadence, layout stability, and DOM identity while the visible answer grows.";

const CONVERSATION_TITLE_PROMPT =
  /generate a very short, concise title|title should reflect the topic or intent/i;

export function resolveDeviceE2eModelCall(
  call: DeviceE2eModelCall,
  { workflowJourney = false }: DeviceE2eModelResolverOptions = {},
): { message: string } | string | null {
  if (workflowJourney && call.modelType === "TEXT_LARGE") {
    return { message: "Digest ready" };
  }
  if (
    call.modelType === "TEXT_SMALL" &&
    CONVERSATION_TITLE_PROMPT.test(call.latestUserText ?? "")
  ) {
    return { message: "Short greeting" };
  }
  if (call.modelType !== "RESPONSE_HANDLER") return null;

  return JSON.stringify({
    shouldRespond: "RESPOND",
    contexts: ["simple"],
    intents: ["chat"],
    replyText: STREAM_E2E_REPLY,
    candidateActionNames: [],
    facts: [],
    relationships: [],
    addressedTo: [],
    emotion: "none",
  });
}
