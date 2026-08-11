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
    vi.resetModules();
    vi.clearAllMocks();
    window.localStorage.clear();
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

  it("echoes traceId and mode in all results when mode:'local' request is staged (finding #1 + #4)", async () => {
    const { runIosVoiceSelfTestSmokeIfRequested } = await import(
      "./ios-voice-selftest-smoke"
    );
    const writes: Array<[string, Record<string, unknown>]> = [];
    const traceId = "voice-local-test-12345";
    const requestTimestamp = Date.now();
    const requestJson = JSON.stringify({
      mode: "local",
      apiBase: "eliza-local-agent://ipc",
      traceId,
      requestTimestamp,
    });
    window.localStorage.setItem(
      "eliza:ios-voice-selftest:request",
      requestJson,
    );
    // Verify localStorage is set
    expect(
      window.localStorage.getItem("eliza:ios-voice-selftest:request"),
    ).toBe(requestJson);

    const started = await runIosVoiceSelfTestSmokeIfRequested({
      isIOS: true,
      client: {} as never,
      getPreference: vi.fn(async () => null),
      removePreference: vi.fn(async () => {}),
      writeResult: vi.fn(async (key, result) => {
        writes.push([key, result]);
      }),
      readStorageSnapshot: () => ({}),
    });

    expect(started).toBe(true);
    // Every result written must echo the traceId and mode from the request
    for (const [key, result] of writes) {
      expect(key).toBe("eliza:ios-voice-selftest:result");
      expect(result.traceId).toBe(traceId);
      expect(result.mode).toBe("local");
    }
    // A terminal result must exist (either complete or failed)
    const terminal = writes.find(
      (w) => w[1].phase === "complete" || w[1].phase === "failed",
    );
    expect(terminal).toBeDefined();
  });
});
