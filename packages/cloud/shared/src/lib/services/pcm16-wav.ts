/**
 * Validates streamed mono PCM16 audio and wraps it in a canonical WAV container.
 * The bounded drain protects Worker memory while preserving the complete byte
 * count required by the RIFF header.
 */

import { ElizaError } from "@elizaos/core";

const WAV_HEADER_BYTES = 44;
const MAX_RIFF_DATA_BYTES = 0xffff_ffff - 36;

function invalidPcm(message: string, context: Record<string, unknown>): ElizaError {
  return new ElizaError(message, {
    code: "TTS_PCM_INVALID",
    context,
    severity: "ephemeral",
  });
}

/** Drains a PCM16 stream without allowing an upstream response to exhaust memory. */
export async function drainPcm16Stream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_RIFF_DATA_BYTES) {
    throw invalidPcm("PCM16 byte limit is outside the WAV container range", { maxBytes });
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("PCM16 response exceeded the configured byte limit");
        throw invalidPcm("PCM16 response exceeded the configured byte limit", {
          maxBytes,
          receivedBytes: total,
        });
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0 || total % 2 !== 0) {
    throw invalidPcm("PCM16 response must contain complete 16-bit samples", {
      receivedBytes: total,
    });
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Wraps little-endian mono PCM16 samples in a 44-byte RIFF/WAV header. */
export function pcm16ToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    throw invalidPcm("PCM16 input must contain complete 16-bit samples", {
      receivedBytes: pcm.byteLength,
    });
  }
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
    throw invalidPcm("PCM16 sample rate must be a positive integer", { sampleRate });
  }
  if (pcm.byteLength > MAX_RIFF_DATA_BYTES) {
    throw invalidPcm("PCM16 input exceeds the WAV container range", {
      receivedBytes: pcm.byteLength,
    });
  }

  const output = new Uint8Array(WAV_HEADER_BYTES + pcm.byteLength);
  const view = new DataView(output.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
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
  view.setUint32(40, pcm.byteLength, true);
  output.set(pcm, WAV_HEADER_BYTES);
  return output;
}
