/** Verifies resolveEffectiveVoiceConfig — cloud-only provider default through the package's configured test harness. */
import { describe, expect, it } from "vitest";
import type { VoiceConfig } from "../api/client-types-config";
import { resolveEffectiveVoiceConfig } from "./voice-chat-types";

/**
 * Regression coverage for the cloud-only robot-voice window (#20483 follow-up).
 *
 * On a cloud-only consumer build the ONLY possible voice backend is Eliza
 * Cloud, but the resolver's `eliza-cloud` default was gated on
 * `cloudConnected` — an async status poll whose first success can trail the
 * first assistant replies by several turns (the worker's auth cache warms with
 * 503s on a cold session). During that window the provider resolved to
 * undefined, processQueue fell through to browser speechSynthesis, and the
 * user heard the robotic OS voice — sneaking past the #12253 fail-closed rule,
 * which only guards failures AFTER a provider is chosen.
 *
 * The fix: `cloudOnly: true` (from branding) makes the resolver default both
 * TTS and ASR to `eliza-cloud` immediately, without waiting for the poll.
 * Explicit stored providers are still respected, and non-cloud-only builds
 * keep the poll-gated behavior unchanged.
 */
describe("resolveEffectiveVoiceConfig — cloud-only provider default", () => {
  it("defaults TTS + ASR to eliza-cloud on cloudOnly builds even before the status poll (the fix)", () => {
    const config: VoiceConfig = {}; // fresh install: no provider, no asr

    const resolved = resolveEffectiveVoiceConfig(config, {
      cloudConnected: false, // poll still warming — the robot-voice window
      cloudOnly: true,
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.provider).toBe("eliza-cloud");
    expect(resolved?.asr?.provider).toBe("eliza-cloud");
  });

  it("upgrades a stored robot-voice provider on cloudOnly builds", () => {
    const config: VoiceConfig = { provider: "robot-voice" };

    const resolved = resolveEffectiveVoiceConfig(config, {
      cloudConnected: false,
      cloudOnly: true,
    });

    expect(resolved?.provider).toBe("eliza-cloud");
  });

  it("still respects an explicit stored provider on cloudOnly builds", () => {
    const config: VoiceConfig = {
      provider: "elevenlabs",
      elevenlabs: { voiceId: "abc" },
    };

    const resolved = resolveEffectiveVoiceConfig(config, {
      cloudConnected: false,
      cloudOnly: true,
    });

    expect(resolved?.provider).toBe("elevenlabs");
  });

  it("keeps the poll-gated behavior unchanged when cloudOnly is not set", () => {
    const config: VoiceConfig = {};

    const resolved = resolveEffectiveVoiceConfig(config, {
      cloudConnected: false,
    });

    // No provider resolvable — downstream defaults (pickDefaultVoiceProvider)
    // still own the non-cloud-only case.
    expect(resolved).toBeNull();
  });
});
