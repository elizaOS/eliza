// @vitest-environment jsdom
//
// Drives the interactive-terminal wiring through the REAL component path
// (mount -> client.spawnPtySession -> mount PtyTerminalPane on the returned
// sessionId; error -> retry; unmount/close -> client.stopPtySession), mocking
// only the client boundary and the xterm pane (which needs a real DOM/canvas).
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const wsHandlers = new Map<
    string,
    Set<(data: Record<string, unknown>) => void>
  >();
  return {
    spawnPtySession: vi.fn(),
    stopPtySession: vi.fn(),
    wsHandlers,
    onWsEvent: vi.fn(
      (type: string, handler: (data: Record<string, unknown>) => void) => {
        let handlers = wsHandlers.get(type);
        if (!handlers) {
          handlers = new Set();
          wsHandlers.set(type, handlers);
        }
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    ),
    emitWsEvent: (type: string, data: Record<string, unknown>) => {
      for (const handler of wsHandlers.get(type) ?? []) handler(data);
    },
  };
});

type ButtonMockProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "size"> & {
  agent?: string;
  children?: ReactNode;
  onPress?: MouseEventHandler<HTMLButtonElement>;
  size?: string;
  variant?: string;
};

vi.mock("@elizaos/ui", () => ({
  client: {
    spawnPtySession: mocks.spawnPtySession,
    stopPtySession: mocks.stopPtySession,
    onWsEvent: mocks.onWsEvent,
  },
  Button: (props: ButtonMockProps) => {
    const {
      children,
      variant: _variant,
      size: _size,
      agent: _agent,
      onPress,
      onClick,
      ...rest
    } = props;
    return (
      <button type="button" {...rest} onClick={onClick ?? onPress}>
        {children}
      </button>
    );
  },
}));

// Stub the xterm pane: surface the sessionId + visibility it was mounted with.
vi.mock("./PtyTerminalPane", () => ({
  PtyTerminalPane: (props: { sessionId: string; visible: boolean }) => (
    <div
      data-testid="pty-pane"
      data-session={props.sessionId}
      data-visible={String(props.visible)}
    />
  ),
}));

import { CockpitInteractiveTerminal } from "./CockpitInteractiveTerminal";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.wsHandlers.clear();
});

describe("CockpitInteractiveTerminal — spawn → attach wiring", () => {
  it("spawns an eliza-code session at the given tier and mounts the pane on it", async () => {
    mocks.spawnPtySession.mockResolvedValue({ sessionId: "sess-1" });
    render(<CockpitInteractiveTerminal tier="smart" />);

    // Spawning state first.
    expect(screen.getByTestId("cockpit-terminal-spawning")).toBeTruthy();

    await waitFor(() =>
      expect(mocks.spawnPtySession).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "eliza-code", tier: "smart" }),
      ),
    );
    const pane = await screen.findByTestId("pty-pane");
    expect(pane.getAttribute("data-session")).toBe("sess-1");
    expect(pane.getAttribute("data-visible")).toBe("true");
  });

  it("forwards an explicit cwd", async () => {
    mocks.spawnPtySession.mockResolvedValue({ sessionId: "sess-cwd" });
    render(<CockpitInteractiveTerminal tier="fast" cwd="/work/repo" />);
    await waitFor(() =>
      expect(mocks.spawnPtySession).toHaveBeenCalledWith(
        expect.objectContaining({ tier: "fast", cwd: "/work/repo" }),
      ),
    );
  });

  it("spawns the experimental vendor kinds through the same surface, without a cerebras tier", async () => {
    for (const kind of ["claude", "codex"] as const) {
      mocks.spawnPtySession.mockResolvedValue({ sessionId: `sess-${kind}` });
      const { unmount } = render(
        <CockpitInteractiveTerminal tier="fast" kind={kind} />,
      );
      await waitFor(() =>
        expect(mocks.spawnPtySession).toHaveBeenCalledWith({ kind }),
      );
      const pane = await screen.findByTestId("pty-pane");
      expect(pane.getAttribute("data-session"), kind).toBe(`sess-${kind}`);
      // The header names the vendor CLI, not the cerebras tier.
      expect(screen.getByText(`${kind} · interactive`), kind).toBeTruthy();
      unmount();
      mocks.spawnPtySession.mockClear();
    }
  });

  it("surfaces the server's gate rejection for vendor kinds", async () => {
    mocks.spawnPtySession.mockRejectedValueOnce(
      new Error(
        'Interactive "claude" CLI sessions are an experimental tier that is off by default (runs the real vendor CLI on your own subscription). Set PTY_VENDOR_CLI_ENABLED=true to enable it.',
      ),
    );
    render(<CockpitInteractiveTerminal tier="fast" kind="claude" />);
    const err = await screen.findByTestId("cockpit-terminal-error");
    expect(err.textContent).toContain("PTY_VENDOR_CLI_ENABLED");
  });

  it("surfaces a spawn error and retries", async () => {
    mocks.spawnPtySession.mockRejectedValueOnce(new Error("no cloud key"));
    render(<CockpitInteractiveTerminal tier="fast" />);

    const err = await screen.findByTestId("cockpit-terminal-error");
    expect(err.textContent).toContain("no cloud key");

    mocks.spawnPtySession.mockResolvedValueOnce({ sessionId: "sess-retry" });
    fireEvent.click(screen.getByTestId("cockpit-terminal-retry"));
    const pane = await screen.findByTestId("pty-pane");
    expect(pane.getAttribute("data-session")).toBe("sess-retry");
    expect(mocks.spawnPtySession).toHaveBeenCalledTimes(2);
  });

  it("kills the session on unmount (no orphan REPL)", async () => {
    mocks.spawnPtySession.mockResolvedValue({ sessionId: "sess-unmount" });
    const { unmount } = render(<CockpitInteractiveTerminal tier="fast" />);
    await screen.findByTestId("pty-pane");
    unmount();
    expect(mocks.stopPtySession).toHaveBeenCalledWith("sess-unmount");
  });

  it("close button stops the session and calls onClose", async () => {
    mocks.spawnPtySession.mockResolvedValue({ sessionId: "sess-close" });
    const onClose = vi.fn();
    render(<CockpitInteractiveTerminal tier="fast" onClose={onClose} />);
    await screen.findByTestId("pty-pane");
    fireEvent.click(screen.getByTestId("cockpit-terminal-close"));
    expect(mocks.stopPtySession).toHaveBeenCalledWith("sess-close");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("CockpitInteractiveTerminal — session death (pty-exit)", () => {
  it("shows the ended state when the session's pty-exit arrives (was: stuck 'ready' forever)", async () => {
    mocks.spawnPtySession.mockResolvedValue({ sessionId: "sess-exit" });
    render(<CockpitInteractiveTerminal tier="fast" />);
    const pane = await screen.findByTestId("pty-pane");
    expect(pane.getAttribute("data-visible")).toBe("true");

    act(() => {
      mocks.emitWsEvent("pty-exit", {
        type: "pty-exit",
        sessionId: "sess-exit",
        exitCode: 0,
      });
    });

    const ended = await screen.findByTestId("cockpit-terminal-ended");
    expect(ended.textContent).toContain("session ended");
    expect(ended.textContent).toContain("exit 0");
    // The dead pane is no longer presented as the live surface.
    expect(screen.getByTestId("pty-pane").getAttribute("data-visible")).toBe(
      "false",
    );
  });

  it("does not stop an already-dead session on unmount", async () => {
    mocks.spawnPtySession.mockResolvedValue({ sessionId: "sess-dead" });
    const { unmount } = render(<CockpitInteractiveTerminal tier="fast" />);
    await screen.findByTestId("pty-pane");

    act(() => {
      mocks.emitWsEvent("pty-exit", {
        type: "pty-exit",
        sessionId: "sess-dead",
        exitCode: null,
      });
    });
    await screen.findByTestId("cockpit-terminal-ended");

    unmount();
    expect(mocks.stopPtySession).not.toHaveBeenCalled();
  });

  it("ignores pty-exit for a different session", async () => {
    mocks.spawnPtySession.mockResolvedValue({ sessionId: "sess-mine" });
    render(<CockpitInteractiveTerminal tier="fast" />);
    await screen.findByTestId("pty-pane");

    act(() => {
      mocks.emitWsEvent("pty-exit", {
        type: "pty-exit",
        sessionId: "sess-other",
        exitCode: 1,
      });
    });

    expect(screen.queryByTestId("cockpit-terminal-ended")).toBeNull();
    expect(screen.getByTestId("pty-pane").getAttribute("data-visible")).toBe(
      "true",
    );
  });

  it("restart spawns a fresh session after the old one ended", async () => {
    mocks.spawnPtySession.mockResolvedValueOnce({ sessionId: "sess-old" });
    render(<CockpitInteractiveTerminal tier="smart" />);
    await screen.findByTestId("pty-pane");

    act(() => {
      mocks.emitWsEvent("pty-exit", {
        type: "pty-exit",
        sessionId: "sess-old",
        exitCode: 137,
      });
    });
    await screen.findByTestId("cockpit-terminal-ended");

    mocks.spawnPtySession.mockResolvedValueOnce({ sessionId: "sess-new" });
    fireEvent.click(screen.getByTestId("cockpit-terminal-restart"));

    await waitFor(() => {
      expect(screen.getByTestId("pty-pane").getAttribute("data-session")).toBe(
        "sess-new",
      );
    });
    expect(screen.getByTestId("pty-pane").getAttribute("data-visible")).toBe(
      "true",
    );
    expect(screen.queryByTestId("cockpit-terminal-ended")).toBeNull();
    expect(mocks.spawnPtySession).toHaveBeenCalledTimes(2);
  });
});
