/**
 * Exercises the native Preferences handshake for the iOS voice self-test smoke
 * from jsdom. The real simulator lane owns ASR, agent, and TTS proof; this test
 * protects the host contract that every staged request ends with a terminal
 * result for the orchestrator to poll.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runVoiceSelfTest: vi.fn(),
}));

vi.mock("@elizaos/ui/voice", () => ({
  EXPECTED_PHRASE: "what time is it",
  KNOWN_PHRASE_WAV_DATA_URL: "data:audio/wav;base64,AA==",
  runVoiceSelfTest: mocks.runVoiceSelfTest,
}));

describe("runIosVoiceSelfTestSmokeIfRequested", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("waits through delayed local readiness then invokes the exact production path once", async () => {
    const { runIosVoiceSelfTestSmokeIfRequested } = await import(
      "./ios-voice-selftest-smoke"
    );
    const request = JSON.stringify({
      mode: "local",
      apiBase: "eliza-local-agent://ipc",
      runId: "run-ready",
      requestedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    });
    class FakeAudioContext {
      state = "running" as const;
      close = vi.fn(async () => undefined);
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const client = {
      getBaseUrl: vi.fn(() => "eliza-local-agent://ipc"),
      getStatus: vi
        .fn()
        .mockResolvedValueOnce({
          state: "running",
          canRespond: false,
          model: undefined,
        })
        .mockResolvedValueOnce({
          state: "running",
          canRespond: true,
          model: "eliza-1-2b",
        }),
      fetch: vi
        .fn()
        .mockResolvedValueOnce({ ready: false, provider: null })
        .mockResolvedValueOnce({
          ready: true,
          provider: "local-inference",
        }),
    };
    mocks.runVoiceSelfTest.mockResolvedValue({
      schemaVersion: 1,
      overall: "pass",
      platform: "ios",
      mode: "wav-direct",
      ttsRoute: "/api/tts/local-inference",
      expectedPhrase: "what time is it",
      transcript: "what time is it",
      reply: "It is noon.",
      sendBackend: "local-inference:eliza-1-2b",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      stages: [
        { stage: "asr", status: "pass", durationMs: 1, detail: {} },
        { stage: "send", status: "pass", durationMs: 1, detail: {} },
        { stage: "tts", status: "pass", durationMs: 1, detail: {} },
      ],
    });
    const writes: Array<Record<string, unknown>> = [];

    await expect(
      runIosVoiceSelfTestSmokeIfRequested({
        isIOS: true,
        client: client as never,
        getPreference: vi.fn(async () => request),
        removePreference: vi.fn(async () => undefined),
        writeResult: vi.fn(async (_key, result) => {
          writes.push(result);
        }),
        readStorageSnapshot: () => ({
          "eliza:mobile-runtime-mode": "local",
          "eliza:first-run-complete": "1",
          "elizaos:active-server": JSON.stringify({
            id: "local:mobile",
            kind: "remote",
            label: "On-device agent",
            apiBase: "eliza-local-agent://ipc",
          }),
        }),
        localReadiness: { maxAttempts: 3, delayMs: 0 },
      }),
    ).resolves.toBe(true);

    expect(client.getStatus).toHaveBeenCalledTimes(2);
    expect(mocks.runVoiceSelfTest).toHaveBeenCalledTimes(1);
    expect(mocks.runVoiceSelfTest).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "ios",
        mode: "wav-direct",
        ttsRoute: "/api/tts/local-inference",
        client,
      }),
    );
    expect(writes.at(-1)).toMatchObject({ ok: true, phase: "complete" });
  });

  it("records a terminal failure without running production voice when local readiness never arrives", async () => {
    const { runIosVoiceSelfTestSmokeIfRequested } = await import(
      "./ios-voice-selftest-smoke"
    );
    const request = JSON.stringify({
      mode: "local",
      apiBase: "eliza-local-agent://ipc",
      runId: "run-unready",
      requestedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    });
    const writes: Array<Record<string, unknown>> = [];
    const client = {
      getBaseUrl: vi.fn(() => "eliza-local-agent://ipc"),
      getStatus: vi.fn(async () => ({
        state: "starting",
        canRespond: false,
        model: undefined,
      })),
      fetch: vi.fn(async () => ({ ready: false, provider: null })),
    };

    await runIosVoiceSelfTestSmokeIfRequested({
      isIOS: true,
      client: client as never,
      getPreference: vi.fn(async () => request),
      removePreference: vi.fn(async () => undefined),
      writeResult: vi.fn(async (_key, result) => {
        writes.push(result);
      }),
      readStorageSnapshot: () => ({
        "eliza:mobile-runtime-mode": "local",
        "eliza:first-run-complete": "1",
        "elizaos:active-server": JSON.stringify({
          id: "local:mobile",
          kind: "remote",
          label: "On-device agent",
          apiBase: "eliza-local-agent://ipc",
        }),
      }),
      localReadiness: { maxAttempts: 2, delayMs: 0 },
    });

    expect(mocks.runVoiceSelfTest).not.toHaveBeenCalled();
    expect(writes.at(-1)).toMatchObject({
      ok: false,
      phase: "failed",
      runId: "run-unready",
    });
    expect(String(writes.at(-1)?.error)).toContain(
      "local voice runtime did not become ready",
    );
  });

  it("writes a terminal failed result when the staged request JSON is malformed", async () => {
    const { runIosVoiceSelfTestSmokeIfRequested } = await import(
      "./ios-voice-selftest-smoke"
    );
    const writes: Array<[string, Record<string, unknown>]> = [];
    const removals: string[] = [];
    window.localStorage.setItem(
      "eliza:ios-voice-selftest:request",
      "{not-json",
    );

    const started = await runIosVoiceSelfTestSmokeIfRequested({
      isIOS: true,
      client: {} as never,
      getPreference: vi.fn(async () => null),
      removePreference: vi.fn(async (key) => {
        removals.push(key);
      }),
      writeResult: vi.fn(async (key, result) => {
        writes.push([key, result]);
      }),
      readStorageSnapshot: () => ({ request: "{not-json" }),
    });

    expect(started).toBe(true);
    expect(mocks.runVoiceSelfTest).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe("eliza:ios-voice-selftest:result");
    expect(writes[0][1]).toMatchObject({
      ok: false,
      phase: "failed",
      apiBase: "http://127.0.0.1:31338",
    });
    expect(String(writes[0][1].error)).toContain(
      "Invalid iOS voice self-test request",
    );
    expect(
      window.localStorage.getItem("eliza:ios-voice-selftest:request"),
    ).toBe(null);
    expect(removals).toEqual(["eliza:ios-voice-selftest:request"]);
  });

  it("records and cleans a stale native request after boot safely ignores it", async () => {
    const { runIosVoiceSelfTestSmokeIfRequested } = await import(
      "./ios-voice-selftest-smoke"
    );
    const stale = JSON.stringify({
      mode: "local",
      apiBase: "eliza-local-agent://ipc",
      runId: "stale-run",
      requestedAt: "2020-01-01T00:00:00.000Z",
      deadlineAt: "2020-01-01T00:20:00.000Z",
    });
    const writes: Array<Record<string, unknown>> = [];
    const removePreference = vi.fn(async () => undefined);
    await runIosVoiceSelfTestSmokeIfRequested({
      isIOS: true,
      client: {} as never,
      getPreference: vi.fn(async () => stale),
      removePreference,
      writeResult: vi.fn(async (_key, result) => {
        writes.push(result);
      }),
      readStorageSnapshot: () => ({}),
    });
    expect(mocks.runVoiceSelfTest).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ ok: false, phase: "failed" });
    expect(String(writes[0].error)).toContain("request is stale");
    expect(removePreference).toHaveBeenCalledWith(
      "eliza:ios-voice-selftest:request",
    );
  });
});
