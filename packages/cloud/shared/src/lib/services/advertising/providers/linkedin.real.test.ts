import { describe, expect, test } from "vitest";
import { linkedinAdsProvider } from "./linkedin";

const liveEnabled = process.env.LINKEDIN_ADS_LIVE_TEST === "1";

describe("linkedinAdsProvider live", () => {
  test.skipIf(!liveEnabled)(
    "lists real LinkedIn ad accounts with a live Marketing API token",
    async () => {
      const accessToken = process.env.LINKEDIN_ADS_ACCESS_TOKEN;
      if (!accessToken) {
        throw new Error(
          "LINKEDIN_ADS_LIVE_TEST=1 requires LINKEDIN_ADS_ACCESS_TOKEN for live provider verification",
        );
      }

      const accounts = await linkedinAdsProvider.listAdAccounts({ accessToken });

      expect(Array.isArray(accounts)).toBe(true);
      expect(accounts.length).toBeGreaterThan(0);
      expect(accounts[0]?.id).toMatch(/\S/);
      expect(accounts[0]?.name).toMatch(/\S/);
    },
  );

  test.skipIf(liveEnabled)(
    "skips live LinkedIn Marketing API verification unless LINKEDIN_ADS_LIVE_TEST=1",
    () => {
      expect(process.env.LINKEDIN_ADS_LIVE_TEST).not.toBe("1");
    },
  );
});
