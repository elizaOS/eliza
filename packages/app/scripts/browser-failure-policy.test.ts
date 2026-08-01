/**
 * Unit coverage for the live development smoke's narrow optional-capability
 * failure policy. Keeping this outside Playwright's test directory prevents
 * its Vitest API from being collected as a browser specification.
 */

import { describe, expect, it } from "vitest";
import {
  ExpectedDevSmokeFailureMatcher,
  isExpectedDevSmokeConsoleError,
  isExpectedDevSmokeResponse,
  isLifeOpsActivitySignals503,
} from "../test/dev-smoke/browser-failure-policy";

const INACTIVE_BODY = JSON.stringify({
  error:
    "LifeOps activity signals are unavailable because the personal-assistant runtime is not active",
});

describe("development smoke browser failure policy", () => {
  it("accepts only the inactive LifeOps activity-signal response", () => {
    const endpoint = "http://127.0.0.1:2138/api/lifeops/activity-signals";
    expect(isExpectedDevSmokeResponse(503, endpoint, INACTIVE_BODY)).toBe(true);
    expect(
      isExpectedDevSmokeResponse(503, `${endpoint}?probe=1`, INACTIVE_BODY),
    ).toBe(true);
    expect(isExpectedDevSmokeResponse(500, endpoint, INACTIVE_BODY)).toBe(
      false,
    );
    expect(
      isExpectedDevSmokeResponse(
        503,
        "http://127.0.0.1:2138/api/status",
        INACTIVE_BODY,
      ),
    ).toBe(false);
  });

  it("keeps same-route runtime and malformed failures fatal", () => {
    const endpoint = "http://127.0.0.1:2138/api/lifeops/activity-signals";
    expect(isLifeOpsActivitySignals503(503, endpoint)).toBe(true);
    expect(
      isExpectedDevSmokeResponse(
        503,
        endpoint,
        JSON.stringify({ error: "Agent runtime is not available" }),
      ),
    ).toBe(false);
    expect(isExpectedDevSmokeResponse(503, endpoint, "not-json")).toBe(false);
    expect(
      isExpectedDevSmokeResponse(
        503,
        endpoint,
        JSON.stringify({
          error:
            "LifeOps activity signals are unavailable because the personal-assistant runtime is not active",
          hiddenFailure: true,
        }),
      ),
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
    expect(
      isExpectedDevSmokeConsoleError(
        `${resourceError} while loading another resource`,
        "http://127.0.0.1:2138/api/lifeops/activity-signals",
      ),
    ).toBe(false);
  });

  it("pairs console noise one-for-one with a verified inactive response", () => {
    const endpoint = "http://127.0.0.1:2138/api/lifeops/activity-signals";
    const resourceError =
      "Failed to load resource: the server responded with a status of 503 (Service Unavailable)";
    const matcher = new ExpectedDevSmokeFailureMatcher();

    expect(matcher.consumeConsoleError(resourceError, endpoint)).toBe(false);
    expect(matcher.recordResponse(503, endpoint, INACTIVE_BODY)).toBe(true);
    expect(matcher.consumeConsoleError(resourceError, endpoint)).toBe(true);
    expect(matcher.consumeConsoleError(resourceError, endpoint)).toBe(false);

    expect(
      matcher.recordResponse(
        503,
        endpoint,
        JSON.stringify({ error: "Agent runtime is not available" }),
      ),
    ).toBe(false);
    expect(matcher.consumeConsoleError(resourceError, endpoint)).toBe(false);
  });
});
