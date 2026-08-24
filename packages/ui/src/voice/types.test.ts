/**
 * Behavioural coverage for the canonical UI voice re-export surface. Every
 * case drives the real re-exported runtime bindings through ./types so a lost
 * or rewired export fails as behaviour, mirroring how voice settings and
 * picker components consume this module.
 */
import { describe, expect, it } from "vitest";
import {
  EDGE_BACKUP_VOICES,
  hasConfiguredApiKey,
  PREMADE_VOICES,
  sanitizeApiKey,
  VOICE_PROVIDERS,
  type VoicePreset,
} from "./types";

describe("sanitizeApiKey", () => {
  it("passes absent and empty keys straight through", () => {
    expect(sanitizeApiKey(undefined)).toBeUndefined();
    expect(sanitizeApiKey("")).toBe("");
  });

  it("keeps the redacted display marker intact", () => {
    expect(sanitizeApiKey("[REDACTED]")).toBe("[REDACTED]");
  });

  it("masks the middle of keys longer than eight characters", () => {
    expect(sanitizeApiKey("sk-live-abcdefgh12345678")).toBe("sk-l...5678");
    expect(sanitizeApiKey("123456789")).toBe("1234...6789");
  });

  it("leaves short keys unmasked", () => {
    expect(sanitizeApiKey("12345678")).toBe("12345678");
    expect(sanitizeApiKey("abc123")).toBe("abc123");
  });
});

describe("hasConfiguredApiKey", () => {
  it.each([null, undefined, "", "   "])(
    "treats %j as not configured",
    (apiKey) => {
      expect(hasConfiguredApiKey(apiKey)).toBe(false);
    },
  );

  it("rejects redacted and all-mask display placeholders", () => {
    expect(hasConfiguredApiKey("REDACTED")).toBe(false);
    expect(hasConfiguredApiKey("[REDACTED]")).toBe(false);
    expect(hasConfiguredApiKey("********")).toBe(false);
  });

  it("rejects masked display values of the shape abcd...wxyz", () => {
    expect(hasConfiguredApiKey("abcd...wxyz")).toBe(false);
  });

  it("accepts a real key, ignoring surrounding whitespace", () => {
    expect(hasConfiguredApiKey("sk-live-abcdefgh12345678")).toBe(true);
    expect(hasConfiguredApiKey("  sk-live-abcdefgh12345678  ")).toBe(true);
  });

  it("a sanitized long key round-trips into a not-configured display value", () => {
    const key = "sk-live-abcdefgh12345678";
    const displayValue = sanitizeApiKey(key);
    expect(displayValue).not.toBe(key);
    expect(hasConfiguredApiKey(displayValue)).toBe(false);
  });
});

/** A preset is consumer-renderable only when these fields survive intact. */
function assertRenderableVoicePreset(preset: VoicePreset): void {
  expect(typeof preset.id).toBe("string");
  expect(preset.id.length).toBeGreaterThan(0);
  expect(preset.name.length).toBeGreaterThan(0);
  expect(preset.voiceId.length).toBeGreaterThan(0);
  expect(preset.hint.length).toBeGreaterThan(0);
  expect(typeof preset.previewUrl).toBe("string");
  expect(["female", "male", "character"]).toContain(preset.gender);
}

function assertUniqueNonEmptyIds(presets: VoicePreset[]): void {
  const ids = presets.map((preset) => preset.id);
  expect(presets.length).toBeGreaterThan(0);
  expect(new Set(ids).size).toBe(ids.length);
}

describe("voice catalogues exposed through the canonical surface", () => {
  it("PREMADE_VOICES is a non-empty list of uniquely identified renderable presets", () => {
    assertUniqueNonEmptyIds(PREMADE_VOICES);
    for (const preset of PREMADE_VOICES) {
      assertRenderableVoicePreset(preset);
    }
  });

  it("EDGE_BACKUP_VOICES provides renderable backups for keyless providers", () => {
    assertUniqueNonEmptyIds(EDGE_BACKUP_VOICES);
    for (const preset of EDGE_BACKUP_VOICES) {
      assertRenderableVoicePreset(preset);
    }
  });

  it("VOICE_PROVIDERS entries carry the fields the settings picker renders", () => {
    expect(VOICE_PROVIDERS.length).toBeGreaterThan(0);
    const ids = VOICE_PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const provider of VOICE_PROVIDERS) {
      expect(provider.label.length).toBeGreaterThan(0);
      expect(provider.labelKey.length).toBeGreaterThan(0);
      expect(provider.hint.length).toBeGreaterThan(0);
      expect(provider.hintKey.length).toBeGreaterThan(0);
      expect(typeof provider.needsKey).toBe("boolean");
    }
  });
});
