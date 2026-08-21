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

  it("prefers the RFC 5322 angle-addr over email-like display-name tokens", () => {
    expect(
      extractAsciiEmailAddress("displayed@wrong.example <real@sender.example>"),
    ).toBe("real@sender.example");
    expect(
      extractLooseEmailAddress("displayed@wrong.example <real@sender.example>"),
    ).toBe("real@sender.example");
    expect(
      extractAsciiEmailAddress(
        '"quoted display displayed@wrong.example" <real@sender.example>',
      ),
    ).toBe("real@sender.example");
    expect(
      extractLooseEmailAddress(
        '"quoted display displayed@wrong.example" <real@sender.example>',
      ),
    ).toBe("real@sender.example");
  });

  it("falls back to the leftmost token when no angle-addr is present", () => {
    expect(extractAsciiEmailAddress("plain@sender.example rest")).toBe(
      "plain@sender.example",
    );
    expect(extractAsciiEmailAddress("Name <not-an-address> a@b.example")).toBe(
      "a@b.example",
    );
    expect(extractLooseEmailAddress("plain@sender.example rest")).toBe(
      "plain@sender.example",
    );
  });
});
