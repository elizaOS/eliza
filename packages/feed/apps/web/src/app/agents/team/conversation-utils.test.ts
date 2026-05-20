import { describe, expect, test } from "bun:test";
import {
  canDeleteConversation,
  getConversationDisplayName,
} from "./conversation-utils";

describe("conversation-utils", () => {
  test("returns explicit conversation name when present", () => {
    const label = getConversationDisplayName(
      {
        name: "Strategy Thread",
        createdAt: "2026-03-01T10:30:00.000Z",
      },
      "en-US",
    );

    expect(label).toBe("Strategy Thread");
  });

  test("builds fallback name from createdAt when name is null", () => {
    const label = getConversationDisplayName(
      {
        name: null,
        createdAt: "2026-03-01T10:30:00.000Z",
      },
      "en-US",
    );

    expect(label.startsWith("New Chat -")).toBe(true);
  });

  test("returns generic fallback when createdAt is invalid", () => {
    const label = getConversationDisplayName(
      {
        name: null,
        createdAt: "not-a-date",
      },
      "en-US",
    );

    expect(label).toBe("New Chat");
  });

  test("allows delete only when more than one conversation exists", () => {
    expect(canDeleteConversation(1)).toBe(false);
    expect(canDeleteConversation(2)).toBe(true);
    expect(canDeleteConversation(5)).toBe(true);
  });

  test("disallows delete when conversation count is zero (degenerate state)", () => {
    expect(canDeleteConversation(0)).toBe(false);
  });

  test("treats empty string name as absent and falls back to date format", () => {
    const label = getConversationDisplayName(
      { name: "", createdAt: "2026-03-01T10:30:00.000Z" },
      "en-US",
    );
    expect(label.startsWith("New Chat -")).toBe(true);
  });

  test("produces a fallback label without throwing when no locale is provided", () => {
    const label = getConversationDisplayName({
      name: null,
      createdAt: "2026-03-01T10:30:00.000Z",
    });
    expect(label.startsWith("New Chat -")).toBe(true);
  });
});
