// @vitest-environment node
//
// Regression tests for the eliza-code TUI "front door": global-shortcut input
// routing (#11266). App's constructor is synchronous and only needs a runtime,
// and FilteringTerminal routes stdin through App.consumeGlobalInput before the
// focused component sees it — so we construct a real App with a minimal runtime
// stub and drive the real interceptor, asserting which keys it consumes.

import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentRuntime } from "@elizaos/core";
import { App } from "./App.js";
import { getAgentClient, resetAgentClient } from "./lib/agent-client.js";
import { useStore } from "./lib/store.js";

// App's constructor builds terminal/tui/panes synchronously; nothing touches
// stdin (FilteringTerminal is inert until start()) or the network at construct
// time, and TaskPane just stores its props. A bare object satisfies the fields
// the construction path reads.
function makeApp(): {
  consume: (data: string) => boolean;
} {
  const runtime = {
    agentId: "test",
    character: { name: "Eliza" },
    getService: () => null,
  } as unknown as AgentRuntime;
  const app = new App(runtime);
  const consume = (data: string): boolean =>
    (
      app as unknown as { consumeGlobalInput(d: string): boolean }
    ).consumeGlobalInput(data);
  return { consume };
}

function makeAbortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function makeAbortableApp(): {
  consume: (data: string) => boolean;
  send: (text: string) => Promise<void>;
  started: Promise<void>;
  seenSignal: () => AbortSignal | undefined;
} {
  let resolveStarted: (() => void) | null = null;
  let seenSignal: AbortSignal | undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });

  const runtime = Object.assign(Object.create(null) as AgentRuntime, {
    agentId: "test",
    character: { name: "Eliza" },
    getService: () => null,
    ensureConnection: async () => {},
    messageService: {
      handleMessage: async (
        _runtime: unknown,
        _message: unknown,
        _callback: unknown,
        options?: { abortSignal?: AbortSignal },
      ) => {
        seenSignal = options?.abortSignal;
        resolveStarted?.();
        if (!seenSignal) {
          throw new Error("missing abort signal");
        }
        await new Promise<void>((_resolve, reject) => {
          if (seenSignal?.aborted) {
            reject(makeAbortError());
            return;
          }
          seenSignal?.addEventListener(
            "abort",
            () => reject(makeAbortError()),
            { once: true },
          );
        });
        return { didRespond: false, responseMessages: [] };
      },
    },
  });

  getAgentClient().setRuntime(runtime);
  const app = new App(runtime);
  return {
    // biome-ignore lint/complexity/useLiteralKeys: private test hook
    consume: (data: string): boolean => app["consumeGlobalInput"](data),
    // biome-ignore lint/complexity/useLiteralKeys: private test hook
    send: (text: string): Promise<void> => app["handleSendMessage"](text),
    started,
    seenSignal: () => seenSignal,
  };
}

describe("eliza-code global-input routing (#11266)", () => {
  beforeEach(() => {
    // Fresh, chat-focused, empty composer — the normal typing state.
    useStore.setState({ focusedPane: "chat", inputValue: "", rooms: [] });
    resetAgentClient();
  });

  it("does NOT consume punctuation while typing in the chat composer", () => {
    const { consume } = makeApp();
    useStore.setState({ focusedPane: "chat", inputValue: "Fix App.ts" });
    // These reach the editor now (previously hijacked as resize/help).
    expect(consume(",")).toBe(false);
    expect(consume(".")).toBe(false);
    expect(consume("?")).toBe(false);
  });

  it("opens help on '?' only when the composer is empty (or chat unfocused)", () => {
    const { consume } = makeApp();
    useStore.setState({ focusedPane: "chat", inputValue: "" });
    expect(consume("?")).toBe(true); // empty buffer → help
  });

  it("treats bare ','/'.' as pane resize only when the task pane is focused", () => {
    const { consume } = makeApp();
    useStore.setState({ focusedPane: "tasks", inputValue: "" });
    expect(consume(",")).toBe(true);
    expect(consume(".")).toBe(true);
  });

  it("always honors the Ctrl+←/→ resize sequences regardless of focus", () => {
    const { consume } = makeApp();
    useStore.setState({ focusedPane: "chat", inputValue: "typing" });
    expect(consume("\x1b[1;5D")).toBe(true);
    expect(consume("\x1b[1;5C")).toBe(true);
  });

  for (const [label, key] of [
    ["Ctrl+C", "\x03"],
    ["Esc", "\x1b"],
  ] as const) {
    it(`aborts an in-flight turn on ${label} instead of leaving a blank assistant placeholder`, async () => {
      const { consume, send, started, seenSignal } = makeAbortableApp();
      const state = useStore.getState();
      const room = state.createRoom("Abort test");

      const turn = send("think for a long time");
      await started;

      expect(seenSignal()).toBeDefined();
      expect(seenSignal()?.aborted).toBe(false);
      expect(useStore.getState().isLoading).toBe(true);

      expect(consume(key)).toBe(true);
      await turn;

      expect(seenSignal()?.aborted).toBe(true);
      const after = useStore
        .getState()
        .rooms.find((candidate) => candidate.id === room.id);
      expect(after?.messages.map((message) => message.role)).toEqual([
        "user",
        "system",
      ]);
      expect(after?.messages.at(-1)?.content).toBe("Turn aborted.");
      expect(useStore.getState().isLoading).toBe(false);
      expect(useStore.getState().isAgentTyping).toBe(false);
    });
  }
});
