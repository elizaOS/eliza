import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOT_FREE_MEETING_AUDIO_SAMPLE_RATE,
  type BotFreeMeetingAudioSourceMetadata,
  buildBotFreeMeetingAudioArtifacts,
  classifyBotFreeMeetingAudioCaptureMode,
  getBotFreeMeetingAudioSupport,
  mixBotFreeMeetingPcm,
  startBotFreeMeetingAudioCapture,
} from "./bot-free-meeting-audio-capture";

function source(
  kind: BotFreeMeetingAudioSourceMetadata["kind"],
  status: BotFreeMeetingAudioSourceMetadata["status"],
  sampleCount: number,
): BotFreeMeetingAudioSourceMetadata {
  return {
    id: kind,
    kind,
    label: kind,
    status,
    requested: true,
    audioTrackCount: sampleCount > 0 ? 1 : 0,
    videoTrackCount: 0,
    channelCount: sampleCount > 0 ? 1 : 0,
    sampleRateHz: BOT_FREE_MEETING_AUDIO_SAMPLE_RATE,
    sampleCount,
    durationMs: Math.round(
      (sampleCount / BOT_FREE_MEETING_AUDIO_SAMPLE_RATE) * 1000,
    ),
    peak: sampleCount > 0 ? 0.1 : 0,
    rms: sampleCount > 0 ? 0.05 : 0,
  };
}

describe("bot-free meeting audio capture helpers", () => {
  const originalNavigator = globalThis.navigator;
  const originalWindow = globalThis.window;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  it("reports support without prompting for permissions", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { AudioContext: class AudioContext {} },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: vi.fn(),
          getDisplayMedia: vi.fn(),
        },
        userActivation: { isActive: true },
      },
    });

    expect(getBotFreeMeetingAudioSupport()).toEqual({
      audioContext: true,
      microphone: true,
      displayAudio: true,
      userActivationActive: true,
    });
  });

  it("classifies separated, fallback, and unavailable captures from source metadata", () => {
    expect(
      classifyBotFreeMeetingAudioCaptureMode([
        source("local_mic", "captured", 1600),
        source("remote_tab_or_system", "captured", 1600),
      ]),
    ).toBe("separate");

    expect(
      classifyBotFreeMeetingAudioCaptureMode([
        source("mixed_fallback", "captured", 1600),
      ]),
    ).toBe("mixed_fallback");

    expect(
      classifyBotFreeMeetingAudioCaptureMode([
        source("local_mic", "denied", 0),
        source("remote_tab_or_system", "unavailable", 0),
      ]),
    ).toBe("unavailable");
  });

  it("mixes local and remote PCM with clipping and padding", () => {
    const mixed = mixBotFreeMeetingPcm([
      new Float32Array([0.6, -0.7, 0.25]),
      new Float32Array([0.6, -0.5]),
    ]);

    expect(Array.from(mixed)).toEqual([1, -1, 0.25]);
  });

  it("builds source WAV artifacts plus a mixed fallback artifact", () => {
    const artifacts = buildBotFreeMeetingAudioArtifacts([
      {
        sourceId: "local-mic",
        kind: "local_mic",
        label: "Local microphone",
        pcm: new Float32Array([0.1, 0.2, 0.3]),
        sampleRateHz: BOT_FREE_MEETING_AUDIO_SAMPLE_RATE,
        channelCount: 1,
      },
      {
        sourceId: "remote-tab-or-system",
        kind: "remote_tab_or_system",
        label: "Tab/system audio",
        pcm: new Float32Array([0.2, 0.1, 0]),
        sampleRateHz: BOT_FREE_MEETING_AUDIO_SAMPLE_RATE,
        channelCount: 2,
        displaySurface: "browser",
      },
    ]);

    expect(artifacts.map((artifact) => artifact.kind)).toEqual([
      "local_mic",
      "remote_tab_or_system",
      "mixed_fallback",
    ]);
    for (const artifact of artifacts) {
      expect(artifact.mimeType).toBe("audio/wav");
      expect(artifact.byteLength).toBeGreaterThan(44);
      expect(String.fromCharCode(...artifact.audio.slice(0, 4))).toBe("RIFF");
      expect(artifact.metadata.sampleCount).toBe(3);
    }
    expect(
      artifacts.find((artifact) => artifact.kind === "remote_tab_or_system")
        ?.metadata.displaySurface,
    ).toBe("browser");
  });

  it("does not create a mixed fallback from a single non-empty source", () => {
    const artifacts = buildBotFreeMeetingAudioArtifacts([
      {
        sourceId: "local-mic",
        kind: "local_mic",
        label: "Local microphone",
        pcm: new Float32Array([0.1, 0.2, 0.3]),
        sampleRateHz: BOT_FREE_MEETING_AUDIO_SAMPLE_RATE,
        channelCount: 1,
      },
      {
        sourceId: "remote-tab-or-system",
        kind: "remote_tab_or_system",
        label: "Tab/system audio",
        pcm: new Float32Array(),
        sampleRateHz: BOT_FREE_MEETING_AUDIO_SAMPLE_RATE,
        channelCount: 2,
        displaySurface: "browser",
      },
    ]);

    expect(artifacts.map((artifact) => artifact.kind)).toEqual(["local_mic"]);
  });

  it("throws a typed error when no requested source can open", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        AudioContext: class AudioContext {
          state = "running";
          sampleRate = BOT_FREE_MEETING_AUDIO_SAMPLE_RATE;
          close = vi.fn(async () => undefined);
        },
      },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        mediaDevices: {
          getDisplayMedia: vi.fn(async () => {
            throw new DOMException("blocked", "NotAllowedError");
          }),
          getUserMedia: vi.fn(async () => {
            throw new DOMException("blocked", "NotAllowedError");
          }),
        },
        userActivation: { isActive: true },
      },
    });

    await expect(startBotFreeMeetingAudioCapture()).rejects.toMatchObject({
      name: "BotFreeMeetingAudioCaptureError",
      sources: [
        expect.objectContaining({
          kind: "remote_tab_or_system",
          status: "denied",
        }),
        expect.objectContaining({ kind: "local_mic", status: "denied" }),
      ],
    });
  });
});
