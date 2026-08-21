/**
 * Exercises the production completed-turn callback through its dedicated
 * local-agent ElizaClient while JNI/native collaborators are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface TestTurn {
  turnId: string;
  audio: { pcm: Float32Array; sampleRate: number };
  signal: unknown;
}

const mocks = vi.hoisted(() => ({
  clientBase: undefined as string | undefined,
  rawRequest: vi.fn(),
  completedTurn: undefined as ((turn: TestTurn) => Promise<void>) | undefined,
  stopTurn: undefined as TestTurn | undefined,
}));

vi.mock("../api", () => ({
  ElizaClient: class {
    rawRequest = mocks.rawRequest;

    constructor(baseUrl?: string) {
      mocks.clientBase = baseUrl;
    }
  },
}));

vi.mock("../bridge/native-plugins", () => ({
  getElizaVoicePlugin: () => ({}),
  getTalkModePlugin: () => ({}),
}));

vi.mock("../first-run/mobile-runtime-mode", () => ({
  MOBILE_LOCAL_AGENT_API_BASE: "http://127.0.0.1:3000",
}));

vi.mock("./jni-voice-pipeline", () => ({
  JniVoicePipeline: class {
    framesSent = 0;
    isRunning = false;

    constructor(
      _talkMode: unknown,
      _elizaVoice: unknown,
      options: { onCompletedPcmTurn?: typeof mocks.completedTurn },
    ) {
      mocks.completedTurn = options.onCompletedPcmTurn;
    }

    onTurn(): void {}

    async start(): Promise<{ started: boolean }> {
      this.isRunning = true;
      return { started: true };
    }

    async stop(): Promise<void> {
      this.isRunning = false;
      const turn = mocks.stopTurn;
      mocks.stopTurn = undefined;
      if (turn) void mocks.completedTurn?.(turn);
    }
  },
}));

import { installJniVoiceHarness } from "./jni-voice-harness";

const TURN = {
  turnId: "t1",
  audio: { pcm: new Float32Array([0.5, -0.5]), sampleRate: 16_000 },
  signal: { agentShouldSpeak: false, nextSpeaker: "user" },
};

async function startHarness() {
  const control = installJniVoiceHarness();
  await control.start();
  if (!mocks.completedTurn) {
    throw new Error("JNI pipeline did not receive onCompletedPcmTurn");
  }
  return { control, completedTurn: mocks.completedTurn };
}

describe("jni-voice-harness native PCM turn deadline", () => {
  let stopHarness: (() => Promise<unknown>) | undefined;

  beforeEach(() => {
    mocks.rawRequest.mockReset();
    mocks.stopTurn = undefined;
  });

  afterEach(async () => {
    await stopHarness?.();
    stopHarness = undefined;
    vi.useRealTimers();
  });

  it("pins the production handoff to the bounded local-agent client", async () => {
    mocks.rawRequest.mockResolvedValue(new Response(null, { status: 204 }));

    const { control, completedTurn } = await startHarness();
    stopHarness = () => control.stop();
    await expect(completedTurn(TURN)).resolves.toBeUndefined();

    expect(mocks.clientBase).toBe("http://127.0.0.1:3000");
    expect(mocks.rawRequest).toHaveBeenCalledWith(
      "/api/voice/native-pcm-turn",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: expect.any(String),
        signal: expect.any(AbortSignal),
      },
      { timeoutMs: 15_000 },
    );
    const body = JSON.parse(
      mocks.rawRequest.mock.calls[0]?.[1]?.body as string,
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      turnId: "t1",
      sampleRate: 16_000,
      signal: TURN.signal,
    });
    expect(typeof body.pcm).toBe("string");
  });

  it("surfaces a bounded-client failure to the JNI pipeline", async () => {
    const timeout = new Error("Request timed out after 15000ms");
    mocks.rawRequest.mockRejectedValue(timeout);

    const { control, completedTurn } = await startHarness();
    stopHarness = () => control.stop();
    await expect(completedTurn(TURN)).rejects.toBe(timeout);
  });

  it("keeps the deadline active while consuming a successful response body", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    mocks.rawRequest.mockImplementation(
      async (_path: string, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Response(
          new ReadableStream({
            start() {},
          }),
        );
      },
    );

    const { control, completedTurn } = await startHarness();
    stopHarness = () => control.stop();
    const handoff = completedTurn(TURN);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(handoff).rejects.toMatchObject({ name: "TimeoutError" });
    expect(requestSignal?.reason).toMatchObject({ name: "TimeoutError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an in-flight body read when the harness stops", async () => {
    let cancelledWith: unknown;
    let requestSignal: AbortSignal | undefined;
    mocks.rawRequest.mockImplementation(
      async (_path: string, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Response(
          new ReadableStream({
            start() {},
            cancel(reason) {
              cancelledWith = reason;
            },
          }),
        );
      },
    );

    const { control, completedTurn } = await startHarness();
    const handoff = completedTurn(TURN);
    const stopped = control.stop();

    await expect(handoff).rejects.toMatchObject({ name: "AbortError" });
    await expect(stopped).resolves.toMatchObject({ stopped: true });
    expect(requestSignal?.reason).toMatchObject({ name: "AbortError" });
    expect(cancelledWith).toBe(requestSignal?.reason);
  });

  it("waits for the final flushed PCM turn before completing stop", async () => {
    let finishRequest!: (response: Response) => void;
    const requestStarted = new Promise<void>((resolve) => {
      mocks.rawRequest.mockImplementation(
        () =>
          new Promise<Response>((finish) => {
            finishRequest = finish;
            resolve();
          }),
      );
    });
    const { control } = await startHarness();
    mocks.stopTurn = TURN;
    let stopped = false;

    const stopping = control.stop().then(() => {
      stopped = true;
    });
    await requestStarted;
    expect(stopped).toBe(false);
    finishRequest(new Response(null, { status: 204 }));
    await stopping;

    expect(stopped).toBe(true);
  });
});
