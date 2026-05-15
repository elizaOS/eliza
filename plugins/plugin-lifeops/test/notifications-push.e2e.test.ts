/**
 * Integration tests for the Ntfy push notification client.
 *
 * Live tests are gated on NTFY_BASE_URL being set. When the env var is absent
 * the suite skips rather than failing — consistent with the credential-gated
 * pattern used across this test directory.
 *
 * Unit-level tests (config parsing, error paths) always run.
 *
 * ---------------------------------------------------------------------------
 * AlwaysSkipped in CI
 * ---------------------------------------------------------------------------
 * The `sendPush — live Ntfy` describe block at the bottom of this file is
 * `describe.skipIf(!LIVE_BASE_URL)`. NTFY_BASE_URL is not configured in any
 * GitHub Actions workflow (see .github/workflows/*.yml — no match for
 * NTFY_BASE_URL), so the live block is always skipped in CI today. It is
 * kept here to document the live contract and to run locally when a
 * developer points the suite at a real Ntfy server.
 *
 * To run locally:
 *   NTFY_BASE_URL=https://ntfy.sh \
 *   NTFY_DEFAULT_TOPIC=eliza-test \
 *     bunx vitest run plugins/app-lifeops/test/notifications-push.integration.test.ts
 *
 * Do NOT enable this suite in CI by injecting NTFY_BASE_URL — it publishes
 * real notifications to a public broker. If we want CI coverage for the
 * HTTP layer, convert this into an offline harness with a local HTTP
 * server stub (nock / msw / `http.createServer`) in a follow-up.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NtfyConfigError,
  readNtfyConfigFromEnv,
  type SendPushRequest,
  sendPush,
} from "../src/lifeops/notifications-push.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.NTFY_BASE_URL;
  delete process.env.NTFY_DEFAULT_TOPIC;
});

afterEach(() => {
  Object.assign(process.env, ORIGINAL_ENV);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Config parsing — always runs
// ---------------------------------------------------------------------------

describe("readNtfyConfigFromEnv", () => {
  it("throws NtfyConfigError when NTFY_BASE_URL is absent", () => {
    expect(() => readNtfyConfigFromEnv()).toThrow(NtfyConfigError);
    expect(() => readNtfyConfigFromEnv()).toThrow(/NTFY_BASE_URL/);
  });

  it("strips trailing slash from baseUrl", () => {
    process.env.NTFY_BASE_URL = "https://ntfy.sh/";
    const config = readNtfyConfigFromEnv();
    expect(config.baseUrl).toBe("https://ntfy.sh");
  });

  it("uses NTFY_DEFAULT_TOPIC when set", () => {
    process.env.NTFY_BASE_URL = "https://ntfy.sh";
    process.env.NTFY_DEFAULT_TOPIC = "my-alerts";
    const config = readNtfyConfigFromEnv();
    expect(config.defaultTopic).toBe("my-alerts");
  });

  it("falls back to 'eliza' when NTFY_DEFAULT_TOPIC is not set", () => {
    process.env.NTFY_BASE_URL = "https://ntfy.sh";
    const config = readNtfyConfigFromEnv();
    expect(config.defaultTopic).toBe("eliza");
  });
});

// ---------------------------------------------------------------------------
// sendPush error path — always runs (no network)
// ---------------------------------------------------------------------------

describe("sendPush — config error", () => {
  it("throws NtfyConfigError when no config passed and env is empty", async () => {
    await expect(sendPush({ title: "Test", message: "Hello" })).rejects.toThrow(
      NtfyConfigError,
    );
  });
});

describe("sendPush — network error handling", () => {
  it("throws Error on fetch rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    process.env.NTFY_BASE_URL = "https://ntfy.example.invalid";

    await expect(sendPush({ title: "Test", message: "Hello" })).rejects.toThrow(
      "Failed to fetch",
    );
  });

  it("throws Error on non-OK HTTP response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => "Forbidden",
      }),
    );
    process.env.NTFY_BASE_URL = "https://ntfy.example.invalid";

    await expect(sendPush({ title: "Test", message: "Hello" })).rejects.toThrow(
      "403",
    );
  });

  it("returns messageId and deliveredAt on success", async () => {
    const fakeId = "abc123";
    const fakeTime = Math.floor(Date.now() / 1000);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: fakeId, time: fakeTime }),
      }),
    );
    process.env.NTFY_BASE_URL = "https://ntfy.example.invalid";

    const result = await sendPush({ title: "Test", message: "Hello" });
    expect(result.messageId).toBe(fakeId);
    expect(result.deliveredAt).toBe(new Date(fakeTime * 1000).toISOString());
  });

  it("uses topic from request over default", async () => {
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        capturedUrl = url;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ id: "x", time: Math.floor(Date.now() / 1000) }),
        });
      }),
    );
    process.env.NTFY_BASE_URL = "https://ntfy.example.invalid";
    process.env.NTFY_DEFAULT_TOPIC = "default-topic";

    await sendPush({ topic: "custom-topic", title: "Test", message: "Hello" });
    expect(capturedUrl).toContain("/custom-topic");
  });

  it("forwards click, tags, and normalized priority headers", async () => {
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        capturedInit = init;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ id: "x", time: Math.floor(Date.now() / 1000) }),
        });
      }),
    );
    process.env.NTFY_BASE_URL = "https://ntfy.example.invalid";

    await sendPush({
      title: "Meeting ladder",
      message: "Board meeting starts in 10 minutes.",
      priority: 5,
      tags: ["calendar", "alarm_clock"],
      click: "eliza://meeting/board-123",
    });

    expect(capturedInit?.headers).toMatchObject({
      Title: "Meeting ladder",
      Priority: "5",
      Tags: "calendar,alarm_clock",
      Click: "eliza://meeting/board-123",
    });
  });
});

// ---------------------------------------------------------------------------
// Live integration — gated on NTFY_BASE_URL
// ---------------------------------------------------------------------------

const LIVE_BASE_URL = ORIGINAL_ENV.NTFY_BASE_URL;

describe.skipIf(!LIVE_BASE_URL)("sendPush — live Ntfy", () => {
  it("publishes a notification and returns a messageId", async () => {
    const request: SendPushRequest = {
      title: "LifeOps integration test",
      message:
        "This is a test push from the notifications-push integration test suite.",
      priority: 3,
      tags: ["white_check_mark"],
    };

    const result = await sendPush(request, {
      baseUrl: LIVE_BASE_URL!.replace(/\/$/, ""),
      defaultTopic: ORIGINAL_ENV.NTFY_DEFAULT_TOPIC ?? "eliza-test",
    });

    expect(typeof result.messageId).toBe("string");
    expect(result.messageId.length).toBeGreaterThan(0);
    expect(typeof result.deliveredAt).toBe("string");
  });
});
