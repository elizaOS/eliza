import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "../api";
import {
  clearFirstRunTranscriptMessages,
  isFirstRunTranscriptMessage,
} from "./clear-first-run-transcript";

function firstRunTurn(
  id: string,
  extra: Partial<ConversationMessage> = {},
): ConversationMessage {
  return {
    id,
    role: "assistant",
    text: "onboarding turn",
    timestamp: 1,
    source: "first_run",
    ...extra,
  };
}

function realUser(id: string, text = "hi"): ConversationMessage {
  return { id, role: "user", text, timestamp: 2 };
}

function realAssistant(id: string, text = "hey there"): ConversationMessage {
  return { id, role: "assistant", text, timestamp: 3 };
}

describe("isFirstRunTranscriptMessage", () => {
  it("matches the first_run source marker", () => {
    expect(
      isFirstRunTranscriptMessage(firstRunTurn("first-run:greeting")),
    ).toBe(true);
  });

  it("matches the first-run: id namespace even without the source marker", () => {
    // A conductor turn is always seeded with BOTH signals; matching either is
    // the robust superset so a future turn that sets only one is still caught.
    expect(
      isFirstRunTranscriptMessage({
        id: "first-run:user:3",
        role: "user",
        text: "typed during onboarding",
        timestamp: 1,
      }),
    ).toBe(true);
  });

  it("never matches a real server turn", () => {
    expect(isFirstRunTranscriptMessage(realUser("srv-user-1"))).toBe(false);
    expect(isFirstRunTranscriptMessage(realAssistant("srv-asst-1"))).toBe(
      false,
    );
  });

  it("never matches an optimistic temp- turn", () => {
    expect(isFirstRunTranscriptMessage(realUser("temp-123"))).toBe(false);
    expect(isFirstRunTranscriptMessage(realAssistant("temp-resp-123"))).toBe(
      false,
    );
  });
});

describe("clearFirstRunTranscriptMessages", () => {
  it("drops every synthetic first-run turn and keeps real turns in order", () => {
    // The exact #15354 shape: a returning-account shared-tier onboarding seeds
    // greeting + welcome-back + cloud-done (three greeting-looking assistant
    // bubbles) plus a typed reply pair, then the user's real first turn arrives.
    const messages: ConversationMessage[] = [
      firstRunTurn("first-run:greeting", { text: "Sign in to Eliza Cloud" }),
      firstRunTurn("first-run:cloud-signin", { text: "Welcome back" }),
      firstRunTurn("first-run:user:1", { role: "user", text: "who are you" }),
      firstRunTurn("first-run:reply:1", { text: "I'm Eliza" }),
      firstRunTurn("first-run:cloud-done", { text: "All set" }),
      realUser("temp-1000", "hi"),
      realAssistant("temp-resp-1000", "hey!"),
    ];

    const result = clearFirstRunTranscriptMessages(messages);

    expect(result.map((m) => m.id)).toEqual(["temp-1000", "temp-resp-1000"]);
    // Exactly one user turn + one assistant turn survive — the single real send.
    expect(result.filter((m) => m.role === "user")).toHaveLength(1);
    expect(result.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("returns the SAME array reference when there is nothing to remove", () => {
    // Safe to run inside a state setter without forcing a spurious re-render.
    const clean: ConversationMessage[] = [
      realUser("srv-user-1"),
      realAssistant("srv-asst-1"),
    ];
    expect(clearFirstRunTranscriptMessages(clean)).toBe(clean);
  });

  it("is a no-op on an empty transcript (silent-reuse onboarding, #15133)", () => {
    const empty: ConversationMessage[] = [];
    expect(clearFirstRunTranscriptMessages(empty)).toBe(empty);
  });

  it("purges an all-first-run transcript down to empty", () => {
    const onlyOnboarding: ConversationMessage[] = [
      firstRunTurn("first-run:greeting"),
      firstRunTurn("first-run:cloud-done"),
    ];
    expect(clearFirstRunTranscriptMessages(onlyOnboarding)).toEqual([]);
  });
});
