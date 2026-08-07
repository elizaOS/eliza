/**
 * Locks browser-audit optional-capability exceptions to exact response bodies
 * and matching Chromium console events. This Vitest suite stays outside
 * Playwright's dev-smoke directory so the browser runner cannot collect it as
 * an incompatible test module.
 */
import { describe, expect, it } from "vitest";
import {
  BROWSER_BRIDGE_COMPANIONS_PATH,
  BROWSER_BRIDGE_SERVICE_UNAVAILABLE_ERROR,
  browserResourceConsoleErrorStatus,
  ExpectedBrowserResponseConsoleMatcher,
  ExpectedDevSmokeFailureMatcher,
  isBrowserBridgeCompanions503,
  isExpectedDevSmokeConsoleError,
  isExpectedDevSmokeResponse,
  isExpectedDevSmokeResponseCandidate,
  isExpectedEmbeddedBrowserConsoleError,
  isExpectedUnavailableBrowserBridgeCompanionsResponse,
  isLifeOpsActivitySignals503,
} from "../test/dev-smoke/browser-failure-policy";

const LIFEOPS_PATH = "/api/lifeops/activity-signals";
const INACTIVE_BODY = JSON.stringify({
  error:
    "LifeOps activity signals are unavailable because the personal-assistant runtime is not active",
});
const BROWSER_BRIDGE_UNAVAILABLE_BODY = JSON.stringify({
  error: BROWSER_BRIDGE_SERVICE_UNAVAILABLE_ERROR,
});
const CHROME_CONSOLE_503 =
  "Failed to load resource: the server responded with a status of 503 (Service Unavailable)";

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
    expect(isLifeOpsActivitySignals503(503, "http://localhost/api/other")).toBe(
      false,
    );
  });

  it("rejects 503 on a path that merely contains the suffix", () => {
    expect(
      isLifeOpsActivitySignals503(
        503,
        "http://localhost/api/lifeops/activity-signals-extra",
      ),
    ).toBe(false);
  });

  it("matches the exact path when a query and fragment are present", () => {
    expect(
      isLifeOpsActivitySignals503(
        503,
        `http://localhost${LIFEOPS_PATH}?source=smoke#result`,
      ),
    ).toBe(true);
  });

  it("matches the relative URL shape accepted by browser event sources", () => {
    expect(isLifeOpsActivitySignals503(503, LIFEOPS_PATH)).toBe(true);
  });

  it("rejects a malformed URL instead of widening the exception", () => {
    expect(isLifeOpsActivitySignals503(503, "http://[")).toBe(false);
  });
});

describe("isExpectedDevSmokeResponse", () => {
  it("matches the canonical inactive 503 body", () => {
    expect(
      isExpectedDevSmokeResponse(
        503,
        `http://localhost${LIFEOPS_PATH}`,
        INACTIVE_BODY,
      ),
    ).toBe(true);
  });

  it("rejects a body with an extra key", () => {
    const body = JSON.stringify({ error: "unavailable", retry: true });
    expect(
      isExpectedDevSmokeResponse(503, `http://localhost${LIFEOPS_PATH}`, body),
    ).toBe(false);
  });

  it.each(["null", "[]", JSON.stringify({})])(
    "rejects the non-canonical JSON shape %s",
    (body) => {
      expect(
        isExpectedDevSmokeResponse(
          503,
          `http://localhost${LIFEOPS_PATH}`,
          body,
        ),
      ).toBe(false);
    },
  );

  it("rejects a body with the wrong error message", () => {
    const body = JSON.stringify({ error: "something else" });
    expect(
      isExpectedDevSmokeResponse(503, `http://localhost${LIFEOPS_PATH}`, body),
    ).toBe(false);
  });

  it("rejects non-JSON body", () => {
    expect(
      isExpectedDevSmokeResponse(
        503,
        `http://localhost${LIFEOPS_PATH}`,
        "not json",
      ),
    ).toBe(false);
  });

  it("rejects non-503 status even with correct body", () => {
    expect(
      isExpectedDevSmokeResponse(
        500,
        `http://localhost${LIFEOPS_PATH}`,
        INACTIVE_BODY,
      ),
    ).toBe(false);
  });

  it("rejects correct body on wrong path", () => {
    expect(
      isExpectedDevSmokeResponse(
        503,
        "http://localhost/api/other",
        INACTIVE_BODY,
      ),
    ).toBe(false);
  });
});

describe("Browser Bridge companion response policy", () => {
  it("matches only a 503 on the exact companion-inventory path", () => {
    expect(
      isBrowserBridgeCompanions503(
        503,
        `http://localhost${BROWSER_BRIDGE_COMPANIONS_PATH}`,
      ),
    ).toBe(true);
    expect(
      isBrowserBridgeCompanions503(
        500,
        `http://localhost${BROWSER_BRIDGE_COMPANIONS_PATH}`,
      ),
    ).toBe(false);
    expect(
      isBrowserBridgeCompanions503(
        503,
        "http://localhost/api/browser-bridge/settings",
      ),
    ).toBe(false);
  });

  it("matches the exact service-unavailable response", () => {
    expect(
      isExpectedUnavailableBrowserBridgeCompanionsResponse(
        503,
        `http://localhost${BROWSER_BRIDGE_COMPANIONS_PATH}`,
        BROWSER_BRIDGE_UNAVAILABLE_BODY,
      ),
    ).toBe(true);
    expect(
      isExpectedDevSmokeResponse(
        503,
        `http://localhost${BROWSER_BRIDGE_COMPANIONS_PATH}`,
        BROWSER_BRIDGE_UNAVAILABLE_BODY,
      ),
    ).toBe(true);
  });

  it.each([
    JSON.stringify({ error: "Agent runtime is not available" }),
    JSON.stringify({
      error: BROWSER_BRIDGE_SERVICE_UNAVAILABLE_ERROR,
      extra: 1,
    }),
    "not json",
  ])("rejects the non-canonical response body %s", (body) => {
    expect(
      isExpectedUnavailableBrowserBridgeCompanionsResponse(
        503,
        `http://localhost${BROWSER_BRIDGE_COMPANIONS_PATH}`,
        body,
      ),
    ).toBe(false);
  });

  it("identifies exact routes for body inspection without accepting a bodyless response", () => {
    const url = `http://localhost${BROWSER_BRIDGE_COMPANIONS_PATH}`;
    expect(isExpectedDevSmokeResponseCandidate(503, url)).toBe(true);
    expect(isExpectedDevSmokeResponse(503, url, undefined)).toBe(false);
    expect(isExpectedDevSmokeResponseCandidate(503, `${url}/extra`)).toBe(
      false,
    );
  });
});

describe("isExpectedDevSmokeConsoleError", () => {
  it("matches the Chromium 503 console error for the activity-signals path", () => {
    expect(
      isExpectedDevSmokeConsoleError(
        CHROME_CONSOLE_503,
        `http://localhost${LIFEOPS_PATH}`,
      ),
    ).toBe(true);
  });

  it.each([
    "Some other error",
    `${CHROME_CONSOLE_503} while loading another resource`,
  ])("rejects the non-canonical error text %s", (text) => {
    expect(
      isExpectedDevSmokeConsoleError(text, `http://localhost${LIFEOPS_PATH}`),
    ).toBe(false);
  });

  it("rejects the canonical text without a resource location", () => {
    expect(isExpectedDevSmokeConsoleError(CHROME_CONSOLE_503, "")).toBe(false);
  });

  it("rejects the correct text on a different path", () => {
    expect(
      isExpectedDevSmokeConsoleError(
        CHROME_CONSOLE_503,
        "http://localhost/api/other",
      ),
    ).toBe(false);
  });

  it("rejects 501 console error on the activity-signals path", () => {
    const text =
      "Failed to load resource: the server responded with a status of 501 (Not Implemented)";
    expect(
      isExpectedDevSmokeConsoleError(text, `http://localhost${LIFEOPS_PATH}`),
    ).toBe(false);
  });

  it("matches the canonical Chromium error on the companion-inventory path", () => {
    expect(
      isExpectedDevSmokeConsoleError(
        CHROME_CONSOLE_503,
        `http://localhost${BROWSER_BRIDGE_COMPANIONS_PATH}`,
      ),
    ).toBe(true);
  });
});

describe("ExpectedDevSmokeFailureMatcher", () => {
  it("records a matching response and consumes the console error", () => {
    const matcher = new ExpectedDevSmokeFailureMatcher();
    expect(
      matcher.recordResponse(
        503,
        `http://localhost${LIFEOPS_PATH}`,
        INACTIVE_BODY,
      ),
    ).toBe(true);
    expect(
      matcher.consumeConsoleError(
        CHROME_CONSOLE_503,
        `http://localhost${LIFEOPS_PATH}`,
      ),
    ).toBe(true);
  });

  it("rejects a console error when no response was recorded", () => {
    const matcher = new ExpectedDevSmokeFailureMatcher();
    expect(
      matcher.consumeConsoleError(
        CHROME_CONSOLE_503,
        `http://localhost${LIFEOPS_PATH}`,
      ),
    ).toBe(false);
  });

  it("rejects a second console error after the first is consumed", () => {
    const matcher = new ExpectedDevSmokeFailureMatcher();
    matcher.recordResponse(
      503,
      `http://localhost${LIFEOPS_PATH}`,
      INACTIVE_BODY,
    );
    expect(
      matcher.consumeConsoleError(
        CHROME_CONSOLE_503,
        `http://localhost${LIFEOPS_PATH}`,
      ),
    ).toBe(true);
    expect(
      matcher.consumeConsoleError(
        CHROME_CONSOLE_503,
        `http://localhost${LIFEOPS_PATH}`,
      ),
    ).toBe(false);
  });

  it("tracks multiple independent responses", () => {
    const matcher = new ExpectedDevSmokeFailureMatcher();
    matcher.recordResponse(
      503,
      `http://localhost${LIFEOPS_PATH}`,
      INACTIVE_BODY,
    );
    matcher.recordResponse(
      503,
      `http://localhost${LIFEOPS_PATH}`,
      INACTIVE_BODY,
    );
    expect(
      matcher.consumeConsoleError(
        CHROME_CONSOLE_503,
        `http://localhost${LIFEOPS_PATH}`,
      ),
    ).toBe(true);
    expect(
      matcher.consumeConsoleError(
        CHROME_CONSOLE_503,
        `http://localhost${LIFEOPS_PATH}`,
      ),
    ).toBe(true);
    expect(
      matcher.consumeConsoleError(
        CHROME_CONSOLE_503,
        `http://localhost${LIFEOPS_PATH}`,
      ),
    ).toBe(false);
  });

  it("does not correlate distinct request URLs that share the allowed path", () => {
    const matcher = new ExpectedDevSmokeFailureMatcher();
    matcher.recordResponse(
      503,
      `http://localhost${LIFEOPS_PATH}?request=one`,
      INACTIVE_BODY,
    );

    expect(
      matcher.consumeConsoleError(
        CHROME_CONSOLE_503,
        `http://localhost${LIFEOPS_PATH}?request=two`,
      ),
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

  it("correlates a Browser Bridge console error only after its exact response", () => {
    const matcher = new ExpectedDevSmokeFailureMatcher();
    const url = `http://localhost${BROWSER_BRIDGE_COMPANIONS_PATH}`;
    expect(
      matcher.recordResponse(503, url, BROWSER_BRIDGE_UNAVAILABLE_BODY),
    ).toBe(true);
    expect(matcher.consumeConsoleError(CHROME_CONSOLE_503, url)).toBe(true);
    expect(matcher.consumeConsoleError(CHROME_CONSOLE_503, url)).toBe(false);
  });

  it("does not let one optional route consume another route's console error", () => {
    const matcher = new ExpectedDevSmokeFailureMatcher();
    matcher.recordResponse(
      503,
      `http://localhost${LIFEOPS_PATH}`,
      INACTIVE_BODY,
    );
    expect(
      matcher.consumeConsoleError(
        CHROME_CONSOLE_503,
        `http://localhost${BROWSER_BRIDGE_COMPANIONS_PATH}`,
      ),
    ).toBe(false);
  });
});

describe("ExpectedBrowserResponseConsoleMatcher", () => {
  it("consumes one console line for one pre-classified response", () => {
    const matcher = new ExpectedBrowserResponseConsoleMatcher();
    const url = "http://localhost/api/meetings?active=1";
    const text =
      "Failed to load resource: the server responded with a status of 404 (Not Found)";
    expect(matcher.recordResponse(404, url)).toBe(true);
    expect(matcher.consumeConsoleError(text, url)).toBe(true);
    expect(matcher.consumeConsoleError(text, url)).toBe(false);
  });

  it("does not consume a different status or URL", () => {
    const matcher = new ExpectedBrowserResponseConsoleMatcher();
    const url = "http://localhost/api/database/status";
    matcher.recordResponse(404, url);
    expect(
      matcher.consumeConsoleError(
        "Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
        url,
      ),
    ).toBe(false);
    expect(
      matcher.consumeConsoleError(
        "Failed to load resource: the server responded with a status of 404 (Not Found)",
        "http://localhost/api/other",
      ),
    ).toBe(false);
  });

  it("parses only the canonical Chromium resource-error shape", () => {
    expect(
      browserResourceConsoleErrorStatus(
        "Failed to load resource: the server responded with a status of 401 (Unauthorized)",
      ),
    ).toBe(401);
    expect(
      browserResourceConsoleErrorStatus("request failed with 404"),
    ).toBeNull();
  });
});

describe("isExpectedEmbeddedBrowserConsoleError", () => {
  const autofocusError =
    "Blocked autofocusing on a <textarea> element in a cross-origin subframe.";

  it("accepts the exact intervention from the canonical embedded Google start page", () => {
    expect(
      isExpectedEmbeddedBrowserConsoleError(
        autofocusError,
        "https://www.google.com/webhp?igu=1",
      ),
    ).toBe(true);
  });

  it.each([
    [
      "Blocked a different browser action.",
      "https://www.google.com/webhp?igu=1",
    ],
    [autofocusError, "https://www.google.com/webhp"],
    [autofocusError, "https://www.google.com/search?igu=1"],
    [autofocusError, "https://example.com/webhp?igu=1"],
    [autofocusError, "not a url"],
  ])("rejects a near miss", (text, url) => {
    expect(isExpectedEmbeddedBrowserConsoleError(text, url)).toBe(false);
  });
});
