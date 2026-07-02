// @vitest-environment node
//
// Queue-and-send + abort-key semantics for the eliza-code TUI (#11294):
// * Enter during a running turn buffers the submission (no second concurrent
//   turn) and fires it when the turn completes — opencode behavior.
// * Aborting a turn discards the queue ("stop everything").
// * A second Ctrl+C while an aborted turn is still unwinding quits the app
//   instead of being eaten; Ctrl+C when idle quits on the first press.
//
// Pattern follows global-input.test.ts: construct a real App around a minimal
// runtime stub and drive the real private handlers.

import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentRuntime } from "@elizaos/core";
import { App } from "./App.js";
import { getAgentClient, resetAgentClient } from "./lib/agent-client.js";
import { useStore } from "./lib/store.js";
import type { Message } from "./types.js";

function makeAbortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

async function waitFor(cond: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function roomMessages(roomId: string): Message[] {
  return (
    useStore.getState().rooms.find((room) => room.id === roomId)?.messages ?? []
  );
}

interface DeferredTurn {
  text: string;
  resolve: () => void;
}

/**
 * App wired to a runtime whose turns block until the test resolves them, so a
 * second submission can arrive while the first turn is verifiably in flight.
 * Turns honor the abort signal (reject with AbortError).
 */
function makeQueueApp() {
  const sentTexts: string[] = [];
  const turns: DeferredTurn[] = [];
  const runtime = Object.assign(Object.create(null) as AgentRuntime, {
    agentId: "test",
    character: { name: "Eliza" },
    getService: () => null,
    ensureConnection: async () => {},
    messageService: {
      handleMessage: async (
        _runtime: unknown,
        message: { content?: { text?: string } },
        callback: (content: { text: string }) => Promise<unknown>,
        options?: { abortSignal?: AbortSignal },
      ) => {
        const text = message.content?.text ?? "";
        sentTexts.push(text);
        await new Promise<void>((resolve, reject) => {
          turns.push({ text, resolve });
          options?.abortSignal?.addEventListener(
            "abort",
            () => reject(makeAbortError()),
            { once: true },
          );
        });
        await callback({ text: `echo: ${text}` });
        return { didRespond: true, responseMessages: [] };
      },
    },
  });

  getAgentClient().setRuntime(runtime);
  const app = new App(runtime);
  return {
    app,
    // biome-ignore lint/complexity/useLiteralKeys: private test hook
    send: (text: string): Promise<void> => app["handleSendMessage"](text),
    // biome-ignore lint/complexity/useLiteralKeys: private test hook
    consume: (data: string): boolean => app["consumeGlobalInput"](data),
    sentTexts: () => sentTexts,
    turns,
  };
}

/**
 * App wired to a runtime that wedges: handleMessage never settles and ignores
 * the abort signal entirely — the worst case a slow/broken provider produces.
 */
function makeWedgedApp() {
  let turnStarted = false;
  const runtime = Object.assign(Object.create(null) as AgentRuntime, {
    agentId: "test",
    character: { name: "Eliza" },
    getService: () => null,
    ensureConnection: async () => {},
    messageService: {
      handleMessage: async () => {
        turnStarted = true;
        await new Promise(() => {});
      },
    },
  });

  getAgentClient().setRuntime(runtime);
  const app = new App(runtime);
  return {
    app,
    // biome-ignore lint/complexity/useLiteralKeys: private test hook
    send: (text: string): Promise<void> => app["handleSendMessage"](text),
    // biome-ignore lint/complexity/useLiteralKeys: private test hook
    consume: (data: string): boolean => app["consumeGlobalInput"](data),
    turnStarted: () => turnStarted,
  };
}

/** Stub out session persistence and App.stop; returns spies + restore. */
function instrumentQuit(app: App): {
  stopped: () => boolean;
  restore: () => void;
} {
  let stopped = false;
  const originalSave = useStore.getState().saveSessionState;
  useStore.setState({ saveSessionState: async () => {} });
  (app as { stop: () => void }).stop = () => {
    stopped = true;
  };
  return {
    stopped: () => stopped,
    restore: () => {
      useStore.setState({ saveSessionState: originalSave });
    },
  };
}

beforeEach(() => {
  useStore.setState({
    focusedPane: "chat",
    inputValue: "",
    rooms: [],
    pendingSubmissions: [],
    isLoading: false,
    isAgentTyping: false,
  });
  resetAgentClient();
});

describe("eliza-code queue-and-send (#11294)", () => {
  it("queues a submission made during a running turn and sends it when the turn completes", async () => {
    const { send, sentTexts, turns } = makeQueueApp();
    const room = useStore.getState().createRoom("Queue test");

    const turnA = send("first question");
    await waitFor(() => turns.length === 1, "first turn to start");

    // Second submission while the turn runs: buffered, NOT sent concurrently.
    await send("second question");
    expect(sentTexts()).toEqual(["first question"]);
    expect(useStore.getState().pendingSubmissions).toEqual(["second question"]);
    const queuedNotice = roomMessages(room.id)
      .filter((message) => message.role === "system")
      .at(-1);
    expect(queuedNotice?.content).toContain("Queued (1): second question");

    // Turn A completes → the queued submission fires as its own turn.
    turns[0]?.resolve();
    await turnA;
    await waitFor(() => turns.length === 2, "queued turn to start");
    expect(sentTexts()).toEqual(["first question", "second question"]);
    expect(useStore.getState().pendingSubmissions).toEqual([]);

    turns[1]?.resolve();
    await waitFor(
      () => !useStore.getState().isLoading && turns.length === 2,
      "queued turn to finish",
    );

    const finalMessages = roomMessages(room.id);
    expect(finalMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "system",
      "user",
      "assistant",
    ]);
    expect(finalMessages[1]?.content).toBe("echo: first question");
    expect(finalMessages[3]?.content).toBe("second question");
    expect(finalMessages[4]?.content).toBe("echo: second question");
  });

  it("drains multiple queued submissions in FIFO order", async () => {
    const { send, sentTexts, turns } = makeQueueApp();
    useStore.getState().createRoom("FIFO test");

    const turnA = send("one");
    await waitFor(() => turns.length === 1, "first turn to start");
    await send("two");
    await send("three");
    expect(useStore.getState().pendingSubmissions).toEqual(["two", "three"]);

    turns[0]?.resolve();
    await turnA;
    await waitFor(() => turns.length === 2, "second turn to start");
    turns[1]?.resolve();
    await waitFor(() => turns.length === 3, "third turn to start");
    turns[2]?.resolve();
    await waitFor(
      () => !useStore.getState().isLoading && turns.length === 3,
      "all turns to finish",
    );

    expect(sentTexts()).toEqual(["one", "two", "three"]);
    expect(useStore.getState().pendingSubmissions).toEqual([]);
  });

  it("discards queued submissions when the turn is aborted", async () => {
    const { send, sentTexts, consume, turns } = makeQueueApp();
    const room = useStore.getState().createRoom("Abort-discard test");

    const turnA = send("running turn");
    await waitFor(() => turns.length === 1, "turn to start");
    await send("queued behind it");
    expect(useStore.getState().pendingSubmissions).toEqual([
      "queued behind it",
    ]);

    expect(consume("\x03")).toBe(true);
    await turnA;

    expect(useStore.getState().pendingSubmissions).toEqual([]);
    const systemLines = roomMessages(room.id)
      .filter((message) => message.role === "system")
      .map((message) => message.content);
    expect(systemLines).toContain("Turn aborted.");
    expect(systemLines).toContain("Discarded 1 queued message.");

    // Give a drain (if one were wrongly scheduled) a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sentTexts()).toEqual(["running turn"]);
  });

  it("still runs slash commands immediately during a turn instead of queueing them", async () => {
    const { send, turns } = makeQueueApp();
    const room = useStore.getState().createRoom("Slash-during-turn test");

    const turnA = send("busy turn");
    await waitFor(() => turns.length === 1, "turn to start");

    await send("/pwd");
    expect(useStore.getState().pendingSubmissions).toEqual([]);
    const lastSystem = roomMessages(room.id)
      .filter((message) => message.role === "system")
      .at(-1);
    expect(lastSystem?.content).not.toContain("Queued");

    turns[0]?.resolve();
    await turnA;
  });
});

describe("eliza-code abort-key fallthrough (#11294)", () => {
  it("quits on the second Ctrl+C while an aborted turn is still unwinding", async () => {
    const { app, send, consume, turnStarted } = makeWedgedApp();
    const quit = instrumentQuit(app);
    try {
      useStore.getState().createRoom("Wedge test");
      void send("hang forever");
      await waitFor(turnStarted, "wedged turn to start");

      // First Ctrl+C: consumed, requests the abort — must NOT quit.
      expect(consume("\x03")).toBe(true);
      expect(quit.stopped()).toBe(false);

      // Esc after the abort request falls through without quitting.
      expect(consume("\x1b")).toBe(false);
      expect(quit.stopped()).toBe(false);

      // Second Ctrl+C: the turn never unwound (provider ignores the signal),
      // so the keystroke falls through to the quit handler.
      expect(consume("\x03")).toBe(true);
      expect(quit.stopped()).toBe(true);
    } finally {
      quit.restore();
    }
  });

  it("quits on the first Ctrl+C when no turn is running", () => {
    const { app, consume } = makeQueueApp();
    const quit = instrumentQuit(app);
    try {
      expect(consume("\x03")).toBe(true);
      expect(quit.stopped()).toBe(true);
    } finally {
      quit.restore();
    }
  });
});
