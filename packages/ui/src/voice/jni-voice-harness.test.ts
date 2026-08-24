// @vitest-environment jsdom
/**
 * Unit coverage for the JNI voice harness control surface
 * (`installJniVoiceHarness`) driving the real harness while the native bridge
 * plugins, local-agent client, and `JniVoicePipeline` collaborators are mocked:
 * pins lazy single-pipeline wiring and option derivation, start/stop lifecycle
 * results, the structured status fallback when the voice ABI probe fails, and
 * the 20-entry recent-turns ring buffer surfaced through `status()`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { installJniVoiceHarness } from "./jni-voice-harness";
import type {
  JniAttributedTurn,
  JniCompletedPcmTurn,
  JniVoicePipelineOptions,
} from "./jni-voice-pipeline";
import type { VoiceTurnSignal } from "./voice-turn-signal";

class FakeJniVoicePipeline {
  framesSent = 0;
  playbackFramesReceived = 0;
  lastEchoErleDb = 0;
  turnsObserved = 0;
  turnListener: ((turn: JniAttributedTurn) => void) | null = null;
  startOutcome: { started: boolean; error?: string } | { failure: unknown } = {
    started: true,
  };
  onStop: (() => void) | undefined;

  constructor(
    readonly talkMode: unknown,
    readonly voicePlugin: unknown,
    readonly options: JniVoicePipelineOptions,
  ) {
    pipelineCaptures.instances.push(this);
    if (pipelineCaptures.nextStart) {
      this.startOutcome = pipelineCaptures.nextStart;
    }
  }

  private running = false;

  get isRunning(): boolean {
    return this.running;
  }

  onTurn(listener: (turn: JniAttributedTurn) => void): () => void {
    this.turnListener = listener;
    return () => {
      this.turnListener = null;
    };
  }

  async start(): Promise<{ started: boolean; error?: string }> {
    if ("failure" in this.startOutcome) throw this.startOutcome.failure;
    if (!this.startOutcome.started) return this.startOutcome;
    this.running = true;
    return { started: true };
  }

  async stop(): Promise<void> {
    this.onStop?.();
    this.running = false;
  }
}

const pipelineCaptures: {
  instances: FakeJniVoicePipeline[];
  nextStart: { started: boolean; error?: string } | { failure: unknown } | null;
} = {
  instances: [],
  nextStart: null,
};

const shared = {
  talkModePlugin: {} as Record<string, unknown>,
  elizaVoicePlugin: { voiceAbiVersion: vi.fn() },
};

const clientState = {
  bases: [] as (string | undefined)[],
  rawRequest: vi.fn(),
};

vi.mock("../api", () => ({
  ElizaClient: class {
    rawRequest = clientState.rawRequest;

    constructor(baseUrl?: string) {
      clientState.bases.push(baseUrl);
    }
  },
}));

vi.mock("../bridge/native-plugins", () => ({
  getTalkModePlugin: () => shared.talkModePlugin,
  getElizaVoicePlugin: () => shared.elizaVoicePlugin,
}));

vi.mock("../first-run/mobile-runtime-mode", () => ({
  MOBILE_LOCAL_AGENT_API_BASE: "http://127.0.0.1:3000",
}));

vi.mock("./jni-voice-pipeline", () => ({
  JniVoicePipeline: FakeJniVoicePipeline,
}));

type JniVoiceHarnessOptions = Parameters<typeof installJniVoiceHarness>[0];

// Tests re-import the subject after vi.resetModules() so its private
// singletons (pipeline, recentTurns, installed flag) start fresh; the static
// value binding keeps the option types tied to the real source.
async function loadHarness(options: JniVoiceHarnessOptions = {}) {
  const module = await import("./jni-voice-harness");
  return module.installJniVoiceHarness(options);
}

function signalFixture(
  overrides: Partial<VoiceTurnSignal> = {},
): VoiceTurnSignal {
  return {
    endOfTurnProbability: 0.92,
    nextSpeaker: "user",
    agentShouldSpeak: false,
    source: "test",
    ...overrides,
  };
}

function attributedTurnFixture(
  overrides: Partial<JniAttributedTurn> = {},
): JniAttributedTurn {
  return {
    turnId: "t1",
    samples: 16_000,
    durationMs: 1_000,
    embeddingNorm: 1.02,
    embedding: new Float32Array(),
    diarizLabels: new Int8Array(),
    diarizDistinctClasses: 1,
    signal: signalFixture(),
    ...overrides,
  };
}

function completedPcmTurnFixture(): JniCompletedPcmTurn {
  return {
    turnId: "t1",
    audio: { pcm: new Float32Array([0.5, -0.5]), sampleRate: 16_000 },
    signal: signalFixture(),
  };
}

beforeEach(() => {
  vi.resetModules();
  pipelineCaptures.instances.length = 0;
  pipelineCaptures.nextStart = null;
  clientState.bases.length = 0;
  clientState.rawRequest = vi.fn();
  shared.talkModePlugin = {};
  shared.elizaVoicePlugin = { voiceAbiVersion: vi.fn() };
  window.__jniVoice = undefined;
});

describe("installJniVoiceHarness window attachment", () => {
  it("attaches the first control to window.__jniVoice and keeps it stable across reinstalls", async () => {
    const first = await loadHarness();
    expect(window.__jniVoice).toBe(first);

    const second = await loadHarness();
    expect(second).not.toBe(first);
    expect(window.__jniVoice).toBe(first);

    expect(await second.status()).toEqual(await first.status());
  });
});

describe("pipeline wiring and lifecycle", () => {
  it("constructs the pipeline lazily on first use with the bridge plugins and derived options", async () => {
    const control = await loadHarness({
      bundleDir: "/data/eliza-1/bundle",
      knownSpeakerEntityIds: ["owner-1"],
    });
    expect(pipelineCaptures.instances).toHaveLength(0);

    await control.start();

    expect(pipelineCaptures.instances).toHaveLength(1);
    const instance = pipelineCaptures.instances[0];
    if (!instance) throw new Error("pipeline was not constructed");
    expect(instance.talkMode).toBe(shared.talkModePlugin);
    expect(instance.voicePlugin).toBe(shared.elizaVoicePlugin);
    expect(instance.options.bundleDir).toBe("/data/eliza-1/bundle");
    expect(instance.options.knownSpeakerEntityIds).toEqual(["owner-1"]);
    expect(typeof instance.options.onCompletedPcmTurn).toBe("function");
  });

  it("reuses one pipeline across installs and later starts, ignoring later options", async () => {
    const first = await loadHarness({ bundleDir: "/first" });
    await first.start();

    const second = await loadHarness({ bundleDir: "/second" });
    await expect(second.start()).resolves.toEqual({ started: true });

    expect(pipelineCaptures.instances).toHaveLength(1);
    expect(pipelineCaptures.instances[0]?.options.bundleDir).toBe("/first");
    expect(second.isRunning()).toBe(true);
  });

  it("strips the completed-turn forwarder when forwarding is disabled", async () => {
    const control = await loadHarness({ forwardCompletedPcmTurns: false });
    await control.start();

    expect(
      pipelineCaptures.instances[0]?.options.onCompletedPcmTurn,
    ).toBeUndefined();
  });

  it("passes an explicit completed-turn handler through by reference even when forwarding is disabled", async () => {
    const explicit = vi.fn();
    const control = await loadHarness({
      onCompletedPcmTurn: explicit,
      forwardCompletedPcmTurns: false,
    });
    await control.start();

    expect(pipelineCaptures.instances[0]?.options.onCompletedPcmTurn).toBe(
      explicit,
    );
  });

  it("returns a failed capture result verbatim and leaves forwarding inert", async () => {
    pipelineCaptures.nextStart = { started: false, error: "mic busy" };
    const control = await loadHarness();

    await expect(control.start()).resolves.toEqual({
      started: false,
      error: "mic busy",
    });
    expect(control.isRunning()).toBe(false);

    const instance = pipelineCaptures.instances[0];
    if (!instance) throw new Error("pipeline was not constructed");
    const forwarded = instance.options.onCompletedPcmTurn;
    if (!forwarded) throw new Error("forwarder missing");
    await expect(forwarded(completedPcmTurnFixture())).resolves.toBeUndefined();
    expect(clientState.rawRequest).not.toHaveBeenCalled();
  });

  it("propagates a throwing pipeline start", async () => {
    pipelineCaptures.nextStart = { failure: new Error("native crash") };
    const control = await loadHarness();

    await expect(control.start()).rejects.toThrow("native crash");
    expect(control.isRunning()).toBe(false);
  });

  it("stop reports the frame count captured before stopping", async () => {
    const control = await loadHarness();
    await control.start();
    const instance = pipelineCaptures.instances[0];
    if (!instance) throw new Error("pipeline was not constructed");
    instance.framesSent = 7;
    instance.onStop = () => {
      instance.framesSent = 99;
    };

    await expect(control.stop()).resolves.toEqual({
      stopped: true,
      framesSent: 7,
    });
    expect(control.isRunning()).toBe(false);
    expect(instance.framesSent).toBe(99);
  });
});

describe("status reporting", () => {
  it.each([
    ["an Error rejection", new Error("bridge offline"), "bridge offline"],
    ["a non-Error rejection", "bridge unavailable", "bridge unavailable"],
  ])(
    "reports structured defaults with %s from the ABI probe before the pipeline exists",
    async (_label, rejection, expectedError) => {
      shared.elizaVoicePlugin.voiceAbiVersion.mockRejectedValueOnce(rejection);
      const control = await loadHarness();

      const status = await control.status();

      expect(status.running).toBe(false);
      expect(status.framesSent).toBe(0);
      expect(status.playbackFramesReceived).toBe(0);
      expect(status.lastEchoErleDb).toBe(0);
      expect(status.turnsObserved).toBe(0);
      expect(status.recentTurns).toEqual([]);
      expect(status.error).toBe(expectedError);
      expect("abi" in status).toBe(false);
    },
  );

  it("aggregates live pipeline counters, recorded turns, and the voice ABI", async () => {
    const abi = { loaded: true, vad: 1, speaker: 1, diariz: 1 };
    shared.elizaVoicePlugin.voiceAbiVersion.mockResolvedValueOnce(abi);
    const control = await loadHarness();
    await control.start();

    const instance = pipelineCaptures.instances[0];
    if (!instance) throw new Error("pipeline was not constructed");
    instance.framesSent = 3;
    instance.playbackFramesReceived = 5;
    instance.lastEchoErleDb = -8.25;
    instance.turnsObserved = 4;
    instance.turnListener?.(
      attributedTurnFixture({
        turnId: "t9",
        durationMs: 1_500,
        embeddingNorm: 0.97,
        diarizDistinctClasses: 2,
        signal: signalFixture({
          agentShouldSpeak: true,
          nextSpeaker: "agent",
        }),
      }),
    );

    const status = await control.status();

    expect(status.running).toBe(true);
    expect(status.framesSent).toBe(3);
    expect(status.playbackFramesReceived).toBe(5);
    expect(status.lastEchoErleDb).toBe(-8.25);
    expect(status.turnsObserved).toBe(4);
    expect(status.abi).toEqual(abi);
    expect("error" in status).toBe(false);
    expect(status.recentTurns).toEqual([
      {
        turnId: "t9",
        durationMs: 1_500,
        embeddingNorm: 0.97,
        diarizDistinctClasses: 2,
        agentShouldSpeak: true,
        nextSpeaker: "agent",
      },
    ]);
  });

  it("caps recentTurns at twenty entries and drops the oldest first", async () => {
    const control = await loadHarness();
    await control.start();
    const instance = pipelineCaptures.instances[0];
    if (!instance) throw new Error("pipeline was not constructed");

    for (let index = 1; index <= 22; index += 1) {
      instance.turnListener?.(
        attributedTurnFixture({
          turnId: `t${String(index).padStart(2, "0")}`,
        }),
      );
    }

    const status = await control.status();
    expect(status.recentTurns).toHaveLength(20);
    expect(status.recentTurns[0]?.turnId).toBe("t03");
    expect(status.recentTurns.at(-1)?.turnId).toBe("t22");
  });

  it("returns defensive copies of recentTurns on every status read", async () => {
    const control = await loadHarness();
    await control.start();
    const instance = pipelineCaptures.instances[0];
    if (!instance) throw new Error("pipeline was not constructed");
    instance.turnListener?.(attributedTurnFixture({ turnId: "only" }));

    const first = await control.status();
    first.recentTurns.pop();

    const second = await control.status();
    expect(second.recentTurns).toHaveLength(1);
    expect(second.recentTurns[0]?.turnId).toBe("only");
    expect(second.recentTurns).not.toBe(first.recentTurns);
  });
});
