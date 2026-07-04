/**
 * Browser-side asset helpers shared by the Model Tester view wrappers.
 * The module stays React-free so both component surfaces use the same file and audio decode logic.
 */

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export interface AudioPayload {
  audioDataUrl: string;
  pcmSamples: number[];
  sampleRateHz: number;
}

/** Read a File into a base64 data URL via FileReader. */
export async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () =>
      reject(reader.error ?? new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

/** Decode an audio File to a 16 kHz mono PCM payload (capped at 15s). */
export async function audioFileToPayload(file: File): Promise<AudioPayload> {
  const audioDataUrl = await fileToDataUrl(file);
  const buffer = await file.arrayBuffer();
  const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error("This browser cannot decode audio files.");
  }
  const context = new AudioContextCtor();
  const decoded = await context.decodeAudioData(buffer.slice(0));
  const src = decoded.getChannelData(0);
  const targetRate = 16_000;
  const maxSamples = targetRate * 15;
  const ratio = decoded.sampleRate / targetRate;
  const length = Math.min(maxSamples, Math.floor(src.length / ratio));
  const pcmSamples = new Array<number>(length);
  for (let i = 0; i < length; i += 1) {
    pcmSamples[i] = src[Math.min(src.length - 1, Math.floor(i * ratio))] ?? 0;
  }
  await context.close();
  return { audioDataUrl, pcmSamples, sampleRateHz: targetRate };
}
