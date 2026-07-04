// Exercises programmatic dsp.real behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "vitest";
import { programmaticDspProvider } from "./programmatic-dsp";

// Post-merge live lane. Skips visibly unless the operator provisions DSP
// credentials + endpoint. A generic OpenRTB DSP has no shared public sandbox,
// so the live target is whatever endpoint the operator points us at.
const liveEnabled = process.env.PROGRAMMATIC_DSP_LIVE_TEST === "1";

describe("programmaticDspProvider live", () => {
  test.skipIf(!liveEnabled)(
    "lists real DSP advertiser accounts against the configured OpenRTB endpoint",
    async () => {
      const accessToken = process.env.PROGRAMMATIC_DSP_ACCESS_TOKEN;
      if (!process.env.PROGRAMMATIC_DSP_ENDPOINT) {
        throw new Error(
          "PROGRAMMATIC_DSP_LIVE_TEST=1 requires PROGRAMMATIC_DSP_ENDPOINT for live provider verification",
        );
      }
      if (!accessToken) {
        throw new Error(
          "PROGRAMMATIC_DSP_LIVE_TEST=1 requires PROGRAMMATIC_DSP_ACCESS_TOKEN for live provider verification",
        );
      }

      const accounts = await programmaticDspProvider.listAdAccounts({ accessToken });

      expect(Array.isArray(accounts)).toBe(true);
      expect(accounts.length).toBeGreaterThan(0);
      expect(accounts[0]?.id).toMatch(/\S/);
      expect(accounts[0]?.name).toMatch(/\S/);
    },
  );

  test.skipIf(liveEnabled)(
    "skips live DSP verification unless PROGRAMMATIC_DSP_LIVE_TEST=1",
    () => {
      expect(process.env.PROGRAMMATIC_DSP_LIVE_TEST).not.toBe("1");
    },
  );
});
