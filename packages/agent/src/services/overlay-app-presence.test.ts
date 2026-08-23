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

  it("exports a 60s default TTL", async () => {
    const mod = await loadPresence();
    expect(mod.OVERLAY_APP_PRESENCE_TTL_MS).toBe(60_000);
  });

  it("treats name matching as case-sensitive identity, not a canonical fold", async () => {
    const mod = await loadPresence();
    mod.setOverlayAppPresence("Companion");
    expect(mod.isOverlayAppPresenceActive("Companion")).toBe(true);
    expect(mod.isOverlayAppPresenceActive("companion")).toBe(false);
  });

  it("does not trim the query name when comparing", async () => {
    const mod = await loadPresence();
    mod.setOverlayAppPresence("companion");
    expect(mod.isOverlayAppPresenceActive("  companion  ")).toBe(false);
  });

  it("stores the raw name when trim is truthy, not the trimmed value", async () => {
    const mod = await loadPresence();
    mod.setOverlayAppPresence("  companion  ");
    expect(mod.isOverlayAppPresenceActive("companion")).toBe(false);
    expect(mod.isOverlayAppPresenceActive("  companion  ")).toBe(true);
  });

  it("replaces the previous name so only the last writer is active", async () => {
    const mod = await loadPresence();
    mod.setOverlayAppPresence("companion");
    mod.setOverlayAppPresence("@elizaos/plugin-phone");
    expect(mod.isOverlayAppPresenceActive("companion")).toBe(false);
    expect(mod.isOverlayAppPresenceActive("@elizaos/plugin-phone")).toBe(true);
  });

  it("clears a previously active name when set to null", async () => {
    const mod = await loadPresence();
    mod.setOverlayAppPresence("companion");
    expect(mod.isOverlayAppPresenceActive("companion")).toBe(true);
    mod.setOverlayAppPresence(null);
    expect(mod.isOverlayAppPresenceActive("companion")).toBe(false);
  });

  it("clears a previously active name when set to an empty string", async () => {
    const mod = await loadPresence();
    mod.setOverlayAppPresence("companion");
    mod.setOverlayAppPresence("");
    expect(mod.isOverlayAppPresenceActive("companion")).toBe(false);
  });

  it("clears a previously active name when set to whitespace-only", async () => {
    const mod = await loadPresence();
    mod.setOverlayAppPresence("companion");
    mod.setOverlayAppPresence("   \t");
    expect(mod.isOverlayAppPresenceActive("companion")).toBe(false);
  });

  it("stays active at exactly the default TTL boundary (inclusive <=)", async () => {
    vi.useFakeTimers();
    const mod = await loadPresence();
    mod.setOverlayAppPresence("companion");
    vi.advanceTimersByTime(mod.OVERLAY_APP_PRESENCE_TTL_MS);
    expect(mod.isOverlayAppPresenceActive("companion")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(mod.isOverlayAppPresenceActive("companion")).toBe(false);
  });

  it("treats maxAgeMs 0 as active only in the same millisecond as the report", async () => {
    vi.useFakeTimers();
    const mod = await loadPresence();
    mod.setOverlayAppPresence("companion");
    expect(mod.isOverlayAppPresenceActive("companion", 0)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(mod.isOverlayAppPresenceActive("companion", 0)).toBe(false);
  });

  it("is inactive for a negative maxAgeMs even at the report instant", async () => {
    const mod = await loadPresence();
    mod.setOverlayAppPresence("companion");
    expect(mod.isOverlayAppPresenceActive("companion", -1)).toBe(false);
  });

  it("refreshes lastReportAt on a later heartbeat of the same name", async () => {
    vi.useFakeTimers();
    const mod = await loadPresence();
    mod.setOverlayAppPresence("companion");
    vi.advanceTimersByTime(mod.OVERLAY_APP_PRESENCE_TTL_MS + 1);
    expect(mod.isOverlayAppPresenceActive("companion")).toBe(false);
    mod.setOverlayAppPresence("companion");
    expect(mod.isOverlayAppPresenceActive("companion")).toBe(true);
  });
});
