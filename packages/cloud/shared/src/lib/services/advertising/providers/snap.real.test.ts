import { describe, expect, test } from "vitest";
import { snapAdsProvider } from "./snap";

const liveEnabled = process.env.SNAP_ADS_LIVE_TEST === "1";

describe("snapAdsProvider live", () => {
  test.skipIf(!liveEnabled)(
    "lists real Snap ad accounts with a live Marketing API token",
    async () => {
      const accessToken = process.env.SNAP_ADS_ACCESS_TOKEN;
      if (!accessToken) {
        throw new Error(
          "SNAP_ADS_LIVE_TEST=1 requires SNAP_ADS_ACCESS_TOKEN for live provider verification",
        );
      }

      const accounts = await snapAdsProvider.listAdAccounts({ accessToken });

      expect(Array.isArray(accounts)).toBe(true);
      expect(accounts.length).toBeGreaterThan(0);
      expect(accounts[0]?.id).toMatch(/\S/);
      expect(accounts[0]?.name).toMatch(/\S/);
    },
  );

  test.skipIf(liveEnabled)(
    "skips live Snap Marketing API verification unless SNAP_ADS_LIVE_TEST=1",
    () => {
      expect(process.env.SNAP_ADS_LIVE_TEST).not.toBe("1");
    },
  );
});
