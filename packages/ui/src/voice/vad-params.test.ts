// Guards the single-source contract for VAD params (voice VAD-tunability lane):
// the end-of-speech VAD tunables surfaced by `vad-params.ts` MUST equal the
// runtime `DEFAULT_LOCAL_ASR_AUTO_STOP` the capture detector actually reads —
// never a divergent copy. This is the "one place to tune" assertion the owner
// relies on when iterating on-device.

import { describe, expect, it } from "vitest";
import { DEFAULT_LOCAL_ASR_AUTO_STOP } from "./local-asr-capture";
import { AUTO_SEND_GUARD, END_OF_SPEECH_VAD } from "./vad-params";
import { isVadDebugEnabled } from "./vad-debug";

describe("END_OF_SPEECH_VAD — single source of the end-of-speech tunables", () => {
  it("mirrors the runtime auto-stop config field-for-field", () => {
    // If someone forks a magic number into the capture loop instead of the one
    // config, this test fails — the whole point of the module.
    expect(END_OF_SPEECH_VAD.startGraceMs).toBe(
      DEFAULT_LOCAL_ASR_AUTO_STOP.startGraceMs,
    );
    expect(END_OF_SPEECH_VAD.minSpeechMs).toBe(
      DEFAULT_LOCAL_ASR_AUTO_STOP.minSpeechMs,
    );
    expect(END_OF_SPEECH_VAD.silenceMs).toBe(
      DEFAULT_LOCAL_ASR_AUTO_STOP.silenceMs,
    );
    expect(END_OF_SPEECH_VAD.maxSpeechMs).toBe(
      DEFAULT_LOCAL_ASR_AUTO_STOP.maxSpeechMs,
    );
    expect(END_OF_SPEECH_VAD.speechRmsThreshold).toBe(
      DEFAULT_LOCAL_ASR_AUTO_STOP.speechRmsThreshold,
    );
    expect(END_OF_SPEECH_VAD.speechPeakThreshold).toBe(
      DEFAULT_LOCAL_ASR_AUTO_STOP.speechPeakThreshold,
    );
  });

  it("covers exactly the auto-stop config keys (no drift on either side)", () => {
    // Both param blocks must enumerate the same knob set so a new VAD knob can't
    // be added to the runtime config without surfacing here.
    expect(Object.keys(END_OF_SPEECH_VAD).sort()).toEqual(
      Object.keys(DEFAULT_LOCAL_ASR_AUTO_STOP).sort(),
    );
  });
});

describe("AUTO_SEND_GUARD — sane reliability floors", () => {
  it("has non-degenerate guard thresholds", () => {
    expect(AUTO_SEND_GUARD.minChars).toBeGreaterThanOrEqual(1);
    expect(AUTO_SEND_GUARD.minWords).toBeGreaterThanOrEqual(1);
    expect(AUTO_SEND_GUARD.minSpeechMs).toBeGreaterThan(0);
  });
});

describe("VAD dev logging — off by default", () => {
  it("isVadDebugEnabled() is false without the env flag", () => {
    // The QA affordance must NOT be on in a normal build/test run.
    const prev = process.env.ELIZA_VOICE_VAD_DEBUG;
    delete process.env.ELIZA_VOICE_VAD_DEBUG;
    try {
      expect(isVadDebugEnabled()).toBe(false);
    } finally {
      if (prev !== undefined) process.env.ELIZA_VOICE_VAD_DEBUG = prev;
    }
  });

  it("flips on when the env flag is truthy", () => {
    const prev = process.env.ELIZA_VOICE_VAD_DEBUG;
    process.env.ELIZA_VOICE_VAD_DEBUG = "1";
    try {
      expect(isVadDebugEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ELIZA_VOICE_VAD_DEBUG;
      else process.env.ELIZA_VOICE_VAD_DEBUG = prev;
    }
  });
});
