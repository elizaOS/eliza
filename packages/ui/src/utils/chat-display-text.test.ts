import { describe, expect, it } from "vitest";
import {
  sanitizeAssistantDisplayText,
  shouldDisplayConversationMessage,
} from "./chat-display-text";

describe("chat display text sanitizer", () => {
  it("removes inline evaluator and telemetry JSON from assistant text", () => {
    const text =
      '{"success":false,"decision":"CONTINUE","thought":"need another step"}' +
      '{"type":"evaluation","result":{"success":true}}' +
      "settings view closed.";

    expect(sanitizeAssistantDisplayText(text)).toBe("settings view closed.");
  });

  it("removes fenced internal memory JSON while preserving surrounding text", () => {
    const text = [
      "Done.",
      "```json",
      JSON.stringify({
        factMemory: [],
        relationships: [],
        identities: [],
        success: true,
      }),
      "```",
      "Ready.",
    ].join("\n");

    expect(sanitizeAssistantDisplayText(text)).toBe("Done.\n\nReady.");
  });

  it("preserves normal user-facing JSON", () => {
    const text = 'Use this shape: {"root":"card","elements":{"card":{}}}.';

    expect(sanitizeAssistantDisplayText(text)).toBe(text);
  });

  it("preserves non-internal success and decision JSON", () => {
    const text =
      'API result: {"success":true,"decision":"APPROVED","data":{"id":"42"}}.';

    expect(sanitizeAssistantDisplayText(text)).toBe(text);
  });

  it("preserves bare evaluator-shaped JSON when it is user-facing text", () => {
    const text = 'Status example: {"success":true,"decision":"FINISH"}.';

    expect(sanitizeAssistantDisplayText(text)).toBe(text);
  });

  it("removes bare evaluator verdict JSON only when chained to an internal artifact", () => {
    const text =
      '{"type":"tool_result","result":{"ok":true}}{"success":false,"decision":"CONTINUE"}Done.';

    expect(sanitizeAssistantDisplayText(text)).toBe("Done.");
  });

  it("treats artifact-only assistant messages as non-renderable", () => {
    expect(
      shouldDisplayConversationMessage({
        id: "m1",
        role: "assistant",
        text: '{"type":"tool_result","result":{"ok":true}}',
        timestamp: 1,
      }),
    ).toBe(false);
  });
});
