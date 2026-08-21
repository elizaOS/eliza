/**
 * Pins the workerd short-circuit for the agent-sandbox schema convergence
 * guard (STAGING-FLOW-GREEN-2026-08-19).
 *
 * On workerd the guard's large sequential DDL batch cannot reliably finish
 * inside a request (or its waitUntil budget). Observed live on staging: every cold
 * shared-agent scope hydration died with the guard's own
 * "Failed query: ALTER TABLE agent_sandboxes ..." — keeping the scope cache
 * permanently cold, so the first-turn warming 503 recurred on every cold
 * conversation instead of resolving once. The guard must therefore skip on
 * Workers unless explicitly opted in.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { runWithCloudBindings } from "../lib/runtime/cloud-bindings";
import { shouldSkipEnsure } from "./ensure-agent-sandbox-schema";

const globalRecord = globalThis as Record<string, unknown>;
const hadWebSocketPair = Object.hasOwn(globalRecord, "WebSocketPair");
const originalWebSocketPair = globalRecord.WebSocketPair;

function enterWorkerRuntime(): void {
  // isCloudflareWorkerRuntime() detects workerd via the WebSocketPair global.
  globalRecord.WebSocketPair = class {};
}

function leaveWorkerRuntime(): void {
  if (hadWebSocketPair) {
    globalRecord.WebSocketPair = originalWebSocketPair;
  } else {
    delete globalRecord.WebSocketPair;
  }
}

afterEach(() => {
  leaveWorkerRuntime();
  delete process.env.SKIP_AGENT_SANDBOX_ENSURE;
  delete process.env.AGENT_SANDBOX_ENSURE_IN_WORKER;
  delete process.env.ENVIRONMENT;
});

describe("shouldSkipEnsure", () => {
  test("skips on workerd by default (the staging cold-scope incident class)", () => {
    enterWorkerRuntime();
    expect(shouldSkipEnsure()).toBe(true);
  });

  test("workerd can opt back in explicitly", () => {
    enterWorkerRuntime();
    process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";
    process.env.AGENT_SANDBOX_ENSURE_IN_WORKER = "1";
    expect(shouldSkipEnsure()).toBe(false);
  });

  test("workerd reads the opt-in from request-scoped Worker bindings", () => {
    enterWorkerRuntime();
    process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";
    expect(
      runWithCloudBindings({ AGENT_SANDBOX_ENSURE_IN_WORKER: "1" }, () => shouldSkipEnsure()),
    ).toBe(false);
  });

  test("non-Worker runtimes still run the convergence guard", () => {
    expect(shouldSkipEnsure()).toBe(false);
  });

  test("explicit escape hatch still wins everywhere", () => {
    process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";
    expect(shouldSkipEnsure()).toBe(true);
    enterWorkerRuntime();
    expect(shouldSkipEnsure()).toBe(true);
  });

  test("local environment still skips", () => {
    process.env.ENVIRONMENT = "local";
    expect(shouldSkipEnsure()).toBe(true);
  });
});
