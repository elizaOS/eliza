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

describe("eliza-code global-input routing (#11266)", () => {
  beforeEach(() => {
    // Fresh, chat-focused, empty composer — the normal typing state.
    useStore.setState({ focusedPane: "chat", inputValue: "", rooms: [] });
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
});
