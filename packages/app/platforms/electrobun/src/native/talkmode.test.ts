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
import { TalkModeManager } from "./talkmode";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalFetch = globalThis.fetch;

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
      stderr: streamChunks([]),
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
      stderr: streamChunks([]),
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
    vi.stubGlobal("Bun", {
      spawn: vi.fn(),
      which: vi.fn((name: string) => name),
    });
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

  it.each([
    ["darwin", ["say", "hello there"]],
    ["linux", ["espeak-ng", "--stdin"]],
  ] as const)(
    "speaks through the %s system voice when no API key is set",
    async (platform, argv) => {
      stubPlatform(platform);
      const spawned = immediateSpawn();
      const spawn = vi.spyOn(Bun, "spawn").mockReturnValue(spawned.proc);

      await manager.speak({ text: "hello there" });

      expect(spawn).toHaveBeenCalledWith(
        argv,
        platform === "linux"
          ? { stdin: expect.any(Blob), stdout: "ignore", stderr: "pipe" }
          : { stderr: "pipe" },
      );
      if (platform === "linux") {
        const input = spawn.mock.calls[0][1]?.stdin;
        if (!(input instanceof Blob))
          throw new Error("Expected complete speech input");
        expect(await input.text()).toBe("hello there");
      }
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

  it.each([null, "empty"])(
    "rejects an ElevenLabs response without audio (%s)",
    async (body) => {
      setApiKey("sk-live");
      globalThis.fetch = vi.fn(
        async () => new Response(body === null ? null : streamChunks([])),
      ) as unknown as typeof fetch;
      await expect(manager.speak({ text: "nobody" })).rejects.toMatchObject({
        code: "TTS_AUDIO_MISSING",
      });
      expect(sendToWebview).not.toHaveBeenCalledWith("talkmodeSpeakComplete");
      await expect(manager.getState()).resolves.toEqual({ state: "error" });
    },
  );

  it("rejects a failed system process instead of reporting completed speech", async () => {
    const spawned = immediateSpawn();
    Object.assign(spawned.proc, {
      exited: Promise.resolve(2),
      stderr: streamChunks([
        new TextEncoder().encode("audio device unavailable"),
      ]),
    });
    vi.spyOn(Bun, "spawn").mockReturnValue(spawned.proc);
    await expect(manager.speak({ text: "hello" })).rejects.toMatchObject({
      code: "SYSTEM_TTS_FAILED",
      context: expect.objectContaining({
        exitCode: 2,
        diagnostic: "audio device unavailable",
      }),
    });
    expect(sendToWebview).not.toHaveBeenCalledWith("talkmodeSpeakComplete");
  });

  it("rejects missing Linux voices before spawning and supports legacy espeak", async () => {
    stubPlatform("linux");
    vi.mocked(Bun.which).mockReturnValue(null);
    await expect(manager.speak({ text: "hello" })).rejects.toMatchObject({
      code: "SYSTEM_TTS_UNAVAILABLE",
    });
    expect(Bun.spawn).not.toHaveBeenCalled();
    vi.mocked(Bun.which).mockImplementation((name) =>
      name === "espeak" ? "/usr/bin/espeak" : null,
    );
    vi.mocked(Bun.spawn).mockReturnValue(immediateSpawn().proc);
    const text = `--help\n${"complete speech ".repeat(10000)}`;
    await manager.speak({ text });
    const [argv, options] = vi.mocked(Bun.spawn).mock.calls[0];
    expect(argv).toEqual(["/usr/bin/espeak", "--stdin"]);
    const input = options?.stdin;
    if (!(input instanceof Blob))
      throw new Error("Expected complete speech input");
    expect(await input.text()).toBe(text);
  });

  it("stopping the session cancels speech without a completion event", async () => {
    const spawned = hangingSpawn();
    vi.mocked(Bun.spawn).mockReturnValue(spawned.proc);
    const speaking = manager.speak({ text: "long" });
    await manager.stop();
    await speaking;
    expect(spawned.kill).toHaveBeenCalledOnce();
    expect(sendToWebview).not.toHaveBeenCalledWith("talkmodeSpeakComplete");
  });

  it("a cancelled old process cannot clear a newer speech operation", async () => {
    const first = hangingSpawn();
    const second = hangingSpawn();
    vi.mocked(Bun.spawn)
      .mockReturnValueOnce(first.proc)
      .mockReturnValueOnce(second.proc);
    const oldSpeech = manager.speak({ text: "old" });
    const newSpeech = manager.speak({ text: "new" });
    await oldSpeech;
    await expect(manager.isSpeaking()).resolves.toEqual({ speaking: true });
    await manager.stopSpeaking();
    await newSpeech;
    expect(second.kill).toHaveBeenCalledOnce();
    expect(sendToWebview).not.toHaveBeenCalledWith("talkmodeSpeakComplete");
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

});
