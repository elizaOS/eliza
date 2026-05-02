import { describe, expect, it } from "vitest";
import {
  DEFAULT_SAM_OPTIONS,
  SAMServiceType,
  SPEECH_TRIGGERS,
  VOCALIZATION_PATTERNS,
} from "../types";

describe("SamTTSOptions", () => {
  describe("DEFAULT_SAM_OPTIONS", () => {
    it("has correct default speed", () => {
      expect(DEFAULT_SAM_OPTIONS.speed).toBe(72);
    });

    it("has correct default pitch", () => {
      expect(DEFAULT_SAM_OPTIONS.pitch).toBe(64);
    });

    it("has correct default throat", () => {
      expect(DEFAULT_SAM_OPTIONS.throat).toBe(128);
    });

    it("has correct default mouth", () => {
      expect(DEFAULT_SAM_OPTIONS.mouth).toBe(128);
    });
  });
});

describe("SAMServiceType", () => {
  it("has SAM_TTS type", () => {
    expect(SAMServiceType.SAM_TTS).toBe("SAM_TTS");
  });
});

describe("SPEECH_TRIGGERS", () => {
  it("is not empty", () => {
    expect(SPEECH_TRIGGERS.length).toBeGreaterThan(0);
  });

  it("contains common triggers", () => {
    expect(SPEECH_TRIGGERS).toContain("say aloud");
    expect(SPEECH_TRIGGERS).toContain("speak");
    expect(SPEECH_TRIGGERS).toContain("read aloud");
    expect(SPEECH_TRIGGERS).toContain("voice");
  });

  it("contains voice modifiers", () => {
    expect(SPEECH_TRIGGERS).toContain("higher voice");
    expect(SPEECH_TRIGGERS).toContain("lower voice");
    expect(SPEECH_TRIGGERS).toContain("robotic voice");
    expect(SPEECH_TRIGGERS).toContain("retro voice");
  });

  it("all triggers are lowercase", () => {
    for (const trigger of SPEECH_TRIGGERS) {
      expect(trigger).toBe(trigger.toLowerCase());
    }
  });
});

describe("VOCALIZATION_PATTERNS", () => {
  it("is not empty", () => {
    expect(VOCALIZATION_PATTERNS.length).toBeGreaterThan(0);
  });

  it("contains common patterns", () => {
    expect(VOCALIZATION_PATTERNS).toContain("can you say");
    expect(VOCALIZATION_PATTERNS).toContain("please say");
    expect(VOCALIZATION_PATTERNS).toContain("i want to hear");
    expect(VOCALIZATION_PATTERNS).toContain("let me hear");
  });

  it("all patterns are lowercase", () => {
    for (const pattern of VOCALIZATION_PATTERNS) {
      expect(pattern).toBe(pattern.toLowerCase());
    }
  });
});
