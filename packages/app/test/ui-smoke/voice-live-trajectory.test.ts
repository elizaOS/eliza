/** Exercises live-voice trajectory correlation against concurrent activity. */

import { describe, expect, test } from "vitest";
import { selectVoiceTrajectory } from "./voice-live-trajectory";

describe("selectVoiceTrajectory", () => {
  test("ignores a newer concurrent trajectory from another room", () => {
    expect(
      selectVoiceTrajectory(
        [
          {
            id: "concurrent",
            startTime: 200,
            roomId: "other-room",
            llmCallCount: 3,
            metadata: { messageId: "concurrent-message" },
          },
          {
            id: "voice-turn",
            startTime: 150,
            roomId: "voice-room",
            llmCallCount: 1,
            metadata: { messageId: "voice-message" },
          },
        ],
        {
          startedAt: 100,
          roomId: "voice-room",
          userMessageId: "voice-message",
        },
      ),
    ).toMatchObject({ id: "voice-turn" });
  });

  test("ignores a concurrent trajectory in the same room", () => {
    expect(
      selectVoiceTrajectory(
        [
          {
            id: "voice-a",
            startTime: 150,
            roomId: "voice-room",
            llmCallCount: 1,
            metadata: { messageId: "voice-message" },
          },
          {
            id: "voice-b",
            startTime: 160,
            roomId: "voice-room",
            llmCallCount: 1,
            metadata: { messageId: "other-message" },
          },
        ],
        {
          startedAt: 100,
          roomId: "voice-room",
          userMessageId: "voice-message",
        },
      ),
    ).toMatchObject({ id: "voice-a" });
  });

  test("fails closed when the exact message correlation is missing", () => {
    expect(() =>
      selectVoiceTrajectory(
        [
          {
            id: "same-room-wrong-message",
            startTime: 150,
            roomId: "voice-room",
            llmCallCount: 1,
            metadata: { messageId: "other-message" },
          },
        ],
        {
          startedAt: 100,
          roomId: "voice-room",
          userMessageId: "voice-message",
        },
      ),
    ).toThrow(/exactly one live voice trajectory/);
  });
});
