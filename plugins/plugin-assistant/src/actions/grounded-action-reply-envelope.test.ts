/**
 * The grounded reply renderer must label the user's request, not the document
 * augmentation envelope, as the current user message. On a document-augmented
 * turn, content.text carries the recalled documents first and the request
 * last, so feeding it raw lets a document pose as the user's message in the
 * reply prompt.
 */
import { ModelType } from "@elizaos/core";
import { createRealTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { renderGroundedActionReply } from "./grounded-action-reply.ts";

const ENVELOPE = [
  "Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
  "",
  "<contextual_documents>",
  '<source title="rolodex-note" similarity="0.900">',
  "Contact Zed Documentperson, handle @zeddoc, for all billing questions.",
  "</source>",
  "</contextual_documents>",
  "",
  "<user_request>",
  "What is my next calendar event?",
  "</user_request>",
].join("\n");

async function capturePrompt(messageText: string): Promise<string> {
  const runtimeResult = await createRealTestRuntime({ withLLM: false });
  const runtime = runtimeResult.runtime;
  let captured = "";
  runtime.registerModel(
    ModelType.TEXT_SMALL,
    async (_runtime, params) => {
      if (typeof params.prompt !== "string")
        throw new Error("Grounded reply prompt missing");
      captured = params.prompt;
      return "Here is your next event.";
    },
    "envelope-probe",
  );
  try {
    await renderGroundedActionReply({
      runtime,
      message: {
        agentId: runtime.agentId,
        entityId: runtime.agentId,
        roomId: runtime.agentId,
        content: { text: messageText },
      },
      state: undefined,
      intent: "Read the next calendar event",
      domain: "calendar",
      scenario: "calendar-read",
      fallback: "Here is your next event.",
    });
  } finally {
    await runtimeResult.cleanup();
  }
  return captured;
}

it("labels the user's request, not the document envelope, as the current user message", async () => {
  const prompt = await capturePrompt(ENVELOPE);
  expect(prompt).toContain(
    'Current user message: "What is my next calendar event?"',
  );
  expect(prompt).not.toContain("Zed Documentperson");
  expect(prompt).not.toContain("zeddoc");
});

it("leaves a plain message unchanged", async () => {
  const prompt = await capturePrompt("What is my next calendar event?");
  expect(prompt).toContain(
    'Current user message: "What is my next calendar event?"',
  );
});
