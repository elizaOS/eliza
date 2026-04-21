import { describe, expect, it } from "vitest";
import { MobileSignalsWeb } from "./web.js";

describe("MobileSignalsWeb Screen Time status", () => {
  it("reports Screen Time as unavailable without fabricating usage data", async () => {
    const plugin = new MobileSignalsWeb();

    const permissions = await plugin.checkPermissions();
    expect(permissions.screenTime).toEqual({
      supported: false,
      entitlements: {
        familyControls: false,
        appAndWebsiteUsage: false,
      },
      authorization: {
        status: "unavailable",
        canRequest: false,
      },
      reportAvailable: false,
      coarseSummaryAvailable: false,
      thresholdEventsAvailable: false,
      rawUsageExportAvailable: false,
      reason: "Web fallback has no Family Controls or DeviceActivity access.",
    });

    const snapshot = await plugin.getSnapshot();
    expect(snapshot.healthSnapshot?.screenTime).toEqual(permissions.screenTime);
  });
});
