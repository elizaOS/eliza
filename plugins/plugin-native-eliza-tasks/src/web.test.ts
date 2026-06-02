import { describe, expect, it } from "vitest";

import { ElizaTasksWeb } from "./web";

describe("ElizaTasksWeb fallback", () => {
  it("reports the browser as unsupported without throwing", async () => {
    await expect(new ElizaTasksWeb().getStatus()).resolves.toEqual({
      supported: false,
      platform: "web",
      refreshScheduled: false,
      processingScheduled: false,
      lastWakeFiredAtMs: null,
      lastWakeKind: null,
      reason: "BGTaskScheduler is iOS-only; web has no background wake path.",
    });
  });

  it.each([
    undefined,
    {},
    { earliestBeginSec: Number.NaN, alsoProcessing: true },
    { earliestBeginSec: Number.POSITIVE_INFINITY, alsoProcessing: true },
    { earliestBeginSec: -1, alsoProcessing: true },
  ])("ignores schedule options on web %#", async (options) => {
    await expect(new ElizaTasksWeb().scheduleNext(options)).resolves.toEqual({
      scheduled: false,
      identifier: "ai.eliza.tasks.refresh",
      earliestBeginAtMs: null,
      reason: "BGTaskScheduler is iOS-only; web has no background wake path.",
    });
  });

  it("cancelAll is a no-op on web", async () => {
    await expect(new ElizaTasksWeb().cancelAll()).resolves.toEqual({
      cancelled: false,
    });
  });
});
