/**
 * Covers `extractAssistantReplyText` and `stripAssistantStageDirections`:
 * recovering user-facing reply text from leaked response-handler JSON and
 * argument fragments, unwrapping bare {reply}/{response} objects (primitives
 * only, guarded against unrelated payloads), stripping stage directions, and
 * degrading safely on null/undefined input. Pure string assertions.
 */
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

  it("extracts replyText from leaked boolean response-handler fragments", () => {
    expect(
      extractAssistantReplyText(
        'true,"contexts":["general"],"intents":["general"],"replyText":"Hello, how are you?"}',
      ),
    ).toBe("Hello, how are you?");
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

  it('unwraps a bare {"reply":...} object the model emitted as text', () => {
    expect(extractAssistantReplyText('{"reply":"107"}')).toBe("107");
    expect(
      extractAssistantReplyText('{"reply":"Red, blue, and yellow."}'),
    ).toBe("Red, blue, and yellow.");
  });

  it('unwraps {"reply":...} alongside known response-shape siblings', () => {
    expect(
      extractAssistantReplyText('{"reply":"hi there","action":"NONE"}'),
    ).toBe("hi there");
    expect(
      extractAssistantReplyText(
        JSON.stringify({ thought: "x", reply: "done", actions: ["REPLY"] }),
      ),
    ).toBe("done");
  });

  it("strips stage directions from an unwrapped reply object", () => {
    expect(extractAssistantReplyText('{"reply":"*waves* hello"}')).toBe(
      "hello",
    );
  });

  it("does NOT unwrap a reply object carrying unrelated data or a non-primitive reply", () => {
    expect(
      extractAssistantReplyText('{"reply":"hi","userData":{"id":1}}'),
    ).toBeNull();
    // an object/array reply is not user-facing text → leave it alone
    expect(extractAssistantReplyText('{"reply":{"x":1}}')).toBeNull();
    expect(extractAssistantReplyText('{"reply":[1,2]}')).toBeNull();
  });

  it("unwraps a primitive (number/boolean) reply the model emitted as text", () => {
    expect(extractAssistantReplyText('{"reply":42}')).toBe("42");
    expect(extractAssistantReplyText('{"reply":true}')).toBe("true");
    expect(extractAssistantReplyText('{"reply":7,"action":"NONE"}')).toBe("7");
  });

  it("unwraps the `response` wrapper key too (the key drifts reply/response)", () => {
    expect(extractAssistantReplyText('{"response":"54"}')).toBe("54");
    expect(extractAssistantReplyText('{"response":42}')).toBe("42");
    expect(extractAssistantReplyText('{"response":"hi","action":"NONE"}')).toBe(
      "hi",
    );
    // still rejects a non-primitive value or an unknown-key payload
    expect(extractAssistantReplyText('{"response":{"x":1}}')).toBeNull();
    expect(
      extractAssistantReplyText('{"response":"hi","userData":{"id":1}}'),
    ).toBeNull();
  });

  it("does not rewrite ordinary chat text that merely contains the word reply", () => {
    expect(
      extractAssistantReplyText("Sure — my reply is that the sky is blue."),
    ).toBeNull();
  });

  it("is null/undefined-safe (e.g. a 202 placeholder body with no text)", () => {
    // Non-string input must not throw — degrade gracefully.
    expect(
      extractAssistantReplyText(undefined as unknown as string),
    ).toBeNull();
    expect(extractAssistantReplyText(null as unknown as string)).toBeNull();
    expect(stripAssistantStageDirections(undefined as unknown as string)).toBe(
      "",
    );
    expect(stripAssistantStageDirections(null as unknown as string)).toBe("");
  });
});
