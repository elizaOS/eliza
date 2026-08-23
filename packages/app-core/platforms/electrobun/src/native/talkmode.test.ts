/**
 * Exercises TalkModeManager lifecycle, renderer forwarding, system TTS
 * process selection, and ElevenLabs request construction. Bun.spawn and
 * fetch are stubbed at the I/O boundary so tests never speak or hit the
 * network; the manager itself is the real module.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./agent", () => ({
  diagnosticLog: () => undefined,
}));

import type { SendToWebview } from "../types.js";
import { getTalkModeManager, TalkModeManager } from "./talkmode";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalFetch = globalThis.fetch;
const POWERSHELL_SPEAK_COMMAND =
  "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak($env:ELIZA_TTS_TEXT)";
const DEFAULT_ELEVENLABS_VOICE = "21m00Tcm4TlvDq8ikWAM";

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

function restorePlatform(): void {
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }
}

function setApiKey(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.ELEVEN_LABS_API_KEY;
    return;
  }
  process.env.ELEVEN_LABS_API_KEY = value;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function immediateSpawn(): {
  kill: ReturnType<typeof vi.fn>;
  proc: ReturnType<typeof Bun.spawn>;
} {
  const kill = vi.fn();
  return {
    kill,
    proc: {
      exited: Promise.resolve(0),
      kill,
    } as unknown as ReturnType<typeof Bun.spawn>,
  };
}

function hangingSpawn(): {
  kill: ReturnType<typeof vi.fn>;
  finish: (code?: number) => void;
  proc: ReturnType<typeof Bun.spawn>;
} {
  const exited = deferred<number>();
  const kill = vi.fn(() => {
    exited.resolve(1);
  });
  return {
    kill,
    finish: (code = 0) => {
      exited.resolve(code);
    },
    proc: {
      exited: exited.promise,
      kill,
    } as unknown as ReturnType<typeof Bun.spawn>,
  };
}

function streamChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

describe("TalkModeManager", () => {
  const previousApiKey = process.env.ELEVEN_LABS_API_KEY;
  let sendToWebview: ReturnType<typeof vi.fn<SendToWebview>>;
  let manager: TalkModeManager;

  beforeEach(() => {
    sendToWebview = vi.fn<SendToWebview>();
    manager = new TalkModeManager();
    manager.setSendToWebview(sendToWebview);
    setApiKey(undefined);
    vi.stubGlobal("Bun", { spawn: vi.fn() });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    manager.dispose();
    setApiKey(previousApiKey);
    globalThis.fetch = originalFetch;
    restorePlatform();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts idle, reports enabled, and is not speaking", async () => {
    await expect(manager.getState()).resolves.toEqual({ state: "idle" });
    await expect(manager.isEnabled()).resolves.toEqual({ enabled: true });
    await expect(manager.isSpeaking()).resolves.toEqual({ speaking: false });
    expect(sendToWebview).not.toHaveBeenCalled();
  });

  it("start reports Web Speech availability and moves to listening", async () => {
    await expect(manager.start()).resolves.toEqual({
      available: true,
      reason: "Using Web Speech API for STT (native whisper pipeline removed)",
    });
    await expect(manager.getState()).resolves.toEqual({ state: "listening" });
    expect(sendToWebview).toHaveBeenCalledWith("talkmodeStateChanged", {
      state: "listening",
    });
  });

  it("stop returns to idle and clears the speaking flag", async () => {
    await manager.start();
    await manager.stop();

    await expect(manager.getState()).resolves.toEqual({ state: "idle" });
    await expect(manager.isSpeaking()).resolves.toEqual({ speaking: false });
    expect(sendToWebview).toHaveBeenCalledWith("talkmodeStateChanged", {
      state: "idle",
    });
  });

  it("isEnabled stays true across listening, speaking, error, and idle", async () => {
    await expect(manager.isEnabled()).resolves.toEqual({ enabled: true });
    await manager.start();
    await expect(manager.isEnabled()).resolves.toEqual({ enabled: true });

    vi.spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("say missing");
    });
    await manager.speak({ text: "hi" });
    await expect(manager.getState()).resolves.toEqual({ state: "error" });
    await expect(manager.isEnabled()).resolves.toEqual({ enabled: true });

    await manager.stop();
    await expect(manager.isEnabled()).resolves.toEqual({ enabled: true });
  });

  it("forwards audio chunks only while listening", async () => {
    await manager.audioChunk({ data: "idle-bytes" });
    expect(sendToWebview).not.toHaveBeenCalled();

    await manager.start();
    sendToWebview.mockClear();
    await manager.audioChunk({ data: "listen-bytes" });
    expect(sendToWebview).toHaveBeenCalledTimes(1);
    expect(sendToWebview).toHaveBeenCalledWith("talkmodeAudioChunkPush", {
      data: "listen-bytes",
    });

    await manager.stop();
    sendToWebview.mockClear();
    await manager.audioChunk({ data: "after-stop" });
    expect(sendToWebview).not.toHaveBeenCalled();
  });

  it("forwards empty audio data while listening and ignores it while idle", async () => {
    await manager.audioChunk({ data: "" });
    expect(sendToWebview).not.toHaveBeenCalled();

    await manager.start();
    sendToWebview.mockClear();
    await manager.audioChunk({ data: "" });
    expect(sendToWebview).toHaveBeenCalledWith("talkmodeAudioChunkPush", {
      data: "",
    });
  });

  it("does not forward audio while system TTS is in flight", async () => {
    const hanging = hangingSpawn();
    vi.spyOn(Bun, "spawn").mockReturnValue(hanging.proc);

    const speaking = manager.speak({ text: "hold" });
    await vi.waitFor(async () => {
      await expect(manager.getState()).resolves.toEqual({ state: "speaking" });
    });

    sendToWebview.mockClear();
    await manager.audioChunk({ data: "during-speak" });
    expect(sendToWebview).not.toHaveBeenCalled();

    hanging.finish();
    await speaking;
  });

  it("does not throw when no webview callback is registered", async () => {
    const isolated = new TalkModeManager();
    await expect(isolated.start()).resolves.toMatchObject({ available: true });
    await expect(
      isolated.audioChunk({ data: "orphan" }),
    ).resolves.toBeUndefined();
    await expect(isolated.stop()).resolves.toBeUndefined();
    isolated.dispose();
  });

  it("merges updateConfig onto the existing config without wiping fields", async () => {
    setApiKey("sk-test");
    await manager.updateConfig({
      language: "fr",
      voiceId: "voice-from-config",
    });

    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: null,
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await manager.speak({ text: "bonjour" });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice-from-config/stream",
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      text: "bonjour",
      model_id: "eleven_v3",
    });
  });

  it("lets a later updateConfig replace voiceId used by the next speak", async () => {
    setApiKey("sk-test");
    await manager.updateConfig({ voiceId: "first-voice" });
    await manager.updateConfig({ voiceId: "second-voice" });

    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: null,
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await manager.speak({ text: "next" });
    const [url] = vi.mocked(globalThis.fetch).mock.calls[0] as [string];
    expect(url).toContain("/second-voice/stream");
  });

  it.each([
    ["darwin", ["say", "hello there"]],
    ["linux", ["espeak", "hello there"]],
  ] as const)(
    "speaks through the %s system voice when no API key is set",
    async (platform, argv) => {
      stubPlatform(platform);
      const spawned = immediateSpawn();
      const spawn = vi.spyOn(Bun, "spawn").mockReturnValue(spawned.proc);

      await manager.speak({ text: "hello there" });

      expect(spawn).toHaveBeenCalledWith(argv, { stderr: "pipe" });
      expect(globalThis.fetch).toBe(originalFetch);
      expect(sendToWebview).toHaveBeenCalledWith("talkmodeStateChanged", {
        state: "speaking",
      });
      expect(sendToWebview).toHaveBeenCalledWith("talkmodeSpeakComplete");
      expect(sendToWebview).toHaveBeenCalledWith("talkmodeStateChanged", {
        state: "idle",
      });
      await expect(manager.getState()).resolves.toEqual({ state: "idle" });
      await expect(manager.isSpeaking()).resolves.toEqual({ speaking: false });
    },
  );

  it("speaks through PowerShell on win32 and passes text via env, not -Command", async () => {
    stubPlatform("win32");
    const spawned = immediateSpawn();
    const spawn = vi.spyOn(Bun, "spawn").mockReturnValue(spawned.proc);

    await manager.speak({ text: "rm -rf / ; hello" });

    expect(spawn).toHaveBeenCalledTimes(1);
    const [argv, options] = spawn.mock.calls[0] as [
      string[],
      { stderr: string; env: NodeJS.ProcessEnv },
    ];
    expect(argv).toEqual([
      "powershell",
      "-NoProfile",
      "-Command",
      POWERSHELL_SPEAK_COMMAND,
    ]);
    expect(argv[3]).not.toContain("rm -rf");
    expect(argv[3]).not.toContain("hello");
    expect(options.stderr).toBe("pipe");
    expect(options.env.ELIZA_TTS_TEXT).toBe("rm -rf / ; hello");
    expect(sendToWebview).toHaveBeenCalledWith("talkmodeSpeakComplete");
  });

  it("treats a whitespace-only ElevenLabs key as missing and uses system TTS", async () => {
    stubPlatform("darwin");
    setApiKey("   \t  ");
    const spawned = immediateSpawn();
    const spawn = vi.spyOn(Bun, "spawn").mockReturnValue(spawned.proc);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await manager.speak({ text: "fallback" });

    expect(spawn).toHaveBeenCalledWith(["say", "fallback"], { stderr: "pipe" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sets error and skips speakComplete when system TTS spawn throws", async () => {
    vi.spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("spawn failed");
    });

    await manager.speak({ text: "nope" });

    await expect(manager.getState()).resolves.toEqual({ state: "error" });
    await expect(manager.isSpeaking()).resolves.toEqual({ speaking: false });
    expect(sendToWebview).toHaveBeenCalledWith("talkmodeStateChanged", {
      state: "speaking",
    });
    expect(sendToWebview).toHaveBeenCalledWith("talkmodeStateChanged", {
      state: "error",
    });
    expect(sendToWebview).not.toHaveBeenCalledWith("talkmodeSpeakComplete");
    expect(sendToWebview).not.toHaveBeenCalledWith("talkmodeStateChanged", {
      state: "idle",
    });
  });

  it("start after a system TTS error returns to listening", async () => {
    vi.spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("spawn failed");
    });
    await manager.speak({ text: "nope" });
    await expect(manager.getState()).resolves.toEqual({ state: "error" });

    await manager.start();
    await expect(manager.getState()).resolves.toEqual({ state: "listening" });
  });

  it("stopSpeaking kills an in-flight system TTS process and returns to idle", async () => {
    const hanging = hangingSpawn();
    vi.spyOn(Bun, "spawn").mockReturnValue(hanging.proc);

    const speaking = manager.speak({ text: "long" });
    await vi.waitFor(async () => {
      await expect(manager.isSpeaking()).resolves.toEqual({ speaking: true });
    });

    await manager.stopSpeaking();
    expect(hanging.kill).toHaveBeenCalledTimes(1);
    await speaking;

    await expect(manager.getState()).resolves.toEqual({ state: "idle" });
    await expect(manager.isSpeaking()).resolves.toEqual({ speaking: false });
  });

  it("stopSpeaking swallows kill failures from an already-exited process", async () => {
    const hanging = hangingSpawn();
    hanging.kill.mockImplementation(() => {
      throw new Error("already exited");
    });
    vi.spyOn(Bun, "spawn").mockReturnValue(hanging.proc);

    const speaking = manager.speak({ text: "long" });
    await vi.waitFor(async () => {
      await expect(manager.isSpeaking()).resolves.toEqual({ speaking: true });
    });

    await expect(manager.stopSpeaking()).resolves.toBeUndefined();
    hanging.finish();
    await speaking;
    await expect(manager.getState()).resolves.toEqual({ state: "idle" });
  });

  it("stopSpeaking with nothing in flight still returns idle and not speaking", async () => {
    await manager.start();
    await manager.stopSpeaking();
    await expect(manager.getState()).resolves.toEqual({ state: "idle" });
    await expect(manager.isSpeaking()).resolves.toEqual({ speaking: false });
    expect(sendToWebview).toHaveBeenCalledWith("talkmodeStateChanged", {
      state: "idle",
    });
  });

  it("uses the default ElevenLabs voice, model, and voice settings", async () => {
    setApiKey("sk-live");
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: streamChunks([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await manager.speak({ text: "stream me" });

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      `https://api.elevenlabs.io/v1/text-to-speech/${DEFAULT_ELEVENLABS_VOICE}/stream`,
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "xi-api-key": "sk-live",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      text: "stream me",
      model_id: "eleven_v3",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    });
    expect(sendToWebview).toHaveBeenCalledWith("talkmodeAudioChunkPush", {
      data: Buffer.from([1, 2, 3]).toString("base64"),
    });
    expect(sendToWebview).toHaveBeenCalledWith("talkmodeAudioChunkPush", {
      data: Buffer.from([4, 5]).toString("base64"),
    });
    expect(sendToWebview).toHaveBeenCalledWith("talkmodeSpeakComplete");
    await expect(manager.getState()).resolves.toEqual({ state: "idle" });
    await expect(manager.isSpeaking()).resolves.toEqual({ speaking: false });
  });

  it("trims the API key before sending it as xi-api-key", async () => {
    setApiKey("  sk-padded  ");
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: null,
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await manager.speak({ text: "hi" });
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe(
      "sk-padded",
    );
  });

  it("prefers directive voice, model, and settings over config and defaults", async () => {
    setApiKey("sk-live");
    await manager.updateConfig({ voiceId: "config-voice" });
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: null,
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await manager.speak({
      text: "override",
      directive: {
        voiceId: "directive-voice",
        modelId: "eleven_turbo_v2",
        stability: 0.1,
        similarity: 0.9,
      },
    });

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/directive-voice/stream",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      text: "override",
      model_id: "eleven_turbo_v2",
      voice_settings: {
        stability: 0.1,
        similarity_boost: 0.9,
      },
    });
  });

  it("keeps an empty directive voiceId instead of falling back to the default", async () => {
    setApiKey("sk-live");
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: null,
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await manager.speak({
      text: "empty-voice",
      directive: { voiceId: "" },
    });

    const [url] = vi.mocked(globalThis.fetch).mock.calls[0] as [string];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech//stream");
  });

  it("completes ElevenLabs speech when the response body is missing", async () => {
    setApiKey("sk-live");
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: null,
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await manager.speak({ text: "nobody" });
    expect(sendToWebview).not.toHaveBeenCalledWith(
      "talkmodeAudioChunkPush",
      expect.anything(),
    );
    expect(sendToWebview).toHaveBeenCalledWith("talkmodeSpeakComplete");
    await expect(manager.getState()).resolves.toEqual({ state: "idle" });
  });

  it("reports an ElevenLabs HTTP error and stays in error without speakComplete", async () => {
    setApiKey("sk-live");
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        body: streamChunks([new Uint8Array([9])]),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await manager.speak({ text: "secret" });

    expect(sendToWebview).toHaveBeenCalledWith("talkmodeError", {
      source: "elevenlabs",
      message: "ElevenLabs API error: 401 Unauthorized",
    });
    expect(sendToWebview).not.toHaveBeenCalledWith(
      "talkmodeAudioChunkPush",
      expect.anything(),
    );
    expect(sendToWebview).not.toHaveBeenCalledWith("talkmodeSpeakComplete");
    await expect(manager.getState()).resolves.toEqual({ state: "error" });
    await expect(manager.isSpeaking()).resolves.toEqual({ speaking: false });
  });

  it("reports a thrown ElevenLabs fetch error and stays in error", async () => {
    setApiKey("sk-live");
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    await manager.speak({ text: "down" });

    expect(sendToWebview).toHaveBeenCalledWith("talkmodeError", {
      source: "elevenlabs",
      message: "ECONNRESET",
    });
    await expect(manager.getState()).resolves.toEqual({ state: "error" });
    await expect(manager.isSpeaking()).resolves.toEqual({ speaking: false });
  });

  it("stringifies a non-Error ElevenLabs throw as the error message", async () => {
    setApiKey("sk-live");
    globalThis.fetch = vi.fn(async () => {
      throw "upstream-down";
    }) as unknown as typeof fetch;

    await manager.speak({ text: "down" });

    expect(sendToWebview).toHaveBeenCalledWith("talkmodeError", {
      source: "elevenlabs",
      message: "upstream-down",
    });
    await expect(manager.getState()).resolves.toEqual({ state: "error" });
  });

  it("treats AbortError from stopSpeaking as a quiet cancel, not an error", async () => {
    setApiKey("sk-live");
    const started = deferred<void>();
    globalThis.fetch = vi.fn((_url, init) => {
      started.resolve();
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener("abort", () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as unknown as typeof fetch;

    const speaking = manager.speak({ text: "cancel me" });
    await started.promise;
    await expect(manager.isSpeaking()).resolves.toEqual({ speaking: true });

    await manager.stopSpeaking();
    await speaking;

    expect(sendToWebview).not.toHaveBeenCalledWith(
      "talkmodeError",
      expect.anything(),
    );
    expect(sendToWebview).not.toHaveBeenCalledWith("talkmodeSpeakComplete");
    await expect(manager.getState()).resolves.toEqual({ state: "idle" });
    await expect(manager.isSpeaking()).resolves.toEqual({ speaking: false });
  });

  it("does not call Bun.spawn when an ElevenLabs key is configured", async () => {
    setApiKey("sk-live");
    const spawn = vi.spyOn(Bun, "spawn");
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: null,
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await manager.speak({ text: "cloud" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("dispose clears speaking and the webview callback without emitting", async () => {
    await manager.start();
    sendToWebview.mockClear();
    manager.dispose();

    expect(sendToWebview).not.toHaveBeenCalled();
    await expect(manager.getState()).resolves.toEqual({ state: "idle" });
    await expect(manager.isSpeaking()).resolves.toEqual({ speaking: false });

    await manager.start();
    expect(sendToWebview).not.toHaveBeenCalled();
    await expect(manager.getState()).resolves.toEqual({ state: "listening" });
  });
});

describe("getTalkModeManager", () => {
  it("returns one TalkModeManager instance on repeated calls", () => {
    const first = getTalkModeManager();
    const second = getTalkModeManager();

    expect(first).toBeInstanceOf(TalkModeManager);
    expect(second).toBe(first);
  });

  it("does not alias a directly constructed manager onto the singleton", async () => {
    const constructed = new TalkModeManager();
    const singleton = getTalkModeManager();

    expect(constructed).not.toBe(singleton);
    await constructed.start();
    await expect(constructed.getState()).resolves.toEqual({
      state: "listening",
    });
    await expect(singleton.getState()).resolves.toEqual({ state: "idle" });
    constructed.dispose();
  });
});
