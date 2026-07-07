/**
 * Exercises `AppBlockerWeb` directly (no mocked bridge) — its not-applicable
 * responses and `blockApps` input validation are plain fallback logic with
 * no native dependency to stub.
 */
import { describe, expect, it } from "vitest";

import { AppBlockerWeb } from "./web";

describe("AppBlockerWeb fallback", () => {
  it("reports app blocking as unavailable on web", async () => {
    const blocker = new AppBlockerWeb();

    await expect(blocker.checkPermissions()).resolves.toMatchObject({
      status: "not-applicable",
      engine: "none",
      canRequest: false,
    });
    await expect(blocker.getStatus()).resolves.toMatchObject({
      status: "unavailable",
      available: false,
      active: false,
      blockedCount: 0,
    });
    await expect(blocker.getInstalledApps()).resolves.toEqual({ apps: [] });
    await expect(blocker.selectApps()).resolves.toEqual({
      apps: [],
      cancelled: true,
    });
  });

  it.each([
    { packageNames: [""] },
    { packageNames: ["../settings"] },
    { packageNames: ["com..example"] },
    { packageNames: [{ name: "com.example.app" } as unknown as string] },
    { appTokens: ["valid", ""] },
    { appTokens: [42 as unknown as string] },
    { durationMinutes: 0 },
    { durationMinutes: Number.POSITIVE_INFINITY },
    { durationMinutes: Number.NaN },
  ])("rejects malformed blockApps options %#", async (options) => {
    await expect(new AppBlockerWeb().blockApps(options)).rejects.toThrow(
      /packageNames|appTokens|durationMinutes/,
    );
  });

  it("returns a mobile-only block response for valid web fallback options", async () => {
    await expect(
      new AppBlockerWeb().blockApps({
        packageNames: ["com.example.app"],
        appTokens: ["token-1"],
        durationMinutes: 30,
      }),
    ).resolves.toEqual({
      success: false,
      endsAt: null,
      error: "App blocking is only available on mobile devices.",
      blockedCount: 0,
    });
  });
});
