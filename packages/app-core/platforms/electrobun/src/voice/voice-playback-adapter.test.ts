/** Exercises voice playback adapter behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import { VoiceError } from "./errors";
import type { VoicePlayAudioParams } from "./types";
import {
  UnavailableVoicePlaybackAdapter,
  type VoicePlaybackAdapter,
} from "./voice-playback-adapter";

const PLAYBACK_UNAVAILABLE_REASON =
  "Host playback acknowledgement is not wired.";

const audioParams: VoicePlayAudioParams = {
  audioBase64: "Zg==",
  mimeType: "audio/wav",
};

function adapter(): VoicePlaybackAdapter {
  return new UnavailableVoicePlaybackAdapter();
}

describe("UnavailableVoicePlaybackAdapter", () => {
  it("reports playback acknowledgement as unsupported", async () => {
    expect(await adapter().status()).toEqual({
      playbackAckSupported: false,
      reason: PLAYBACK_UNAVAILABLE_REASON,
    });
  });

  it("returns the same unavailable status on every call", async () => {
    const playback = adapter();

    expect(await playback.status()).toEqual(await playback.status());
    expect(await playback.status()).toEqual(await adapter().status());
  });

  it("rejects playAudio with VOICE_AUDIO_OUTPUT_UNAVAILABLE", async () => {
    const playback = adapter();

    await expect(playback.playAudio(audioParams)).rejects.toBeInstanceOf(
      VoiceError,
    );

    try {
      await playback.playAudio(audioParams);
      throw new Error("playAudio must reject");
    } catch (error) {
      if (!(error instanceof VoiceError)) {
        throw error;
      }
      expect(error.code).toBe("VOICE_AUDIO_OUTPUT_UNAVAILABLE");
      expect(error.message).toBe(PLAYBACK_UNAVAILABLE_REASON);
      expect(error.name).toBe("VoiceError");
      expect(error.details).toBeUndefined();
    }
  });

  it("rejects playAudio for empty bytes, extra metadata, and concurrent calls", async () => {
    const playback = adapter();
    const variants: VoicePlayAudioParams[] = [
      { audioBase64: "", mimeType: "" },
      {
        audioBase64: audioParams.audioBase64,
        mimeType: "audio/mpeg",
        trace: true,
        metadata: { source: "test" },
      },
    ];

    for (const params of variants) {
      await expect(playback.playAudio(params)).rejects.toMatchObject({
        name: "VoiceError",
        code: "VOICE_AUDIO_OUTPUT_UNAVAILABLE",
        message: PLAYBACK_UNAVAILABLE_REASON,
      });
    }

    const settled = await Promise.allSettled([
      playback.playAudio(audioParams),
      playback.playAudio(audioParams),
    ]);
    expect(settled.every((result) => result.status === "rejected")).toBe(true);
    for (const result of settled) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(VoiceError);
      }
    }
  });

  it("interrupt is a no-op whether or not a reason is supplied", async () => {
    const playback = adapter();

    await expect(playback.interrupt()).resolves.toBeUndefined();
    await expect(playback.interrupt({})).resolves.toBeUndefined();
    await expect(
      playback.interrupt({ reason: "barge-in" }),
    ).resolves.toBeUndefined();
    expect(await playback.status()).toEqual({
      playbackAckSupported: false,
      reason: PLAYBACK_UNAVAILABLE_REASON,
    });
  });

  it("interrupt does not make playAudio succeed", async () => {
    const playback = adapter();

    await playback.interrupt({ reason: "barge-in" });
    await expect(playback.playAudio(audioParams)).rejects.toBeInstanceOf(
      VoiceError,
    );
  });
});
