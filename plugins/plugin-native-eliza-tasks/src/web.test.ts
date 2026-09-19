/** Exercises unsupported scheduling and cancellation through the real web bridge. */
import { expect, it } from "vitest";
import { ElizaTasksWeb } from "./web";

it("keeps background wakes unsupported after scheduling and cancellation", async () => {
  const plugin = new ElizaTasksWeb();
  await expect(
    plugin.scheduleNext({ earliestBeginSec: 900, alsoProcessing: true }),
  ).resolves.toMatchObject({ scheduled: false, earliestBeginAtMs: null });
  await expect(plugin.cancelAll()).resolves.toEqual({ cancelled: false });
  await expect(plugin.getStatus()).resolves.toMatchObject({
    supported: false,
    refreshScheduled: false,
    processingScheduled: false,
    lastWakeFiredAtMs: null,
    lastWakeKind: null,
  });
});
