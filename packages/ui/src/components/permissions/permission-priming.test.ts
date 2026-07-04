// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  hasPrimedPermissions,
  markPermissionsPrimed,
  PERMISSION_PRIMING_STORAGE_KEY,
  PRIMING_COPY,
  resetPermissionPriming,
  resolvePrimingSet,
} from "./permission-priming";

afterEach(() => {
  localStorage.clear();
});

describe("resolvePrimingSet", () => {
  it("returns the voice-first set on iOS, including speech-recognition", () => {
    expect(resolvePrimingSet({ platform: "ios" })).toEqual([
      "microphone",
      "speech-recognition",
      "notifications",
      "location",
    ]);
  });

  it("returns mic/notifications/location on android and desktop", () => {
    expect(resolvePrimingSet({ platform: "android" })).toEqual([
      "microphone",
      "notifications",
      "location",
    ]);
    expect(resolvePrimingSet({ platform: "desktop" })).toEqual([
      "microphone",
      "notifications",
      "location",
    ]);
  });

  it("primes nothing on web (JIT only — eager browser prompts are a dark pattern)", () => {
    expect(resolvePrimingSet({ platform: "web" })).toEqual([]);
  });

  it("never includes an id without a declared iOS usage string (crash guard)", () => {
    // contacts / reminders / bluetooth have no NS*UsageDescription — requesting
    // them on iOS aborts the process, so they must never appear in any set.
    for (const platform of ["ios", "android", "desktop", "web"] as const) {
      const set = resolvePrimingSet({ platform });
      expect(set).not.toContain("contacts");
      expect(set).not.toContain("reminders");
      expect(set).not.toContain("bluetooth");
    }
  });

  it("only returns ids that have priming copy", () => {
    for (const platform of ["ios", "android", "desktop"] as const) {
      for (const id of resolvePrimingSet({ platform })) {
        expect(PRIMING_COPY[id]).toBeDefined();
      }
    }
  });

  it("honors an explicit `only` override, still filtered to ids with copy", () => {
    expect(
      resolvePrimingSet({ only: ["microphone", "contacts", "location"] }),
    ).toEqual(["microphone", "location"]);
  });
});

describe("priming persistence", () => {
  it("defaults to not-primed and flips on mark", () => {
    expect(hasPrimedPermissions()).toBe(false);
    markPermissionsPrimed();
    expect(localStorage.getItem(PERMISSION_PRIMING_STORAGE_KEY)).toBe("1");
    expect(hasPrimedPermissions()).toBe(true);
  });

  it("reset clears the flag so the modal can be re-triggered", () => {
    markPermissionsPrimed();
    resetPermissionPriming();
    expect(hasPrimedPermissions()).toBe(false);
    expect(localStorage.getItem(PERMISSION_PRIMING_STORAGE_KEY)).toBeNull();
  });
});
