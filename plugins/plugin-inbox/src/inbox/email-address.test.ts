/** Proves sender-address scanners remain bounded on adversarial long headers. */
import { describe, expect, it } from "vitest";
import {
  extractAsciiEmailAddress,
  extractLooseEmailAddress,
} from "./email-address.ts";
import { normalizeGeneratedGmailReplyDraftBody } from "./gmail-normalize.ts";

describe("linear inbox token scanners", () => {
  it("handles 100k address and think-tag runs", () => {
    const noise = "<".repeat(100_000);
    expect(extractAsciiEmailAddress(`${noise}User.Name+tag@example.com`)).toBe(
      "user.name+tag@example.com",
    );
    expect(
      extractLooseEmailAddress(`${"@".repeat(100_000)}valid@example.com`),
    ).toBe("valid@example.com");
    expect(
      normalizeGeneratedGmailReplyDraftBody(
        `<think>${"x".repeat(100_000)}</think>hello`,
      ),
    ).toBe("hello");
  });
});
