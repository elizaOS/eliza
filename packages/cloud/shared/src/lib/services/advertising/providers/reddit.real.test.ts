import { describe, expect, test } from "bun:test";
import { redditAdsProvider } from "./reddit";

const runLive = process.env.REDDIT_ADS_LIVE_TEST === "1";
const accessToken = process.env.REDDIT_ADS_ACCESS_TOKEN;

describe("redditAdsProvider live", () => {
  test.skipIf(!runLive)(
    "discovers live Reddit Ads accounts when REDDIT_ADS_LIVE_TEST=1",
    async () => {
      if (!accessToken) {
        throw new Error("REDDIT_ADS_ACCESS_TOKEN is required when REDDIT_ADS_LIVE_TEST=1");
      }

      const validation = await redditAdsProvider.validateCredentials({
        accessToken,
      });
      expect(validation).toMatchObject({ valid: true });
      expect(validation.accountId).toBeTruthy();
      expect(validation.accountName).toBeTruthy();

      const accounts = await redditAdsProvider.listAdAccounts({ accessToken });
      expect(accounts.length).toBeGreaterThan(0);
      expect(accounts[0]).toEqual({
        id: validation.accountId,
        name: validation.accountName,
      });
    },
  );
});
