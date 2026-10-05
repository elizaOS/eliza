import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attachLogCapture } from "./log-capture.mjs";
import {
  deriveNetworkFailureIssues,
  writeFrontendLogs,
} from "./run-story-gate.mjs";

/**
 * Minimal fake Playwright Page: records the event handlers attachLogCapture
 * registers so a test can synthesize console/response/requestfailed events and
 * assert the helper's structured output, headlessly (no real browser).
 */
function makeFakePage() {
  const handlers = new Map();
  return {
    handlers,
    on(event, fn) {
      handlers.set(event, fn);
    },
    off(event, fn) {
      if (handlers.get(event) === fn) handlers.delete(event);
    },
    emitConsole(type, text) {
      handlers.get("console")?.({ type: () => type, text: () => text });
    },
    emitResponse(status, url) {
      handlers.get("response")?.({ status: () => status, url: () => url });
    },
    emitRequestFailed(url, errorText) {
      handlers.get("requestfailed")?.({
        url: () => url,
        failure: () => ({ errorText }),
      });
    },
  };
}

describe("story-gate log-capture wiring (#13624)", () => {
  it("captures a failed network RESPONSE during render (the dropped signal)", () => {
    const page = makeFakePage();
    const cap = attachLogCapture(page, { label: "acme--widget" });
    page.emitResponse(500, "http://127.0.0.1/api/thing");
    expect(cap.failedResponses).toHaveLength(1);
    expect(cap.failedResponses[0]).toMatchObject({
      status: 500,
      url: "http://127.0.0.1/api/thing",
    });
    expect(cap.hasErrors()).toBe(true);
  });

  it("captures a request FAILURE during render", () => {
    const page = makeFakePage();
    const cap = attachLogCapture(page, { label: "acme--widget" });
    page.emitRequestFailed(
      "http://127.0.0.1/api/down",
      "net::ERR_CONNECTION_REFUSED",
    );
    expect(cap.requestFailures).toHaveLength(1);
    expect(cap.requestFailures[0]).toMatchObject({
      url: "http://127.0.0.1/api/down",
      failure: "net::ERR_CONNECTION_REFUSED",
    });
  });

  it("noise network responses (telemetry/favicon) are allow-listed, not flagged", () => {
    const page = makeFakePage();
    const cap = attachLogCapture(page, {});
    page.emitResponse(404, "http://127.0.0.1/favicon.ico");
    page.emitResponse(500, "https://sentry.io/api/envelope");
    expect(cap.failedResponses).toHaveLength(0);
  });

  it("deriveNetworkFailureIssues escalates a rendered story to broken on a net failure", () => {
    // Only a REAL catalog-bundle fault escalates (#15370): a same-origin code
    // chunk / stylesheet the static server should serve but that 502s or fails.
    // `/api/*` and public-asset failures are expected-absent in the backend-less
    // catalog and stay soft — covered by story-gate-classify.test.mjs.
    const origin = "http://x";
    const cap = {
      failedResponses: [{ status: 502, url: `${origin}/assets/app.chunk.js` }],
      requestFailures: [
        { failure: "net::ERR_FAILED", url: `${origin}/assets/app.css` },
      ],
    };
    // Pass the catalog origin exactly as the runner does (run-story-gate.mjs
    // derives it from baseUrl); the origin gates same-origin bundle faults from
    // external hosts.
    const { escalate, issues } = deriveNetworkFailureIssues(
      cap,
      "good",
      origin,
    );
    expect(escalate).toBe(true);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain("network-failure: net-response 502");
    expect(issues[1]).toContain("network-failure: net-request net::ERR_FAILED");
  });

  it("deriveNetworkFailureIssues NEVER punishes a needs-runtime story", () => {
    // A story that never mounts (missing live app context) legitimately fails
    // its network calls; that is not a code fault and must stay soft.
    const cap = {
      failedResponses: [{ status: 500, url: "http://x/api/a" }],
      requestFailures: [{ failure: "net::ERR_FAILED", url: "http://x/api/b" }],
    };
    const { escalate, issues } = deriveNetworkFailureIssues(
      cap,
      "needs-runtime",
    );
    expect(escalate).toBe(false);
    expect(issues).toEqual([]);
  });

  it("deriveNetworkFailureIssues is a no-op when there are no network failures", () => {
    const { escalate, issues } = deriveNetworkFailureIssues(
      { failedResponses: [], requestFailures: [] },
      "good",
    );
    expect(escalate).toBe(false);
    expect(issues).toEqual([]);
  });

  it("writes network failures and their counts into the actual JSON artifact", async () => {
    const directory = mkdtempSync(join(tmpdir(), "story-logs-"));
    try {
      const capture = {
        summary: { failedResponses: 1, requestFailures: 0 },
        failedResponses: [{ status: 502, url: "http://x/assets/chunk.js" }],
      };
      await writeFrontendLogs(directory, [
        {
          id: "sample",
          title: "Sample",
          name: "Broken",
          verdict: "broken",
          consoleErrors: [],
          issues: [],
          logCapture: capture,
        },
      ]);
      const artifact = JSON.parse(
        readFileSync(join(directory, "frontend-logs.json"), "utf8"),
      );
      expect(artifact.schema).toBe("eliza_story_gate_frontend_logs_v2");
      expect(artifact.summary).toMatchObject({
        stories: 1,
        withNetworkFailures: 1,
        broken: 1,
      });
      expect(artifact.stories[0].capture).toEqual(capture);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
