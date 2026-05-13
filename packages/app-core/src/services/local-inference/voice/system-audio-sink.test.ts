import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WavFileAudioSink } from "./system-audio-sink";

describe("WavFileAudioSink", () => {
  it("drain drops buffered chunks before finalize", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eliza-audio-sink-"));
    const filePath = path.join(dir, "out.wav");
    try {
      const sink = new WavFileAudioSink({ sampleRate: 24_000, filePath });
      sink.write(new Float32Array([0.1, 0.2, 0.3]), 24_000);
      expect(sink.bufferedSamples()).toBe(3);

      sink.drain();
      expect(sink.bufferedSamples()).toBe(0);
      sink.finalize();

      const wav = readFileSync(filePath);
      expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
      expect(wav.readUInt32LE(40)).toBe(0);
      expect(wav.length).toBe(44);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
