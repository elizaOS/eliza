/**
 * Serializes complete workbench evidence separately from its on-screen metadata preview.
 * Typed audio arrays use base64 bytes, an explicit element type, and native byte
 * order so every Float32 bit survives JSON, including non-finite sample values.
 */
import type { VoicePlaybackEvidenceEvent } from "../voice-playback-evidence";
import type {
  VoiceWorkbenchReport,
  VoiceWorkbenchTurnReport,
} from "./voice-workbench-player";

type PreviewEvent =
  | Exclude<VoicePlaybackEvidenceEvent, { kind: "encoded" | "decoded" }>
  | (Omit<Extract<VoicePlaybackEvidenceEvent, { kind: "encoded" }>, "bytes"> & {
      byteLength: number;
    })
  | (Omit<
      Extract<VoicePlaybackEvidenceEvent, { kind: "decoded" }>,
      "channels"
    > & { channelLengths: number[] });

type PreviewReport = Omit<VoiceWorkbenchReport, "turns"> & {
  turns: (Omit<VoiceWorkbenchTurnReport, "playbackEvidence"> & {
    playbackEvidence?: PreviewEvent[];
  })[];
};

export function voiceWorkbenchReportPreview(
  report: VoiceWorkbenchReport,
): PreviewReport {
  return {
    ...report,
    turns: report.turns.map((turn) => {
      const { playbackEvidence, ...rest } = turn;
      return {
        ...rest,
        ...(playbackEvidence
          ? {
              playbackEvidence: playbackEvidence.map((event) => {
                if (event.kind === "encoded") {
                  const { bytes, ...metadata } = event;
                  return { ...metadata, byteLength: bytes.byteLength };
                }
                if (event.kind === "decoded") {
                  const { channels, ...metadata } = event;
                  return {
                    ...metadata,
                    channelLengths: channels.map((channel) => channel.length),
                  };
                }
                return event;
              }),
            }
          : {}),
      };
    }),
  };
}

export function serializeVoiceWorkbenchReport(
  report: VoiceWorkbenchReport,
): string {
  const nativeOrder =
    new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? "little" : "big";
  return JSON.stringify(
    { schema: "eliza.voice-workbench.playback.v1", report },
    (_key, value: unknown) => {
      if (!(value instanceof Uint8Array) && !(value instanceof Float32Array))
        return value;
      const bytes = new Uint8Array(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      );
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return {
        encoding: "base64",
        elementType:
          value instanceof Float32Array ? "Float32Array" : "Uint8Array",
        byteOrder:
          value instanceof Float32Array ? nativeOrder : "not-applicable",
        length: value.length,
        data: btoa(binary),
      };
    },
    2,
  );
}
