/**
 * Unit coverage for the playback frame pump and mono downmix. Pure functions over
 * audio buffers, no live playback.
 */
import { describe, expect, it, vi } from "vitest";
import {
  downmixAudioBufferToMono,
  type PlaybackAudioFrameEvent,
  PlaybackFramePump,
} from "./playback-frame-pump";

interface SentBody {
  frames?: PlaybackAudioFrameEvent[];
  reset?: boolean;
}

function makeFetcher(sent: SentBody[], ok = true) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as SentBody);
    return { ok } as Response;
  });
}

function pcm(samples: number, value = 0.25): Float32Array {
  return new Float32Array(samples).fill(value);
}

describe("PlaybackFramePump", () => {
  it("encodes 16 kHz mono PCM into 20 ms playback frames and reset-only stop", async () => {
    const sent: SentBody[] = [];
    const pump = new PlaybackFramePump({
      fetcher: makeFetcher(sent),
      nowMs: () => 1_000,
    });
    const session = pump.createSessionForTest();

    session.start();
    session.appendPcm(pcm(640, 0.5), 16_000);
    await session.stop({ reset: true });

    expect(sent).toHaveLength(2);
    expect(sent[0]?.frames).toHaveLength(2);
    expect(sent[0]?.frames?.[0]).toMatchObject({
      sampleRate: 16_000,
      channels: 1,
      samples: 320,
      timestamp: 1_000,
      frameIndex: 0,
    });
    expect(sent[0]?.frames?.[1]?.timestamp).toBe(1_020);
    expect(sent[0]?.frames?.[0]?.pcm16).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(sent[1]).toEqual({ reset: true });
  });

  it("resamples 48 kHz worklet chunks to 16 kHz frames", async () => {
    const sent: SentBody[] = [];
    const pump = new PlaybackFramePump({
      fetcher: makeFetcher(sent),
      nowMs: () => 2_000,
    });
    const session = pump.createSessionForTest();

    session.start();
    session.appendPcm(pcm(960, 0.2), 48_000);
    await session.stop();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.frames).toHaveLength(1);
    expect(sent[0]?.frames?.[0]?.samples).toBe(320);
    expect(sent[0]?.frames?.[0]?.timestamp).toBe(2_000);
  });

  it("downmixes decoded AudioBuffers before scheduled fallback pumping", () => {
    const left = new Float32Array([1, 0, -1]);
    const right = new Float32Array([0, 0.5, 1]);
    const buffer = {
      length: 3,
      numberOfChannels: 2,
      getChannelData: (index: number) => (index === 0 ? left : right),
    } as AudioBuffer;

    expect(Array.from(downmixAudioBufferToMono(buffer))).toEqual([
      0.5, 0.25, 0,
    ]);
  });

  it("swallows playback route failures so TTS playback is not coupled to AEC", async () => {
    const sent: SentBody[] = [];
    const pump = new PlaybackFramePump({
      fetcher: makeFetcher(sent, false),
      nowMs: () => 3_000,
    });
    const session = pump.createSessionForTest();

    session.start();
    session.appendPcm(pcm(320), 16_000);
    await expect(session.stop({ reset: true })).resolves.toBeUndefined();
    expect(sent[0]?.frames).toHaveLength(1);
  });
});
