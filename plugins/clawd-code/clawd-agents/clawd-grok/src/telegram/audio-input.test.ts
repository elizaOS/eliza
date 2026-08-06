import { describe, expect, it } from "vitest";
import { buildTelegramAudioFileName, formatTelegramAudioTranscript, getTelegramAudioSource } from "./audio-input";

describe("telegram audio input helpers", () => {
  it("extracts a voice source from a telegram message payload", () => {
    expect(
      getTelegramAudioSource({
        voice: {
          file_id: "voice-file",
          mime_type: "audio/ogg",
        },
      }),
    ).toEqual({
      kind: "voice",
      fileId: "voice-file",
      mimeType: "audio/ogg",
    });
  });

  it("extracts an audio attachment source from a telegram message payload", () => {
    expect(
      getTelegramAudioSource({
        audio: {
          file_id: "audio-file",
          file_name: "song.mp3",
          mime_type: "audio/mpeg",
        },
      }),
    ).toEqual({
      kind: "audio",
      fileId: "audio-file",
      fileName: "song.mp3",
      mimeType: "audio/mpeg",
    });
  });

  it("formats user-visible transcript prefixes for voice and audio messages", () => {
    expect(formatTelegramAudioTranscript("voice", "hello there")).toBe("[Voice transcript] hello there");
    expect(formatTelegramAudioTranscript("audio", "demo")).toBe("[Audio transcript] demo");
  });
});

describe("buildTelegramAudioFileName", () => {
  const voice = { kind: "voice" as const, fileId: "f" };
  const audio = (fileName?: string) => ({ kind: "audio" as const, fileId: "f", fileName });

  it("falls back to input<ext> when no filename is provided", () => {
    expect(buildTelegramAudioFileName(voice, ".ogg")).toBe("input.ogg");
  });

  it("preserves safe filenames", () => {
    expect(buildTelegramAudioFileName(audio("song.mp3"), ".mp3")).toBe("song.mp3");
  });

  it("strips POSIX path traversal attempts", () => {
    expect(buildTelegramAudioFileName(audio("../../etc/passwd"), ".bin")).toBe("passwd");
    expect(buildTelegramAudioFileName(audio("/etc/passwd"), ".bin")).toBe("passwd");
  });

  it("strips Windows-style path traversal attempts", () => {
    expect(buildTelegramAudioFileName(audio("..\\..\\Windows\\evil.mp3"), ".mp3")).toBe("evil.mp3");
    expect(buildTelegramAudioFileName(audio("C:\\evil\\song.mp3"), ".mp3")).toBe("song.mp3");
  });

  it("falls back to input<ext> for dot-only or empty sanitized names", () => {
    expect(buildTelegramAudioFileName(audio("../"), ".mp3")).toBe("input.mp3");
    expect(buildTelegramAudioFileName(audio(".."), ".mp3")).toBe("input.mp3");
    expect(buildTelegramAudioFileName(audio("."), ".mp3")).toBe("input.mp3");
    expect(buildTelegramAudioFileName(audio("   "), ".mp3")).toBe("input.mp3");
  });

  it("drops null bytes from the sanitized name", () => {
    expect(buildTelegramAudioFileName(audio("song\0.mp3"), ".mp3")).toBe("song.mp3");
  });
});
