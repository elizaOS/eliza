/**
 * Unit coverage for installDiarizationPumpHarness, the on-device diarization
 * verification control: inert off-window behavior, one-shot window
 * attachment, lazy single-pump wiring to the TalkMode plugin, stop-time
 * frame-count snapshotting, live isRunning mirroring, and the bounded
 * local-agent status request. The harness logic runs for real; its native,
 * client, and pump collaborators are stubbed in-module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => {
  const clientState = {
    baseUrl: undefined as string | undefined,
    fetchImpl: (async () => ({ ok: true })) as (
      ...args: unknown[]
    ) => Promise<unknown>,
  };
  class StubElizaClient {
    constructor(baseUrl?: string) {
      clientState.baseUrl = baseUrl;
    }
    fetch(...args: unknown[]) {
      return clientState.fetchImpl(...args);
    }
  }
  return { __clientState: clientState, ElizaClient: StubElizaClient };
});

vi.mock("../bridge/native-plugins", () => {
  const stubTalkModePlugin = { id: "stub-talk-mode-plugin" };
  return {
    __stubTalkModePlugin: stubTalkModePlugin,
    getTalkModePlugin: () => stubTalkModePlugin,
  };
});

vi.mock("../first-run/mobile-runtime-mode", () => ({
  MOBILE_LOCAL_AGENT_API_BASE: "http://127.0.0.1:3000",
}));

vi.mock("./audio-frame-pump", () => {
  class StubAudioFramePump {
    static instances: StubAudioFramePump[] = [];
    readonly talkModePlugin: unknown;
    isRunning = false;
    framesSent = 0;
    startCalls = 0;
    stopCalls = 0;
    nextStartResult: {
      started: boolean;
      suspendedStt?: boolean;
      error?: string;
    } = { started: true };
    constructor(talkModePlugin: unknown) {
      this.talkModePlugin = talkModePlugin;
      StubAudioFramePump.instances.push(this);
    }
    async start() {
      this.startCalls += 1;
      this.isRunning = this.nextStartResult.started;
      return this.nextStartResult;
    }
    async stop() {
      this.stopCalls += 1;
      this.framesSent += 1;
      this.isRunning = false;
      return { stopped: true };
    }
  }
  return { AudioFramePump: StubAudioFramePump };
});

import * as apiModule from "../api";
import * as nativePlugins from "../bridge/native-plugins";
import { installDiarizationPumpHarness } from "./audio-frame-diarization-harness";
import { AudioFramePump } from "./audio-frame-pump";

interface StubClientState {
  baseUrl: string | undefined;
  fetchImpl: (...args: unknown[]) => Promise<unknown>;
}

interface StubPumpInstance {
  talkModePlugin: unknown;
  isRunning: boolean;
  framesSent: number;
  startCalls: number;
  stopCalls: number;
  nextStartResult: { started: boolean; suspendedStt?: boolean; error?: string };
}

interface StubPumpConstructor {
  instances: StubPumpInstance[];
  new (talkModePlugin: unknown): StubPumpInstance;
}

const clientState = (apiModule as unknown as { __clientState: StubClientState })
  .__clientState;
const stubTalkModePlugin = (
  nativePlugins as unknown as { __stubTalkModePlugin: unknown }
).__stubTalkModePlugin;
const PumpStub = AudioFramePump as unknown as StubPumpConstructor;

function currentPump(): StubPumpInstance {
  return PumpStub.instances[PumpStub.instances.length - 1];
}

function installedWindowControl(): unknown {
  return (globalThis as { window?: { __diarizationPump?: unknown } }).window
    ?.__diarizationPump;
}

describe("installDiarizationPumpHarness", () => {
  describe("without a window", () => {
    it("returns a usable control and defers all pump construction", () => {
      expect(typeof window).toBe("undefined");

      const control = installDiarizationPumpHarness();

      expect(control.isRunning()).toBe(false);
      expect(PumpStub.instances).toHaveLength(0);
    });
  });

  describe("window attachment", () => {
    beforeEach(() => {
      (globalThis as { window?: unknown }).window = {};
    });

    afterEach(() => {
      delete (globalThis as { window?: unknown }).window;
    });

    it("attaches the first control and keeps it stable across re-installs", () => {
      const first = installDiarizationPumpHarness();
      expect(installedWindowControl()).toBe(first);

      const second = installDiarizationPumpHarness();
      expect(installedWindowControl()).toBe(first);
      expect(second).not.toBe(first);

      const fromWindow = installedWindowControl() as ReturnType<
        typeof installDiarizationPumpHarness
      >;
      expect(fromWindow).toBe(first);
      expect(fromWindow.isRunning).toBeTypeOf("function");
      expect(fromWindow.status).toBeTypeOf("function");
      expect(second.isRunning()).toBe(false);
    });
  });

  describe("status transport", () => {
    it("routes status through the bounded local-agent client", async () => {
      const payload = { libLoaded: true, framesReceived: 2, turns: [] };
      const fetchImpl = vi.fn(async () => payload);
      clientState.fetchImpl = fetchImpl;

      const control = installDiarizationPumpHarness();
      await expect(control.status()).resolves.toBe(payload);

      expect(clientState.baseUrl).toBe("http://127.0.0.1:3000");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledWith(
        "/api/voice/audio-frames/status",
        { method: "GET", headers: { accept: "application/json" } },
        { timeoutMs: 15_000 },
      );
    });

    it("surfaces bounded-client failures untouched", async () => {
      const boom = new Error("status hop timed out");
      clientState.fetchImpl = async () => {
        throw boom;
      };

      const control = installDiarizationPumpHarness();
      await expect(control.status()).rejects.toBe(boom);
    });
  });

  describe("pump lifecycle", () => {
    it("builds one pump lazily on first use, wired to the TalkMode plugin", async () => {
      const control = installDiarizationPumpHarness();
      const before = PumpStub.instances.length;

      await expect(control.start()).resolves.toEqual({ started: true });

      expect(PumpStub.instances).toHaveLength(before + 1);
      expect(currentPump().talkModePlugin).toBe(stubTalkModePlugin);
      expect(currentPump().startCalls).toBe(1);
    });

    it("reuses the same pump across calls and passes results through live", async () => {
      const control = installDiarizationPumpHarness();
      const before = PumpStub.instances.length;
      const pump = currentPump();
      const startCallsBefore = pump.startCalls;
      pump.nextStartResult = { started: false, error: "capture denied" };

      await expect(control.start()).resolves.toEqual({
        started: false,
        error: "capture denied",
      });

      expect(PumpStub.instances).toHaveLength(before);
      expect(pump.startCalls).toBe(startCallsBefore + 1);
    });

    it("reports the frame count captured before teardown runs", async () => {
      const control = installDiarizationPumpHarness();
      const pump = currentPump();
      const stopCallsBefore = pump.stopCalls;
      pump.framesSent = 6;

      await expect(control.stop()).resolves.toEqual({
        stopped: true,
        framesSent: 6,
      });

      expect(pump.stopCalls).toBe(stopCallsBefore + 1);
      expect(pump.framesSent).toBe(7);
    });

    it("mirrors the live pump's running state", () => {
      const control = installDiarizationPumpHarness();
      const pump = currentPump();

      pump.isRunning = true;
      expect(control.isRunning()).toBe(true);

      pump.isRunning = false;
      expect(control.isRunning()).toBe(false);
    });
  });
});
