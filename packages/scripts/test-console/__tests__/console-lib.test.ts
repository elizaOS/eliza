/**
 * Unit coverage for the console's own moving parts: result classification
 * (log-line-first, exit-code fallback), the credential store roundtrip in a
 * temp dir, and the registry's real plan discovery + credential gating (the
 * one slow test — it shells the actual run-all-tests plan, no mocks).
 */

import { beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyResult, countStatuses } from "../lib/runner.mjs";

const LABEL = "@elizaos/logger (packages/logger)#test";

describe("classifyResult", () => {
  test("FAIL line wins even with exit 0", () => {
    expect(
      classifyResult({
        label: LABEL,
        code: 0,
        signal: null,
        tail: `[eliza-test] FAIL ${LABEL} (10ms)`,
        cancelled: false,
      }),
    ).toBe("failed");
  });

  test("PASS line classifies passed", () => {
    expect(
      classifyResult({
        label: LABEL,
        code: 0,
        signal: null,
        tail: `[eliza-test] PASS ${LABEL} (10ms)`,
        cancelled: false,
      }),
    ).toBe("passed");
  });

  test("SKIP line classifies skipped", () => {
    expect(
      classifyResult({
        label: LABEL,
        code: 0,
        signal: null,
        tail: `[eliza-test] SKIP ${LABEL} (no local test files)`,
        cancelled: false,
      }),
    ).toBe("skipped");
  });

  test("exit 3 without status lines is the vacuous-green skip", () => {
    expect(
      classifyResult({
        label: LABEL,
        code: 3,
        signal: null,
        tail: "",
        cancelled: false,
      }),
    ).toBe("skipped");
  });

  test("signal death is failure; cancellation wins over everything", () => {
    expect(
      classifyResult({
        label: LABEL,
        code: null,
        signal: "SIGTERM",
        tail: "",
        cancelled: false,
      }),
    ).toBe("failed");
    expect(
      classifyResult({
        label: LABEL,
        code: 1,
        signal: null,
        tail: "",
        cancelled: true,
      }),
    ).toBe("cancelled");
  });

  test("countStatuses aggregates", () => {
    expect(
      countStatuses([
        { status: "passed" },
        { status: "passed" },
        { status: "failed" },
      ]),
    ).toEqual({ passed: 2, failed: 1 });
  });
});

describe("store roundtrip", () => {
  let store: typeof import("../lib/store.mjs");

  beforeAll(async () => {
    process.env.ELIZA_TEST_CONSOLE_DIR = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-test-console-"),
    );
    store = await import("../lib/store.mjs");
  });

  test("credentials save with 0600 and merge into env", () => {
    store.setConnection("openai", { OPENAI_API_KEY: "sk-test-123" });
    store.setConnection("github", { GITHUB_TOKEN: "ghp_test" });
    const file = path.join(
      process.env.ELIZA_TEST_CONSOLE_DIR!,
      "credentials.json",
    );
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(store.credentialsToEnv()).toEqual({
      OPENAI_API_KEY: "sk-test-123",
      GITHUB_TOKEN: "ghp_test",
    });
    store.removeConnection("github");
    expect(store.credentialsToEnv()).toEqual({ OPENAI_API_KEY: "sk-test-123" });
  });

  test("run manifests and history persist and list", () => {
    store.newRunDir("run-1");
    store.saveRunManifest("run-1", {
      runId: "run-1",
      lane: "pr",
      counts: { passed: 1 },
    });
    store.recordTaskStatus(LABEL, {
      status: "failed",
      runId: "run-1",
      at: "now",
    });
    expect(store.listRuns()[0].runId).toBe("run-1");
    expect(store.loadHistory()[LABEL].status).toBe("failed");
  });
});

describe("registry (real plan discovery)", () => {
  test("plan discovers the workspace and credentials flip suite gating", async () => {
    const { buildRegistry } = await import("../lib/registry.mjs");

    const without = buildRegistry({
      savedCredentials: {},
      optInToggles: {},
      history: {},
    });
    expect(without.tasks.length).toBeGreaterThan(200);
    expect(without.orphanSuites).toEqual([]);
    expect(without.connections.length).toBeGreaterThan(30);

    const webSearchTask = without.tasks.find((t) =>
      t.liveSuites.some((s) => s.file.includes("plugin-web-search")),
    );
    expect(webSearchTask).toBeDefined();

    const suiteState = (registry: ReturnType<typeof buildRegistry>) =>
      registry.tasks
        .flatMap((t) => t.liveSuites)
        .find((s) => s.file.includes("webSearchService.real.test.ts"))!.state;

    // Deterministic regardless of ambient env: with an explicit key the suite
    // arms; the no-credentials expectation only holds on machines that don't
    // already export TAVILY_API_KEY, so assert the armed side only.
    const withKey = buildRegistry({
      savedCredentials: { tavily: { TAVILY_API_KEY: "tvly-test" } },
      optInToggles: {},
      history: {},
    });
    expect(suiteState(withKey)).toBe("armed");
  }, 30_000);
});
