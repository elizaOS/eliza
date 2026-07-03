import { describe, expect, test } from "bun:test";
import { logger } from "../../../utils/logger";
import { linkedinAdsProvider } from "./linkedin";

const hasCredentials = Boolean(process.env.LINKEDIN_ADS_ACCESS_TOKEN);

if (!hasCredentials) {
  logger.warn(
    "[LinkedInAdsRealTest] SKIPPED: set LINKEDIN_ADS_ACCESS_TOKEN (rw_ads scope) to run the live LinkedIn Marketing API lane",
  );
}

describe("linkedinAdsProvider live credentials", () => {
  (hasCredentials ? test : test.skip)(
    "discovers live LinkedIn ad accounts with an OAuth2 access token",
    async () => {
      const accounts = await linkedinAdsProvider.listAdAccounts({
        accessToken: process.env.LINKEDIN_ADS_ACCESS_TOKEN as string,
      });

      expect(accounts.length).toBeGreaterThan(0);
      expect(accounts[0]?.id).toMatch(/^\d+$/);
    },
  );

  (hasCredentials && process.env.LINKEDIN_ADS_ACCOUNT_ID ? test : test.skip)(
    "reads live campaign analytics for the configured ad account",
    async () => {
      const validation = await linkedinAdsProvider.validateCredentials({
        accessToken: process.env.LINKEDIN_ADS_ACCESS_TOKEN as string,
      });
      expect(validation.valid).toBe(true);
    },
  );
});
