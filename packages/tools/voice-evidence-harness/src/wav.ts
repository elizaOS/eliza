/**
 * Minimal WAV (RIFF/PCM) reader + writer for the evidence harness.
 * Only supports mono/stereo integer/float PCM, which is all the voice pipeline
 * uses (linear16 uplink, pcm_s16le / pcm_f32le downlink). This is deliberately
 * dependency-free so the harness runs standalone under `bun`.
 */

export interface WavData {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** 1 = PCM integer, 3 = IEEE float */
  audioFormat: number;
  /** raw PCM body bytes (no RIFF header) */
  pcm: Uint8Array;
}

export function parseWav(bytes: Uint8Array): WavData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== "RIFF") {
    throw new Error(`Not a RIFF/WAV file (magic=${JSON.stringify(magic)})`);
  }
  const wave = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (wave !== "WAVE") {
    throw new Error(`Not a WAVE file (form=${JSON.stringify(wave)})`);
  }

  let offset = 12;
  let fmt:
    | { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number }
    | undefined;
  let pcm: Uint8Array | undefined;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3],
    );
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (chunkId === "fmt ") {
      fmt = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (chunkId === "data") {
      pcm = bytes.subarray(body, body + chunkSize);
    }
    // chunks are word-aligned
    offset = body + chunkSize + (chunkSize % 2);
  }

  if (!fmt) throw new Error("WAV missing fmt chunk");
  if (!pcm) throw new Error("WAV missing data chunk");
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    audioFormat: fmt.audioFormat,
    pcm,
  };
}

export function writeWav(params: {
  pcm: Uint8Array;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** 1 = PCM integer, 3 = IEEE float */
  audioFormat?: number;
}): Uint8Array {
  const { pcm, sampleRate, channels, bitsPerSample } = params;
  const audioFormat = params.audioFormat ?? 1;
  const blockAlign = (channels * bitsPerSample) >> 3;
  const byteRate = sampleRate * blockAlign;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, audioFormat, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, "data");
  view.setUint32(40, pcm.byteLength, true);

  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

/**
 * Re-frame an arbitrary PCM body into exact fixed-size chunks. Deepgram Flux
 * requires 80 ms / 2560-byte linear16 mono 16 kHz chunks. The final short chunk
 * is zero-padded to the exact size so the adapter's strict validator accepts it;
 * padding is silence and is documented in the evidence log.
 */
export function frameFixedChunks(pcm: Uint8Array, chunkBytes: number): {
  chunks: Uint8Array[];
  paddedBytes: number;
} {
  const chunks: Uint8Array[] = [];
  let paddedBytes = 0;
  for (let i = 0; i < pcm.byteLength; i += chunkBytes) {
    const slice = pcm.subarray(i, i + chunkBytes);
    if (slice.byteLength === chunkBytes) {
      chunks.push(slice);
    } else {
      const padded = new Uint8Array(chunkBytes);
      padded.set(slice, 0);
      paddedBytes = chunkBytes - slice.byteLength;
      chunks.push(padded);
    }
  }
  return { chunks, paddedBytes };
}
