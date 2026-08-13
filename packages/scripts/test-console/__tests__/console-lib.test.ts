/**
 * Unit coverage for the console's own moving parts: result classification
 * (log-line-first, exit-code fallback), the credential store roundtrip in a
 * temp dir, and the registry's real plan discovery + credential gating (the
 * one slow test — it shells the actual run-all-tests plan, no mocks).
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import {
  classifyResult,
  countStatuses,
  normalizeRunConcurrency,
} from "../lib/runner.mjs";

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

  test("exit 3 without status lines is a semantic-work failure", () => {
    expect(
      classifyResult({
        label: LABEL,
        code: 3,
        signal: null,
        tail: "",
        cancelled: false,
      }),
    ).toBe("failed");
  });

  test("PASS text cannot override a semantic-work failure exit", () => {
    expect(
      classifyResult({
        label: LABEL,
        code: 3,
        signal: null,
        tail: `[eliza-test] PASS ${LABEL} (10ms)`,
        cancelled: false,
      }),
    ).toBe("failed");
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

describe("normalizeRunConcurrency", () => {
  test("preserves the default and ordinary positive integer inputs", () => {
    expect(normalizeRunConcurrency(undefined)).toBe(3);
    expect(normalizeRunConcurrency(4)).toBe(4);
    expect(normalizeRunConcurrency("04")).toBe(4);
  });

  test("rejects values that could disable or exhaust the worker bound", () => {
    for (const value of [
      0,
      -1,
      "1e3",
      "4workers",
      33,
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(() => normalizeRunConcurrency(value)).toThrow(
        "concurrency must be a positive integer from 1 to 32",
      );
    }
  });
});

describe("store roundtrip", () => {
  let store: typeof import("../lib/store.mjs");
  let testConsoleDir: string;

  beforeAll(async () => {
    testConsoleDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-test-console-"),
    );
    process.env.ELIZA_TEST_CONSOLE_DIR = testConsoleDir;
    store = await import("../lib/store.mjs");
  });

  test("credentials save with 0600 and merge into env", () => {
    store.setConnection("openai", { OPENAI_API_KEY: "sk-test-123" });
    store.setConnection("github", { GITHUB_TOKEN: "ghp_test" });
    const file = path.join(testConsoleDir, "credentials.json");
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
    expect(without.tasks.length).toBeGreaterThanOrEqual(150);
    expect(without.orphanSuites).toEqual([]);
    expect(without.connections.length).toBeGreaterThan(30);

    const webSearchTask = without.tasks.find((t) =>
      t.liveSuites.some((s) => s.file.includes("plugin-web-search")),
    );
    expect(webSearchTask).toBeDefined();

    const suiteState = (registry: ReturnType<typeof buildRegistry>) => {
      const suite = registry.tasks
        .flatMap((t) => t.liveSuites)
        .find((s) => s.file.includes("webSearchService.real.test.ts"));
      if (!suite) throw new Error("web-search live suite was not discovered");
      return suite.state;
    };

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

describe("route: POST /api/run rejects invalid concurrency before live-lane side effects", () => {
  const refreshGoogleAccessTokenMock = mock(async () => ({
    accessToken: "fake-access-token",
  }));

  let store: typeof import("../lib/store.mjs");
  let server: typeof import("../server.mjs");

  beforeAll(async () => {
    const testConsoleDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-test-console-route-"),
    );
    process.env.ELIZA_TEST_CONSOLE_DIR = testConsoleDir;

    // Stub the Google OAuth client so a request that *does* reach the
    // refresh step would succeed and persist a token — proving the ordering
    // fix (not an unreachable network call) is what keeps it from firing.
    mock.module("../lib/oauth.mjs", () => ({
      completeGoogleFlow: mock(),
      DEFAULT_CLOUD_BASE_URL: "https://cloud.example.test",
      pollCloudLogin: mock(),
      refreshGoogleAccessToken: refreshGoogleAccessTokenMock,
      startCloudLogin: mock(),
      startGoogleFlow: mock(),
    }));

    store = await import("../lib/store.mjs");
    store.setConnection("google-oauth", {
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "test-refresh-token",
    });

    server = await import("../server.mjs");
  });

  function postRun(body: unknown): Promise<{ status: number }> {
    return new Promise((resolve, reject) => {
      const req = Readable.from([Buffer.from(JSON.stringify(body))]);
      let status = 0;
      const res = {
        writeHead(code: number) {
          status = code;
        },
        end() {
          resolve({ status });
        },
      };
      Promise.resolve(
        server.routes["POST /api/run"](req as never, res as never),
      ).catch(reject);
    });
  }

  test("returns 400 without ever refreshing/persisting Google credentials or starting a run", async () => {
    refreshGoogleAccessTokenMock.mockClear();

    const result = await postRun({
      mode: "all",
      lane: "live",
      concurrency: "Infinity",
    });

    expect(result.status).toBe(400);
    expect(refreshGoogleAccessTokenMock).not.toHaveBeenCalled();
    expect(store.loadCredentials()["google-calendar"]).toBeUndefined();
    expect(server.runManager.isRunning()).toBe(false);
  });
});
