/**
 * PCM conversion helpers for the realtime voice-session client.
 *
 * Uplink is linear16 (Int16 LE) mono 16 kHz — the exact format Deepgram Flux
 * ingests and the server re-frames to 2560-byte chunks. Web Audio hands us
 * Float32 samples in [-1, 1]; these helpers convert to/from Int16 with the
 * standard asymmetric scale (negative range is one step deeper than positive:
 * -1.0 -> -32768, +1.0 -> +32767), matching the existing local-asr-capture and
 * playback-frame-pump conventions in this package so the whole surface encodes
 * PCM identically.
 *
 * Pure + side-effect free so the golden-vector correctness tests exercise the
 * real conversion the mic path uses (no stub).
 */

/** Canonical uplink/downlink sample rate for the pcm16 path. */
export const VOICE_PCM_SAMPLE_RATE = 16_000;

/**
 * Clamp a Float32 sample to the valid [-1, 1] range. NaN maps to 0 (silence);
 * ±Infinity saturates to the corresponding rail (±1) rather than dropping to
 * silence, matching how a real ADC clips a hot signal.
 */
export function clampFloatSample(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value >= 1) return 1;
  if (value <= -1) return -1;
  return value;
}

/**
 * Convert one Float32 sample in [-1, 1] to a signed 16-bit integer.
 * Negative uses the full -32768 depth (× 0x8000); positive uses 0x7fff.
 */
export function floatSampleToInt16(value: number): number {
  const clamped = clampFloatSample(value);
  const scaled = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  // Round toward nearest; then hard-clamp to the Int16 range so a rounding
  // overshoot at the extremes (e.g. 0.99999 * 0x7fff) can never wrap.
  const rounded = Math.round(scaled);
  if (rounded > 32767) return 32767;
  if (rounded < -32768) return -32768;
  return rounded;
}

/** Convert one signed 16-bit integer back to a Float32 sample in [-1, 1]. */
export function int16SampleToFloat(value: number): number {
  return value < 0 ? value / 0x8000 : value / 0x7fff;
}

/**
 * Convert a Float32 mono PCM buffer to a little-endian Int16 byte buffer
 * suitable for a binary uplink frame. Returns a fresh `Uint8Array` whose
 * `byteLength` is exactly `2 * input.length`.
 */
export function floatPcmToInt16Bytes(pcm: Float32Array): Uint8Array {
  const out = new Uint8Array(pcm.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i += 1) {
    view.setInt16(
      i * 2,
      floatSampleToInt16(pcm[i] ?? 0),
      /* littleEndian */ true,
    );
  }
  return out;
}

/**
 * Decode a little-endian Int16 byte buffer (a downlink PCM frame) into Float32
 * samples in [-1, 1] for playback. Ignores a trailing odd byte defensively
 * (a well-formed pcm16 frame is always an even byte length).
 */
export function int16BytesToFloatPcm(bytes: Uint8Array): Float32Array {
  const sampleCount = bytes.byteLength >> 1;
  const out = new Float32Array(sampleCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < sampleCount; i += 1) {
    out[i] = int16SampleToFloat(view.getInt16(i * 2, /* littleEndian */ true));
  }
  return out;
}

/**
 * Downmix an interleaved/planar set of channel Float32 buffers to mono by
 * averaging. Web Audio worklet inputs arrive as an array of per-channel
 * Float32Arrays; the mic path requests a mono constraint but a device can
 * still hand back stereo, so we average defensively.
 */
export function downmixChannelsToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const frames = channels[0].length;
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let ch = 0; ch < channels.length; ch += 1) {
      sum += channels[ch][i] ?? 0;
    }
    out[i] = sum / channels.length;
  }
  return out;
}
