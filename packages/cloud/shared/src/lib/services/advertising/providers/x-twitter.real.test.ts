import { describe, expect, test } from "bun:test";
import { xTwitterAdsProvider } from "./x-twitter";

const hasCredentials = Boolean(
  process.env.X_ADS_CONSUMER_KEY &&
    process.env.X_ADS_CONSUMER_SECRET &&
    process.env.X_ADS_ACCESS_TOKEN &&
    process.env.X_ADS_ACCESS_TOKEN_SECRET,
);

describe("xTwitterAdsProvider live credentials", () => {
  (hasCredentials ? test : test.skip)(
    "discovers live X Ads accounts with OAuth 1.0a credentials",
    async () => {
      const accounts = await xTwitterAdsProvider.listAdAccounts({
        accessToken: process.env.X_ADS_ACCESS_TOKEN as string,
        refreshToken: process.env.X_ADS_ACCESS_TOKEN_SECRET as string,
      });

      expect(accounts.length).toBeGreaterThan(0);
      expect(accounts[0]?.id).toBeTruthy();
    },
  );
});
