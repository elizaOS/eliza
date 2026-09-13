/**
 * Coverage for voice-event-adapter.
 */
import { describe, expect, it } from "vitest";
import type { ServerControlFrame } from "../voice/voice-session-protocol";
import { nativeTranscriptInputFromVoiceServerEvent } from "./voice-event-adapter.js";

describe("voice-event-adapter", () => {
  it("maps stt_partial", () => {
    const r = nativeTranscriptInputFromVoiceServerEvent({
      t: "stt_partial",
      traceId: "t1",
      text: "hello",
    });
    expect(r?.type).toBe("stt.partial");
  });
  it("maps speaking_start", () => {
    const r = nativeTranscriptInputFromVoiceServerEvent({
      t: "speaking_start",
      traceId: "t2",
    });
    expect(r?.type).toBe("tts.audio");
  });
  it("returns null for unknown", () => {
    expect(
      // Deliberately outside the known frame union: the adapter must guard.
      nativeTranscriptInputFromVoiceServerEvent({
        t: "unknown",
      } as ServerControlFrame),
    ).toBeNull();
  });
});
