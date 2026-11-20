// spec/cloud/services/speech.md, "Story: Transcribe a recording"
export const recordingBytes = 44 + 32_000;

export function oneSecondWav(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(recordingBytes);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => bytes.set(Array.from(value, (character) => character.charCodeAt(0)), at);
  text(0, "RIFF");
  view.setUint32(4, recordingBytes - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, 32_000, true);
  return bytes;
}

export function recordingForm(fields: Readonly<Record<string, string>>): FormData {
  const form = new FormData();
  form.append("audio", new Blob([oneSecondWav()], { type: "audio/wav" }), "clip.wav");
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  return form;
}
