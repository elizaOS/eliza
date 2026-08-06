import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { containsEncryptedReasoning, sanitizeModelMessages } from "./reasoning";

describe("reasoning helpers", () => {
  it("detects encrypted reasoning markers", () => {
    expect(containsEncryptedReasoning("-----BEGIN PGP MESSAGE-----\nabc")).toBe(true);
    expect(containsEncryptedReasoning("normal reasoning text")).toBe(false);
  });

  it("removes encrypted reasoning from assistant messages", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "-----BEGIN PGP MESSAGE-----\nabc" },
          { type: "text", text: "Final answer" },
        ],
      },
    ] as ModelMessage[];

    expect(sanitizeModelMessages(messages)).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "Final answer" }],
      },
    ]);
  });
});
