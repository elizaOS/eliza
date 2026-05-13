import { describe, expect, it } from "vitest";
import {
  analyzeVoiceProfileWav,
  createVoiceProfileArtifact,
  verifyVoiceProfileArtifact,
} from "./voice-profile-artifact";

function sineWav(args: {
  sampleRate?: number;
  durationMs?: number;
  frequencyHz?: number;
  amplitude?: number;
}): Uint8Array {
  const sampleRate = args.sampleRate ?? 16_000;
  const frames = Math.floor(sampleRate * ((args.durationMs ?? 1200) / 1000));
  const dataBytes = frames * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      out[offset + i] = value.charCodeAt(i);
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < frames; i += 1) {
    const value =
      Math.sin((2 * Math.PI * (args.frequencyHz ?? 220) * i) / sampleRate) *
      (args.amplitude ?? 0.35);
    view.setInt16(44 + i * 2, Math.round(value * 32767), true);
  }
  return out;
}

describe("voice-profile-artifact", () => {
  it("creates deterministic profile artifacts from WAV samples and reference metadata", () => {
    const wav = sineWav({ durationMs: 1600, frequencyHz: 210 });
    const args = {
      samples: [
        {
          id: "owner-sample",
          wavBytes: wav,
          referenceText: "This is my reference phrase.",
          recordedAt: "2026-05-12T12:00:00.000Z",
        },
      ],
      reference: {
        speakerId: "entity-owner",
        label: "Owner",
        referenceText: "This is my reference phrase.",
        locale: "en-US",
        consent: {
          attribution: true,
          synthesis: false,
          grantedAt: "2026-05-12T12:00:00.000Z",
          evidenceId: "consent-1",
        },
      },
      createdAt: "2026-05-12T12:00:01.000Z",
    };

    const first = createVoiceProfileArtifact(args);
    const second = createVoiceProfileArtifact(args);

    expect(first).toEqual(second);
    expect(first.artifactId).toMatch(/^vpa_[a-f0-9]{32}$/);
    expect(first.embeddingModel).toBe("eliza-voice-profile-features-v1");
    expect(first.centroidEmbedding.length).toBeGreaterThan(8);
    expect(first.usage).toMatchObject({
      attributionAuthorized: true,
      synthesisAuthorized: false,
    });

    const verification = verifyVoiceProfileArtifact({
      artifact: first,
      sampleWavs: { "owner-sample": wav },
    });
    expect(verification.status).toBe("ready");
    expect(verification.artifactIdMatches).toBe(true);
    expect(verification.attributionStatus).toBe("ready");
    expect(verification.synthesisStatus).toBe("not_authorized");
    expect(verification.samples[0]).toMatchObject({
      status: "pass",
      wavSha256Matches: true,
    });
  });

  it("reports invalid status for tampered profile content or sample bytes", () => {
    const wav = sineWav({ durationMs: 1300, frequencyHz: 220 });
    const artifact = createVoiceProfileArtifact({
      samples: [{ id: "sample", wavBytes: wav, referenceText: "hello world" }],
      reference: {
        consent: { attribution: true, synthesis: true },
      },
    });
    const tampered = {
      ...artifact,
      totalDurationMs: artifact.totalDurationMs + 10,
    };
    const verification = verifyVoiceProfileArtifact({
      artifact: tampered,
      sampleWavs: {
        sample: sineWav({ durationMs: 1300, frequencyHz: 440 }),
      },
    });

    expect(verification.status).toBe("invalid");
    expect(verification.artifactIdMatches).toBe(false);
    expect(verification.samples[0].wavSha256Matches).toBe(false);
  });

  it("extracts stable PCM16 WAV audio features", () => {
    const wav = sineWav({ durationMs: 1000, frequencyHz: 300 });
    const features = analyzeVoiceProfileWav(wav);

    expect(features).toMatchObject({
      format: "wav/pcm_s16le",
      channels: 1,
      sampleRateHz: 16000,
      bitsPerSample: 16,
      samplesPerChannel: 16000,
      durationMs: 1000,
    });
    expect(features.rms).toBeGreaterThan(0.1);
    expect(features.peakAbs).toBeGreaterThan(0.3);
  });
});
