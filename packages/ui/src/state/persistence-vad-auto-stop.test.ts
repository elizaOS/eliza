// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LOCAL_ASR_AUTO_STOP } from "../voice/local-asr-capture";
import { loadVadAutoStop, saveVadAutoStop } from "./persistence";

describe("VAD auto-stop persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns the canonical defaults when nothing is stored", () => {
    expect(loadVadAutoStop()).toEqual({
      silenceMs: DEFAULT_LOCAL_ASR_AUTO_STOP.silenceMs,
      speechRmsThreshold: DEFAULT_LOCAL_ASR_AUTO_STOP.speechRmsThreshold,
    });
  });

  it("round-trips a saved value", () => {
    saveVadAutoStop({ silenceMs: 1500, speechRmsThreshold: 0.01 });
    expect(loadVadAutoStop()).toEqual({
      silenceMs: 1500,
      speechRmsThreshold: 0.01,
    });
  });

  it("falls back to defaults for malformed JSON", () => {
    localStorage.setItem("eliza:voice:vad-auto-stop", "{not json");
    expect(loadVadAutoStop()).toEqual({
      silenceMs: DEFAULT_LOCAL_ASR_AUTO_STOP.silenceMs,
      speechRmsThreshold: DEFAULT_LOCAL_ASR_AUTO_STOP.speechRmsThreshold,
    });
  });

  it("backfills missing or non-finite fields from defaults", () => {
    localStorage.setItem(
      "eliza:voice:vad-auto-stop",
      JSON.stringify({ silenceMs: 2000, speechRmsThreshold: "loud" }),
    );
    expect(loadVadAutoStop()).toEqual({
      silenceMs: 2000,
      speechRmsThreshold: DEFAULT_LOCAL_ASR_AUTO_STOP.speechRmsThreshold,
    });
  });
});
