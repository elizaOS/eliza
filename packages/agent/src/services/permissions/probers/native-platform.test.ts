/**
 * Unit coverage for the native-platform permission probers. Drives the real
 * module: every id in the exported registry maps to a Prober whose check()
 * and request() both return the production platformUnsupportedState. These
 * ids only have meaning on native mobile hosts; the desktop registry reports
 * them uniformly as not-applicable instead of leaving them unregistered.
 */
import { describe, expect, it } from "vitest";

import { nativePlatformProbers } from "./native-platform.ts";

const EXPECTED_IDS = [
  "speech-recognition",
  "photos",
  "phone",
  "messages",
  "wifi",
  "bluetooth",
  "app-blocking",
  "usage-access",
  "overlay",
  "write-settings",
  "local-network",
  "battery-optimization",
] as const;

const DESKTOP_OWNED_IDS = [
  "accessibility",
  "automation",
  "calendar",
  "camera",
  "contacts",
  "full-disk",
  "health",
  "location",
  "microphone",
  "notes",
  "notifications",
  "reminders",
  "screen-recording",
  "screentime",
  "shell",
  "website-blocking",
] as const;

describe("nativePlatformProbers", () => {
  it("exports one prober per mobile-only id in declaration order", () => {
    expect(nativePlatformProbers).toHaveLength(EXPECTED_IDS.length);
    expect(nativePlatformProbers.map((prober) => prober.id)).toEqual([
      ...EXPECTED_IDS,
    ]);
  });

  it("does not duplicate ids", () => {
    const ids = nativePlatformProbers.map((prober) => prober.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not register desktop-owned or plugin-provided permission ids", () => {
    const ids = new Set(nativePlatformProbers.map((prober) => prober.id));
    for (const id of DESKTOP_OWNED_IDS) {
      expect(ids.has(id)).toBe(false);
    }
  });

  it("is not an empty registry", () => {
    expect(nativePlatformProbers.length).toBeGreaterThan(0);
    expect(nativePlatformProbers[0]).toBeDefined();
  });

  it("exposes check() and request() on every prober and omits openSettings", () => {
    for (const prober of nativePlatformProbers) {
      expect(typeof prober.check).toBe("function");
      expect(typeof prober.request).toBe("function");
      expect(prober.openSettings).toBeUndefined();
    }
  });
});

describe("nativePlatformProbers.check", () => {
  it.each(EXPECTED_IDS)(
    "reports %s as platform-unsupported without stamping lastRequested",
    async (id) => {
      const prober = nativePlatformProbers.find((entry) => entry.id === id);
      expect(prober).toBeDefined();
      const before = Date.now();
      const state = await prober?.check();
      const after = Date.now();

      expect(state).toMatchObject({
        id,
        status: "not-applicable",
        canRequest: false,
        restrictedReason: "platform_unsupported",
        platform: process.platform,
      });
      expect(state?.lastChecked).toBeGreaterThanOrEqual(before);
      expect(state?.lastChecked).toBeLessThanOrEqual(after);
      expect(state?.lastRequested).toBeUndefined();
      expect(state?.lastBlockedFeature).toBeUndefined();
      expect(state?.reason).toBeUndefined();
    },
  );
});

describe("nativePlatformProbers.request", () => {
  it.each(EXPECTED_IDS)(
    "reports %s as platform-unsupported even when a reason is supplied",
    async (id) => {
      const prober = nativePlatformProbers.find((entry) => entry.id === id);
      expect(prober).toBeDefined();
      const before = Date.now();
      const state = await prober?.request({
        reason: "unit-test native-platform coverage",
      });
      const after = Date.now();

      expect(state).toMatchObject({
        id,
        status: "not-applicable",
        canRequest: false,
        restrictedReason: "platform_unsupported",
        platform: process.platform,
      });
      expect(state?.lastChecked).toBeGreaterThanOrEqual(before);
      expect(state?.lastChecked).toBeLessThanOrEqual(after);
      expect(state?.lastRequested).toBeUndefined();
      expect(state?.reason).toBeUndefined();
    },
  );

  it("does not mutate a later check() after request()", async () => {
    const prober = nativePlatformProbers[0];
    expect(prober).toBeDefined();
    await prober?.request({ reason: "unit-test" });
    const before = Date.now();
    const state = await prober?.check();
    expect(state?.id).toBe("speech-recognition");
    expect(state?.status).toBe("not-applicable");
    expect(state?.canRequest).toBe(false);
    expect(state?.lastRequested).toBeUndefined();
    expect(state?.lastChecked).toBeGreaterThanOrEqual(before);
  });
});
