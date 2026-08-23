/**
 * Coverage for overlay-app presence heartbeat gating: TTL expiry, app-name
 * matching, blank-name rejection, and default TTL semantics. Module state is
 * reset between tests via vi.resetModules + dynamic import.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type PresenceModule = {
  OVERLAY_APP_PRESENCE_TTL_MS: number;
  isOverlayAppPresenceActive: (
    appCanonicalName: string,
    maxAgeMs?: number,
  ) => boolean;
  setOverlayAppPresence: (appName: string | null) => void;
};

async function loadPresence(): Promise<PresenceModule> {
  vi.resetModules();
  return import("./overlay-app-presence.ts");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("overlay-app-presence", () => {
  it("is inactive before any report", async () => {
    const mod = await loadPresence();
    expect(mod.isOverlayAppPresenceActive("companion")).toBe(false);
  });

  it("reports an app as active right after being set", async () => {
    const mod = await loadPresence();
    mod.setOverlayAppPresence("companion");
    expect(mod.isOverlayAppPresenceActive("companion")).toBe(true);
  });

  it("does not match a different app name", async () => {
    const mod = await loadPresence();
    mod.setOverlayAppPresence("companion");
    expect(mod.isOverlayAppPresenceActive("dashboard")).toBe(false);
  });

  it("ignores blank names", async () => {
    const mod = await loadPresence();
    mod.setOverlayAppPresence("   ");
    expect(mod.isOverlayAppPresenceActive("companion")).toBe(false);
    mod.setOverlayAppPresence(null);
    expect(mod.isOverlayAppPresenceActive("companion")).toBe(false);
  });

  it("expires after the default TTL", async () => {
    vi.useFakeTimers();
    const mod = await loadPresence();
    mod.setOverlayAppPresence("companion");
    expect(mod.isOverlayAppPresenceActive("companion")).toBe(true);
    vi.advanceTimersByTime(mod.OVERLAY_APP_PRESENCE_TTL_MS + 1);
    expect(mod.isOverlayAppPresenceActive("companion")).toBe(false);
  });

  it("honours a caller-supplied max age", async () => {
    vi.useFakeTimers();
    const mod = await loadPresence();
    mod.setOverlayAppPresence("companion");
    expect(mod.isOverlayAppPresenceActive("companion", 1_000)).toBe(true);
    vi.advanceTimersByTime(1_001);
    expect(mod.isOverlayAppPresenceActive("companion", 1_000)).toBe(false);
  });
});
