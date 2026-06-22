// @vitest-environment jsdom
//
// DOM/behavioral coverage for the live-terminal coding UX (PtyConsoleBase,
// src/PtyConsoleBase.tsx). Before this file the PTY console component had ZERO
// in-plugin unit coverage — the regression surface (WS subscribe/unsubscribe
// lifecycle, buffered-output hydrate, append-on-pty-output, cross-session
// filtering, the 200k ring-buffer trim, terminal input/Enter/Send/Ctrl-C wiring,
// stop-vs-close semantics, the resize(120|96, 32) variant gate, session-switch
// resubscribe, and the `disposed` guard against setState-after-unmount) was
// entirely untested. We mock @elizaos/ui exactly like the sibling
// CodingAgentTasksPanel.test.tsx (the vitest.config alias points @elizaos/ui at
// real source; vi.mock overrides it) so the component's own behavior is under
// test. The WS bus is driven deterministically by capturing the handler passed
// to client.onWsEvent and invoking it directly inside act().
//
// OUT OF SCOPE (documented, not tested here): PtyTerminalPane.tsx dynamically
// imports @xterm/xterm + @xterm/addon-fit, calls term.open() (needs a real
// canvas/layout) and uses ResizeObserver — none of which are reliably testable
// in jsdom; covering it would test the mocks, not the code.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted vi.fn handles for every client method PtyConsoleBase calls.
const getPtyBufferedOutput = vi.fn();
const subscribePtyOutput = vi.fn();
const unsubscribePtyOutput = vi.fn();
const sendPtyInput = vi.fn();
const resizePty = vi.fn();
const stopCodingAgent = vi.fn();
const onWsEvent = vi.fn();

vi.mock("@elizaos/ui", () => ({
  client: {
    getPtyBufferedOutput: (...a: unknown[]) => getPtyBufferedOutput(...a),
    subscribePtyOutput: (...a: unknown[]) => subscribePtyOutput(...a),
    unsubscribePtyOutput: (...a: unknown[]) => unsubscribePtyOutput(...a),
    sendPtyInput: (...a: unknown[]) => sendPtyInput(...a),
    resizePty: (...a: unknown[]) => resizePty(...a),
    stopCodingAgent: (...a: unknown[]) => stopCodingAgent(...a),
    onWsEvent: (...a: unknown[]) => onWsEvent(...a),
  },
  // Minimal Button stub rendering a real <button> so the header/footer
  // aria-label / onClick wiring is exercised through getByLabelText + click.
  Button: ({
    children,
    onClick,
    title,
    "aria-label": ariaLabel,
  }: {
    children: ReactNode;
    onClick?: () => void;
    title?: string;
    "aria-label"?: string;
  }) => (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  ),
}));

// Import the component AFTER the mock (vi.mock is hoisted).
import { PtyConsoleBase } from "../../src/PtyConsoleBase";

// The CodingAgentSession shape is type-only (erased at runtime). Inlined here so
// the fixture is self-contained and matches client-types-cloud.ts exactly.
interface CodingAgentSession {
  sessionId: string;
  agentType: string;
  label: string;
  originalTask: string;
  workdir: string;
  status:
    | "active"
    | "blocked"
    | "completed"
    | "stopped"
    | "error"
    | "tool_running";
  decisionCount: number;
  autoResolvedCount: number;
  toolDescription?: string;
  lastActivity?: string;
}

function session(
  over: Partial<CodingAgentSession> & { sessionId: string },
): CodingAgentSession {
  return {
    agentType: "codex",
    label: "Term",
    originalTask: "",
    workdir: "/repo",
    status: "active",
    decisionCount: 0,
    autoResolvedCount: 0,
    ...over,
  };
}

// Grab the pty-output WS handler the component registered so the test can drive
// events deterministically.
function emitPty(): (e: Record<string, unknown>) => void {
  const call = onWsEvent.mock.calls.find(([type]) => type === "pty-output");
  if (!call) throw new Error("onWsEvent was not called with 'pty-output'");
  return call[1] as (e: Record<string, unknown>) => void;
}

// Read the live terminal text out of the <pre> inside the testid container.
function preText(): string {
  const pre = screen.getByTestId("pty-console-base").querySelector("pre");
  if (!pre) throw new Error("no <pre> in pty-console-base");
  return pre.textContent ?? "";
}

// Module-scope unbind spy so cleanup/session-switch can be asserted.
let unbind: ReturnType<typeof vi.fn>;
const onClose = vi.fn();

beforeEach(() => {
  getPtyBufferedOutput.mockReset().mockResolvedValue("");
  subscribePtyOutput.mockReset();
  unsubscribePtyOutput.mockReset();
  sendPtyInput.mockReset();
  resizePty.mockReset();
  stopCodingAgent.mockReset().mockResolvedValue(true);
  unbind = vi.fn();
  onWsEvent.mockReset().mockReturnValue(unbind);
  onClose.mockReset();
});

afterEach(() => {
  cleanup();
});

function renderBase(
  over?: Partial<{
    activeSessionId: string;
    sessions: CodingAgentSession[];
    variant: "drawer" | "side-panel" | "full";
  }>,
) {
  const props = {
    activeSessionId: "s1",
    sessions: [
      session({ sessionId: "s1", label: "Term A", workdir: "/repo/a" }),
    ],
    onClose,
    variant: "drawer" as const,
    ...over,
  };
  return render(<PtyConsoleBase {...props} />);
}

describe("PtyConsoleBase — mount wiring", () => {
  it("subscribes, registers the pty-output handler, fetches the buffer, and resizes (drawer => 96x32)", async () => {
    renderBase();

    await waitFor(() => expect(getPtyBufferedOutput).toHaveBeenCalledTimes(1));

    expect(onWsEvent).toHaveBeenCalledTimes(1);
    expect(onWsEvent.mock.calls[0][0]).toBe("pty-output");
    expect(typeof onWsEvent.mock.calls[0][1]).toBe("function");

    expect(subscribePtyOutput).toHaveBeenCalledTimes(1);
    expect(subscribePtyOutput).toHaveBeenCalledWith("s1");
    expect(getPtyBufferedOutput).toHaveBeenCalledWith("s1");

    expect(resizePty).toHaveBeenCalledTimes(1);
    expect(resizePty).toHaveBeenCalledWith("s1", 96, 32);
  });

  it("resizes to 120x32 for variant=full", async () => {
    renderBase({ variant: "full" });
    await waitFor(() => expect(resizePty).toHaveBeenCalledTimes(1));
    expect(resizePty).toHaveBeenCalledWith("s1", 120, 32);
  });
});

describe("PtyConsoleBase — output rendering", () => {
  it("shows the 'Connecting to terminal' placeholder when the buffer is empty", async () => {
    getPtyBufferedOutput.mockResolvedValue("");
    renderBase();
    await waitFor(() => expect(getPtyBufferedOutput).toHaveBeenCalled());
    expect(preText()).toContain("Connecting to terminal");
  });

  it("hydrates the <pre> from the buffered output", async () => {
    getPtyBufferedOutput.mockResolvedValue("hello-buffered-output");
    renderBase();
    await screen.findByText("hello-buffered-output");
    expect(preText()).toBe("hello-buffered-output");
  });

  it("appends pty-output events in order", async () => {
    renderBase();
    await waitFor(() => expect(onWsEvent).toHaveBeenCalled());
    const emit = emitPty();

    act(() => emit({ sessionId: "s1", data: "line-1\n" }));
    await waitFor(() => expect(preText()).toContain("line-1"));

    act(() => emit({ sessionId: "s1", data: "line-2\n" }));
    await waitFor(() => expect(preText()).toContain("line-2"));

    // Concatenation order preserved: line-1 precedes line-2.
    const text = preText();
    expect(text.indexOf("line-1")).toBeLessThan(text.indexOf("line-2"));
    expect(text).toBe("line-1\nline-2\n");
  });

  it("ignores events for other sessions and events with no data", async () => {
    renderBase();
    await waitFor(() => expect(onWsEvent).toHaveBeenCalled());
    const emit = emitPty();

    act(() => emit({ sessionId: "s2", data: "should-not-appear" }));
    act(() => emit({ sessionId: "s1" })); // no data field => ignored

    // Still showing the placeholder, no foreign data leaked in.
    expect(preText()).not.toContain("should-not-appear");
    expect(preText()).toContain("Connecting to terminal");
  });

  it("caps the buffer at MAX_BUFFER_CHARS (200k) keeping the tail", async () => {
    getPtyBufferedOutput.mockResolvedValue("X".repeat(199_990));
    renderBase();
    await waitFor(() =>
      expect(preText().length).toBeGreaterThanOrEqual(199_990),
    );
    const emit = emitPty();

    act(() => emit({ sessionId: "s1", data: "Y".repeat(50) }));

    await waitFor(() => expect(preText().endsWith("Y".repeat(50))).toBe(true));
    const text = preText();
    expect(text.length).toBe(200_000); // 199_990 + 50 = 200_040 trimmed to 200_000
    expect(text.startsWith("X")).toBe(true); // head retained up to the cap
    expect(text.endsWith("Y".repeat(50))).toBe(true); // tail kept, head trimmed
  });
});

describe("PtyConsoleBase — terminal input", () => {
  it("sends the line + newline on Enter and clears the input", async () => {
    renderBase();
    await waitFor(() => expect(onWsEvent).toHaveBeenCalled());

    const input = screen.getByLabelText("Terminal input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ls -la" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(sendPtyInput).toHaveBeenCalledTimes(1);
    expect(sendPtyInput).toHaveBeenCalledWith("s1", "ls -la\n");
    expect(input.value).toBe("");
  });

  it("does not send on a non-Enter key", async () => {
    renderBase();
    await waitFor(() => expect(onWsEvent).toHaveBeenCalled());

    const input = screen.getByLabelText("Terminal input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ls" } });
    fireEvent.keyDown(input, { key: "a" });

    expect(sendPtyInput).not.toHaveBeenCalled();
  });

  it("sends via the Send button", async () => {
    renderBase();
    await waitFor(() => expect(onWsEvent).toHaveBeenCalled());

    const input = screen.getByLabelText("Terminal input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "echo hi" } });
    fireEvent.click(screen.getByLabelText("Send terminal input"));

    expect(sendPtyInput).toHaveBeenCalledWith("s1", "echo hi\n");
    expect(input.value).toBe("");
  });

  it("sends a bare newline for an empty line (only truly-empty data is dropped)", async () => {
    // sendInput's `if (!data) return` blocks "" but "\n" is truthy, so an
    // empty input + Enter still pushes a newline to the PTY.
    renderBase();
    await waitFor(() => expect(onWsEvent).toHaveBeenCalled());

    const input = screen.getByLabelText("Terminal input");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(sendPtyInput).toHaveBeenCalledTimes(1);
    expect(sendPtyInput).toHaveBeenCalledWith("s1", "\n");
  });

  it("sends the Ctrl-C (ETX) byte from the Interrupt button", async () => {
    renderBase();
    await waitFor(() => expect(onWsEvent).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText("Interrupt terminal"));
    expect(sendPtyInput).toHaveBeenCalledWith("s1", "");
  });
});

describe("PtyConsoleBase — stop vs close", () => {
  it("stops the coding agent from the Stop button", async () => {
    renderBase();
    await waitFor(() => expect(onWsEvent).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText("Stop terminal session"));
    expect(stopCodingAgent).toHaveBeenCalledTimes(1);
    expect(stopCodingAgent).toHaveBeenCalledWith("s1");
  });

  it("calls onClose (and NOT stopCodingAgent) from the Close button", async () => {
    renderBase();
    await waitFor(() => expect(onWsEvent).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText("Close terminal"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(stopCodingAgent).not.toHaveBeenCalled();
  });
});

describe("PtyConsoleBase — lifecycle", () => {
  it("unbinds the WS handler and unsubscribes on unmount", async () => {
    const result = renderBase();
    await waitFor(() => expect(onWsEvent).toHaveBeenCalled());

    result.unmount();

    expect(unbind).toHaveBeenCalledTimes(1);
    expect(unsubscribePtyOutput).toHaveBeenCalledTimes(1);
    expect(unsubscribePtyOutput).toHaveBeenCalledWith("s1");
  });

  it("resubscribes on session switch and resets the output", async () => {
    getPtyBufferedOutput.mockImplementation((id: string) =>
      Promise.resolve(id === "s1" ? "s1-buffer" : "s2-buffer"),
    );
    const sessions = [
      session({ sessionId: "s1", label: "Term A", workdir: "/repo/a" }),
      session({ sessionId: "s2", label: "Term B", workdir: "/repo/b" }),
    ];
    const result = renderBase({ activeSessionId: "s1", sessions });
    await screen.findByText("s1-buffer");

    result.rerender(
      <PtyConsoleBase
        activeSessionId="s2"
        sessions={sessions}
        onClose={onClose}
        variant="drawer"
      />,
    );

    // Old session torn down.
    expect(unbind).toHaveBeenCalledTimes(1);
    expect(unsubscribePtyOutput).toHaveBeenCalledWith("s1");

    // New session wired: fresh handler registration + subscribe + buffer fetch.
    await waitFor(() => expect(onWsEvent.mock.calls.length).toBe(2));
    expect(subscribePtyOutput).toHaveBeenCalledWith("s2");
    expect(getPtyBufferedOutput).toHaveBeenCalledWith("s2");

    // Output reset then re-hydrated from s2's buffer.
    await screen.findByText("s2-buffer");
    expect(preText()).toBe("s2-buffer");
  });

  it("does not setState after unmount when the buffer resolves late (disposed guard)", async () => {
    let resolveBuf!: (v: string) => void;
    getPtyBufferedOutput.mockReturnValue(
      new Promise<string>((r) => {
        resolveBuf = r;
      }),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = renderBase();
    await waitFor(() => expect(getPtyBufferedOutput).toHaveBeenCalled());

    // Unmount BEFORE the buffered output resolves.
    result.unmount();
    await act(async () => {
      resolveBuf("late-data");
      await Promise.resolve();
    });

    // No React "state update on an unmounted component" warning was emitted.
    const warned = errorSpy.mock.calls.some((args) =>
      args.some(
        (a) =>
          typeof a === "string" &&
          a.includes("unmounted") &&
          a.includes("state update"),
      ),
    );
    expect(warned).toBe(false);
    // The late data never made it into a (now-removed) <pre>.
    expect(document.body.textContent).not.toContain("late-data");

    errorSpy.mockRestore();
  });
});

describe("PtyConsoleBase — header label / workdir", () => {
  it("renders the active session label and workdir", async () => {
    renderBase({
      activeSessionId: "s1",
      sessions: [
        session({ sessionId: "s1", label: "Term A", workdir: "/repo/a" }),
      ],
    });
    await waitFor(() => expect(onWsEvent).toHaveBeenCalled());

    expect(screen.getByText("Term A")).toBeTruthy();
    expect(screen.getByText("/repo/a")).toBeTruthy();
  });

  it("falls back to 'Terminal' + the activeSessionId when the session is unknown", async () => {
    renderBase({
      activeSessionId: "ghost",
      sessions: [
        session({ sessionId: "s1", label: "Term A", workdir: "/repo/a" }),
      ],
    });
    await waitFor(() => expect(onWsEvent).toHaveBeenCalled());

    expect(screen.getByText("Terminal")).toBeTruthy();
    expect(screen.getByText("ghost")).toBeTruthy();
  });
});
