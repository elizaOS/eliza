/**
 * Coverage for the startup embedding warmup snapshot: progress-percentage
 * parsing, phase transitions, staleness expiry, and the ready-state reset.
 * Module state is reset via vi.resetModules + dynamic import.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type StartupOverlayModule = {
  parseEmbeddingProgressPercent: (
    detail: string | undefined,
  ) => number | undefined;
  getStartupEmbeddingAugmentation: () => Record<string, unknown> | null;
  updateStartupEmbeddingProgress: (
    phase: "checking" | "downloading" | "loading" | "ready",
    detail?: string,
  ) => void;
};

async function loadOverlay(): Promise<StartupOverlayModule> {
  vi.resetModules();
  return import("./startup-overlay.ts");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("parseEmbeddingProgressPercent", () => {
  it("extracts a plain percentage", async () => {
    const mod = await loadOverlay();
    expect(mod.parseEmbeddingProgressPercent("45% of 95 MB")).toBe(45);
  });

  it("handles decimal percentages by rounding", async () => {
    const mod = await loadOverlay();
    expect(mod.parseEmbeddingProgressPercent("12.6% of 300 MB")).toBe(13);
  });

  it("clamps out-of-range values", async () => {
    const mod = await loadOverlay();
    expect(mod.parseEmbeddingProgressPercent("150% complete")).toBe(100);
    // The regex captures only digits, so a leading minus sign is not part of
    // the match; "5%" is parsed and clamped to 5.
    expect(mod.parseEmbeddingProgressPercent("-5% complete")).toBe(5);
  });

  it("returns undefined for missing or unparseable detail", async () => {
    const mod = await loadOverlay();
    expect(mod.parseEmbeddingProgressPercent(undefined)).toBeUndefined();
    expect(
      mod.parseEmbeddingProgressPercent("downloading chunks"),
    ).toBeUndefined();
  });
});

describe("getStartupEmbeddingAugmentation", () => {
  it("returns null before any update", async () => {
    const mod = await loadOverlay();
    expect(mod.getStartupEmbeddingAugmentation()).toBeNull();
  });

  it("reports phase and detail after an update", async () => {
    const mod = await loadOverlay();
    mod.updateStartupEmbeddingProgress("downloading", "45% of 95 MB");
    const out = mod.getStartupEmbeddingAugmentation();
    expect(out).not.toBeNull();
    expect(out?.embeddingPhase).toBe("downloading");
    expect(out?.embeddingDetail).toBe("45% of 95 MB");
    expect(out?.embeddingProgressPct).toBe(45);
  });

  it("omits the progress percentage when detail has none", async () => {
    const mod = await loadOverlay();
    mod.updateStartupEmbeddingProgress("checking");
    const out = mod.getStartupEmbeddingAugmentation();
    expect(out?.embeddingPhase).toBe("checking");
    expect(out?.embeddingProgressPct).toBeUndefined();
  });

  it("clears the snapshot when ready", async () => {
    const mod = await loadOverlay();
    mod.updateStartupEmbeddingProgress("downloading", "10% of 100 MB");
    mod.updateStartupEmbeddingProgress("ready");
    expect(mod.getStartupEmbeddingAugmentation()).toBeNull();
  });

  it("expires stale snapshots", async () => {
    vi.useFakeTimers();
    const mod = await loadOverlay();
    mod.updateStartupEmbeddingProgress("loading", "80% of 100 MB");
    expect(mod.getStartupEmbeddingAugmentation()).not.toBeNull();
    // STALE_MS is module-private (not exported); use its documented value.
    vi.advanceTimersByTime(120_000 + 1);
    expect(mod.getStartupEmbeddingAugmentation()).toBeNull();
  });
});
