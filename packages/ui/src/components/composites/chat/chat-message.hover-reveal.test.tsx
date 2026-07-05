// @vitest-environment jsdom

// The desktop (hover-chrome) side of #13533's per-message delete: on a hover
// device the composite ChatMessage renders the panel action rail — and this
// asserts that rail carries the persistent delete control for a real turn, and
// correctly omits it when the surface wires no `onDelete` or the turn is an
// optimistic `temp-` bubble with no persisted memory row to delete. The touch
// tap-to-reveal path is covered by chat-message.tap-reveal.test.tsx; together
// they cover both reveal chromes the acceptance criterion names.
//
// The rail's show/hide transition on real desktop is CSS/paint driven, which
// jsdom cannot exercise, so this asserts the meaningful, testable fact — whether
// the delete control is present for the pointer to reach — not the opacity tween.
// Runs in its own file because the hover MediaQueryList is cached at module
// scope; a `matches:false` device installed by a sibling suite would poison it.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ChatMessage } from "./chat-message";
import type { ChatMessageData } from "./chat-types";

beforeAll(() => {
  // Hover device: `(hover: hover) and (pointer: fine)` matches so ChatMessage
  // takes the pointer (panel-rail) chrome, not the touch tap-reveal chrome.
  // Installed before the first render because the MediaQueryList is cached on
  // first read.
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(cleanup);

function makeMessage(
  overrides: Partial<ChatMessageData> = {},
): ChatMessageData {
  return {
    id: "msg-1",
    role: "assistant",
    text: "Here are your latest balances.",
    ...overrides,
  };
}

function deleteControl(): HTMLElement | null {
  return screen.queryByRole("button", { name: "Delete message" });
}

describe("ChatMessage desktop hover-chrome delete control (#13533)", () => {
  it("surfaces the delete control on a real turn when the surface wires onDelete", () => {
    render(
      <ChatMessage
        message={makeMessage()}
        onCopy={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    // The persistent per-message delete lives in the panel rail alongside
    // copy/edit — reachable by the desktop pointer, not just the touch row.
    expect(deleteControl()).not.toBeNull();
  });

  it("omits the delete control when the surface wires no onDelete", () => {
    render(<ChatMessage message={makeMessage()} onCopy={vi.fn()} />);
    expect(deleteControl()).toBeNull();
  });

  it("omits the delete control on an optimistic (temp-) turn even with onDelete wired", () => {
    render(
      <ChatMessage
        message={makeMessage({ id: "temp-123" })}
        onCopy={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    // A temp turn has no persisted memory row to delete; ChatMessage's canDelete
    // guard excludes `temp-` ids so the control never appears on it.
    expect(deleteControl()).toBeNull();
  });
});
