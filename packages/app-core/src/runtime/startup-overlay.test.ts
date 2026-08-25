/**
 * Coverage for the startup embedding warmup snapshot: progress-percentage
 * parsing, phase transitions, last-write-wins, empty/unparseable detail,
 * staleness expiry (including the exact STALE_MS boundary), recovery after
 * ready/stale, and the ready-state reset. Module state is reset via
 * vi.resetModules + dynamic import. No mocks of the overlay itself.
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

  it("treats an empty string as missing detail", async () => {
    const mod = await loadOverlay();
    expect(mod.parseEmbeddingProgressPercent("")).toBeUndefined();
  });

  it("keeps 0% and 100% at the clamp bounds", async () => {
    const mod = await loadOverlay();
    expect(mod.parseEmbeddingProgressPercent("0%")).toBe(0);
    expect(mod.parseEmbeddingProgressPercent("100%")).toBe(100);
  });

  it("allows whitespace between the number and the percent sign", async () => {
    const mod = await loadOverlay();
    expect(mod.parseEmbeddingProgressPercent("45 % of 95 MB")).toBe(45);
  });

  it("uses the first percentage when several appear", async () => {
    const mod = await loadOverlay();
    expect(mod.parseEmbeddingProgressPercent("10% then 90%")).toBe(10);
  });

  it("rounds halves away from zero then clamps past 100", async () => {
    const mod = await loadOverlay();
    expect(mod.parseEmbeddingProgressPercent("0.4%")).toBe(0);
    expect(mod.parseEmbeddingProgressPercent("0.5%")).toBe(1);
    // 100.5 rounds to 101, then min(100, 101) clamps it.
    expect(mod.parseEmbeddingProgressPercent("100.5%")).toBe(100);
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

  it("keeps a snapshot at exactly STALE_MS and expires one millisecond later", async () => {
    vi.useFakeTimers();
    const mod = await loadOverlay();
    mod.updateStartupEmbeddingProgress("loading", "80% of 100 MB");
    vi.advanceTimersByTime(120_000);
    expect(mod.getStartupEmbeddingAugmentation()).toEqual({
      embeddingPhase: "loading",
      embeddingDetail: "80% of 100 MB",
      embeddingProgressPct: 80,
    });
    vi.advanceTimersByTime(1);
    expect(mod.getStartupEmbeddingAugmentation()).toBeNull();
  });

  it("returns only embeddingPhase when detail is omitted", async () => {
    const mod = await loadOverlay();
    mod.updateStartupEmbeddingProgress("checking");
    expect(mod.getStartupEmbeddingAugmentation()).toEqual({
      embeddingPhase: "checking",
    });
  });

  it("omits embeddingDetail when the detail string is empty", async () => {
    const mod = await loadOverlay();
    mod.updateStartupEmbeddingProgress("downloading", "");
    expect(mod.getStartupEmbeddingAugmentation()).toEqual({
      embeddingPhase: "downloading",
    });
  });

  it("keeps unparseable detail without a progress percentage", async () => {
    const mod = await loadOverlay();
    mod.updateStartupEmbeddingProgress("loading", "fetching shards");
    expect(mod.getStartupEmbeddingAugmentation()).toEqual({
      embeddingPhase: "loading",
      embeddingDetail: "fetching shards",
    });
  });

  it("lets a later update replace phase, detail, and percent", async () => {
    const mod = await loadOverlay();
    mod.updateStartupEmbeddingProgress("checking");
    mod.updateStartupEmbeddingProgress("downloading", "12% of 40 MB");
    mod.updateStartupEmbeddingProgress("loading", "88% of 40 MB");
    expect(mod.getStartupEmbeddingAugmentation()).toEqual({
      embeddingPhase: "loading",
      embeddingDetail: "88% of 40 MB",
      embeddingProgressPct: 88,
    });
  });

  it("still clears when ready is recorded with leftover detail", async () => {
    const mod = await loadOverlay();
    mod.updateStartupEmbeddingProgress("loading", "99% of 40 MB");
    mod.updateStartupEmbeddingProgress("ready", "loaded nomic-embed");
    expect(mod.getStartupEmbeddingAugmentation()).toBeNull();
  });

  it("exposes a later phase after ready cleared the snapshot", async () => {
    const mod = await loadOverlay();
    mod.updateStartupEmbeddingProgress("downloading", "10% of 40 MB");
    mod.updateStartupEmbeddingProgress("ready");
    mod.updateStartupEmbeddingProgress("checking");
    expect(mod.getStartupEmbeddingAugmentation()).toEqual({
      embeddingPhase: "checking",
    });
  });

  it("does not clear a fresh snapshot on repeated reads", async () => {
    const mod = await loadOverlay();
    mod.updateStartupEmbeddingProgress("downloading", "45% of 95 MB");
    expect(mod.getStartupEmbeddingAugmentation()).toEqual({
      embeddingPhase: "downloading",
      embeddingDetail: "45% of 95 MB",
      embeddingProgressPct: 45,
    });
    expect(mod.getStartupEmbeddingAugmentation()).toEqual({
      embeddingPhase: "downloading",
      embeddingDetail: "45% of 95 MB",
      embeddingProgressPct: 45,
    });
  });

  it("accepts a fresh update after a stale read cleared the snapshot", async () => {
    vi.useFakeTimers();
    const mod = await loadOverlay();
    mod.updateStartupEmbeddingProgress("downloading", "10% of 40 MB");
    vi.advanceTimersByTime(120_000 + 1);
    expect(mod.getStartupEmbeddingAugmentation()).toBeNull();
    mod.updateStartupEmbeddingProgress("loading", "50% of 40 MB");
    expect(mod.getStartupEmbeddingAugmentation()).toEqual({
      embeddingPhase: "loading",
      embeddingDetail: "50% of 40 MB",
      embeddingProgressPct: 50,
    });
  });

  it("refreshes the stale clock when a later update arrives", async () => {
    vi.useFakeTimers();
    const mod = await loadOverlay();
    mod.updateStartupEmbeddingProgress("checking");
    vi.advanceTimersByTime(100_000);
    mod.updateStartupEmbeddingProgress("downloading", "20% of 40 MB");
    vi.advanceTimersByTime(50_000);
    expect(mod.getStartupEmbeddingAugmentation()).toEqual({
      embeddingPhase: "downloading",
      embeddingDetail: "20% of 40 MB",
      embeddingProgressPct: 20,
    });
  });
});
