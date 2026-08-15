/**
 * Deploy command tests cover dry-run planning, credential discovery, and cloud
 * polling behavior with real temporary project files and stubbed fetch calls.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEPLOY_COMMAND_DESCRIPTION,
  DEPLOY_DRY_RUN_DESCRIPTION,
  runDeploy,
} from "./deploy";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const originalCwd = process.cwd();

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  process.chdir(originalCwd);
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

describe("runDeploy", () => {
  it("describes deploy as a real queue-and-poll command", () => {
    expect(DEPLOY_COMMAND_DESCRIPTION).toContain("Deploy");
    expect(DEPLOY_COMMAND_DESCRIPTION).toContain("poll until READY");
    expect(DEPLOY_COMMAND_DESCRIPTION).not.toContain("plan");
    expect(DEPLOY_DRY_RUN_DESCRIPTION).toContain("without network calls");
    expect(DEPLOY_DRY_RUN_DESCRIPTION).not.toContain("always a preview");
  });

  it("keeps dry-run mode network-free", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runDeploy({ dryRun: true, appId: "app-1" });

    expect(code).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("queues a cloud deploy and polls to READY", async () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "eliza_test_key";
    process.env.ELIZA_CLOUD_API_BASE_URL = "https://cloud.example.test/api/v1";
    process.env.ELIZAOS_DEPLOY_POLL_INTERVAL_MS = "0";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { success: true, deploymentId: "dep-1", status: "BUILDING" },
          202,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          deploymentId: "dep-1",
          status: "READY",
          vercelUrl: "https://app.example.vercel.app",
        }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runDeploy({ appId: "app-1" });

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.example.test/api/v1/apps/app-1/deploy",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer eliza_test_key",
          "Content-Type": "application/json; charset=utf-8",
        }),
        body: "{}",
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.example.test/api/v1/apps/app-1/deploy/status",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer eliza_test_key" },
      }),
    );
  });

  it.each(["-1", "1.5", "2147483648"])(
    "rejects malformed poll interval %s before any network call",
    async (interval) => {
      process.env.ELIZAOS_CLOUD_API_KEY = "eliza_test_key";
      process.env.ELIZAOS_DEPLOY_POLL_INTERVAL_MS = interval;
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const code = await runDeploy({ appId: "app-1" });

      expect(code).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "ELIZAOS_DEPLOY_POLL_INTERVAL_MS must be an integer from 0 through 2147483647",
        ),
      );
    },
  );

  // The accepted grammar is any Number()-compatible integer spelling, not
  // just base-10 - the error message must describe the real contract instead
  // of claiming a narrower one (review finding on #19384).
  it.each([
    ["0x10", 16],
    ["0b10", 2],
    ["0o10", 8],
  ])(
    "accepts the non-decimal Number()-compatible spelling %s as %dms",
    async (interval, expectedMs) => {
      process.env.ELIZAOS_CLOUD_API_KEY = "eliza_test_key";
      process.env.ELIZA_CLOUD_API_BASE_URL = "https://cloud.example.test";
      process.env.ELIZAOS_DEPLOY_POLL_INTERVAL_MS = interval;
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(
            { success: true, deploymentId: "dep-1", status: "QUEUED" },
            202,
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            success: true,
            deploymentId: "dep-1",
            status: "BUILDING",
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            success: true,
            deploymentId: "dep-1",
            status: "READY",
          }),
        );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      vi.spyOn(console, "log").mockImplementation(() => {});
      const setTimeoutSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation(((callback: () => void) => {
          callback();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout);

      const code = await runDeploy({ appId: "app-1" });

      expect(code).toBe(0);
      expect(
        setTimeoutSpy.mock.calls.some((call) => call[1] === expectedMs),
      ).toBe(true);
    },
  );

  // Mutation-resistant: proves a configured, non-default poll interval actually
  // reaches the real setTimeout call inside pollDeploymentStatus's sleep(), not
  // just that the standalone parser resolves it correctly in isolation. Also
  // covers every Number()-compatible spelling the pre-existing Number(...)
  // parser accepted (blank/unset, leading zero, exponent, surrounding
  // whitespace) to prove the stricter regex didn't silently narrow the
  // accepted configuration grammar.
  it.each([
    ["", 5_000],
    ["01000", 1_000],
    ["1e3", 1_000],
    [" 1000 ", 1_000],
    ["2147483647", 2_147_483_647],
  ])(
    "uses the exact configured poll interval for %s (%dms), not the 5s default",
    async (interval, expectedMs) => {
      process.env.ELIZAOS_CLOUD_API_KEY = "eliza_test_key";
      process.env.ELIZA_CLOUD_API_BASE_URL = "https://cloud.example.test";
      process.env.ELIZAOS_DEPLOY_POLL_INTERVAL_MS = interval;
      // Set a timeout budget larger than every interval under test (including
      // the max 2147483647ms) so this test's concern - the configured
      // interval reaching the real timer unaltered - stays independent of
      // pollDeploymentStatus's separate remaining-timeout-budget bound.
      process.env.ELIZAOS_DEPLOY_TIMEOUT_MS = "9999999999";
      // The deploy POST response and the first status GET are two separate
      // calls; a third response is required so the poll loop observes a
      // non-terminal status at least once and actually calls sleep() before
      // seeing READY.
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(
            { success: true, deploymentId: "dep-1", status: "QUEUED" },
            202,
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            success: true,
            deploymentId: "dep-1",
            status: "BUILDING",
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            success: true,
            deploymentId: "dep-1",
            status: "READY",
          }),
        );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      vi.spyOn(console, "log").mockImplementation(() => {});
      const setTimeoutSpy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation(((callback: () => void) => {
          callback();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout);

      const code = await runDeploy({ appId: "app-1" });

      expect(code).toBe(0);
      expect(
        setTimeoutSpy.mock.calls.some((call) => call[1] === expectedMs),
      ).toBe(true);
      if (expectedMs !== 5_000) {
        expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 5_000)).toBe(
          false,
        );
      }
    },
  );

  // rndrntwrk's review of #19384: the accepted max poll interval
  // (2147483647ms, ~24.8 days) can defeat the documented deploy timeout,
  // because pollDeploymentStatus only rechecks the deadline after a sleep
  // completes - an interval bigger than the timeout means the deadline is
  // never rechecked until the huge sleep itself finishes. Proves the fix
  // (bounding each sleep by the remaining timeout budget) makes a max
  // interval still exit at the configured timeout, using fake timers so the
  // test doesn't actually wait.
  it("bounds a max poll interval by the remaining timeout, not by intervalMs itself", async () => {
    vi.useFakeTimers();
    try {
      process.env.ELIZAOS_CLOUD_API_KEY = "eliza_test_key";
      process.env.ELIZA_CLOUD_API_BASE_URL = "https://cloud.example.test";
      process.env.ELIZAOS_DEPLOY_POLL_INTERVAL_MS = "2147483647";
      process.env.ELIZAOS_DEPLOY_TIMEOUT_MS = "600000";
      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        if (typeof url === "string" && url.endsWith("/deploy")) {
          return jsonResponse(
            { success: true, deploymentId: "dep-1", status: "QUEUED" },
            202,
          );
        }
        // Status poll never reaches a terminal state - the run must exit via
        // the timeout, not via READY/ERROR.
        return jsonResponse({
          success: true,
          deploymentId: "dep-1",
          status: "BUILDING",
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const runPromise = runDeploy({ appId: "app-1" });
      // Advance well past the 600000ms timeout - nowhere close to the
      // configured 2147483647ms interval - to prove the wait is bounded by
      // the timeout, not the interval.
      await vi.advanceTimersByTimeAsync(600_001);
      const code = await runPromise;

      expect(code).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Deploy did not reach READY or ERROR within 600000ms",
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("attaches a custom domain after queueing the deploy", async () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "eliza_test_key";
    process.env.ELIZA_CLOUD_API_BASE_URL = "https://cloud.example.test";
    process.env.ELIZAOS_DEPLOY_POLL_INTERVAL_MS = "0";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { success: true, deploymentId: "dep-1", status: "BUILDING" },
          202,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          verified: false,
          verificationRecord: {
            type: "TXT",
            name: "_eliza.example.com",
            value: "eliza-verify-token",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          deploymentId: "dep-1",
          status: "READY",
        }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await runDeploy({
      appId: "app-1",
      domain: "agent.example.com",
    });

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.example.test/api/v1/apps/app-1/domains",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ domain: "agent.example.com" }),
      }),
    );
  });

  it("fails real deploys without cloud credentials", async () => {
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.ELIZA_CLOUD_API_KEY;
    delete process.env.ELIZACLOUD_API_KEY;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runDeploy({ appId: "app-1" });

    expect(code).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails corrupt project metadata before app lookup", async () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "eliza_test_key";
    const projectDir = mkdtempSync(
      path.join(os.tmpdir(), "elizaos-deploy-project-"),
    );
    mkdirSync(path.join(projectDir, ".elizaos"));
    writeFileSync(
      path.join(projectDir, ".elizaos", "template.json"),
      "{not-json",
    );
    process.chdir(projectDir);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const code = await runDeploy({});

      expect(code).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid project metadata JSON"),
      );
      // Path is rendered with the OS separator (backslash on Windows), so match
      // the joined form rather than a hardcoded POSIX substring.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(path.join(".elizaos", "template.json")),
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("fails corrupt credentials before deploy request", async () => {
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.ELIZA_CLOUD_API_KEY;
    delete process.env.ELIZACLOUD_API_KEY;
    const homeDir = mkdtempSync(path.join(os.tmpdir(), "elizaos-deploy-home-"));
    mkdirSync(path.join(homeDir, ".elizaos"));
    writeFileSync(
      path.join(homeDir, ".elizaos", "credentials.json"),
      "{not-json",
    );
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const code = await runDeploy({ appId: "app-1" });

      expect(code).toBe(1);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid Eliza Cloud credentials JSON"),
      );
      // Path is rendered with the OS separator (backslash on Windows), so match
      // the joined form rather than a hardcoded POSIX substring.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(path.join(".elizaos", "credentials.json")),
      );
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  // `runDeploy` validates `--domain` against DOMAIN_REGEX as its very first step,
  // before resolving credentials or touching the network — a malformed value
  // must fail closed with no request issued. Credentials are present in these
  // cases so the regex gate (not a missing key) is provably what stops it.
  it("rejects a malformed --domain before any network call", async () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "eliza_test_key";
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const malformed = [
      "notahostname", // no dot / TLD
      "bad domain.com", // whitespace
      "-lead.example.com", // label starts with a hyphen
      "trailing.dot.", // trailing dot, empty TLD
      "UPPER.example.com", // regex is lowercase-only
      "under_score.example.com", // underscore not allowed in a hostname
    ];
    for (const domain of malformed) {
      fetchMock.mockClear();
      const code = await runDeploy({ appId: "app-1", domain });
      expect(code, `domain "${domain}" should be rejected`).toBe(1);
      expect(
        fetchMock,
        `domain "${domain}" must not reach the network`,
      ).not.toHaveBeenCalled();
    }
  });

  it("lets well-formed --domain values through the gate to the network", async () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "eliza_test_key";
    process.env.ELIZA_CLOUD_API_BASE_URL = "https://cloud.example.test";
    // Reject the first request so the run unwinds quickly; we only need to prove
    // a valid domain passes validation and proceeds far enough to call fetch.
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error("network disabled in test"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const wellFormed = [
      "app.example.com",
      "a.io", // single-char label + 2-char TLD
      "sub.domain.example.co",
      "x1-y2.example.com", // digits + interior hyphen
    ];
    for (const domain of wellFormed) {
      fetchMock.mockClear();
      await runDeploy({ appId: "app-1", domain });
      expect(
        fetchMock,
        `valid domain "${domain}" should reach the network`,
      ).toHaveBeenCalled();
    }
  });
});
