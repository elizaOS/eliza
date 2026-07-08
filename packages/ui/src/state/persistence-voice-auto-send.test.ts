// @vitest-environment jsdom

/**
 * Voice auto-send persistence (`persistence`): `loadVoiceAutoSend` /
 * `saveVoiceAutoSend` round-trip + rehydrate, and the DEFAULT-OFF (review)
 * launch default. jsdom + real `localStorage`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { loadVoiceAutoSend, saveVoiceAutoSend } from "./persistence";

const KEY = "eliza:voice:auto-send";

describe("voice auto-send persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to false (composer review) when nothing is stored", () => {
    expect(loadVoiceAutoSend()).toBe(false);
  });

  it("round-trips (persists + rehydrates) an enabled value", () => {
    saveVoiceAutoSend(true);
    expect(localStorage.getItem(KEY)).toBe("true");
    // A fresh load reads the persisted value (rehydration).
    expect(loadVoiceAutoSend()).toBe(true);
  });

  it("round-trips a disabled value back to review", () => {
    saveVoiceAutoSend(true);
    saveVoiceAutoSend(false);
    expect(loadVoiceAutoSend()).toBe(false);
  });

  it("treats any non-\"true\" stored value as review (fail-safe off)", () => {
    localStorage.setItem(KEY, "garbage");
    expect(loadVoiceAutoSend()).toBe(false);
  });
});
