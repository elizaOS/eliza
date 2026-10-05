import assert from "node:assert/strict";
import { test } from "vitest";
import {
  encodeMonoPcm16Wav,
  encodeMonoPcm16WavChunks,
} from "../../src/voice/pcm-wave.ts";

test("mono WAV headers describe every sample and integer rate", () => {
  const bytes = encodeMonoPcm16Wav(
    new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2]),
    16000,
  );
  const view = new DataView(bytes.buffer);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(bytes.subarray(8, 16)), "WAVEfmt ");
  assert.equal(view.getUint32(4, true), bytes.length - 8);
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(28, true), 32000);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(new TextDecoder().decode(bytes.subarray(36, 40)), "data");
  assert.equal(view.getUint32(40, true), 14);
  assert.deepEqual(
    Array.from({ length: 7 }, (_, i) => view.getInt16(44 + i * 2, true)),
    [-32768, -32768, -16384, 0, 16384, 32767, 32767],
  );
});

test("chunk boundaries and empty chunks preserve complete output without mutating inputs", () => {
  const pcm = Float32Array.from({ length: 4097 }, (_, i) => Math.sin(i / 9));
  const original = pcm.slice();
  for (const split of [0, 1, 2048, 4096, 4097])
    assert.deepEqual(
      encodeMonoPcm16WavChunks(
        [pcm.subarray(0, split), new Float32Array(), pcm.subarray(split)],
        48000,
      ),
      encodeMonoPcm16Wav(pcm, 48000),
    );
  assert.deepEqual(pcm, original);
  assert.equal(encodeMonoPcm16WavChunks([], 16000).length, 44);
});

test("nonfinite samples are silent and recorder sample-rate normalization is preserved", () => {
  const bytes = encodeMonoPcm16Wav(
    new Float32Array([NaN, Infinity, -Infinity]),
    16000.6,
  );
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(24, true), 16001);
  assert.deepEqual([...bytes.subarray(44)], [0, 0, 0, 0, 0, 0]);
  assert.equal(
    new DataView(encodeMonoPcm16Wav(new Float32Array(), 0).buffer).getUint32(
      24,
      true,
    ),
    1,
  );
});
