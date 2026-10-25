/**
 * Converts Twilio Media Streams' 8 kHz G.711 mu-law frames to and from the
 * 16 kHz little-endian PCM16 frames consumed by the realtime voice runtime.
 */

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32_635;

/** Decode one base64 Twilio media payload and upsample it to PCM16 at 16 kHz. */
export function decodeTwilioMedia(payload: string): Uint8Array {
  const encoded = atob(payload);
  const pcm = new Uint8Array(encoded.length * 4);
  const view = new DataView(pcm.buffer);
  for (let index = 0; index < encoded.length; index += 1) {
    const sample = decodeMuLawSample(encoded.charCodeAt(index));
    const offset = index * 4;
    // Telephone audio is 8 kHz. Repeating each sample is deterministic linear
    // upsampling and preserves the exact duration expected by Ink's 16 kHz leg.
    view.setInt16(offset, sample, true);
    view.setInt16(offset + 2, sample, true);
  }
  return pcm;
}

/** Downsample PCM16 at 16 kHz and encode a base64 Twilio mu-law payload. */
export function encodeTwilioMedia(pcm16: Uint8Array): string {
  if (pcm16.byteLength % 2 !== 0) {
    throw new Error("PCM16 telephony audio must contain complete samples");
  }
  const view = new DataView(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
  let binary = "";
  for (let offset = 0; offset < pcm16.byteLength; offset += 4) {
    const first = view.getInt16(offset, true);
    // Provider chunks are not required to contain an even count of samples.
    // A final unpaired sample represents 62.5 microseconds and is encoded once
    // rather than crashing the live call at a provider framing boundary.
    const second =
      offset + 2 < pcm16.byteLength ? view.getInt16(offset + 2, true) : first;
    binary += String.fromCharCode(
      encodeMuLawSample(Math.round((first + second) / 2)),
    );
  }
  return btoa(binary);
}

function decodeMuLawSample(value: number): number {
  const muLaw = ~value & 0xff;
  const sign = muLaw & 0x80;
  const exponent = (muLaw >> 4) & 0x07;
  const mantissa = muLaw & 0x0f;
  const magnitude = ((mantissa << 3) + MULAW_BIAS) << exponent;
  const sample = magnitude - MULAW_BIAS;
  return sign ? -sample : sample;
}

function encodeMuLawSample(value: number): number {
  const sign = value < 0 ? 0x80 : 0;
  const magnitude = Math.min(Math.abs(value), MULAW_CLIP) + MULAW_BIAS;
  let exponent = 7;
  for (
    let mask = 0x4000;
    exponent > 0 && (magnitude & mask) === 0;
    mask >>= 1
  ) {
    exponent -= 1;
  }
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}
