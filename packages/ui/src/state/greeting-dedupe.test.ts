import { MESSAGE_SOURCE_AGENT_GREETING } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "../api";
import {
  appendGreetingOnce,
  dedupeGreetings,
  isAgentGreetingMessage,
} from "./greeting-dedupe";

function greeting(text: string, id = `greeting-${text}`): ConversationMessage {
  return {
    id,
    role: "assistant",
    text,
    timestamp: Date.now(),
    source: MESSAGE_SOURCE_AGENT_GREETING,
  };
}

function userMsg(text: string): ConversationMessage {
  return { id: `u-${text}`, role: "user", text, timestamp: Date.now() };
}

function assistantMsg(text: string): ConversationMessage {
  return { id: `a-${text}`, role: "assistant", text, timestamp: Date.now() };
}

describe("isAgentGreetingMessage", () => {
  it("matches an assistant greeting-sourced message", () => {
    expect(isAgentGreetingMessage(greeting("hi"))).toBe(true);
  });
  it("rejects a plain assistant message", () => {
    expect(isAgentGreetingMessage(assistantMsg("hi"))).toBe(false);
  });
  it("rejects a user message even if sourced as greeting", () => {
    expect(
      isAgentGreetingMessage({
        ...userMsg("hi"),
        source: MESSAGE_SOURCE_AGENT_GREETING,
      }),
    ).toBe(false);
  });
});

describe("dedupeGreetings", () => {
  it("returns the same reference when there is at most one greeting", () => {
    const single = [greeting("Hey, I'm Sol"), userMsg("hello")];
    expect(dedupeGreetings(single)).toBe(single);
    const none = [userMsg("hello"), assistantMsg("reply")];
    expect(dedupeGreetings(none)).toBe(none);
  });

  it("drops later duplicate greetings even with DIFFERENT text (the device defect)", () => {
    // Two random preset greetings from a create/fetch race — different text.
    const dup = [
      greeting("Hey, I'm Sol. What can I help you with?", "g1"),
      greeting("Hi — how can I help today?", "g2"),
    ];
    const out = dedupeGreetings(dup);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("g1"); // earliest greeting wins
  });

  it("keeps the first greeting and preserves following conversation order", () => {
    const thread = [
      greeting("first", "g1"),
      userMsg("q"),
      assistantMsg("a"),
      greeting("second", "g2"),
    ];
    const out = dedupeGreetings(thread);
    expect(out.map((m) => m.id)).toEqual(["g1", "u-q", "a-a"]);
  });
});

describe("appendGreetingOnce", () => {
  it("appends when the thread has no greeting", () => {
    const thread = [userMsg("hi")];
    const out = appendGreetingOnce(thread, greeting("welcome"));
    expect(out).toHaveLength(2);
    expect(isAgentGreetingMessage(out[1])).toBe(true);
  });

  it("is a no-op (same reference) when a greeting already exists — even different text", () => {
    const thread = [greeting("existing", "g1")];
    const out = appendGreetingOnce(
      thread,
      greeting("late random greeting", "g2"),
    );
    expect(out).toBe(thread);
  });
});
