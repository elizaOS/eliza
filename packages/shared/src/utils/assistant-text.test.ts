import { describe, expect, it } from "vitest";
import {
  extractAssistantReplyText,
  stripAssistantStageDirections,
} from "./assistant-text";

describe("assistant text helpers", () => {
  it("extracts replyText from leaked response-handler object content", () => {
    expect(
      extractAssistantReplyText(
        JSON.stringify({
          shouldRespond: "RESPOND",
          contexts: ["simple"],
          replyText: "Hello! How can I help you today?",
          threadOps: [],
        }),
      ),
    ).toBe("Hello! How can I help you today?");
  });

  it("extracts replyText from leaked response-handler argument fragments", () => {
    expect(
      extractAssistantReplyText(
        '"RESPOND", "contexts": ["simple"], "intents": ["hello"], "replyText": "Hi there.", "threadOps": []',
      ),
    ).toBe("Hi there.");
  });

  it("does not rewrite ordinary assistant text that mentions replyText", () => {
    expect(
      extractAssistantReplyText(
        'The field named "replyText" is part of the schema.',
      ),
    ).toBeNull();
  });

  it("still strips stage directions from extracted reply text", () => {
    expect(
      extractAssistantReplyText(
        '"RESPOND", "contexts": ["simple"], "replyText": "*smiles* hello"',
      ),
    ).toBe("hello");
    expect(stripAssistantStageDirections("*waves* hello").trim()).toBe("hello");
  });
});
