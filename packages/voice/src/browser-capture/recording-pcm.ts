/** Bounds for decoding an owned recording to mono PCM. */
export type RecordingPcmLimits = {
  sampleRate?: number;
  maxSeconds?: number;
  maxBytes?: number;
};

/**
 * Decode an owned browser recording (any format the browser decodes) to mono samples at
 * sampleRate (default 16 kHz), within size and duration bounds. Cancellation is checked
 * between each asynchronous step.
 */
export async function decodeRecordingPcm(
  blob: Blob,
  signal: AbortSignal,
  limits: RecordingPcmLimits = {},
): Promise<Float32Array> {
  const sampleRate = limits.sampleRate ?? 16000,
    maxSeconds = limits.maxSeconds ?? 60,
    maxBytes = limits.maxBytes ?? 16_000_000;
  signal.throwIfAborted();
  if (!blob.size || blob.size > maxBytes)
    throw Error("Recording size is invalid.");
  const context = new OfflineAudioContext(1, 1, sampleRate);
  const decoded = await context.decodeAudioData(await blob.arrayBuffer());
  signal.throwIfAborted();
  if (
    !Number.isFinite(decoded.duration) ||
    decoded.duration <= 0 ||
    decoded.duration > maxSeconds
  )
    throw Error(`Keep recordings under ${maxSeconds} seconds.`);
  const length = Math.ceil(decoded.duration * sampleRate),
    renderer = new OfflineAudioContext(1, length, sampleRate);
  const source = renderer.createBufferSource();
  source.buffer = decoded;
  source.connect(renderer.destination);
  source.start();
  const rendered = await renderer.startRendering();
  signal.throwIfAborted();
  return rendered.getChannelData(0);
}

/**
 * Mono PCM16 WAV bytes for float samples in [-1, 1]. Values outside are clipped; negative
 * values scale by 32768 and positive by 32767, so full scale maps to the int16 limits.
 */
export function encodePcm16Wav(
  samples: Float32Array,
  sampleRate = 16000,
): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000)
    throw Error("Unsupported sample rate.");
  const bytes = new Uint8Array(44 + samples.length * 2),
    view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      bytes[offset + i] = value.charCodeAt(i);
  };
  text(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Number.isFinite(samples[i])
      ? Math.max(-1, Math.min(1, samples[i]))
      : 0;
    view.setInt16(
      44 + i * 2,
      Math.round(value * (value < 0 ? 32768 : 32767)),
      true,
    );
  }
  return bytes;
}

/** Decode a recording and encode it as mono PCM16 WAV, for speech services that take WAV. */
export async function recordingPcmWav(
  blob: Blob,
  signal: AbortSignal,
  limits: RecordingPcmLimits = {},
): Promise<Uint8Array> {
  return encodePcm16Wav(
    await decodeRecordingPcm(blob, signal, limits),
    limits.sampleRate ?? 16000,
  );
}
