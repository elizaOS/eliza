/**
 * Unit tests for cloud service pricing constants.
 */

import { describe, expect, it } from "vitest";
import {
  API_KEY_PREFIX_LENGTH,
  BASE_IMAGE_GENERATION_COST,
  CUSTOM_VOICE_TTS_MARKUP,
  IMAGE_GENERATION_COST,
  MONTHLY_CREDIT_CAP,
  PLATFORM_MARKUP_MULTIPLIER,
  STT_COST_PER_MINUTE,
  STT_MINIMUM_COST,
  TTS_COST_PER_1K_CHARS,
  TTS_MINIMUM_COST,
  VIDEO_GENERATION_COST,
  VIDEO_GENERATION_FALLBACK_COST,
  VOICE_CLONE_INSTANT_COST,
  VOICE_CLONE_PROFESSIONAL_COST,
  VOICE_SAMPLE_UPLOAD_COST,
  VOICE_UPDATE_COST,
} from "./pricing-constants.js";

describe("Pricing and billing constants", () => {
  it("defines API key prefix length and platform markup", () => {
    expect(API_KEY_PREFIX_LENGTH).toBe(12);
    expect(PLATFORM_MARKUP_MULTIPLIER).toBeGreaterThan(1);
    expect(MONTHLY_CREDIT_CAP).toBe(2.4);
  });

  it("calculates media generation costs correctly with platform markup", () => {
    expect(BASE_IMAGE_GENERATION_COST).toBe(0.039);
    expect(IMAGE_GENERATION_COST).toBe(0.0468);
    expect(VIDEO_GENERATION_COST).toBe(3.84);
    expect(VIDEO_GENERATION_FALLBACK_COST).toBe(0.336);
  });

  it("defines voice cloning and customization rates", () => {
    expect(VOICE_CLONE_INSTANT_COST).toBe(0.5);
    expect(VOICE_CLONE_PROFESSIONAL_COST).toBe(2.0);
    expect(VOICE_SAMPLE_UPLOAD_COST).toBe(0.05);
    expect(VOICE_UPDATE_COST).toBe(0.1);
    expect(CUSTOM_VOICE_TTS_MARKUP).toBe(1.1);
  });

  it("defines TTS and STT cost rates and minimum invocation charges", () => {
    expect(TTS_COST_PER_1K_CHARS).toBe(0.06);
    expect(STT_COST_PER_MINUTE).toBe(0.0044);
    expect(TTS_MINIMUM_COST).toBe(0.001);
    expect(STT_MINIMUM_COST).toBe(0.001);
  });
});
