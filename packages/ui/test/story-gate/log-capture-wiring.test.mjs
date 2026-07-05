/**
 * Regression tests for wiring the shared attachLogCapture helper into the
 * story gate, issue #13624 (task: "Wire attachLogCapture + captureBackendLogs
 * into run-story-gate.mjs (emit JSON into output/), or delete them + their doc
 * claims").
 *
 * Before this change:
 *  - `log-capture.mjs` (`attachLogCapture`) was ORPHANED — imported by nobody —
 *    yet the README + packages/ui AGENTS.md/CLAUDE.md listed it as a wired
 *    "reusable piece". run-story-gate.mjs instead used a REDUCED inline
 *    console/pageerror capture that dropped the failed/erroring network
 *    response + request-failure signal entirely, so a story that rendered but
 *    fired a broken network request went completely unsignalled.
 *  - `backend-log-capture.mjs` (`captureBackendLogs`) was fully unwired; the
 *    static Storybook gate serves only static assets (no live backend /
 *    `/api/dev/console-log`), so wiring it would be a fabricated no-op capture.
 *    It is deleted, along with its doc mention.
 *
 * These tests pin: (1) attachLogCapture is captured live per story, its console
 * + network legs feed the gate, and its snapshot lands in the durable artifact;
 * (2) the network-failure derivation escalates a rendered story to `broken`
 * while never punishing a `needs-runtime` story; (3) the dead backend helper is
 * gone and no code imports it.
 *
 * Runs in the standard `packages/ui` vitest suite (env: node). Importing the
 * module does not launch a browser — `main()` is guarded behind import.meta.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { attachLogCapture } from "./log-capture.mjs";
import { deriveNetworkFailureIssues } from "./run-story-gate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runnerSrc = readFileSync(join(here, "run-story-gate.mjs"), "utf8");

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
  it("attachLogCapture is imported + used in run-story-gate.mjs (not orphaned)", () => {
    // Reversion guard: if the wiring is removed the helper goes back to dead
    // code and the README/AGENTS claim becomes a lie again.
    expect(runnerSrc).toMatch(
      /import\s*\{\s*attachLogCapture\s*\}\s*from\s*["']\.\/log-capture\.mjs["']/,
    );
    expect(runnerSrc).toContain("attachLogCapture(page,");
  });

  it("the dead backend-log-capture.mjs helper is deleted and unreferenced", () => {
    expect(existsSync(join(here, "backend-log-capture.mjs"))).toBe(false);
    // The runner must not resurrect a no-op backend capture in the backend-less
    // static gate.
    expect(runnerSrc).not.toContain("captureBackendLogs");
    expect(runnerSrc).not.toContain("backend-log-capture");
  });

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
    const cap = {
      failedResponses: [{ status: 502, url: "http://x/api/a" }],
      requestFailures: [{ failure: "net::ERR_FAILED", url: "http://x/api/b" }],
    };
    const { escalate, issues } = deriveNetworkFailureIssues(cap, "good");
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

  it("writeFrontendLogs emits the richer capture (schema v2 + network legs) into output/", () => {
    // Pin the durable-artifact contract the docs promise: the frontend-logs
    // artifact carries the shared-helper snapshot incl. network failures.
    expect(runnerSrc).toContain("eliza_story_gate_frontend_logs_v2");
    expect(runnerSrc).toContain("withNetworkFailures");
    expect(runnerSrc).toMatch(/capture:\s*r\.logCapture/);
    expect(runnerSrc).toContain('join(dir, "frontend-logs.json")');
  });
});
