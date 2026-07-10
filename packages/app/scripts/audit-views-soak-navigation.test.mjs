/**
 * The real-app view soak must never bypass the surface-realm navigation gate
 * while releasing its final active view.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("./audit-views-soak.mjs", import.meta.url),
  "utf8",
);

test("cleanup navigates through the shell event instead of raw History", () => {
  expect(source).toContain(
    'await dispatchShellNavigation({ id: "chat", path: "/chat" });',
  );
  expect(source).not.toContain("window.history.pushState");
  expect(source).not.toContain("window.history.replaceState");
});

test("context teardown owns video finalization without a redundant page close", () => {
  expect(source).toContain("await ctx.close().catch(() => {});");
  expect(source).not.toContain("await page.close()");
});

test("the soak completes current in-chat onboarding before view churn", () => {
  expect(source).toContain("async function waitForRuntimeReady");
  expect(source).toContain("/api/health");
  expect(source).toContain('attempt.value.body.runtime === "ok"');
  expect(source.indexOf("await waitForRuntimeReady()")).toBeLessThan(
    source.indexOf("await completeFirstRunIfNeeded()"),
  );
  expect(source).toContain(
    'localStorage.setItem("eliza:first-run-complete", "1")',
  );
  expect(source).toContain(
    'localStorage.setItem("eliza:setup:step", "activate")',
  );
  expect(source).toContain("/api/first-run/status");
  expect(source).toContain("/api/first-run");
  expect(source).toContain('getByTestId("chat-first-run-backdrop")');
  expect(source).not.toContain("first-run-runtime-chooser");
});

test("the soak recognizes unavailable optional services and protected boundaries", () => {
  expect(source).toContain('"/api/meetings"');
  expect(source).toContain('"/api/lifeops/todos"');
  expect(source).toContain('"/api/cloud/status"');
  expect(source).toContain("entry.status === 401");
  expect(source).toContain("protected_route_without_session");
});
