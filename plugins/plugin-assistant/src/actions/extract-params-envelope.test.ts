/**
 * The LLM param extractor must read the user's request, not the document
 * augmentation envelope. On a document-augmented turn, chat-routes replaces
 * content.text with the envelope (contextual documents first, then
 * <user_request>), so feeding raw content.text to the extraction model lets
 * a recalled document supply missing action parameters.
 */
import { ModelType } from "@elizaos/core";
import { createRealTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { extractActionParamsViaLlm } from "./extract-params.ts";

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
  "Search for Alice Example",
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
        throw new Error("Extraction prompt missing");
      captured = params.prompt;
      return JSON.stringify({ query: "Alice Example" });
    },
    "envelope-probe",
  );
  try {
    await extractActionParamsViaLlm({
      runtime,
      message: {
        agentId: runtime.agentId,
        entityId: runtime.agentId,
        roomId: runtime.agentId,
        content: { text: messageText },
      },
      actionName: "SEARCH_CONTACT",
      actionDescription: "Search the Rolodex for a person by name.",
      paramSchema: [
        { name: "query", description: "Person to search for", required: true },
      ],
      existingParams: {},
      requiredFields: ["query"] as const,
    });
  } finally {
    await runtimeResult.cleanup();
  }
  return captured;
}

it("does not feed document text to the param extraction model", async () => {
  const prompt = await capturePrompt(ENVELOPE);
  expect(prompt).toContain("Alice Example");
  expect(prompt).not.toContain("Zed Documentperson");
  expect(prompt).not.toContain("zeddoc");
});

it("leaves a plain message unchanged", async () => {
  const prompt = await capturePrompt("Search for Bob Plain");
  expect(prompt).toContain("Bob Plain");
});
