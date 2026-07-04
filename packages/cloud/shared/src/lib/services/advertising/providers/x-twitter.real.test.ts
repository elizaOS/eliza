// Exercises x twitter.real behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import { xTwitterAdsProvider } from "./x-twitter";

const runLive = process.env.X_ADS_LIVE_TEST === "1";

describe("xTwitterAdsProvider live credentials", () => {
  test.skipIf(!runLive)("discovers live X Ads accounts when X_ADS_LIVE_TEST=1", async () => {
    const missing = [
      "X_ADS_CONSUMER_KEY",
      "X_ADS_CONSUMER_SECRET",
      "X_ADS_ACCESS_TOKEN",
      "X_ADS_ACCESS_TOKEN_SECRET",
    ].filter((key) => !process.env[key]);
    if (missing.length > 0) {
      throw new Error(`Missing X Ads live test credentials: ${missing.join(", ")}`);
    }

    const accounts = await xTwitterAdsProvider.listAdAccounts({
      accessToken: process.env.X_ADS_ACCESS_TOKEN as string,
      refreshToken: process.env.X_ADS_ACCESS_TOKEN_SECRET as string,
    });

    expect(accounts.length).toBeGreaterThan(0);
    expect(accounts[0]?.id).toBeTruthy();
  });
});
