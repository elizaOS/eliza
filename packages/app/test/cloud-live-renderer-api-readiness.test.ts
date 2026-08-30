/**
 * Covers the renderer/API readiness boundary with a deterministic clock so
 * transient defaults and persistent invalid builds remain distinguishable.
 */

import { describe, expect, it } from "vitest";
import { waitForRendererCloudApiOrigin } from "./cloud-live-renderer-api-readiness";

const STAGING_API_ORIGIN = "https://api-staging.eliza.app";

function deterministicClock() {
  let currentMs = 0;
  return {
    now: () => currentMs,
    sleep: async (durationMs: number) => {
      currentMs += durationMs;
    },
  };
}

describe("deployed renderer Cloud API readiness", () => {
  it("waits through the production default until staging boot config arrives", async () => {
    const values = ["https://eliza.app", "https://cloud-staging.eliza.app"];
    let reads = 0;
    const clock = deterministicClock();

    const result = await waitForRendererCloudApiOrigin({
      readCloudBase: async () => values[Math.min(reads++, values.length - 1)],
      expectedApiOrigin: STAGING_API_ORIGIN,
      timeoutMs: 10,
      pollIntervalMs: 1,
      ...clock,
    });

    expect(reads).toBe(2);
    expect(result).toEqual({
      cloudBase: "https://cloud-staging.eliza.app",
      apiOrigin: STAGING_API_ORIGIN,
    });
  });

  it("fails with the last base and origin when production persists", async () => {
    const clock = deterministicClock();

    await expect(
      waitForRendererCloudApiOrigin({
        readCloudBase: async () => "https://eliza.app",
        expectedApiOrigin: STAGING_API_ORIGIN,
        timeoutMs: 2,
        pollIntervalMs: 1,
        ...clock,
      }),
    ).rejects.toThrow(
      "last base https://eliza.app resolved to https://api.eliza.app; expected https://api-staging.eliza.app",
    );
  });

  it("fails with the malformed build value instead of defaulting", async () => {
    const clock = deterministicClock();

    await expect(
      waitForRendererCloudApiOrigin({
        readCloudBase: async () => "not a URL",
        expectedApiOrigin: STAGING_API_ORIGIN,
        timeoutMs: 1,
        pollIntervalMs: 1,
        ...clock,
      }),
    ).rejects.toThrow(
      "last base not a URL resolved to <unparseable: not a URL>; expected https://api-staging.eliza.app",
    );
  });
});
