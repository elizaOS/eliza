/**
 * Unit coverage for the deploy-configurable Whisper STT model resolution
 * (#14373). Pure function — proves the env override, the multilingual default,
 * and the whitespace-degrades-to-default guard without booting the route's
 * billing/service graph. The non-English round-trip itself is a live-Railway
 * assertion tracked in voice-kokoro-whisper-live.test.ts.
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_WHISPER_STT_MODEL,
  resolveWhisperSttModel,
} from "./whisper-model";

describe("resolveWhisperSttModel (#14373)", () => {
  it("defaults to the multilingual small model when unset", () => {
    expect(resolveWhisperSttModel(undefined)).toBe(DEFAULT_WHISPER_STT_MODEL);
    expect(DEFAULT_WHISPER_STT_MODEL).toBe("Systran/faster-whisper-small");
  });

  it("uses a deploy-configured multilingual model verbatim", () => {
    expect(resolveWhisperSttModel("Systran/faster-whisper-small")).toBe(
      "Systran/faster-whisper-small",
    );
  });

  it("trims surrounding whitespace from the configured value", () => {
    expect(resolveWhisperSttModel("  Systran/faster-whisper-medium  ")).toBe(
      "Systran/faster-whisper-medium",
    );
  });

  it("degrades a blank/whitespace-only value to the default (never sends an empty model)", () => {
    expect(resolveWhisperSttModel("")).toBe(DEFAULT_WHISPER_STT_MODEL);
    expect(resolveWhisperSttModel("   ")).toBe(DEFAULT_WHISPER_STT_MODEL);
  });
});
