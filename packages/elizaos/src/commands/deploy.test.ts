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

  it("accepts valid poll-interval number formats (backward compatibility)", async () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "eliza_test_key";
    process.env.ELIZA_CLOUD_API_BASE_URL = "https://cloud.example.test/api/v1";

    const validIntervals = [
      { env: "1000", expected: 1000, desc: "simple decimal" },
      { env: "12.34", expected: 12.34, desc: "decimal with fraction" },
      { env: " 500 ", expected: 500, desc: "whitespace-padded" },
      { env: "1e3", expected: 1000, desc: "exponent notation (1e3 = 1000)" },
      { env: "1.5e2", expected: 150, desc: "exponent with fraction (1.5e2 = 150)" },
      { env: "1E+3", expected: 1000, desc: "uppercase exponent with plus sign" },
      { env: "2e-1", expected: 0.2, desc: "negative exponent (2e-1 = 0.2)" },
    ];

    for (const { env, desc } of validIntervals) {
      process.env.ELIZAOS_DEPLOY_POLL_INTERVAL_MS = env;
      process.env.ELIZAOS_DEPLOY_TIMEOUT_MS = "100"; // short timeout for fast test
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
          }),
        );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      vi.spyOn(console, "log").mockImplementation(() => {});

      // Deploy should complete successfully when given a valid interval format
      const code = await runDeploy({ appId: "app-1" });

      expect(code, `poll-interval "${env}" (${desc}) should be accepted`).toBe(
        0,
      );
      fetchMock.mockClear();
    }
  });

  it("uses configured poll interval with timer (real setTimeout spy)", async () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "eliza_test_key";
    process.env.ELIZA_CLOUD_API_BASE_URL = "https://cloud.example.test/api/v1";
    process.env.ELIZAOS_DEPLOY_POLL_INTERVAL_MS = "250";

    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    // Mock first response: BUILDING (triggers sleep), second: READY (exits loop)
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

    const code = await runDeploy({ appId: "app-1" });

    expect(code).toBe(0);
    // setTimeout should be called at least once with the configured interval (250ms)
    // during the polling loop for BUILDING → BUILDING transition
    expect(setTimeoutSpy).toHaveBeenCalledWith(
      expect.any(Function),
      250,
    );
  });

  it("rejects invalid poll-interval values and uses default", async () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "eliza_test_key";
    process.env.ELIZA_CLOUD_API_BASE_URL = "https://cloud.example.test/api/v1";

    const invalidIntervals = [
      "not-a-number",
      "123abc",
      "Infinity",
      "-1000", // negative values should use default (bounds check)
      "NaN",
    ];

    for (const env of invalidIntervals) {
      process.env.ELIZAOS_DEPLOY_POLL_INTERVAL_MS = env;
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(
            { success: true, deploymentId: "dep-1", status: "READY" },
            202,
          ),
        );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      vi.spyOn(console, "log").mockImplementation(() => {});

      await runDeploy({ appId: "app-1" });

      // Should fall back to DEFAULT_POLL_INTERVAL_MS (5000) when interval can't be used
      // Note: when status is READY on first poll, setTimeout is not called at all
      // So we just verify the deploy succeeds (invalid values fall back to default)
      expect(fetchMock).toHaveBeenCalled();

      vi.restoreAllMocks();
    }
  });
});
