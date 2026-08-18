/**
 * Exercises the production completed-turn callback through its dedicated
 * local-agent ElizaClient while JNI/native collaborators are mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clientBase: undefined as string | undefined,
  rawRequest: vi.fn(),
  completedTurn: undefined as
    | ((turn: {
        turnId: string;
        audio: { pcm: Float32Array; sampleRate: number };
        signal: unknown;
      }) => Promise<void>)
    | undefined,
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

    constructor(
      _talkMode: unknown,
      _elizaVoice: unknown,
      options: { onCompletedPcmTurn?: typeof mocks.completedTurn },
    ) {
      mocks.completedTurn = options.onCompletedPcmTurn;
    }

    onTurn(): void {}

    async start(): Promise<{ started: boolean }> {
      return { started: true };
    }
  },
}));

import { installJniVoiceHarness } from "./jni-voice-harness";

const TURN = {
  turnId: "t1",
  audio: { pcm: new Float32Array([0.5, -0.5]), sampleRate: 16_000 },
  signal: { agentShouldSpeak: false, nextSpeaker: "user" },
};

async function getCompletedTurnCallback() {
  await installJniVoiceHarness().start();
  if (!mocks.completedTurn) {
    throw new Error("JNI pipeline did not receive onCompletedPcmTurn");
  }
  return mocks.completedTurn;
}

describe("jni-voice-harness native PCM turn deadline", () => {
  beforeEach(() => {
    mocks.rawRequest.mockReset();
  });

  it("pins the production handoff to the bounded local-agent client", async () => {
    mocks.rawRequest.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      (await getCompletedTurnCallback())(TURN),
    ).resolves.toBeUndefined();

    expect(mocks.clientBase).toBe("http://127.0.0.1:3000");
    expect(mocks.rawRequest).toHaveBeenCalledWith(
      "/api/voice/native-pcm-turn",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: expect.any(String),
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

    await expect((await getCompletedTurnCallback())(TURN)).rejects.toBe(
      timeout,
    );
  });
});
