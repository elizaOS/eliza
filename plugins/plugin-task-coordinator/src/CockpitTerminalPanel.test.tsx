// @vitest-environment jsdom
//
// Drives the cockpit terminal panel through the rendered DOM, mocking only at
// the leaf boundaries a unit test cannot stand up: xterm.js (so the raw CLI pane
// can mount in jsdom) and the `@elizaos/ui` client + Button primitive (so the
// PTY WS protocol is observable without a live agent). Asserts the pretty⇄CLI
// toggle, the empty state, and — for the pretty PtyConsoleBase pane — drives the
// real `pty-output` WS event → <pre> update and a typed line → `sendPtyInput`.
//
// HONEST NOTE: this proves the panel's wiring + mount behavior. That raw stdin
// actually reaches a prompt so a live `/slash` executes needs a runtime with a
// registered PTY_SERVICE (node-pty) — out of reach for a unit test; see the
// component docblock + 05-GAP-FILL-PLAN.md Step 3 "Build-lead call".

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// --- xterm mocked so PtyTerminalPane's lazy import can resolve under jsdom ---
const xterm = vi.hoisted(() => {
  const open = vi.fn();
  const onData = vi.fn();
  // Regular functions (not arrows) so PtyTerminalPane can `new Terminal(...)`.
  const TerminalCtor = vi.fn(function MockTerminal() {
    return {
      open,
      onData,
      write: vi.fn(),
      dispose: vi.fn(),
      loadAddon: vi.fn(),
      scrollToBottom: vi.fn(),
      cols: 80,
      rows: 24,
    };
  });
  const FitAddonCtor = vi.fn(function MockFitAddon() {
    return { fit: vi.fn() };
  });
  return { TerminalCtor, FitAddonCtor, open };
});

vi.mock("@xterm/xterm", () => ({ Terminal: xterm.TerminalCtor }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: xterm.FitAddonCtor }));

// --- @elizaos/ui mocked at the client + Button boundary ---
const ui = vi.hoisted(() => {
  const handlers: Record<string, ((event: unknown) => void)[]> = {};
  const client = {
    getPtyBufferedOutput: vi.fn(async () => ""),
    onWsEvent: vi.fn((event: string, handler: (event: unknown) => void) => {
      const list = handlers[event] ?? [];
      list.push(handler);
      handlers[event] = list;
      return () => {
        handlers[event] = (handlers[event] ?? []).filter((h) => h !== handler);
      };
    }),
    subscribePtyOutput: vi.fn(),
    unsubscribePtyOutput: vi.fn(),
    resizePty: vi.fn(),
    sendPtyInput: vi.fn(),
    stopCodingAgent: vi.fn(),
    // PtyTerminalPane re-sends pty-subscribe on WS reconnect.
    onReconnect: vi.fn(() => () => undefined),
  };
  const emit = (event: string, payload: unknown) => {
    for (const handler of handlers[event] ?? []) handler(payload);
  };
  return { client, emit };
});

vi.mock("@elizaos/ui", () => ({
  client: ui.client,
  Button: (props: Record<string, unknown>) => {
    const { children, variant: _variant, size: _size, ...rest } = props;
    return React.createElement(
      "button",
      { type: "button", ...rest },
      children as React.ReactNode,
    );
  },
}));

import { CockpitTerminalPanel } from "./CockpitTerminalPanel";

// jsdom (vitest) ships no ResizeObserver; PtyTerminalPane constructs one.
class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver =
  MockResizeObserver as unknown as typeof ResizeObserver;
if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(
      () => cb(Date.now()),
      0,
    ) as unknown as number) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) =>
    clearTimeout(id)) as typeof cancelAnimationFrame;
}

const sessions = [
  {
    sessionId: "s1",
    agentType: "elizaos",
    label: "Coding agent",
    originalTask: "fix the auth bug",
    workdir: "/work/repo",
    status: "active" as const,
    decisionCount: 0,
    autoResolvedCount: 0,
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CockpitTerminalPanel — pretty ⇄ CLI toggle", () => {
  it("defaults to the pretty PtyConsoleBase watch view", async () => {
    render(<CockpitTerminalPanel activeSessionId="s1" sessions={sessions} />);
    expect(screen.getByTestId("cockpit-terminal-panel")).toBeTruthy();
    expect(screen.getByTestId("pty-console-base")).toBeTruthy();
    expect(screen.queryByTestId("cockpit-term-cli")).toBeNull();
    expect(screen.queryByTestId("cockpit-terminal-empty")).toBeNull();
    // The pretty pane attaches to the active session on mount.
    await waitFor(() =>
      expect(ui.client.subscribePtyOutput).toHaveBeenCalledWith("s1"),
    );
  });

  it("clicking the CLI toggle mounts the raw xterm terminal pane", async () => {
    render(<CockpitTerminalPanel activeSessionId="s1" sessions={sessions} />);
    fireEvent.click(screen.getByTestId("cockpit-term-toggle-cli"));

    expect(screen.getByTestId("cockpit-term-cli")).toBeTruthy();
    expect(screen.queryByTestId("pty-console-base")).toBeNull();
    // The lazy xterm import resolves + the terminal opens into the container.
    await waitFor(() => expect(xterm.TerminalCtor).toHaveBeenCalled());
    await waitFor(() => expect(xterm.open).toHaveBeenCalled());
  });

  it("toggling back to pretty restores the console view", async () => {
    render(<CockpitTerminalPanel activeSessionId="s1" sessions={sessions} />);
    fireEvent.click(screen.getByTestId("cockpit-term-toggle-cli"));
    expect(screen.queryByTestId("pty-console-base")).toBeNull();
    fireEvent.click(screen.getByTestId("cockpit-term-toggle-pretty"));
    expect(screen.getByTestId("pty-console-base")).toBeTruthy();
    expect(screen.queryByTestId("cockpit-term-cli")).toBeNull();
  });

  it("shows the empty state (not a terminal) when there is no active session", () => {
    render(<CockpitTerminalPanel activeSessionId={null} sessions={[]} />);
    // Default (pretty) with no session → empty state, not the console.
    expect(screen.getByTestId("cockpit-terminal-empty")).toBeTruthy();
    expect(screen.queryByTestId("pty-console-base")).toBeNull();

    // Toggling to CLI must still show the empty state, never mount xterm.
    fireEvent.click(screen.getByTestId("cockpit-term-toggle-cli"));
    expect(screen.getByTestId("cockpit-terminal-empty")).toBeTruthy();
    expect(screen.queryByTestId("cockpit-term-cli")).toBeNull();
    expect(xterm.TerminalCtor).not.toHaveBeenCalled();
  });

  it("streams a pty-output WS event into the pretty console <pre>", async () => {
    const { container } = render(
      <CockpitTerminalPanel activeSessionId="s1" sessions={sessions} />,
    );
    await waitFor(() =>
      expect(ui.client.subscribePtyOutput).toHaveBeenCalledWith("s1"),
    );
    act(() => {
      ui.emit("pty-output", { sessionId: "s1", data: "hello from pty\n" });
    });
    await waitFor(() => {
      const pre = container.querySelector("pre");
      expect(pre?.textContent).toContain("hello from pty");
    });
    // A frame for a different session must be ignored.
    act(() => {
      ui.emit("pty-output", { sessionId: "other", data: "LEAK" });
    });
    const pre = container.querySelector("pre");
    expect(pre?.textContent).not.toContain("LEAK");
  });

  it("sends a typed line plus a trailing newline via the client on Enter", () => {
    render(<CockpitTerminalPanel activeSessionId="s1" sessions={sessions} />);
    const input = screen.getByLabelText("Terminal input");
    fireEvent.change(input, { target: { value: "ls -la" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(ui.client.sendPtyInput).toHaveBeenCalledWith("s1", "ls -la\n");
  });
});
