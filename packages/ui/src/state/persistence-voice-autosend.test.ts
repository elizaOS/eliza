// @vitest-environment jsdom

/**
 * Voice auto-send toggle persistence (voice V2a): `loadVoiceAutoSendEnabled` /
 * `saveVoiceAutoSendEnabled` round-trip + the OFF-by-default contract (the
 * launch default is review-then-send; auto-send flips on later once reliable).
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadVoiceAutoSendEnabled,
  saveVoiceAutoSendEnabled,
} from "./persistence";

const KEY = "eliza:voice:autosend-enabled";

describe("voice auto-send persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults OFF when nothing is stored (review-then-send launch default)", () => {
    expect(loadVoiceAutoSendEnabled()).toBe(false);
  });

  it("round-trips an enabled value", () => {
    saveVoiceAutoSendEnabled(true);
    expect(localStorage.getItem(KEY)).toBe("true");
    expect(loadVoiceAutoSendEnabled()).toBe(true);
  });

  it("round-trips a disabled value", () => {
    saveVoiceAutoSendEnabled(true);
    saveVoiceAutoSendEnabled(false);
    expect(loadVoiceAutoSendEnabled()).toBe(false);
  });

  it("treats any non-'true' stored value as OFF", () => {
    localStorage.setItem(KEY, "yes");
    expect(loadVoiceAutoSendEnabled()).toBe(false);
    localStorage.setItem(KEY, "1");
    expect(loadVoiceAutoSendEnabled()).toBe(false);
  });
});
