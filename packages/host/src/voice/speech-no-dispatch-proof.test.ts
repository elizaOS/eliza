import { expect, test } from "vitest";
import { readConfirmedSpeechRetirement } from "./speech-relay-wire";

const id = "11111111-1111-4111-8111-111111111111";
test.each(["not_started", "settled_actual"] as const)(
  "accepts exact no-dispatch proof with %s accounting",
  (accounting) => {
    const value = {
      revoked: true,
      retirement: {
        version: 1,
        sessionId: id,
        state: "confirmed",
        mode: "not_dispatched",
        stt: "not_dispatched",
        tts: "not_dispatched",
        accounting,
        completedAt: new Date().toISOString(),
      },
    };
    expect(readConfirmedSpeechRetirement(value, id)).not.toBeNull();
    expect(readConfirmedSpeechRetirement(value, "other-session")).toBeNull();
    expect(
      readConfirmedSpeechRetirement(
        { ...value, retirement: { ...value.retirement, tts: "unknown" } },
        id,
      ),
    ).toBeNull();
  },
);
