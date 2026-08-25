import * as blockerEngine from "@elizaos/plugin-blocker/services/app-blocker/index";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appBlockerContribution } from "./app-blocker-contribution";

beforeEach(() => {
  vi.spyOn(blockerEngine, "getAppBlockerStatus").mockResolvedValue({
    available: true,
    permissionStatus: "granted",
    active: false,
    blockedCount: 0,
    endsAt: null,
    reason: null,
  });
  vi.spyOn(blockerEngine, "startAppBlock").mockResolvedValue({ success: true });
  vi.spyOn(blockerEngine, "stopAppBlock").mockResolvedValue({ success: true });
});

describe("appBlockerContribution.verifyAvailable", () => {
  it("reports denied with the engine reason when unavailable", async () => {
    vi.mocked(blockerEngine.getAppBlockerStatus).mockResolvedValue({
      available: false,
      permissionStatus: "denied",
      active: false,
      blockedCount: 0,
      endsAt: null,
      reason: "Family Controls not configured",
    });
    await expect(appBlockerContribution.verifyAvailable()).resolves.toEqual({
      available: false,
      reason: "Family Controls not configured",
      permission: "denied",
    });
  });

  it("falls back to a default message when unavailable without a reason", async () => {
    vi.mocked(blockerEngine.getAppBlockerStatus).mockResolvedValue({
      available: false,
      permissionStatus: "denied",
      active: false,
      blockedCount: 0,
      endsAt: null,
      reason: null,
    });
    const result = await appBlockerContribution.verifyAvailable();
    expect(result.available).toBe(false);
    expect(result.permission).toBe("denied");
    expect(result.reason).toMatch(/not available/i);
  });

  it("maps a granted permission status through", async () => {
    await expect(appBlockerContribution.verifyAvailable()).resolves.toEqual({
      available: true,
      reason: null,
      permission: "granted",
    });
  });

  it("maps a denied permission status through", async () => {
    vi.mocked(blockerEngine.getAppBlockerStatus).mockResolvedValue({
      available: true,
      permissionStatus: "denied",
      active: false,
      blockedCount: 0,
      endsAt: null,
      reason: null,
    });
    await expect(appBlockerContribution.verifyAvailable()).resolves.toEqual({
      available: true,
      reason: null,
      permission: "denied",
    });
  });

  it("treats unknown permission statuses as prompt", async () => {
    vi.mocked(blockerEngine.getAppBlockerStatus).mockResolvedValue({
      available: true,
      permissionStatus: "notDetermined",
      active: false,
      blockedCount: 0,
      endsAt: null,
      reason: null,
    });
    await expect(appBlockerContribution.verifyAvailable()).resolves.toEqual({
      available: true,
      reason: null,
      permission: "prompt",
    });
  });
});

describe("appBlockerContribution.start", () => {
  it("delegates to the engine with the request options", async () => {
    const request = { appIds: ["com.example.game"], durationMs: 3600000 };
    await appBlockerContribution.start(request as never);
    expect(blockerEngine.startAppBlock).toHaveBeenCalledWith(request);
  });
});

describe("appBlockerContribution.stop", () => {
  it("resolves when the engine reports success", async () => {
    await expect(appBlockerContribution.stop()).resolves.toBeUndefined();
  });

  it("throws when the engine reports failure", async () => {
    vi.mocked(blockerEngine.stopAppBlock).mockResolvedValue({
      success: false,
      error: "Cannot remove block",
    });
    await expect(appBlockerContribution.stop()).rejects.toThrow(
      "Cannot remove block",
    );
  });

  it("throws a fallback message when failure carries no error text", async () => {
    vi.mocked(blockerEngine.stopAppBlock).mockResolvedValue({
      success: false,
      error: undefined,
    });
    await expect(appBlockerContribution.stop()).rejects.toThrow(
      /Failed to remove app block/,
    );
  });
});

describe("appBlockerContribution.status", () => {
  it("reports inactive with the engine reason when unavailable", async () => {
    vi.mocked(blockerEngine.getAppBlockerStatus).mockResolvedValue({
      available: false,
      permissionStatus: "denied",
      active: false,
      blockedCount: 0,
      endsAt: null,
      reason: "Usage Access not granted",
    });
    await expect(appBlockerContribution.status()).resolves.toEqual({
      active: false,
      endsAt: null,
      text: "Usage Access not granted",
    });
  });

  it("reports inactive when no block is active", async () => {
    await expect(appBlockerContribution.status()).resolves.toEqual({
      active: false,
      endsAt: null,
      text: "No app block is active right now.",
    });
  });

  it("reports a single blocked app with singular phrasing", async () => {
    vi.mocked(blockerEngine.getAppBlockerStatus).mockResolvedValue({
      available: true,
      permissionStatus: "granted",
      active: true,
      blockedCount: 1,
      endsAt: "2026-08-25T13:00:00Z",
      reason: null,
    });
    const result = await appBlockerContribution.status();
    expect(result.active).toBe(true);
    expect(result.endsAt).toBe("2026-08-25T13:00:00Z");
    expect(result.text).toContain("1 app");
    expect(result.text).toContain("until 2026-08-25T13:00:00Z");
  });

  it("reports multiple blocked apps with plural phrasing", async () => {
    vi.mocked(blockerEngine.getAppBlockerStatus).mockResolvedValue({
      available: true,
      permissionStatus: "granted",
      active: true,
      blockedCount: 3,
      endsAt: null,
      reason: null,
    });
    const result = await appBlockerContribution.status();
    expect(result.active).toBe(true);
    expect(result.text).toContain("3 apps");
    expect(result.text).toContain("until you remove it");
  });
});
