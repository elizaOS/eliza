// @vitest-environment jsdom
//
// Drives the interactive-terminal wiring through the REAL component path
// (mount -> client.spawnPtySession -> mount PtyTerminalPane on the returned
// sessionId; error -> retry; unmount/close -> client.stopPtySession), mocking
// only the client boundary and the xterm pane (which needs a real DOM/canvas).
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawnPtySession: vi.fn(),
  stopPtySession: vi.fn(),
}));

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
