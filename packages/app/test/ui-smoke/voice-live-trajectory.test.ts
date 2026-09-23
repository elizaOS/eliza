/** Exercises live-voice trajectory correlation against concurrent activity. */

import { describe, expect, test } from "vitest";
import { selectVoiceTrajectory } from "./voice-live-trajectory";

describe("selectVoiceTrajectory", () => {
  test("selects the exact turn among concurrent rooms and messages", () => {
    expect(
      selectVoiceTrajectory(
        [
          {
            id: "concurrent",
            startTime: 200,
            roomId: "other-room",
            llmCallCount: 3,
            metadata: { messageId: "voice-message" },
          },
          {
            id: "other-turn",
            startTime: 160,
            roomId: "voice-room",
            llmCallCount: 1,
            metadata: { messageId: "other-message" },
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
