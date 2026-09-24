/**
 * Exercises FusedWakeManager start, stop, failure reasons, frame rebuffering,
 * and renderer forwarding against a deterministic voice-wake collaborator.
 * Native libwakeword and DesktopMicSource stay faked; the manager is real.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const VOICE_WAKE_EXPORTS = [
  "bridgeDetectorToFusedWake",
  "DesktopMicSource",
  "OpenWakeWordDetector",
  "OpenWakeWordGgmlModel",
  "resolveWakeWordStandalonePaths",
] as const;

const runtime = vi.hoisted(() => ({
  distPath: "/tmp/eliza-fused-wake-missing-runtime",
}));

const harness = vi.hoisted(() => {
  const STAGED_PATHS = {
    libraryPath: "/tmp/libwakeword.so",
    melspec: "/tmp/hey-eliza.melspec.gguf",
    embedding: "/tmp/hey-eliza.embedding.gguf",
    classifier: "/tmp/hey-eliza.classifier.gguf",
  };
  type MicOpts = {
    sampleRate: number;
    program?: string;
    argv?: string[];
  };
  type LoadOpts = {
    libraryPath: string;
    paths: {
      melspec: string;
      embedding: string;
      classifier: string;
    };
    config?: { threshold: number };
  };
  type DetectorOpts = {
    model: {
      frameSamples: number;
      sampleRate: number;
      scoreFrame: (frame: Float32Array) => Promise<number>;
      reset: () => void;
      close: () => void;
    };
    config?: { threshold: number };
    onWake: (info: { confidence: number }) => void;
  };

  const state = {
    importError: null as unknown,
    paths: STAGED_PATHS as typeof STAGED_PATHS | null,
    loadError: null as unknown,
    micStartError: null as unknown,
    micStopError: null as unknown,
    frameSamples: 4,
    loadCalls: [] as LoadOpts[],
    detectorOpts: [] as DetectorOpts[],
    micOpts: [] as MicOpts[],
    pushFrames: [] as Float32Array[],
    unsubCount: 0,
    closeCount: 0,
    startCount: 0,
    stopCount: 0,
    frameListener: null as ((frame: { pcm: Float32Array }) => void) | null,
    onWake: null as ((info: { confidence: number }) => void) | null,
  };

  function restoreNamespace(): void {
    namespace.bridgeDetectorToFusedWake = (
      sink: (event: { stage: string; confidence: number }) => void,
    ) => {
      return (info: { confidence: number }) => {
        sink({ stage: "head-fired", confidence: info.confidence });
      };
    };
    namespace.DesktopMicSource = class DesktopMicSource {
      constructor(opts: MicOpts) {
        state.micOpts.push(opts);
      }
      onFrame(listener: (frame: { pcm: Float32Array }) => void): () => void {
        state.frameListener = listener;
        return () => {
          state.unsubCount += 1;
        };
      }
      async start(): Promise<void> {
        state.startCount += 1;
        if (state.micStartError !== null) throw state.micStartError;
      }
      async stop(): Promise<void> {
        state.stopCount += 1;
        if (state.micStopError !== null) throw state.micStopError;
      }
    };
    namespace.OpenWakeWordDetector = class OpenWakeWordDetector {
      constructor(opts: DetectorOpts) {
        state.detectorOpts.push(opts);
        state.onWake = opts.onWake;
      }
      async pushFrame(frame: Float32Array): Promise<void> {
        state.pushFrames.push(frame);
      }
    };
    function OpenWakeWordGgmlModel() {}
    OpenWakeWordGgmlModel.load = async (opts: LoadOpts) => {
      state.loadCalls.push(opts);
      if (state.loadError !== null) throw state.loadError;
      return {
        frameSamples: state.frameSamples,
        sampleRate: 16_000,
        async scoreFrame(): Promise<number> {
          return 0;
        },
        reset(): void {},
        close(): void {
          state.closeCount += 1;
        },
        activeBackend(): string {
          return "test";
        },
      };
    };
    namespace.OpenWakeWordGgmlModel = OpenWakeWordGgmlModel;
    namespace.resolveWakeWordStandalonePaths = (opts: { head?: string }) => {
      void opts;
      return state.paths;
    };
  }

  const raw: Record<string, unknown> = {};
  const namespace: Record<string, unknown> = new Proxy(raw, {
    get(target, prop, receiver) {
      if (
        state.importError !== null &&
        typeof prop === "string" &&
        prop !== "__esModule" &&
        prop !== "default"
      ) {
        throw state.importError;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  restoreNamespace();

  return {
    STAGED_PATHS,
    state,
    namespace,
    restoreNamespace,
    reset() {
      state.importError = null;
      state.paths = { ...STAGED_PATHS };
      state.loadError = null;
      state.micStartError = null;
      state.micStopError = null;
      state.frameSamples = 4;
      state.loadCalls = [];
      state.detectorOpts = [];
      state.micOpts = [];
      state.pushFrames = [];
      state.unsubCount = 0;
      state.closeCount = 0;
      state.startCount = 0;
      state.stopCount = 0;
      state.frameListener = null;
      state.onWake = null;
      restoreNamespace();
    },
  };
});

vi.mock("./agent", () => ({
  resolveRuntimeDistPath: () => runtime.distPath,
}));

vi.mock("@elizaos/plugin-local-inference/voice-wake", () => {
  if (harness.state.importError !== null) {
    throw harness.state.importError;
  }
  return harness.namespace;
});

const originalMicProgram = process.env.ELIZA_FUSED_WAKE_MIC_PROGRAM;
const originalMicArgv = process.env.ELIZA_FUSED_WAKE_MIC_ARGV;
const tempRoots: string[] = [];

async function loadFusedWake() {
  return import("./fused-wake");
}

const BUNDLED_VOICE_WAKE_JS = `
export function bridgeDetectorToFusedWake(sink) {
  return (info) => sink({ stage: "head-fired", confidence: info.confidence });
}
export class DesktopMicSource {
  constructor(opts) { this.opts = opts; }
  onFrame() { return () => {}; }
  async start() {}
  async stop() {}
}
export class OpenWakeWordDetector {
  constructor(opts) { this.opts = opts; }
  async pushFrame() {}
}
export class OpenWakeWordGgmlModel {
  static async load() {
    return {
      frameSamples: 4,
      sampleRate: 16000,
      async scoreFrame() { return 0; },
      reset() {},
      close() {},
      activeBackend() { return "bundled"; },
    };
  }
}
export function resolveWakeWordStandalonePaths() {
  return {
    libraryPath: "/bundled/libwakeword.so",
    melspec: "/bundled/melspec.gguf",
    embedding: "/bundled/embedding.gguf",
    classifier: "/bundled/classifier.gguf",
  };
}
`;

function writeBundledVoiceWake(source: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fused-wake-runtime-"));
  tempRoots.push(root);
  const destDir = path.join(
    root,
    "node_modules",
    "@elizaos",
    "plugin-local-inference",
    "dist",
  );
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, "voice-wake.js"), source);
  return root;
}

beforeEach(() => {
  harness.reset();
  runtime.distPath = "/tmp/eliza-fused-wake-missing-runtime";
  delete process.env.ELIZA_FUSED_WAKE_MIC_PROGRAM;
  delete process.env.ELIZA_FUSED_WAKE_MIC_ARGV;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.resetModules();
});

afterEach(() => {
  if (originalMicProgram === undefined) {
    delete process.env.ELIZA_FUSED_WAKE_MIC_PROGRAM;
  } else {
    process.env.ELIZA_FUSED_WAKE_MIC_PROGRAM = originalMicProgram;
  }
  if (originalMicArgv === undefined) {
    delete process.env.ELIZA_FUSED_WAKE_MIC_ARGV;
  } else {
    process.env.ELIZA_FUSED_WAKE_MIC_ARGV = originalMicArgv;
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("getFusedWakeManager", () => {
  it("returns one FusedWakeManager instance on repeated calls", async () => {
    const { FusedWakeManager, getFusedWakeManager } = await loadFusedWake();
    const first = getFusedWakeManager();
    const second = getFusedWakeManager();

    expect(first).toBeInstanceOf(FusedWakeManager);
    expect(second).toBe(first);
  });

  it("does not alias a directly constructed manager onto the singleton", async () => {
    const { FusedWakeManager, getFusedWakeManager } = await loadFusedWake();
    const constructed = new FusedWakeManager();
    const singleton = getFusedWakeManager();

    expect(constructed).not.toBe(singleton);
    await expect(constructed.isListening()).resolves.toEqual({
      listening: false,
    });
    await expect(singleton.isListening()).resolves.toEqual({
      listening: false,
    });
  });
});

describe("FusedWakeManager start", () => {
  it("reports idle before start", async () => {
    const { FusedWakeManager } = await loadFusedWake();
    await expect(new FusedWakeManager().isListening()).resolves.toEqual({
      listening: false,
    });
  });

  it("returns started without re-arming when already listening", async () => {
    const { FusedWakeManager } = await loadFusedWake();
    const manager = new FusedWakeManager();

    await expect(manager.start()).resolves.toEqual({ started: true });
    await expect(manager.start({ head: "hey-other" })).resolves.toEqual({
      started: true,
    });

    expect(harness.state.startCount).toBe(1);
    expect(harness.state.loadCalls).toHaveLength(1);
    await expect(manager.isListening()).resolves.toEqual({ listening: true });
  });

  it("defaults the wake head to hey-eliza", async () => {
    const { FusedWakeManager } = await loadFusedWake();
    const resolve = vi.fn(() => harness.state.paths);
    harness.namespace.resolveWakeWordStandalonePaths = resolve;

    await new FusedWakeManager().start();

    expect(resolve).toHaveBeenCalledWith({ head: "hey-eliza" });
  });

  it("treats a blank head as hey-eliza", async () => {
    const { FusedWakeManager } = await loadFusedWake();
    const resolve = vi.fn(() => harness.state.paths);
    harness.namespace.resolveWakeWordStandalonePaths = resolve;

    await new FusedWakeManager().start({ head: "   " });

    expect(resolve).toHaveBeenCalledWith({ head: "hey-eliza" });
  });

  it("trims a custom head before resolving standalone paths", async () => {
    const { FusedWakeManager } = await loadFusedWake();
    const resolve = vi.fn(() => harness.state.paths);
    harness.namespace.resolveWakeWordStandalonePaths = resolve;

    await new FusedWakeManager().start({ head: "  hey-bob  " });

    expect(resolve).toHaveBeenCalledWith({ head: "hey-bob" });
  });

  it("returns wakeword-module-unavailable when the package import throws an Error", async () => {
    harness.state.importError = new Error("package missing");
    const { FusedWakeManager } = await loadFusedWake();

    await expect(new FusedWakeManager().start()).resolves.toEqual({
      started: false,
      reason:
        "wakeword-module-unavailable: Wake-word support is unavailable at /tmp/eliza-fused-wake-missing-runtime/node_modules/@elizaos/plugin-local-inference/dist/voice-wake.js; package import failed: package missing",
    });
  });

  it("stringifies a non-Error package import failure", async () => {
    harness.state.importError = "no-voice-wake";
    const { FusedWakeManager } = await loadFusedWake();

    const result = await new FusedWakeManager().start();

    expect(result.started).toBe(false);
    expect(result.reason).toContain("wakeword-module-unavailable:");
    expect(result.reason).toContain("no-voice-wake");
  });

  it.each(VOICE_WAKE_EXPORTS)(
    "returns wakeword-module-unavailable when %s is not a function",
    async (name) => {
      harness.namespace[name] = 1;
      const { FusedWakeManager } = await loadFusedWake();

      await expect(new FusedWakeManager().start()).resolves.toEqual({
        started: false,
        reason: `wakeword-module-unavailable: Wake-word support is unavailable at /tmp/eliza-fused-wake-missing-runtime/node_modules/@elizaos/plugin-local-inference/dist/voice-wake.js; package import failed: voice-wake module did not export ${name}.`,
      });
    },
  );

  it("does not poison a later start after a failed module resolve", async () => {
    harness.namespace.DesktopMicSource = 1;
    const { FusedWakeManager } = await loadFusedWake();
    const manager = new FusedWakeManager();

    await expect(manager.start()).resolves.toMatchObject({ started: false });

    harness.restoreNamespace();
    await expect(manager.start()).resolves.toEqual({ started: true });
    await expect(manager.isListening()).resolves.toEqual({ listening: true });
  });

  it("stays inert when standalone wake models are not staged", async () => {
    harness.state.paths = null;
    const { FusedWakeManager } = await loadFusedWake();

    await expect(new FusedWakeManager().start()).resolves.toEqual({
      started: false,
      reason: "wakeword-model-not-staged",
    });
    expect(harness.state.loadCalls).toHaveLength(0);
    expect(harness.state.startCount).toBe(0);
  });

  it("returns wakeword-load-failed when the ggml model throws an Error", async () => {
    harness.state.loadError = new Error("gguf missing");
    const { FusedWakeManager } = await loadFusedWake();

    await expect(new FusedWakeManager().start()).resolves.toEqual({
      started: false,
      reason: "wakeword-load-failed: gguf missing",
    });
    expect(harness.state.startCount).toBe(0);
  });

  it("stringifies a non-Error ggml load failure", async () => {
    harness.state.loadError = "bad-abi";
    const { FusedWakeManager } = await loadFusedWake();

    await expect(new FusedWakeManager().start()).resolves.toEqual({
      started: false,
      reason: "wakeword-load-failed: bad-abi",
    });
  });

  it("omits model and detector config when threshold is unset", async () => {
    const { FusedWakeManager } = await loadFusedWake();

    await new FusedWakeManager().start();

    expect(harness.state.loadCalls[0]).toEqual({
      libraryPath: harness.STAGED_PATHS.libraryPath,
      paths: {
        melspec: harness.STAGED_PATHS.melspec,
        embedding: harness.STAGED_PATHS.embedding,
        classifier: harness.STAGED_PATHS.classifier,
      },
    });
    expect(harness.state.loadCalls[0]).not.toHaveProperty("config");
    expect(harness.state.detectorOpts[0]).not.toHaveProperty("config");
  });

  it("forwards a numeric threshold to both model load and detector", async () => {
    const { FusedWakeManager } = await loadFusedWake();

    await new FusedWakeManager().start({ threshold: 0.7 });

    expect(harness.state.loadCalls[0]?.config).toEqual({ threshold: 0.7 });
    expect(harness.state.detectorOpts[0]?.config).toEqual({ threshold: 0.7 });
  });

  it("forwards a zero threshold because it is not undefined", async () => {
    const { FusedWakeManager } = await loadFusedWake();

    await new FusedWakeManager().start({ threshold: 0 });

    expect(harness.state.loadCalls[0]?.config).toEqual({ threshold: 0 });
    expect(harness.state.detectorOpts[0]?.config).toEqual({ threshold: 0 });
  });

  it("unsubscribes and closes the model when mic start throws", async () => {
    harness.state.micStartError = new Error("no recorder");
    const { FusedWakeManager } = await loadFusedWake();
    const manager = new FusedWakeManager();

    await expect(manager.start()).resolves.toEqual({
      started: false,
      reason: "mic-start-failed: no recorder",
    });
    expect(harness.state.unsubCount).toBe(1);
    expect(harness.state.closeCount).toBe(1);
    await expect(manager.isListening()).resolves.toEqual({ listening: false });
  });

  it("stringifies a non-Error mic start failure", async () => {
    harness.state.micStartError = "device-busy";
    const { FusedWakeManager } = await loadFusedWake();

    await expect(new FusedWakeManager().start()).resolves.toEqual({
      started: false,
      reason: "mic-start-failed: device-busy",
    });
  });

  it("marks listening and notifies the renderer after a successful start", async () => {
    const { FusedWakeManager } = await loadFusedWake();
    const manager = new FusedWakeManager();
    const sendToWebview = vi.fn();
    manager.setSendToWebview(sendToWebview);

    await expect(manager.start()).resolves.toEqual({ started: true });
    await expect(manager.isListening()).resolves.toEqual({ listening: true });
    expect(sendToWebview).toHaveBeenCalledWith("voice:fusedWakeState", {
      listening: true,
    });
    expect(harness.state.micOpts).toEqual([{ sampleRate: 16_000 }]);
  });

  it("starts successfully when no renderer callback is registered", async () => {
    const { FusedWakeManager } = await loadFusedWake();
    await expect(new FusedWakeManager().start()).resolves.toEqual({
      started: true,
    });
  });

  it("overrides the mic program when both env vars are set", async () => {
    process.env.ELIZA_FUSED_WAKE_MIC_PROGRAM = " ffmpeg ";
    process.env.ELIZA_FUSED_WAKE_MIC_ARGV =
      "-hide_banner|-re|-i|/tmp/hey-eliza.f32|-f|s16le|-";
    const { FusedWakeManager } = await loadFusedWake();

    await new FusedWakeManager().start();

    expect(harness.state.micOpts).toEqual([
      {
        sampleRate: 16_000,
        program: "ffmpeg",
        argv: [
          "-hide_banner",
          "-re",
          "-i",
          "/tmp/hey-eliza.f32",
          "-f",
          "s16le",
          "-",
        ],
      },
    ]);
  });

  it("uses the default mic when only the program env is set", async () => {
    process.env.ELIZA_FUSED_WAKE_MIC_PROGRAM = "ffmpeg";
    const { FusedWakeManager } = await loadFusedWake();

    await new FusedWakeManager().start();

    expect(harness.state.micOpts).toEqual([{ sampleRate: 16_000 }]);
  });

  it("uses the default mic when only the argv env is set", async () => {
    process.env.ELIZA_FUSED_WAKE_MIC_ARGV = "-i|/tmp/clip.f32";
    const { FusedWakeManager } = await loadFusedWake();

    await new FusedWakeManager().start();

    expect(harness.state.micOpts).toEqual([{ sampleRate: 16_000 }]);
  });

  it("uses the default mic when the program env trims to empty", async () => {
    process.env.ELIZA_FUSED_WAKE_MIC_PROGRAM = "   ";
    process.env.ELIZA_FUSED_WAKE_MIC_ARGV = "-i|/tmp/clip.f32";
    const { FusedWakeManager } = await loadFusedWake();

    await new FusedWakeManager().start();

    expect(harness.state.micOpts).toEqual([{ sampleRate: 16_000 }]);
  });
});

describe("FusedWakeManager frame rebuffering and wake forwarding", () => {
  it("does not push an undersized frame", async () => {
    const { FusedWakeManager } = await loadFusedWake();
    await new FusedWakeManager().start();

    harness.state.frameListener?.({ pcm: new Float32Array([0.1, 0.2]) });

    expect(harness.state.pushFrames).toHaveLength(0);
  });

  it("pushes one detector frame when the mic chunk is exact", async () => {
    const { FusedWakeManager } = await loadFusedWake();
    await new FusedWakeManager().start();
    const pcm = new Float32Array([1, 2, 3, 4]);

    harness.state.frameListener?.({ pcm });

    expect(harness.state.pushFrames).toHaveLength(1);
    expect(Array.from(harness.state.pushFrames[0] ?? [])).toEqual([1, 2, 3, 4]);
  });

  it("splits an overflowing chunk and keeps the remainder", async () => {
    const { FusedWakeManager } = await loadFusedWake();
    await new FusedWakeManager().start();

    harness.state.frameListener?.({
      pcm: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    });

    expect(harness.state.pushFrames).toHaveLength(2);
    expect(Array.from(harness.state.pushFrames[0] ?? [])).toEqual([1, 2, 3, 4]);
    expect(Array.from(harness.state.pushFrames[1] ?? [])).toEqual([5, 6, 7, 8]);

    harness.state.frameListener?.({ pcm: new Float32Array([11, 12]) });

    expect(harness.state.pushFrames).toHaveLength(3);
    expect(Array.from(harness.state.pushFrames[2] ?? [])).toEqual([
      9, 10, 11, 12,
    ]);
  });

  it("completes a remainder across two undersized chunks", async () => {
    const { FusedWakeManager } = await loadFusedWake();
    await new FusedWakeManager().start();

    harness.state.frameListener?.({ pcm: new Float32Array([1, 2]) });
    harness.state.frameListener?.({ pcm: new Float32Array([3]) });
    expect(harness.state.pushFrames).toHaveLength(0);

    harness.state.frameListener?.({ pcm: new Float32Array([4, 5]) });
    expect(harness.state.pushFrames).toHaveLength(1);
    expect(Array.from(harness.state.pushFrames[0] ?? [])).toEqual([1, 2, 3, 4]);
  });

  it("forwards a detector fire as voice:fusedWake head-fired", async () => {
    const { FusedWakeManager } = await loadFusedWake();
    const manager = new FusedWakeManager();
    const sendToWebview = vi.fn();
    manager.setSendToWebview(sendToWebview);
    await manager.start();
    sendToWebview.mockClear();

    harness.state.onWake?.({ confidence: 0.91 });

    expect(sendToWebview).toHaveBeenCalledWith("voice:fusedWake", {
      stage: "head-fired",
      confidence: 0.91,
    });
  });

  it("does not throw on a detector fire when no renderer callback is set", async () => {
    const { FusedWakeManager } = await loadFusedWake();
    await new FusedWakeManager().start();

    expect(() => harness.state.onWake?.({ confidence: 0.5 })).not.toThrow();
  });
});

describe("FusedWakeManager stop and dispose", () => {
  it("unsubscribes, stops the mic, closes the model, and notifies the renderer", async () => {
    const { FusedWakeManager } = await loadFusedWake();
    const manager = new FusedWakeManager();
    const sendToWebview = vi.fn();
    manager.setSendToWebview(sendToWebview);
    await manager.start();
    sendToWebview.mockClear();

    await manager.stop();

    expect(harness.state.unsubCount).toBe(1);
    expect(harness.state.stopCount).toBe(1);
    expect(harness.state.closeCount).toBe(1);
    expect(sendToWebview).toHaveBeenCalledWith("voice:fusedWakeState", {
      listening: false,
    });
    await expect(manager.isListening()).resolves.toEqual({ listening: false });
  });

  it("still notifies listening false when stop runs idle", async () => {
    const { FusedWakeManager } = await loadFusedWake();
    const manager = new FusedWakeManager();
    const sendToWebview = vi.fn();
    manager.setSendToWebview(sendToWebview);

    await manager.stop();

    expect(harness.state.stopCount).toBe(0);
    expect(harness.state.closeCount).toBe(0);
    expect(sendToWebview).toHaveBeenCalledWith("voice:fusedWakeState", {
      listening: false,
    });
  });

  it("closes the model and notifies even when mic stop throws", async () => {
    harness.state.micStopError = new Error("stop failed");
    const { FusedWakeManager } = await loadFusedWake();
    const manager = new FusedWakeManager();
    const sendToWebview = vi.fn();
    manager.setSendToWebview(sendToWebview);
    await manager.start();
    sendToWebview.mockClear();

    await expect(manager.stop()).rejects.toThrow("stop failed");
    expect(harness.state.closeCount).toBe(1);
    expect(sendToWebview).toHaveBeenCalledWith("voice:fusedWakeState", {
      listening: false,
    });
    await expect(manager.isListening()).resolves.toEqual({ listening: false });
  });

  it("can start again after a clean stop", async () => {
    const { FusedWakeManager } = await loadFusedWake();
    const manager = new FusedWakeManager();
    await manager.start();
    await manager.stop();

    await expect(manager.start()).resolves.toEqual({ started: true });
    expect(harness.state.startCount).toBe(2);
    await expect(manager.isListening()).resolves.toEqual({ listening: true });
  });

  it("clears the renderer callback so a late stop state event is not delivered", async () => {
    const { FusedWakeManager } = await loadFusedWake();
    const manager = new FusedWakeManager();
    const sendToWebview = vi.fn();
    manager.setSendToWebview(sendToWebview);
    await manager.start();
    sendToWebview.mockClear();

    manager.dispose();
    await vi.waitFor(() => {
      expect(harness.state.stopCount).toBe(1);
    });

    expect(sendToWebview).not.toHaveBeenCalledWith("voice:fusedWakeState", {
      listening: false,
    });
  });
});

describe("FusedWakeManager bundled runtime import", () => {
  it("loads voice-wake.js from the packaged runtime dist when that file exists", async () => {
    runtime.distPath = writeBundledVoiceWake(BUNDLED_VOICE_WAKE_JS);
    harness.state.paths = null;
    const { FusedWakeManager } = await loadFusedWake();
    const manager = new FusedWakeManager();
    const sendToWebview = vi.fn();
    manager.setSendToWebview(sendToWebview);

    await expect(manager.start()).resolves.toEqual({ started: true });
    expect(sendToWebview).toHaveBeenCalledWith("voice:fusedWakeState", {
      listening: true,
    });
    expect(harness.state.loadCalls).toHaveLength(0);
  });

  it("does not fall through to the package when the bundled module fails parse", async () => {
    runtime.distPath = writeBundledVoiceWake(
      "export const bridgeDetectorToFusedWake = 1;\n",
    );
    const { FusedWakeManager } = await loadFusedWake();

    await expect(new FusedWakeManager().start()).resolves.toEqual({
      started: false,
      reason:
        "wakeword-module-unavailable: voice-wake module did not export bridgeDetectorToFusedWake.",
    });
    expect(harness.state.loadCalls).toHaveLength(0);
  });
});
