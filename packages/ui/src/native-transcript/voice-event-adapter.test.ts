/**
 * Coverage for voice-event-adapter.
 */
import { describe, expect, it } from "vitest";
import { nativeTranscriptInputFromVoiceServerEvent } from "./voice-event-adapter.js";

describe("voice-event-adapter", () => {
  it("maps stt_partial", () => {
    const r = nativeTranscriptInputFromVoiceServerEvent({
      t: "stt_partial",
      traceId: "t1",
      text: "hello",
    } as any);
    expect(r?.type).toBe("stt.partial");
  });
  it("maps speaking_start", () => {
    const r = nativeTranscriptInputFromVoiceServerEvent({
      t: "speaking_start",
      traceId: "t2",
    } as any);
    expect(r?.type).toBe("tts.audio");
  });
  it("returns null for unknown", () => {
    expect(
      nativeTranscriptInputFromVoiceServerEvent({ t: "unknown" } as any),
    ).toBeNull();
  });
});
