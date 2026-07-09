/**
 * Non-speech pendant replay fixtures for performance lanes.
 *
 * Opus frames are raw 10 ms packets extracted from an Ogg Opus file generated
 * from a 16 kHz synthetic tone followed by silence. PCM fixtures are generated
 * at runtime from tone/silence formulas so no transcript, voice, or device data
 * is committed.
 */

export const PENDANT_FIXTURE_SAMPLE_RATE_HZ = 16000 as const;
export const PENDANT_FIXTURE_FRAME_SAMPLES = 160 as const;

export const RAW_OPUS_TONE_FRAME_BASE64 = [
  "sLTu9N6ZIgf/fK318ZY/m5alacDk696wlTHuTeUXVdtlkVApHBBbkqetqL277/QEFk1S8sAfrQ==",
  "sLPE48jQEgcWt4607dnwfRjusEdGkHag3cgvCd+G6dOt",
  "sLEVTfWJ+OXOJ3VIsr6WlMmhx2UkHMjaUZ2nTBvtrQ==",
  "sLEV7LE8ptS3uYpo+ui9eMCiWmrGU7cCf6PSnqjzl8jA3GWt",
  "sLDW+5J8W/9Vj/Yuqw2frcxlpxKUPACF4AfelxrO/RNDUnoH360=",
  "sLDdVsN1pqx3DB1gOGraDKOX5IoEgqF5FSLhAWeQzpea7b2N+9DRB8et",
  "sLDW9uq81PR+Tc8ocqSonGoSkAO9GNCf0v8U5291nDTagfiRlSeG1a0=",
  "sLEVTgsiHXxH+aiAY5qHahgyNW8koIJNIaOVK1EzaMupc1IYUwqn7a0=",
  "sLEV7LwJyynQWfLOHaMAXrq3JSRGBDy/kL+HF8cAaU84hozab0m5vOWt",
  "sLDW+5J8W/ucuRiMQC+f+WkW/bjnLmSt9AtcaSDaqz2lgSVZVPQH360=",
  "sLDdVsN1pqx3DB1gOGraDKOX5Ij3yud5FSLhAWfKlpea7b2N+9DRB8et",
  "sLDW9uq81PIKtbTBsC2vA34WzoWbEzx0/pf4pzt7rOGm1B6WQKyfDqmt",
  "sLEVTfWKRT1iVoBxuqnQpU0oC9mdmW1mkNBGErOijZcupcRPQpRFTtmt",
  "sLEV7LE9i9aRn1c0BFkIKwLZOY0JP3chfw4vjgDcZ5xDQnU3pgG8560=",
  "sLDW+5J8W/ucuRiMQC+f+WkW/bjnLmSt9AtcaSDaqz2lgSVZVPQH360=",
  "sLDdVsN1pqx3DB1gOGraDKOX5Ij3yud5FSLhAWfKlpea7b2N+9DRB8et",
  "sLDW9uq81PR+Tc8ocqSonGoSkAO9GNCf0v8fGW91nDTagfiRlSeG1a0=",
  "sLEVTgsiHXxH+RoL7z5IhkNsFKGcpl95pDRypWdFGy5dS6RPYUoap+ut",
  "sLEV7LE9i9aRn1c0BFkIKwLZOY0JP3chfw4vjgDcZ5xDQnU3pgG8560=",
  "sLDW+5J8W/ucUmgbsEFeISG0xAgqC24VD6Ba40kG1VntLCD2ZVHsB1+t",
  "sLDdVsN1pqx9wLLM0uwgagHBULcltdRP0VIvXoLPIZ0vNdtmN/qLUg+NrQ==",
  "sLDW9uq81PIKtbTBsC2vA34WzoWbEzw0/pf4pzt7rOGm1B6WQKyfDqmt",
  "sLEVTgsiHXxH+RoL7z5IhkNXX0mcpl9ppDRypWdFG0ZdS6RPYUoap22t",
  "sLEV7LE9i85MoyGeRh6dhmwbYt4pEnZ5C/hz61wBuM84hozaQpQDec2t",
  "sLDW+5J8W/ucUmgbsEFeISG0xAgqC24VD6Ba40kG1VntLCD2ZVHsB9+t",
  "sLDdVsN1pqx9wLLM0uwgagHBcZyeYtRP0VIvXoLPlS00NdtmN/qLUg+NrQ==",
  "sLDW9uq81PIKtbTBsC2vA34WzoWbEzx0/pf4pzt7rOGm1B6WQKyfDamt",
  "sLEVTgsiHXxH+RoL7z5IhkNXX0mcpl9JpDRypWdFG0ZdS6RPYUoap+2t",
  "sLEV7LE9i9aRn1c0BFkIKwLZOY0JP3chfw4vjgDcZ5xDQnU3pgG8Z60=",
  "sLDW+5J8W/ucUmgbsEFeISG0xAgqC24VD6Ba40kG1VntLCD2ZVHsB9+t",
  "sLDdVsN1pqx9wLLM0uwgagHBcZyeYtRP0VIvXoLPlS00NdtmN/qLUg+NrQ==",
  "sLDW9uq81PIKtbTBsC2vA34WzoWbEzx0/pf4pzt7rOGm1B6WQKyfDamt",
] as const;

export function rawOpusToneFrames(): Uint8Array[] {
  return RAW_OPUS_TONE_FRAME_BASE64.map((frame) =>
    Uint8Array.from(Buffer.from(frame, "base64")),
  );
}

export function pcm16ToneFrame(frameIndex: number): Uint8Array {
  const bytes = new Uint8Array(PENDANT_FIXTURE_FRAME_SAMPLES * 2);
  const view = new DataView(bytes.buffer);
  const frequencyHz = 440;
  for (let i = 0; i < PENDANT_FIXTURE_FRAME_SAMPLES; i += 1) {
    const sampleIndex = frameIndex * PENDANT_FIXTURE_FRAME_SAMPLES + i;
    const phase =
      (2 * Math.PI * frequencyHz * sampleIndex) /
      PENDANT_FIXTURE_SAMPLE_RATE_HZ;
    view.setInt16(i * 2, Math.round(Math.sin(phase) * 0x2000), true);
  }
  return bytes;
}

export function pcm16SilenceFrame(): Uint8Array {
  return new Uint8Array(PENDANT_FIXTURE_FRAME_SAMPLES * 2);
}

export function omiNotification(
  packetIndex: number,
  payload: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(payload.byteLength + 3);
  out[0] = packetIndex & 0xff;
  out[1] = (packetIndex >> 8) & 0xff;
  out[2] = 0;
  out.set(payload, 3);
  return out;
}
