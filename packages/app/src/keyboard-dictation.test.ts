// @vitest-environment jsdom

// App-side keyboard app-handoff dictation session (#12185): App-Group state
// ordering, transcript publication, explicit error states, cancel semantics,
// and the missing-bridge (non-iOS) path. Bridge + capture are injected fakes;
// the state machine and DOM overlay under test are real.

import type {
  VoiceCaptureFactoryOptions,
  VoiceCaptureHandle,
} from "@elizaos/ui/voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isKeyboardDictationSessionActive,
  type KeyboardDictationDeps,
  startKeyboardDictationSession,
} from "./keyboard-dictation";
import type { KeyboardDictationBridge } from "./native/keyboard-dictation-bridge";

interface FakeBridge extends KeyboardDictationBridge {
  writes: Array<Record<string, unknown>>;
  cleared: number;
}

function makeBridge(
  overrides: Partial<KeyboardDictationBridge> = {},
): FakeBridge {
  const bridge: FakeBridge = {
    writes: [],
    cleared: 0,
    setDictationState: vi.fn(async (options) => {
      bridge.writes.push(options as unknown as Record<string, unknown>);
      return { saved: true };
    }),
    clearDictationState: vi.fn(async () => {
      bridge.cleared += 1;
      return { cleared: true };
    }),
    getDictationState: vi.fn(async () => ({ pending: false })),
    ...overrides,
  };
  return bridge;
}

interface FakeCapture {
  handle: VoiceCaptureHandle;
  options: VoiceCaptureFactoryOptions;
  started: number;
  stopped: number;
  disposed: number;
}

function makeCaptureFactory(): {
  create: (options: VoiceCaptureFactoryOptions) => VoiceCaptureHandle;
  captures: FakeCapture[];
} {
  const captures: FakeCapture[] = [];
  return {
    captures,
    create: (options) => {
      const fake: FakeCapture = {
        options,
        started: 0,
        stopped: 0,
        disposed: 0,
        handle: {
          start: vi.fn(async () => {
            fake.started += 1;
          }),
          stop: vi.fn(async () => {
            fake.stopped += 1;
          }),
          dispose: vi.fn(() => {
            fake.disposed += 1;
          }),
          isActive: () => fake.started > fake.stopped,
          getAnalyser: () => null,
        },
      };
      captures.push(fake);
      return fake.handle;
    },
  };
}

function makeDeps(
  bridge: KeyboardDictationBridge | null,
  factory = makeCaptureFactory(),
): { deps: KeyboardDictationDeps; factory: typeof factory } {
  return {
    factory,
    deps: {
      getBridge: () => bridge,
      createCapture: factory.create,
      getLiveActivity: () => ({}),
      documentRef: () => document,
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(async () => {
  document.getElementById("eliza-keyboard-dictation-overlay")?.remove();
  vi.restoreAllMocks();
});

describe("startKeyboardDictationSession", () => {
  it("writes recording, then publishes the final transcript as ready with the session id", async () => {
    const bridge = makeBridge();
    const { deps, factory } = makeDeps(bridge);
    const session = startKeyboardDictationSession(
      new URLSearchParams("source=ios-keyboard&session=s-1"),
      deps,
    );
    await flush();
    expect(factory.captures).toHaveLength(1);
    expect(factory.captures[0].started).toBe(1);
    expect(bridge.writes[0]).toMatchObject({
      status: "recording",
      sessionId: "s-1",
    });

    factory.captures[0].options.onTranscript({
      text: "hello from the keyboard",
      final: true,
      backend: "browser",
    });
    await expect(session.done).resolves.toBe("ready");
    expect(bridge.writes.at(-1)).toMatchObject({
      status: "ready",
      transcript: "hello from the keyboard",
      sessionId: "s-1",
    });
    expect(factory.captures[0].disposed).toBe(1);
    expect(isKeyboardDictationSessionActive()).toBe(false);
    // Overlay switched into the switch-back prompt.
    expect(
      document.getElementById("eliza-keyboard-dictation-overlay")?.textContent,
    ).toContain("switch back to your keyboard");
  });

  it("interim segments update the overlay without publishing a record", async () => {
    const bridge = makeBridge();
    const { deps, factory } = makeDeps(bridge);
    startKeyboardDictationSession(new URLSearchParams("session=s-2"), deps);
    await flush();
    factory.captures[0].options.onTranscript({
      text: "partial words",
      final: false,
      backend: "browser",
    });
    expect(
      document.getElementById("eliza-keyboard-dictation-overlay")?.textContent,
    ).toContain("partial words");
    expect(bridge.writes).toHaveLength(1); // only the initial `recording`
  });

  it("publishes an explicit error record when capture fails (engine not running path)", async () => {
    const bridge = makeBridge();
    const { deps, factory } = makeDeps(bridge);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const session = startKeyboardDictationSession(
      new URLSearchParams("session=s-3"),
      deps,
    );
    await flush();
    factory.captures[0].options.onStateChange?.(
      "error",
      new Error("local ASR engine is not running"),
    );
    await expect(session.done).resolves.toBe("error");
    expect(bridge.writes.at(-1)).toMatchObject({
      status: "error",
      sessionId: "s-3",
    });
    expect(String(bridge.writes.at(-1)?.errorMessage)).toContain(
      "local ASR engine is not running",
    );
    expect(
      document.getElementById("eliza-keyboard-dictation-overlay")?.textContent,
    ).toContain("Speech capture failed");
  });

  it("publishes a no-speech error when finish() drains no final transcript", async () => {
    const bridge = makeBridge();
    const { deps, factory } = makeDeps(bridge);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const session = startKeyboardDictationSession(
      new URLSearchParams("session=s-4"),
      deps,
    );
    await flush();
    session.finish();
    await expect(session.done).resolves.toBe("error");
    expect(factory.captures[0].stopped).toBe(1);
    const statuses = bridge.writes.map((w) => w.status);
    expect(statuses).toEqual(["recording", "transcribing", "error"]);
    expect(String(bridge.writes.at(-1)?.errorMessage)).toContain(
      "No speech detected",
    );
  });

  it("cancel clears the handoff record and removes the overlay", async () => {
    const bridge = makeBridge();
    const { deps, factory } = makeDeps(bridge);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const session = startKeyboardDictationSession(
      new URLSearchParams("session=s-5"),
      deps,
    );
    await flush();
    session.cancel();
    await expect(session.done).resolves.toBe("cancelled");
    expect(bridge.cleared).toBe(1);
    expect(bridge.writes.map((w) => w.status)).toEqual(["recording"]);
    expect(
      document.getElementById("eliza-keyboard-dictation-overlay"),
    ).toBeNull();
    expect(factory.captures[0].disposed).toBe(1);
  });

  it("a relaunch while live cancels the previous session (mic re-tap)", async () => {
    const bridge = makeBridge();
    const { deps, factory } = makeDeps(bridge);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const first = startKeyboardDictationSession(
      new URLSearchParams("session=s-6a"),
      deps,
    );
    await flush();
    const second = startKeyboardDictationSession(
      new URLSearchParams("session=s-6b"),
      deps,
    );
    await expect(first.done).resolves.toBe("cancelled");
    await flush();
    factory.captures[1].options.onTranscript({
      text: "second take",
      final: true,
      backend: "browser",
    });
    await expect(second.done).resolves.toBe("ready");
    expect(bridge.writes.at(-1)).toMatchObject({
      status: "ready",
      transcript: "second take",
      sessionId: "s-6b",
    });
  });

  it("fails explicitly (no capture, no silent no-op) when the bridge is unavailable", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { deps, factory } = makeDeps(null);
    const session = startKeyboardDictationSession(
      new URLSearchParams("session=s-7"),
      deps,
    );
    await expect(session.done).resolves.toBe("error");
    expect(factory.captures).toHaveLength(0);
    expect(
      document.getElementById("eliza-keyboard-dictation-overlay")?.textContent,
    ).toContain("only available in the iOS app");
  });

  it("surfaces a handoff failure when the App-Group write itself rejects", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const bridge = makeBridge({
      setDictationState: vi.fn(async () => {
        throw new Error("App Group group.ai.elizaos.app is unavailable");
      }),
    });
    const { deps, factory } = makeDeps(bridge);
    const session = startKeyboardDictationSession(
      new URLSearchParams("session=s-8"),
      deps,
    );
    await expect(session.done).resolves.toBe("error");
    // Capture never starts when the handoff channel is broken.
    expect(factory.captures[0]?.started ?? 0).toBe(0);
    expect(
      document.getElementById("eliza-keyboard-dictation-overlay")?.textContent,
    ).toContain("Keyboard handoff unavailable");
  });
});
