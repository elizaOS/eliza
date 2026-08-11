/**
 * Deterministic coverage for the pre-mount local-voice transport override. The
 * native bridge is represented by an injected Preferences reader; localStorage
 * and client calls are the real browser-side state transitions.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyIosVoiceSelfTestBootOverride,
  IOS_VOICE_SELFTEST_LOCAL_ACTIVE_SERVER,
  parseIosVoiceSelfTestRequest,
} from "./ios-voice-selftest-boot";

describe("iOS voice self-test pre-mount override", () => {
  beforeEach(() => window.localStorage.clear());

  it("replaces stale remote WKWebView state with canonical local IPC state", async () => {
    window.localStorage.setItem("eliza:mobile-runtime-mode", "remote-mac");
    window.localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "remote:http://127.0.0.1:31338",
        kind: "remote",
        label: "Old host",
        apiBase: "http://127.0.0.1:31338",
      }),
    );
    const request = JSON.stringify({
      mode: "local",
      apiBase: "eliza-local-agent://ipc",
      runId: "run-1",
      requestedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    });
    window.localStorage.setItem(
      "eliza:ios-voice-selftest:request",
      JSON.stringify({
        mode: "remote",
        apiBase: "http://127.0.0.1:31338",
        runId: "stale-webview-request",
      }),
    );
    const client = { setBaseUrl: vi.fn(), setToken: vi.fn() };

    await expect(
      applyIosVoiceSelfTestBootOverride({
        isIOS: true,
        client,
        getPreference: vi.fn(async () => request),
      }),
    ).resolves.toBe(true);

    expect(window.localStorage.getItem("eliza:mobile-runtime-mode")).toBe(
      "local",
    );
    expect(window.localStorage.getItem("eliza:first-run-complete")).toBe("1");
    expect(
      JSON.parse(
        window.localStorage.getItem("elizaos:active-server") ?? "null",
      ),
    ).toEqual(IOS_VOICE_SELFTEST_LOCAL_ACTIVE_SERVER);
    expect(client.setToken).toHaveBeenCalledWith(null);
    expect(client.setBaseUrl).toHaveBeenCalledWith("eliza-local-agent://ipc");
  });

  it("leaves remote compatibility requests to onboarding", async () => {
    const client = { setBaseUrl: vi.fn(), setToken: vi.fn() };
    const applied = await applyIosVoiceSelfTestBootOverride({
      isIOS: true,
      client,
      getPreference: vi.fn(async () =>
        JSON.stringify({
          mode: "remote",
          apiBase: "http://127.0.0.1:31338",
          runId: "run-2",
        }),
      ),
    });
    expect(applied).toBe(false);
    expect(client.setBaseUrl).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("elizaos:active-server")).toBeNull();
  });

  it.each([
    ["malformed", "{not-json"],
    [
      "stale",
      JSON.stringify({
        mode: "local",
        apiBase: "eliza-local-agent://ipc",
        runId: "old-run",
        requestedAt: "2020-01-01T00:00:00.000Z",
        deadlineAt: "2020-01-01T00:20:00.000Z",
      }),
    ],
    [
      "future",
      JSON.stringify({
        mode: "local",
        apiBase: "eliza-local-agent://ipc",
        runId: "future-run",
        requestedAt: "2099-01-01T00:00:00.000Z",
        deadlineAt: "2099-01-01T00:20:00.000Z",
      }),
    ],
  ])(
    "does not let a %s harness request brick normal app boot",
    async (_, raw) => {
      const client = { setBaseUrl: vi.fn(), setToken: vi.fn() };
      await expect(
        applyIosVoiceSelfTestBootOverride({
          isIOS: true,
          client,
          getPreference: vi.fn(async () => raw),
        }),
      ).resolves.toBe(false);
      expect(client.setBaseUrl).not.toHaveBeenCalled();
      expect(client.setToken).not.toHaveBeenCalled();
      expect(
        window.localStorage.getItem("eliza:mobile-runtime-mode"),
      ).toBeNull();
      expect(window.localStorage.getItem("elizaos:active-server")).toBeNull();
    },
  );

  it("does not let a native Preferences read failure mutate normal boot", async () => {
    const client = { setBaseUrl: vi.fn(), setToken: vi.fn() };
    await expect(
      applyIosVoiceSelfTestBootOverride({
        isIOS: true,
        client,
        getPreference: vi.fn(async () => {
          throw new Error("native bridge unavailable");
        }),
      }),
    ).resolves.toBe(false);
    expect(client.setBaseUrl).not.toHaveBeenCalled();
    expect(client.setToken).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("eliza:mobile-runtime-mode")).toBeNull();
  });

  it.each([
    ["fresh", new Date().toISOString()],
    ["stale", "2020-01-01T00:00:00.000Z"],
  ])(
    "does not trust a %s WKWebView-only request when native Preferences is empty",
    async (_label, requestedAt) => {
      window.localStorage.setItem(
        "eliza:ios-voice-selftest:request",
        JSON.stringify({
          mode: "local",
          apiBase: "eliza-local-agent://ipc",
          runId: "webview-only",
          requestedAt,
          deadlineAt: new Date(
            Date.parse(requestedAt) + 20 * 60_000,
          ).toISOString(),
        }),
      );
      const client = { setBaseUrl: vi.fn(), setToken: vi.fn() };
      await expect(
        applyIosVoiceSelfTestBootOverride({
          isIOS: true,
          client,
          getPreference: vi.fn(async () => null),
        }),
      ).resolves.toBe(false);
      expect(client.setBaseUrl).not.toHaveBeenCalled();
      expect(client.setToken).not.toHaveBeenCalled();
      expect(
        window.localStorage.getItem("eliza:mobile-runtime-mode"),
      ).toBeNull();
      expect(window.localStorage.getItem("elizaos:active-server")).toBeNull();
    },
  );

  it("rejects a local request that attempts to select a network host", () => {
    expect(() =>
      parseIosVoiceSelfTestRequest(
        JSON.stringify({
          mode: "local",
          apiBase: "http://127.0.0.1:31338",
        }),
      ),
    ).toThrow(/must use eliza-local-agent:\/\/ipc/);
  });

  it("requires current-run identity and time for authoritative local requests", () => {
    expect(() =>
      parseIosVoiceSelfTestRequest(
        JSON.stringify({
          mode: "local",
          apiBase: "eliza-local-agent://ipc",
          requestedAt: "2026-08-11T09:30:00.000Z",
        }),
      ),
    ).toThrow(/nonlegacy runId/);
    expect(() =>
      parseIosVoiceSelfTestRequest(
        JSON.stringify({
          mode: "local",
          apiBase: "eliza-local-agent://ipc",
          runId: "run-1",
          requestedAt: "not-a-time",
        }),
      ),
    ).toThrow(/valid requestedAt/);
  });

  it("rejects crash-stranded stale and implausibly future local requests", () => {
    const nowMs = Date.parse("2026-08-11T09:30:00.000Z");
    const request = (requestedAt: string) =>
      JSON.stringify({
        mode: "local",
        apiBase: "eliza-local-agent://ipc",
        runId: "run-1",
        requestedAt,
        deadlineAt: new Date(
          Date.parse(requestedAt) + 20 * 60_000,
        ).toISOString(),
      });
    expect(() =>
      parseIosVoiceSelfTestRequest(request("2026-08-11T09:14:59.999Z"), {
        nowMs,
      }),
    ).toThrow(/request is stale/);
    expect(() =>
      parseIosVoiceSelfTestRequest(request("2026-08-11T09:30:30.001Z"), {
        nowMs,
      }),
    ).toThrow(/request is from the future/);
    expect(
      parseIosVoiceSelfTestRequest(request("2026-08-11T09:15:00.000Z"), {
        nowMs,
      }).runId,
    ).toBe("run-1");
  });
});
