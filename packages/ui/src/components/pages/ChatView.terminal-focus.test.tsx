// @vitest-environment jsdom

// Guards ChatView's terminal auto-focus against a re-focus loop. A
// blocked/errored coding-agent session auto-focuses at most once per transition
// into a problem state — decided through pickProblemSessionToAutoFocus with a
// ref-held Set of handled session ids — so clearing `activeTerminalSessionId`
// (closing the terminal panel or selecting a conversation) never re-triggers
// the effect, and a user-initiated dismissal sticks. "Blocked" (waiting for
// input) is a routine long-lived state, which is why once-per-transition rather
// than while-blocked is the correct rule.
//
// The harness mirrors ChatView's exact wiring (ref + effect + focus sets the
// active id) so the semantics are proven under React's real effect scheduling,
// not just as pure-function calls.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingAgentSession } from "../../api/client";
import {
  isProblemSessionStatus,
  pickProblemSessionToAutoFocus,
} from "./ChatView.terminal-focus";

afterEach(() => {
  cleanup();
});

function makeSession(
  sessionId: string,
  status: CodingAgentSession["status"],
): CodingAgentSession {
  return {
    sessionId,
    agentType: "claude-code",
    label: `Session ${sessionId}`,
    originalTask: "fix the tests",
    workdir: "/tmp/work",
    status,
    decisionCount: 0,
    autoResolvedCount: 0,
  };
}

/**
 * Minimal stand-in for ChatView's terminal-focus wiring: same ref + effect +
 * "focus sets activeTerminalSessionId" shape, with a Close button playing the
 * TerminalChannelPanel onClose (setState('activeTerminalSessionId', null)).
 */
function TerminalFocusHarness({
  sessions,
  onFocus,
}: {
  sessions: CodingAgentSession[];
  onFocus: (sessionId: string) => void;
}) {
  const [activeTerminalSessionId, setActiveTerminalSessionId] = useState<
    string | null
  >(null);
  const handledProblemSessionsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const sessionId = pickProblemSessionToAutoFocus(
      sessions,
      activeTerminalSessionId,
      handledProblemSessionsRef.current,
    );
    if (sessionId) {
      onFocus(sessionId);
      setActiveTerminalSessionId(sessionId);
    }
  }, [sessions, activeTerminalSessionId, onFocus]);
  return (
    <div>
      <span data-testid="active-terminal">
        {activeTerminalSessionId ?? "none"}
      </span>
      <button
        type="button"
        data-testid="close-terminal"
        onClick={() => setActiveTerminalSessionId(null)}
      >
        Close
      </button>
    </div>
  );
}

describe("ChatView terminal auto-focus (once per problem transition)", () => {
  it("blocked session focuses once; closing the panel does NOT re-focus (the hijack loop)", () => {
    const onFocus = vi.fn();
    const { rerender } = render(
      <TerminalFocusHarness
        sessions={[makeSession("s1", "blocked")]}
        onFocus={onFocus}
      />,
    );

    // The blocked session pulls focus exactly once.
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledWith("s1");
    expect(screen.getByTestId("active-terminal").textContent).toBe("s1");

    // User closes the terminal panel while the session is STILL blocked.
    act(() => {
      fireEvent.click(screen.getByTestId("close-terminal"));
    });
    expect(screen.getByTestId("active-terminal").textContent).toBe("none");
    // The effect re-runs (activeTerminalSessionId is null again) but must NOT
    // bounce the user back to the terminal.
    expect(onFocus).toHaveBeenCalledTimes(1);

    // Further updates while the session stays blocked (e.g. a poll refresh
    // delivering a new sessions array) must not re-focus either.
    rerender(
      <TerminalFocusHarness
        sessions={[makeSession("s1", "blocked")]}
        onFocus={onFocus}
      />,
    );
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("active-terminal").textContent).toBe("none");
  });

  it("a NEW problem transition (recovered then errored) focuses once again", () => {
    const onFocus = vi.fn();
    const { rerender } = render(
      <TerminalFocusHarness
        sessions={[makeSession("s1", "blocked")]}
        onFocus={onFocus}
      />,
    );
    expect(onFocus).toHaveBeenCalledTimes(1);
    act(() => {
      fireEvent.click(screen.getByTestId("close-terminal"));
    });

    // The session recovers (user's input unblocked it)…
    rerender(
      <TerminalFocusHarness
        sessions={[makeSession("s1", "active")]}
        onFocus={onFocus}
      />,
    );
    expect(onFocus).toHaveBeenCalledTimes(1);

    // …then hits a NEW problem: that transition may focus again, once.
    rerender(
      <TerminalFocusHarness
        sessions={[makeSession("s1", "error")]}
        onFocus={onFocus}
      />,
    );
    expect(onFocus).toHaveBeenCalledTimes(2);
    expect(onFocus).toHaveBeenLastCalledWith("s1");
    expect(screen.getByTestId("active-terminal").textContent).toBe("s1");

    // And dismissing it sticks again.
    act(() => {
      fireEvent.click(screen.getByTestId("close-terminal"));
    });
    expect(onFocus).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("active-terminal").textContent).toBe("none");
  });

  it("a second session's problem transition still pulls focus after the first was dismissed", () => {
    const onFocus = vi.fn();
    const { rerender } = render(
      <TerminalFocusHarness
        sessions={[makeSession("s1", "blocked")]}
        onFocus={onFocus}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByTestId("close-terminal"));
    });
    expect(onFocus).toHaveBeenCalledTimes(1);

    rerender(
      <TerminalFocusHarness
        sessions={[makeSession("s1", "blocked"), makeSession("s2", "error")]}
        onFocus={onFocus}
      />,
    );
    expect(onFocus).toHaveBeenCalledTimes(2);
    expect(onFocus).toHaveBeenLastCalledWith("s2");
  });
});

describe("pickProblemSessionToAutoFocus (helper semantics)", () => {
  it("marks a problem session the user is already viewing as handled", () => {
    const handled = new Set<string>();
    // The terminal panel is open on s1 when it transitions to blocked: no
    // focus needed, but closing the panel afterwards must stick.
    expect(
      pickProblemSessionToAutoFocus(
        [makeSession("s1", "blocked")],
        "s1",
        handled,
      ),
    ).toBeNull();
    expect(
      pickProblemSessionToAutoFocus(
        [makeSession("s1", "blocked")],
        null,
        handled,
      ),
    ).toBeNull();
  });

  it("evicts handled entries when the session leaves the list (completed/stopped)", () => {
    const handled = new Set<string>(["s1"]);
    expect(pickProblemSessionToAutoFocus([], null, handled)).toBeNull();
    expect(handled.has("s1")).toBe(false);
  });

  it("never auto-focuses while another terminal session is active", () => {
    const handled = new Set<string>();
    expect(
      pickProblemSessionToAutoFocus(
        [makeSession("s1", "active"), makeSession("s2", "blocked")],
        "s1",
        handled,
      ),
    ).toBeNull();
    // Once the non-problem session is dismissed, the blocked one may focus.
    expect(
      pickProblemSessionToAutoFocus(
        [makeSession("s1", "active"), makeSession("s2", "blocked")],
        null,
        handled,
      ),
    ).toBe("s2");
  });

  it("treats only error and blocked as problem statuses", () => {
    expect(isProblemSessionStatus("error")).toBe(true);
    expect(isProblemSessionStatus("blocked")).toBe(true);
    expect(isProblemSessionStatus("active")).toBe(false);
    expect(isProblemSessionStatus("tool_running")).toBe(false);
    expect(isProblemSessionStatus("completed")).toBe(false);
    expect(isProblemSessionStatus("stopped")).toBe(false);
  });
});
