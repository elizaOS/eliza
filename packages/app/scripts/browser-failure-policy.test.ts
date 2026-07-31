/**
 * Unit coverage for the live development smoke's narrow optional-capability
 * failure policy. Keeping this outside Playwright's test directory prevents
 * its Vitest API from being collected as a browser specification.
 */

import { describe, expect, it } from "vitest";
import {
  isExpectedDevSmokeConsoleError,
  isExpectedDevSmokeResponse,
} from "../test/dev-smoke/browser-failure-policy";

describe("development smoke browser failure policy", () => {
  it("accepts only the inactive LifeOps activity-signal response", () => {
    expect(
      isExpectedDevSmokeResponse(
        503,
        "http://127.0.0.1:2138/api/lifeops/activity-signals",
      ),
    ).toBe(true);
    expect(
      isExpectedDevSmokeResponse(
        503,
        "http://127.0.0.1:2138/api/lifeops/activity-signals?probe=1",
      ),
    ).toBe(true);
    expect(
      isExpectedDevSmokeResponse(
        500,
        "http://127.0.0.1:2138/api/lifeops/activity-signals",
      ),
    ).toBe(false);
    expect(
      isExpectedDevSmokeResponse(503, "http://127.0.0.1:2138/api/status"),
    ).toBe(false);
  });

  it("uses Chromium's console location to avoid hiding unrelated 503s", () => {
    const resourceError =
      "Failed to load resource: the server responded with a status of 503 (Service Unavailable)";

    expect(
      isExpectedDevSmokeConsoleError(
        resourceError,
        "http://127.0.0.1:2138/api/lifeops/activity-signals",
      ),
    ).toBe(true);
    expect(
      isExpectedDevSmokeConsoleError(
        resourceError,
        "http://127.0.0.1:2138/api/status",
      ),
    ).toBe(false);
    expect(isExpectedDevSmokeConsoleError(resourceError, "")).toBe(false);
    expect(
      isExpectedDevSmokeConsoleError(
        "Application failed with 503",
        "http://127.0.0.1:2138/api/lifeops/activity-signals",
      ),
    ).toBe(false);
  });
});
