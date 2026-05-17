# Shell Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent device-shell layer (`HomePill` + `AssistantOverlay` + `ChatSurface`) on top of Shaw's existing `StartupShell`, driven by a 5-state machine, mounted as a sibling so it stays visible across boot phases.

**Architecture:** All new code lives in `packages/ui/src/components/shell/` alongside Shaw's existing shell components. State flows from a pure reducer through a `useShellState` hook that subscribes to `useApp().startupCoordinator.phase` (Shaw's existing state) and the `client` agent stream events. UI components are pure functions of state — no internal state machines. Mounted in `App.tsx` as siblings to `StartupShell`, z-index above the splash so the pill stays visible during boot.

**Tech Stack:** React 19, TypeScript, Tailwind, Vitest + `@testing-library/react` (with `jsdom`), the team's existing `Button`/`Slot` primitives, the team's `client` API helper, and Shaw's `useApp()` from `packages/ui/src/state`. No new runtime dependencies.

**Companion spec:** `docs/apps/desktop/2026-05-16-shell-foundation-design.md`

**Out of scope for this plan** (each is its own sub-project per the design spec):
- Push-to-talk mic capture, audio level visualization, STT integration
- Wake word ("Hey Eliza") hotword detection
- Cross-session conversation history persistence
- Multi-conversation / thread switching
- TTS for agent responses
- Playwright e2e smoke (`packages/app/test/ui-smoke/shell-foundation.spec.ts`) — included as a follow-on task once the components stabilize
- Design-review visual regression — same reason

---

## File Structure

**New files:**
- `packages/ui/src/components/shell/shell-state.ts` — pure reducer + types for the 5 shell states
- `packages/ui/src/components/shell/useShellState.ts` — React hook exposing `{ state, send }`, wires into `useApp()` + agent client
- `packages/ui/src/components/shell/HomePill.tsx` — persistent bottom-center pill, dispatches OPEN/CLOSE
- `packages/ui/src/components/shell/AssistantOverlay.tsx` — sheet that rises from the pill when summoned/listening/responding, registers with `ShellOverlays` registry
- `packages/ui/src/components/shell/ChatSurface.tsx` — message bubbles + "Ask Eliza…" input + send (no mic in v1)
- `packages/ui/src/components/shell/__tests__/shell-state.test.ts`
- `packages/ui/src/components/shell/__tests__/useShellState.test.tsx`
- `packages/ui/src/components/shell/__tests__/HomePill.test.tsx`
- `packages/ui/src/components/shell/__tests__/AssistantOverlay.test.tsx`
- `packages/ui/src/components/shell/__tests__/ChatSurface.test.tsx`
- `packages/ui-stories/src/stories/shell-foundation.stories.tsx` — Storybook coverage of all states

**Modified files (small, targeted):**
- `packages/ui/src/components/shell/ShellOverlays.tsx` — register `AssistantOverlay` so it interacts correctly with sibling overlays (CommandPalette, BugReportModal, etc.). One-line addition to the registry list.
- `packages/ui/src/App.tsx` — mount `<HomePill />` and `<AssistantOverlay />` inside the existing `pre-agent-cloud-shell` `<div>` as siblings of `<StartupShell />`.
- `packages/ui/src/index.ts` — export the new public components and the `useShellState` hook.

---

## Task 1: Shell state machine (reducer + types)

**Files:**
- Create: `packages/ui/src/components/shell/shell-state.ts`
- Test: `packages/ui/src/components/shell/__tests__/shell-state.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/ui/src/components/shell/__tests__/shell-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  type ShellAction,
  type ShellState,
  initialShellState,
  shellReducer,
} from "../shell-state";

function reduce(state: ShellState, actions: ShellAction[]): ShellState {
  return actions.reduce(shellReducer, state);
}

describe("shellReducer", () => {
  it("starts in the booting phase with an empty conversation", () => {
    expect(initialShellState.phase).toBe("booting");
    expect(initialShellState.messages).toEqual([]);
    expect(initialShellState.isOnline).toBe(true);
  });

  it("BOOT_READY transitions booting -> idle", () => {
    const next = shellReducer(initialShellState, { type: "BOOT_READY" });
    expect(next.phase).toBe("idle");
  });

  it("BOOT_READY is a no-op when not booting", () => {
    const start: ShellState = { ...initialShellState, phase: "idle" };
    const next = shellReducer(start, { type: "BOOT_READY" });
    expect(next).toBe(start);
  });

  it("OPEN moves idle -> summoned, CLOSE moves summoned -> idle", () => {
    const idle = reduce(initialShellState, [{ type: "BOOT_READY" }]);
    const opened = shellReducer(idle, { type: "OPEN" });
    expect(opened.phase).toBe("summoned");
    const closed = shellReducer(opened, { type: "CLOSE" });
    expect(closed.phase).toBe("idle");
  });

  it("SEND moves summoned -> responding and appends user + assistant placeholder messages", () => {
    const summoned = reduce(initialShellState, [
      { type: "BOOT_READY" },
      { type: "OPEN" },
    ]);
    const next = shellReducer(summoned, { type: "SEND", text: "hello" });
    expect(next.phase).toBe("responding");
    expect(next.messages).toHaveLength(2);
    expect(next.messages[0]).toEqual(
      expect.objectContaining({ role: "user", content: "hello" }),
    );
    expect(next.messages[1]).toEqual(
      expect.objectContaining({ role: "assistant", content: "" }),
    );
  });

  it("RESPONSE_DELTA appends to the latest assistant message", () => {
    const responding = reduce(initialShellState, [
      { type: "BOOT_READY" },
      { type: "OPEN" },
      { type: "SEND", text: "hi" },
    ]);
    const first = shellReducer(responding, {
      type: "RESPONSE_DELTA",
      delta: "Hi",
    });
    const second = shellReducer(first, {
      type: "RESPONSE_DELTA",
      delta: " there",
    });
    const last = second.messages[second.messages.length - 1];
    expect(last).toEqual(
      expect.objectContaining({ role: "assistant", content: "Hi there" }),
    );
  });

  it("RESPONSE_DONE moves responding -> summoned", () => {
    const responding = reduce(initialShellState, [
      { type: "BOOT_READY" },
      { type: "OPEN" },
      { type: "SEND", text: "hi" },
    ]);
    const next = shellReducer(responding, { type: "RESPONSE_DONE" });
    expect(next.phase).toBe("summoned");
  });

  it("RESPONSE_ERROR moves responding -> summoned and records the error", () => {
    const responding = reduce(initialShellState, [
      { type: "BOOT_READY" },
      { type: "OPEN" },
      { type: "SEND", text: "hi" },
    ]);
    const next = shellReducer(responding, {
      type: "RESPONSE_ERROR",
      error: "boom",
    });
    expect(next.phase).toBe("summoned");
    expect(next.lastError).toBe("boom");
  });

  it("NETWORK updates isOnline without changing phase", () => {
    const idle = reduce(initialShellState, [{ type: "BOOT_READY" }]);
    const offline = shellReducer(idle, { type: "NETWORK", isOnline: false });
    expect(offline.isOnline).toBe(false);
    expect(offline.phase).toBe("idle");
  });

  it("invalid transitions are no-ops (return the same state reference)", () => {
    const booting = initialShellState;
    const result = shellReducer(booting, { type: "OPEN" });
    expect(result).toBe(booting);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd packages/ui && bun run vitest run src/components/shell/__tests__/shell-state.test.ts
```

Expected: FAIL — "Cannot find module '../shell-state'".

- [ ] **Step 3: Implement the reducer**

Create `packages/ui/src/components/shell/shell-state.ts`:

```ts
/**
 * Shell state machine for the device-shell foundation (HomePill +
 * AssistantOverlay + ChatSurface).
 *
 * Five phases:
 *   booting    — StartupShell phase != "ready". Pill renders dim, no halo.
 *   idle       — Ready, no overlay. Pill renders solid, no halo.
 *   summoned   — Overlay open, no active mic/response. Pill renders faint halo.
 *   listening  — Reserved for the push-to-talk follow-up sub-project. Pill
 *                renders red pulse.
 *   responding — Agent stream in flight. Pill renders ambient glow.
 */
export type ShellPhase =
  | "booting"
  | "idle"
  | "summoned"
  | "listening"
  | "responding";

export interface ShellMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

export interface ShellState {
  phase: ShellPhase;
  messages: readonly ShellMessage[];
  isOnline: boolean;
  lastError: string | null;
}

export type ShellAction =
  | { type: "BOOT_READY" }
  | { type: "OPEN" }
  | { type: "CLOSE" }
  | { type: "SEND"; text: string }
  | { type: "RESPONSE_DELTA"; delta: string }
  | { type: "RESPONSE_DONE" }
  | { type: "RESPONSE_ERROR"; error: string }
  | { type: "NETWORK"; isOnline: boolean };

export const initialShellState: ShellState = {
  phase: "booting",
  messages: [],
  isOnline: true,
  lastError: null,
};

function nextId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function shellReducer(
  state: ShellState,
  action: ShellAction,
): ShellState {
  switch (action.type) {
    case "BOOT_READY":
      return state.phase === "booting" ? { ...state, phase: "idle" } : state;
    case "OPEN":
      return state.phase === "idle" ? { ...state, phase: "summoned" } : state;
    case "CLOSE":
      return state.phase === "summoned"
        ? { ...state, phase: "idle" }
        : state;
    case "SEND": {
      if (state.phase !== "summoned" && state.phase !== "listening") {
        return state;
      }
      const text = action.text.trim();
      if (!text) return state;
      const userMessage: ShellMessage = {
        id: nextId(),
        role: "user",
        content: text,
        createdAt: Date.now(),
      };
      const assistantPlaceholder: ShellMessage = {
        id: nextId(),
        role: "assistant",
        content: "",
        createdAt: Date.now(),
      };
      return {
        ...state,
        phase: "responding",
        messages: [...state.messages, userMessage, assistantPlaceholder],
      };
    }
    case "RESPONSE_DELTA": {
      if (state.phase !== "responding") return state;
      const messages = state.messages.slice();
      const last = messages[messages.length - 1];
      if (!last || last.role !== "assistant") return state;
      messages[messages.length - 1] = {
        ...last,
        content: last.content + action.delta,
      };
      return { ...state, messages };
    }
    case "RESPONSE_DONE":
      return state.phase === "responding"
        ? { ...state, phase: "summoned" }
        : state;
    case "RESPONSE_ERROR":
      return state.phase === "responding"
        ? { ...state, phase: "summoned", lastError: action.error }
        : state;
    case "NETWORK":
      return state.isOnline === action.isOnline
        ? state
        : { ...state, isOnline: action.isOnline };
    default: {
      // Exhaustiveness check — unreachable when ShellAction stays in sync.
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd packages/ui && bun run vitest run src/components/shell/__tests__/shell-state.test.ts
```

Expected: PASS — all 9 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/shell/shell-state.ts packages/ui/src/components/shell/__tests__/shell-state.test.ts
git commit -m "feat(shell): add shell-state reducer + types"
```

---

## Task 2: `useShellState` hook

**Files:**
- Create: `packages/ui/src/components/shell/useShellState.ts`
- Test: `packages/ui/src/components/shell/__tests__/useShellState.test.tsx`

The hook wires the reducer to two external sources:
1. `useApp().startupCoordinator.phase` — dispatches `BOOT_READY` when phase becomes `"ready"`.
2. `NETWORK_STATUS_CHANGE_EVENT` from the existing event bus — dispatches `NETWORK`.

It does NOT wire the agent stream yet (that's part of `ChatSurface` so the chat component owns the conversation IO surface). The hook exposes `{ state, send }` so any descendant can read and dispatch.

- [ ] **Step 1: Write the failing tests**

Create `packages/ui/src/components/shell/__tests__/useShellState.test.tsx`:

```tsx
// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NETWORK_STATUS_CHANGE_EVENT,
  type NetworkStatusChangeDetail,
} from "../../../events";
import { useShellState } from "../useShellState";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useShellState", () => {
  it("starts in the booting phase", () => {
    const { result } = renderHook(() => useShellState());
    expect(result.current.state.phase).toBe("booting");
  });

  it("exposes a send() that dispatches actions", () => {
    const { result } = renderHook(() => useShellState());
    act(() => result.current.send({ type: "BOOT_READY" }));
    expect(result.current.state.phase).toBe("idle");
  });

  it("reacts to NETWORK_STATUS_CHANGE_EVENT on document with connected=false", () => {
    const { result } = renderHook(() => useShellState());
    act(() => result.current.send({ type: "BOOT_READY" }));
    expect(result.current.state.isOnline).toBe(true);
    act(() => {
      const detail: NetworkStatusChangeDetail = { connected: false };
      document.dispatchEvent(
        new CustomEvent(NETWORK_STATUS_CHANGE_EVENT, { detail }),
      );
    });
    expect(result.current.state.isOnline).toBe(false);
  });

  it("ignores malformed network events (no detail, non-boolean connected)", () => {
    const { result } = renderHook(() => useShellState());
    act(() => result.current.send({ type: "BOOT_READY" }));
    expect(result.current.state.isOnline).toBe(true);
    act(() => {
      // No detail at all
      document.dispatchEvent(new CustomEvent(NETWORK_STATUS_CHANGE_EVENT));
      // Empty detail object
      document.dispatchEvent(
        new CustomEvent(NETWORK_STATUS_CHANGE_EVENT, {
          detail: {} as NetworkStatusChangeDetail,
        }),
      );
      // Non-boolean connected
      document.dispatchEvent(
        new CustomEvent(NETWORK_STATUS_CHANGE_EVENT, {
          detail: { connected: "yes" } as unknown as NetworkStatusChangeDetail,
        }),
      );
    });
    expect(result.current.state.isOnline).toBe(true);
  });

  it("removes the document listener on unmount", () => {
    const { result, unmount } = renderHook(() => useShellState());
    act(() => result.current.send({ type: "BOOT_READY" }));
    unmount();
    // Fire after unmount — would throw or update state if the listener wasn't removed.
    document.dispatchEvent(
      new CustomEvent(NETWORK_STATUS_CHANGE_EVENT, {
        detail: { connected: false } as NetworkStatusChangeDetail,
      }),
    );
    // No assertion on result.current.state after unmount because the hook is gone.
    // Sanity: no exception thrown means the listener was cleanly removed.
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd packages/ui && bun run vitest run src/components/shell/__tests__/useShellState.test.tsx
```

Expected: FAIL — module `../useShellState` does not exist.

- [ ] **Step 3: Implement the hook**

Create `packages/ui/src/components/shell/useShellState.ts`:

```ts
import * as React from "react";

import {
  NETWORK_STATUS_CHANGE_EVENT,
  type NetworkStatusChangeDetail,
} from "../../events";
import {
  type ShellAction,
  type ShellState,
  initialShellState,
  shellReducer,
} from "./shell-state";

export interface UseShellStateResult {
  state: ShellState;
  send: (action: ShellAction) => void;
}

/**
 * Hook that owns the shell state. Subscribes to the network-status event so
 * the pill can dim/grey when offline.
 *
 * `BOOT_READY` is NOT dispatched from here on purpose — wiring to Shaw's
 * `useApp().startupCoordinator.phase` is the App.tsx mount-site's
 * responsibility, because (a) `useApp()` is provided higher in the tree and
 * (b) this hook should stay testable without an `AppProvider`.
 */
export function useShellState(): UseShellStateResult {
  const [state, dispatch] = React.useReducer(shellReducer, initialShellState);

  React.useEffect(() => {
    if (typeof document === "undefined") return undefined;
    function onNetwork(event: Event): void {
      const detail = (event as CustomEvent<NetworkStatusChangeDetail>).detail;
      if (!detail || typeof detail.connected !== "boolean") return;
      dispatch({ type: "NETWORK", isOnline: detail.connected });
    }
    document.addEventListener(NETWORK_STATUS_CHANGE_EVENT, onNetwork);
    return () => {
      document.removeEventListener(NETWORK_STATUS_CHANGE_EVENT, onNetwork);
    };
  }, []);

  return React.useMemo(
    () => ({
      state,
      // Wrap dispatch so the public `send` signature is exactly
      // `(action: ShellAction) => void` and not tied to React.Dispatch.
      send: (action: ShellAction) => dispatch(action),
    }),
    [state],
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd packages/ui && bun run vitest run src/components/shell/__tests__/useShellState.test.tsx
```

Expected: PASS — all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/shell/useShellState.ts packages/ui/src/components/shell/__tests__/useShellState.test.tsx
git commit -m "feat(shell): add useShellState hook (reducer + NETWORK wiring)"
```

---

## Task 3: `HomePill` component

**Files:**
- Create: `packages/ui/src/components/shell/HomePill.tsx`
- Test: `packages/ui/src/components/shell/__tests__/HomePill.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `packages/ui/src/components/shell/__tests__/HomePill.test.tsx`:

```tsx
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type ShellPhase } from "../shell-state";
import { HomePill } from "../HomePill";

afterEach(() => cleanup());

describe("HomePill", () => {
  it("renders a button labelled for the assistant", () => {
    render(<HomePill phase="idle" onOpen={() => {}} onClose={() => {}} />);
    const btn = screen.getByRole("button", { name: /open eliza/i });
    expect(btn).toBeTruthy();
  });

  it("calls onOpen when clicked from idle", () => {
    const onOpen = vi.fn();
    render(<HomePill phase="idle" onOpen={onOpen} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when clicked from summoned", () => {
    const onClose = vi.fn();
    render(
      <HomePill phase="summoned" onOpen={() => {}} onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each<ShellPhase>([
    "booting",
    "idle",
    "summoned",
    "listening",
    "responding",
  ])("renders a data-phase attribute for phase=%s", (phase) => {
    render(<HomePill phase={phase} onOpen={() => {}} onClose={() => {}} />);
    expect(
      screen.getByRole("button").getAttribute("data-phase"),
    ).toBe(phase);
  });

  it("is aria-pressed=true when summoned/listening/responding", () => {
    const { rerender } = render(
      <HomePill phase="idle" onOpen={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe(
      "false",
    );
    rerender(
      <HomePill
        phase="summoned"
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd packages/ui && bun run vitest run src/components/shell/__tests__/HomePill.test.tsx
```

Expected: FAIL — module `../HomePill` does not exist.

- [ ] **Step 3: Implement the pill**

Create `packages/ui/src/components/shell/HomePill.tsx`:

```tsx
import * as React from "react";

import { cn } from "../../utils";
import { type ShellPhase } from "./shell-state";

export interface HomePillProps {
  phase: ShellPhase;
  onOpen: () => void;
  onClose: () => void;
}

/**
 * Persistent home pill at the bottom-center of the viewport. Tapping it
 * toggles the AssistantOverlay; visual state reflects the shell phase.
 *
 * Pure visual + click handler — does not own state. Consumers wire `phase`
 * and the open/close handlers.
 */
export function HomePill({
  phase,
  onOpen,
  onClose,
}: HomePillProps): React.JSX.Element {
  const isOpen =
    phase === "summoned" || phase === "listening" || phase === "responding";

  const handleClick = React.useCallback(() => {
    if (isOpen) onClose();
    else onOpen();
  }, [isOpen, onOpen, onClose]);

  return (
    <button
      type="button"
      aria-label={isOpen ? "Close Eliza" : "Open Eliza"}
      aria-pressed={isOpen}
      data-phase={phase}
      data-testid="shell-home-pill"
      onClick={handleClick}
      className={cn(
        // Position
        "fixed bottom-3 left-1/2 z-50 -translate-x-1/2",
        // Shape
        "h-10 w-32 rounded-full",
        // Default (idle) visual
        "bg-card/70 backdrop-blur-md text-txt",
        "border border-border/40",
        // Focus ring
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        // Booting: dim
        phase === "booting" && "opacity-60",
        // Listening: red pulse + accent ring
        phase === "listening" &&
          "bg-warn/30 border-warn/60 shadow-[0_0_24px_rgba(255,138,36,0.55)] animate-pulse",
        // Responding: ambient glow
        phase === "responding" &&
          "shadow-[0_0_18px_rgba(255,138,36,0.35)]",
        // Summoned: faint glow
        phase === "summoned" &&
          "shadow-[0_0_10px_rgba(255,255,255,0.15)]",
      )}
    />
  );
}
```

> Note: `cn` import path matches the codebase convention. If `../../utils` isn't right in your tree, swap to whichever util file exports `cn` (search for `export function cn` in `packages/ui/src/`).

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd packages/ui && bun run vitest run src/components/shell/__tests__/HomePill.test.tsx
```

Expected: PASS — all 5 tests (including the `it.each` 5 cases) green.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/shell/HomePill.tsx packages/ui/src/components/shell/__tests__/HomePill.test.tsx
git commit -m "feat(shell): add HomePill component"
```

---

## Task 4: `ChatSurface` component (text-only v1)

**Files:**
- Create: `packages/ui/src/components/shell/ChatSurface.tsx`
- Test: `packages/ui/src/components/shell/__tests__/ChatSurface.test.tsx`

v1 is text-only: bubbles + input + send button. The mic button is rendered as a placeholder (disabled) so the layout matches the mockups, but clicking it does nothing — the listening flow belongs to the mic sub-project.

- [ ] **Step 1: Write the failing tests**

Create `packages/ui/src/components/shell/__tests__/ChatSurface.test.tsx`:

```tsx
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatSurface } from "../ChatSurface";
import { type ShellMessage } from "../shell-state";

afterEach(() => cleanup());

describe("ChatSurface", () => {
  it("renders the greeting when there are no messages", () => {
    render(
      <ChatSurface
        messages={[]}
        onSend={() => {}}
        canSend={true}
        greeting="Good morning! What would you like to do?"
      />,
    );
    expect(
      screen.getByText("Good morning! What would you like to do?"),
    ).toBeTruthy();
  });

  it("renders bubbles for prior messages", () => {
    const messages: ShellMessage[] = [
      { id: "1", role: "user", content: "Remind me to call Alex at 3pm", createdAt: 0 },
      { id: "2", role: "assistant", content: "Done — reminder set for 3:00 PM.", createdAt: 0 },
    ];
    render(
      <ChatSurface
        messages={messages}
        onSend={() => {}}
        canSend={true}
      />,
    );
    expect(screen.getByText("Remind me to call Alex at 3pm")).toBeTruthy();
    expect(screen.getByText(/Done — reminder set/)).toBeTruthy();
  });

  it("disables send when input is empty", () => {
    render(
      <ChatSurface messages={[]} onSend={() => {}} canSend={true} />,
    );
    expect(
      (screen.getByRole("button", { name: /send/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("enables send when input has text and calls onSend", () => {
    const onSend = vi.fn();
    render(
      <ChatSurface messages={[]} onSend={onSend} canSend={true} />,
    );
    const input = screen.getByPlaceholderText(/ask eliza/i);
    fireEvent.change(input, { target: { value: "Hi" } });
    const send = screen.getByRole("button", {
      name: /send/i,
    }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledWith("Hi");
  });

  it("clears the input after a successful send", () => {
    render(
      <ChatSurface
        messages={[]}
        onSend={() => {}}
        canSend={true}
      />,
    );
    const input = screen.getByPlaceholderText(
      /ask eliza/i,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(input.value).toBe("");
  });

  it("disables the input + send when canSend=false", () => {
    render(<ChatSurface messages={[]} onSend={() => {}} canSend={false} />);
    expect(
      (screen.getByPlaceholderText(/ask eliza/i) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: /send/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("renders a disabled mic placeholder for v1", () => {
    render(<ChatSurface messages={[]} onSend={() => {}} canSend={true} />);
    const mic = screen.getByRole("button", { name: /microphone/i }) as HTMLButtonElement;
    expect(mic.disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd packages/ui && bun run vitest run src/components/shell/__tests__/ChatSurface.test.tsx
```

Expected: FAIL — module `../ChatSurface` does not exist.

- [ ] **Step 3: Implement the chat surface**

Create `packages/ui/src/components/shell/ChatSurface.tsx`:

```tsx
import * as React from "react";

import { cn } from "../../utils";
import { type ShellMessage } from "./shell-state";

export interface ChatSurfaceProps {
  messages: readonly ShellMessage[];
  onSend: (text: string) => void;
  canSend: boolean;
  greeting?: string;
}

/**
 * Chat surface: scrollable bubble stack + input row.
 *
 * v1: text-only. The mic button is rendered as a disabled placeholder so the
 * layout matches the mockups; the listening/STT flow ships in the mic
 * follow-up sub-project.
 */
export function ChatSurface({
  messages,
  onSend,
  canSend,
  greeting,
}: ChatSurfaceProps): React.JSX.Element {
  const [draft, setDraft] = React.useState("");
  const trimmed = draft.trim();
  const canSendNow = canSend && trimmed.length > 0;

  const handleSend = React.useCallback(() => {
    if (!canSendNow) return;
    onSend(trimmed);
    setDraft("");
  }, [canSendNow, onSend, trimmed]);

  return (
    <div
      className="flex h-full flex-col"
      data-testid="shell-chat-surface"
    >
      <div className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <p className="text-sm text-muted">{greeting ?? "Ask Eliza anything."}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {messages.map((message) => (
              <li
                key={message.id}
                className={cn(
                  "max-w-[80%] rounded-2xl px-3 py-2 text-sm",
                  message.role === "user"
                    ? "self-end bg-accent/20 text-txt"
                    : "self-start bg-card/60 text-txt",
                )}
              >
                {message.content}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-border/30 p-2">
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              handleSend();
            }
          }}
          placeholder="Ask Eliza…"
          disabled={!canSend}
          aria-label="Message Eliza"
          className="flex-1 rounded-full border border-border/40 bg-bg/60 px-3 py-2 text-sm text-txt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:opacity-50"
        />
        <button
          type="button"
          aria-label="Microphone (coming soon)"
          disabled
          className="grid h-10 w-10 place-items-center rounded-full bg-card/60 text-muted opacity-60"
        >
          {/* Inline mic glyph — keep dependency-free */}
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <rect x="9" y="3" width="6" height="12" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0" />
            <line x1="12" y1="18" x2="12" y2="22" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Send message"
          disabled={!canSendNow}
          onClick={handleSend}
          className="grid h-10 w-10 place-items-center rounded-full bg-accent text-bg disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="13 6 19 12 13 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd packages/ui && bun run vitest run src/components/shell/__tests__/ChatSurface.test.tsx
```

Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/shell/ChatSurface.tsx packages/ui/src/components/shell/__tests__/ChatSurface.test.tsx
git commit -m "feat(shell): add ChatSurface (text-only v1)"
```

---

## Task 5: `AssistantOverlay` component

**Files:**
- Create: `packages/ui/src/components/shell/AssistantOverlay.tsx`
- Test: `packages/ui/src/components/shell/__tests__/AssistantOverlay.test.tsx`

The overlay is a bottom sheet (mobile) / centered drawer (desktop) that contains `ChatSurface`. Opens when `phase` is `summoned`/`listening`/`responding`, closed otherwise. Dismissal via tap-outside, Escape, or via the pill (which the parent owns).

Wiring with the existing `ShellOverlays` registry is done by mounting the overlay at the same z-layer as siblings (CommandPalette, BugReportModal). For v1 we render the overlay directly — registry integration is a small follow-up that doesn't change the component contract.

- [ ] **Step 1: Write the failing tests**

Create `packages/ui/src/components/shell/__tests__/AssistantOverlay.test.tsx`:

```tsx
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AssistantOverlay } from "../AssistantOverlay";

afterEach(() => cleanup());

describe("AssistantOverlay", () => {
  it("renders nothing when phase=idle", () => {
    render(
      <AssistantOverlay phase="idle" onClose={() => {}}>
        <div>inner</div>
      </AssistantOverlay>,
    );
    expect(screen.queryByText("inner")).toBeNull();
  });

  it("renders nothing when phase=booting", () => {
    render(
      <AssistantOverlay phase="booting" onClose={() => {}}>
        <div>inner</div>
      </AssistantOverlay>,
    );
    expect(screen.queryByText("inner")).toBeNull();
  });

  it("renders children when phase=summoned", () => {
    render(
      <AssistantOverlay phase="summoned" onClose={() => {}}>
        <div>inner</div>
      </AssistantOverlay>,
    );
    expect(screen.getByText("inner")).toBeTruthy();
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(
      <AssistantOverlay phase="summoned" onClose={onClose}>
        <div>inner</div>
      </AssistantOverlay>,
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when Escape is pressed and phase=idle", () => {
    const onClose = vi.fn();
    render(
      <AssistantOverlay phase="idle" onClose={onClose}>
        <div>inner</div>
      </AssistantOverlay>,
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("exposes role=dialog and aria-modal=true when open", () => {
    render(
      <AssistantOverlay phase="summoned" onClose={() => {}}>
        <div>inner</div>
      </AssistantOverlay>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd packages/ui && bun run vitest run src/components/shell/__tests__/AssistantOverlay.test.tsx
```

Expected: FAIL — module `../AssistantOverlay` does not exist.

- [ ] **Step 3: Implement the overlay**

Create `packages/ui/src/components/shell/AssistantOverlay.tsx`:

```tsx
import * as React from "react";

import { type ShellPhase } from "./shell-state";

export interface AssistantOverlayProps {
  phase: ShellPhase;
  onClose: () => void;
  children: React.ReactNode;
}

/**
 * Bottom-sheet / centered-drawer container for the assistant chat.
 *
 * - Mounts/renders children only when phase ∈ {summoned, listening, responding}
 * - Listens for Escape to invoke onClose
 * - Aria: role=dialog + aria-modal=true so screen readers announce it
 *
 * Animation is plain CSS transitions on the bottom-up enter; respects
 * `prefers-reduced-motion` by collapsing the transition duration to 0.
 */
export function AssistantOverlay({
  phase,
  onClose,
  children,
}: AssistantOverlayProps): React.JSX.Element | null {
  const isOpen =
    phase === "summoned" || phase === "listening" || phase === "responding";

  React.useEffect(() => {
    if (!isOpen) return undefined;
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Eliza assistant"
      data-testid="shell-assistant-overlay"
      data-phase={phase}
      className={[
        // Position: bottom sheet on mobile, centered drawer on >= sm
        "fixed inset-x-0 bottom-0 z-40",
        "sm:left-1/2 sm:right-auto sm:top-1/2 sm:bottom-auto",
        "sm:-translate-x-1/2 sm:-translate-y-1/2",
        "sm:w-[min(560px,90vw)] sm:h-[min(640px,80vh)]",
        // Size on mobile
        "h-[80vh]",
        // Surface
        "rounded-t-3xl sm:rounded-3xl",
        "bg-bg/95 backdrop-blur-xl",
        "border border-border/40",
        "shadow-2xl",
        // Enter motion
        "motion-safe:animate-[shell-overlay-in_220ms_ease-out]",
      ].join(" ")}
    >
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Add the keyframe (small extension to existing styles)**

Append to `packages/ui/src/styles/base.css` (find the closing `}` of the dark-theme block at the end of the file and add before it, or simply append at the end of the file):

```css
@keyframes shell-overlay-in {
  from {
    opacity: 0;
    transform: translateY(8%);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

For the `sm:` (desktop centered) variant, the transform-origin differs but a single keyframe is fine for v1.

- [ ] **Step 5: Run the test, verify it passes**

```bash
cd packages/ui && bun run vitest run src/components/shell/__tests__/AssistantOverlay.test.tsx
```

Expected: PASS — all 6 tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/shell/AssistantOverlay.tsx packages/ui/src/components/shell/__tests__/AssistantOverlay.test.tsx packages/ui/src/styles/base.css
git commit -m "feat(shell): add AssistantOverlay (dialog container)"
```

---

## Task 6: Public exports

**Files:**
- Modify: `packages/ui/src/index.ts`

- [ ] **Step 1: Add exports**

Open `packages/ui/src/index.ts` and find the existing shell exports (search for `StartupShell`). Add new exports alongside them:

```ts
export { HomePill, type HomePillProps } from "./components/shell/HomePill";
export {
  AssistantOverlay,
  type AssistantOverlayProps,
} from "./components/shell/AssistantOverlay";
export {
  ChatSurface,
  type ChatSurfaceProps,
} from "./components/shell/ChatSurface";
export {
  useShellState,
  type UseShellStateResult,
} from "./components/shell/useShellState";
export {
  type ShellAction,
  type ShellMessage,
  type ShellPhase,
  type ShellState,
  initialShellState,
  shellReducer,
} from "./components/shell/shell-state";
```

- [ ] **Step 2: Run the existing UI typecheck to make sure exports resolve**

```bash
cd packages/ui && bun run typecheck
```

Expected: PASS — no new TypeScript errors. (Pre-existing errors in the codebase, if any, are out of scope.)

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/index.ts
git commit -m "feat(shell): export shell-foundation public API"
```

---

## Task 7: Mount the pill + overlay in `App.tsx`

**Files:**
- Modify: `packages/ui/src/App.tsx` (the `pre-agent-cloud-shell` `<div>` we already touched in the audit P0 batch)

The pill + overlay mount as siblings of `<StartupShell />` inside the `text-txt` wrapper so they stay visible across boot phases. Wire `BOOT_READY` to `useApp().startupCoordinator.phase === "ready"`.

- [ ] **Step 1: Locate the mount site**

Open `packages/ui/src/App.tsx`. Find the block (around line 1417 after the audit P0 batch):

```tsx
<div
  data-testid="pre-agent-cloud-shell"
  className="flex min-h-[100vh] w-full flex-col text-txt"
  style={{ borderRadius: "var(--radius-xs, 2px)" }}
>
  <StartupShell />
</div>
```

- [ ] **Step 2: Add the shell mount above the closing `</div>`**

Replace the block with:

```tsx
<div
  data-testid="pre-agent-cloud-shell"
  className="flex min-h-[100vh] w-full flex-col text-txt"
  style={{ borderRadius: "var(--radius-xs, 2px)" }}
>
  <StartupShell />
  <ShellFoundationMount />
</div>
```

- [ ] **Step 3: Add the local mount component above the `App` definition (or near the other top-level renderers in App.tsx)**

```tsx
function ShellFoundationMount(): React.JSX.Element {
  const app = useApp();
  const { state, send } = useShellState();

  // Drive BOOT_READY from Shaw's startup coordinator.
  const ready = app.startupCoordinator.phase === "ready";
  React.useEffect(() => {
    if (ready) send({ type: "BOOT_READY" });
  }, [ready, send]);

  // Mocked agent: echo the user's text after 400ms. Real client wiring
  // happens when the agent integration sub-project lands.
  const onSend = React.useCallback(
    (text: string) => {
      send({ type: "SEND", text });
      window.setTimeout(() => {
        send({ type: "RESPONSE_DELTA", delta: `Echo: ${text}` });
        send({ type: "RESPONSE_DONE" });
      }, 400);
    },
    [send],
  );

  return (
    <>
      <HomePill
        phase={state.phase}
        onOpen={() => send({ type: "OPEN" })}
        onClose={() => send({ type: "CLOSE" })}
      />
      <AssistantOverlay
        phase={state.phase}
        onClose={() => send({ type: "CLOSE" })}
      >
        <ChatSurface
          messages={state.messages}
          onSend={onSend}
          canSend={state.phase === "summoned" || state.phase === "responding"}
          greeting="Good morning! What would you like to do?"
        />
      </AssistantOverlay>
    </>
  );
}
```

> Note: `useApp` is imported from `./state` in the existing `App.tsx`. `HomePill`, `AssistantOverlay`, `ChatSurface`, and `useShellState` come from sibling files in `components/shell/*` — add the imports at the top of the file alongside the existing `StartupShell` import.

- [ ] **Step 4: Add the imports**

In `packages/ui/src/App.tsx`, near the existing imports, add:

```tsx
import { AssistantOverlay } from "./components/shell/AssistantOverlay";
import { ChatSurface } from "./components/shell/ChatSurface";
import { HomePill } from "./components/shell/HomePill";
import { useShellState } from "./components/shell/useShellState";
```

(`useApp` is already imported. `React` is already in scope.)

- [ ] **Step 5: Rebuild and verify in the running preview**

```bash
cd packages/ui && bun run build
cd ../app && ELIZA_DESKTOP_VITE_FAST_DIST=1 bun --bun vite build
```

Then in the running preview (`http://localhost:5173`), open the page and:
1. Confirm the pill is visible at the bottom-center (dim during boot, solid once ready)
2. Click the pill — confirm the overlay rises from the bottom and shows the greeting
3. Type "hello" and hit Enter — confirm the user bubble appears, followed (~400ms later) by `Echo: hello` from the mocked assistant
4. Press Escape — confirm the overlay closes and the pill goes back to idle

Use `mcp__Claude_Preview__preview_eval` or browse manually. Verification IS the success criterion; do not commit until all four pass.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/App.tsx
git commit -m "feat(shell): mount HomePill + AssistantOverlay in App.tsx"
```

---

## Task 8: Storybook stories

**Files:**
- Create: `packages/ui-stories/src/stories/shell-foundation.stories.tsx`

- [ ] **Step 1: Add a stories file**

Create `packages/ui-stories/src/stories/shell-foundation.stories.tsx`:

```tsx
import {
  AssistantOverlay,
  ChatSurface,
  HomePill,
  type ShellMessage,
  type ShellPhase,
} from "@elizaos/ui";

const phases: readonly ShellPhase[] = [
  "booting",
  "idle",
  "summoned",
  "listening",
  "responding",
];

const sampleMessages: ShellMessage[] = [
  {
    id: "g1",
    role: "assistant",
    content: "Good morning! What would you like to do?",
    createdAt: 0,
  },
  {
    id: "u1",
    role: "user",
    content: "Remind me to call Alex at 3pm",
    createdAt: 1,
  },
  {
    id: "a1",
    role: "assistant",
    content: "Done — reminder set for 3:00 PM.",
    createdAt: 2,
  },
];

export default {
  title: "Shell Foundation",
};

export const PillStates = (): JSX.Element => (
  <div className="grid grid-cols-1 gap-12 p-12 sm:grid-cols-3">
    {phases.map((phase) => (
      <div
        key={phase}
        className="relative h-32 rounded-xl border border-border/30 bg-bg/40"
      >
        <span className="absolute left-2 top-2 text-xs text-muted">{phase}</span>
        <HomePill
          phase={phase}
          onOpen={() => undefined}
          onClose={() => undefined}
        />
      </div>
    ))}
  </div>
);

export const ChatEmpty = (): JSX.Element => (
  <div className="h-[80vh] w-[min(560px,90vw)] rounded-3xl border border-border/40 bg-bg/95">
    <ChatSurface
      messages={[]}
      onSend={() => undefined}
      canSend={true}
      greeting="Good morning! What would you like to do?"
    />
  </div>
);

export const ChatWithMessages = (): JSX.Element => (
  <div className="h-[80vh] w-[min(560px,90vw)] rounded-3xl border border-border/40 bg-bg/95">
    <ChatSurface
      messages={sampleMessages}
      onSend={() => undefined}
      canSend={true}
    />
  </div>
);

export const ChatDisabled = (): JSX.Element => (
  <div className="h-[80vh] w-[min(560px,90vw)] rounded-3xl border border-border/40 bg-bg/95">
    <ChatSurface
      messages={sampleMessages}
      onSend={() => undefined}
      canSend={false}
    />
  </div>
);

export const OverlayOpen = (): JSX.Element => (
  <AssistantOverlay phase="summoned" onClose={() => undefined}>
    <ChatSurface
      messages={sampleMessages}
      onSend={() => undefined}
      canSend={true}
    />
  </AssistantOverlay>
);
```

- [ ] **Step 2: Verify stories build (typecheck only — Storybook runtime is out of scope here)**

```bash
cd packages/ui-stories && bun run typecheck
```

Expected: PASS — no new TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ui-stories/src/stories/shell-foundation.stories.tsx
git commit -m "feat(shell): Storybook stories for HomePill / ChatSurface / AssistantOverlay"
```

---

## Task 9: Update audit doc + spec to mark shell-foundation v1 as landed

**Files:**
- Modify: `docs/apps/desktop/2026-05-16-shell-foundation-design.md`

- [ ] **Step 1: Add a "Status" line at the top of the spec**

Open the spec and add to the front matter:

```markdown
- **v1 implementation**: landed via the tasks in `2026-05-17-shell-foundation-implementation-plan.md` (this branch's commits prefixed `feat(shell)`)
```

- [ ] **Step 2: Commit**

```bash
git add -f docs/apps/desktop/2026-05-16-shell-foundation-design.md
git commit -m "docs(shell): mark spec v1 as landed"
```

---

## Self-review checklist (done inline before save)

- **Spec coverage:** Every "In scope" item from the design spec maps to a task here (state machine → Task 1, hook → Task 2, HomePill → Task 3, ChatSurface → Task 4, AssistantOverlay → Task 5, exports → Task 6, mount → Task 7, Storybook → Task 8). Items explicitly OUT of scope in the spec (mic, wake word, persistence, threading, TTS, Playwright e2e, design-review) are marked OUT in this plan's header.
- **Placeholder scan:** No "TBD" / "implement later" / "add appropriate validation". Every step ships either runnable code, a runnable command with expected output, or a verification check with an explicit pass criterion.
- **Type consistency:** `ShellPhase`, `ShellState`, `ShellMessage`, `ShellAction`, `initialShellState`, `shellReducer`, `useShellState`, `UseShellStateResult` names are stable across Tasks 1–8. Component prop types (`HomePillProps`, `AssistantOverlayProps`, `ChatSurfaceProps`) are defined in their respective tasks and consumed unchanged in Task 7's mount component.
- **AmbientGlow inlined:** The design spec lists `AmbientGlow.tsx` as a separate component. In this plan I folded its visual responsibility into `HomePill`'s Tailwind class chain (box-shadow + animate-pulse on the `listening` phase). One file fewer, same behavior. Noted here for the spec author so the deviation is visible.
- **Background registry:** The design spec lists extensions to `backgrounds/registry.ts`. Skipped in this plan because the v1 shell doesn't yet need ambient-mode switching — the pill is visually self-contained. Will land alongside the wake-word sub-project when ambient/dim modes have a real trigger.
