/** Verifies composer mic ownership across realtime thinking and speaking phases. */

import { describe, expect, it } from "vitest";
import { shouldBargeInFromMicTap } from "./chat-view-voice-mic";

describe("shouldBargeInFromMicTap", () => {
  it.each([
    { status: "thinking", agentSpeaking: false },
    { status: "speaking", agentSpeaking: true },
  ])("interrupts an active realtime $status turn", (phase) => {
    expect(
      shouldBargeInFromMicTap({
        realtimeActive: true,
        ...phase,
      }),
    ).toBe(true);
  });

  it("keeps ordinary capture for listening, idle, and inactive sessions", () => {
    expect(
      shouldBargeInFromMicTap({
        realtimeActive: true,
        agentSpeaking: false,
        status: "listening",
      }),
    ).toBe(false);
    expect(
      shouldBargeInFromMicTap({
        realtimeActive: false,
        agentSpeaking: true,
        status: "speaking",
      }),
    ).toBe(false);
  });
});
