/**
 * Draft extraction on an augmented turn: the document-augmentation envelope
 * sits in content.text, so extraction must read the user's words inside
 * <user_request>, not the whole envelope. A document fragment naming @alice
 * must not reach the extraction prompt when the user asked to send to @bob.
 * The model call is stubbed and only the prompt it receives is inspected;
 * no draft is created and no send is performed.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { outboundDraftOptionsFromMessage } from "./sendDraft.ts";

function augmented(userRequest: string, documentFragment: string): string {
  return [
    "Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
    "If the answer appears verbatim in the contextual documents, repeat it exactly.",
    "",
    "<contextual_documents>",
    '<source title="contacts" similarity="0.900">',
    documentFragment,
    "</source>",
    "</contextual_documents>",
    "",
    "<user_request>",
    userRequest,
    "</user_request>",
  ].join("\n");
}

describe("sendDraft extraction on an augmented turn (cycle 719 probe)", () => {
  it("does not feed the document fragment to the extraction model", async () => {
    let captured = "";
    const runtime = {
      useModel: async (_type: unknown, { prompt }: { prompt: string }) => {
        captured = prompt;
        return "<response></response>";
      },
    } as unknown as IAgentRuntime;
    const message = {
      content: {
        text: augmented(
          "Send a message to @bob on discord saying hello.",
          "To reach the team, send a message to @alice on telegram.",
        ),
      },
    } as Memory;
    await outboundDraftOptionsFromMessage(runtime, message, { parameters: {} });
    expect(captured).toContain("@bob");
    expect(captured).not.toContain("@alice");
    expect(captured).not.toContain("contextual_documents");
  });
});
