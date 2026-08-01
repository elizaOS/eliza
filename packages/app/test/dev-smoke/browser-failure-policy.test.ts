/**
 * Focused tests for the dev-smoke browser failure policy:
 * positive/negative coverage for every exported classifier and the
 * ExpectedDevSmokeFailureMatcher state machine.
 */
import { describe, expect, it } from "vitest";
import {
  ExpectedDevSmokeFailureMatcher,
  isExpectedDevSmokeConsoleError,
  isExpectedDevSmokeResponse,
  isLifeOpsActivitySignals503,
} from "./browser-failure-policy";

const LIFEOPS_PATH = "/api/lifeops/activity-signals";
const INACTIVE_BODY = JSON.stringify({
  error:
    "LifeOps activity signals are unavailable because the personal-assistant runtime is not active",
});
const CHROME_CONSOLE_503 =
  "Failed to load resource: the server responded with a status of 503 (Service Unavailable)";

// ---------------------------------------------------------------------------
// isLifeOpsActivitySignals503
// ---------------------------------------------------------------------------
describe("isLifeOpsActivitySignals503", () => {
  it("matches 503 on the exact activity-signals path", () => {
    expect(
      isLifeOpsActivitySignals503(503, `http://localhost${LIFEOPS_PATH}`),
    ).toBe(true);
  });

  it("rejects non-503 status on the same path", () => {
    expect(
      isLifeOpsActivitySignals503(500, `http://localhost${LIFEOPS_PATH}`),
    ).toBe(false);
  });

  it("rejects 503 on a different path", () => {
    expect(
      isLifeOpsActivitySignals503(503, "http://localhost/api/other"),
    ).toBe(false);
  });

  it("rejects 503 on a path that merely contains the suffix", () => {
    expect(
      isLifeOpsActivitySignals503(
        503,
        "http://localhost/api/lifeops/activity-signals-extra",
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isExpectedDevSmokeResponse
// ---------------------------------------------------------------------------
describe("isExpectedDevSmokeResponse", () => {
  it("matches the canonical inactive 503 body", () => {
    expect(
      isExpectedDevSmokeResponse(503, `http://localhost${LIFEOPS_PATH}`, INACTIVE_BODY),
    ).toBe(true);
  });

  it("rejects a body with an extra key", () => {
    const body = JSON.stringify({ error: "unavailable", retry: true });
    expect(
      isExpectedDevSmokeResponse(503, `http://localhost${LIFEOPS_PATH}`, body),
    ).toBe(false);
  });

  it("rejects a body with the wrong error message", () => {
    const body = JSON.stringify({ error: "something else" });
    expect(
      isExpectedDevSmokeResponse(503, `http://localhost${LIFEOPS_PATH}`, body),
    ).toBe(false);
  });

  it("rejects non-JSON body", () => {
    expect(
      isExpectedDevSmokeResponse(503, `http://localhost${LIFEOPS_PATH}`, "not json"),
    ).toBe(false);
  });

  it("rejects non-503 status even with correct body", () => {
    expect(
      isExpectedDevSmokeResponse(500, `http://localhost${LIFEOPS_PATH}`, INACTIVE_BODY),
    ).toBe(false);
  });

  it("rejects correct body on wrong path", () => {
    expect(
      isExpectedDevSmokeResponse(503, "http://localhost/api/other", INACTIVE_BODY),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isExpectedDevSmokeConsoleError
// ---------------------------------------------------------------------------
describe("isExpectedDevSmokeConsoleError", () => {
  it("matches the Chromium 503 console error for the activity-signals path", () => {
    expect(
      isExpectedDevSmokeConsoleError(CHROME_CONSOLE_503, `http://localhost${LIFEOPS_PATH}`),
    ).toBe(true);
  });

  it("rejects a different error text on the same path", () => {
    expect(
      isExpectedDevSmokeConsoleError("Some other error", `http://localhost${LIFEOPS_PATH}`),
    ).toBe(false);
  });

  it("rejects the correct text on a different path", () => {
    expect(
      isExpectedDevSmokeConsoleError(CHROME_CONSOLE_503, "http://localhost/api/other"),
    ).toBe(false);
  });

  it("rejects 501 console error on the activity-signals path", () => {
    const text = "Failed to load resource: the server responded with a status of 501 (Not Implemented)";
    expect(
      isExpectedDevSmokeConsoleError(text, `http://localhost${LIFEOPS_PATH}`),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ExpectedDevSmokeFailureMatcher
// ---------------------------------------------------------------------------
describe("ExpectedDevSmokeFailureMatcher", () => {
  it("records a matching response and consumes the console error", () => {
    const matcher = new ExpectedDevSmokeFailureMatcher();
    expect(
      matcher.recordResponse(503, `http://localhost${LIFEOPS_PATH}`, INACTIVE_BODY),
    ).toBe(true);
    expect(
      matcher.consumeConsoleError(CHROME_CONSOLE_503, `http://localhost${LIFEOPS_PATH}`),
    ).toBe(true);
  });

  it("rejects a console error when no response was recorded", () => {
    const matcher = new ExpectedDevSmokeFailureMatcher();
    expect(
      matcher.consumeConsoleError(CHROME_CONSOLE_503, `http://localhost${LIFEOPS_PATH}`),
    ).toBe(false);
  });

  it("rejects a second console error after the first is consumed", () => {
    const matcher = new ExpectedDevSmokeFailureMatcher();
    matcher.recordResponse(503, `http://localhost${LIFEOPS_PATH}`, INACTIVE_BODY);
    expect(
      matcher.consumeConsoleError(CHROME_CONSOLE_503, `http://localhost${LIFEOPS_PATH}`),
    ).toBe(true);
    expect(
      matcher.consumeConsoleError(CHROME_CONSOLE_503, `http://localhost${LIFEOPS_PATH}`),
    ).toBe(false);
  });

  it("tracks multiple independent responses", () => {
    const matcher = new ExpectedDevSmokeFailureMatcher();
    matcher.recordResponse(503, `http://localhost${LIFEOPS_PATH}`, INACTIVE_BODY);
    matcher.recordResponse(503, `http://localhost${LIFEOPS_PATH}`, INACTIVE_BODY);
    expect(
      matcher.consumeConsoleError(CHROME_CONSOLE_503, `http://localhost${LIFEOPS_PATH}`),
    ).toBe(true);
    expect(
      matcher.consumeConsoleError(CHROME_CONSOLE_503, `http://localhost${LIFEOPS_PATH}`),
    ).toBe(true);
    expect(
      matcher.consumeConsoleError(CHROME_CONSOLE_503, `http://localhost${LIFEOPS_PATH}`),
    ).toBe(false);
  });

  it("rejects a non-matching response", () => {
    const matcher = new ExpectedDevSmokeFailureMatcher();
    expect(
      matcher.recordResponse(500, `http://localhost${LIFEOPS_PATH}`, "error"),
    ).toBe(false);
  });

  it("rejects a matching response on a different path", () => {
    const matcher = new ExpectedDevSmokeFailureMatcher();
    expect(
      matcher.recordResponse(503, "http://localhost/api/other", INACTIVE_BODY),
    ).toBe(false);
  });
});
