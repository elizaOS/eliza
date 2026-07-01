// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getViewChatBinding } from "../../../state/view-chat-binding";
import { HELP_ENTRIES } from "./help-content";
import { HelpView } from "./HelpView";

// Collaborators mocked at their real seams. HelpView itself (list rendering,
// scoring/filter, selection state, deep-link routing) is exercised for real.

// setTab is the single app-store field HelpView reads; expose a spy through the
// same selector contract useAppSelector honors.
const setTab = vi.hoisted(() => vi.fn());
vi.mock("../../../state", () => ({
  useAppSelector: (sel: (s: { setTab: (t: string) => void }) => unknown) =>
    sel({ setTab }),
}));

// startTutorial is a module-level side effect; spy it to prove the tutorial
// deep-link fires the tour (not just a tab switch).
const startTutorial = vi.hoisted(() => vi.fn());
vi.mock("../tutorial/tutorial-controller", () => ({ startTutorial }));

// Agent-surface instrumentation is orthogonal to the behavior under test; the
// visible <button onClick> paths carry the semantics we assert.
vi.mock("../../../agent-surface", () => ({
  useAgentElement: () => ({ ref: undefined, agentProps: {} }),
}));

// The shell wrapper only provides the agent-surface bridge; render children.
vi.mock("../../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: React.ReactNode }) =>
    children,
}));

// Empty state: render a stable marker + the title so "no results" is assertable
// without pulling the full composite (which owns its own chat-prefill context).
vi.mock("../../composites/chat", () => ({
  ChatEmptyStateWithRecommendations: ({ title }: { title?: string }) => (
    <div data-testid="help-empty-state">{title}</div>
  ),
}));

/** Drive the chat→view search binding the way the composer would as the user types. */
function typeQuery(text: string): void {
  act(() => {
    getViewChatBinding()?.onQuery?.(text);
  });
}

function entryLi(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(
    `[data-testid="help-entry-${id}"]`,
  );
  if (!el) throw new Error(`entry ${id} not rendered`);
  return el;
}

function toggle(container: HTMLElement, id: string): void {
  const btn = entryLi(container, id).querySelector("button");
  if (!btn) throw new Error(`toggle for ${id} missing`);
  act(() => {
    fireEvent.click(btn);
  });
}

function isOpen(container: HTMLElement, id: string): boolean {
  const btn = entryLi(container, id).querySelector("button");
  return btn?.getAttribute("aria-expanded") === "true";
}

/** Deep-link button label rendered as `${label} →`; return it if visible. */
function deepLinkButton(
  container: HTMLElement,
  id: string,
  label: string,
): HTMLButtonElement | null {
  const buttons = entryLi(container, id).querySelectorAll("button");
  for (const b of Array.from(buttons)) {
    if ((b.textContent ?? "").includes(label)) return b as HTMLButtonElement;
  }
  return null;
}

function listItemCount(container: HTMLElement): number {
  return container.querySelectorAll('[data-testid^="help-entry-"]').length;
}

describe("HelpView", () => {
  beforeEach(() => {
    setTab.mockClear();
    startTutorial.mockClear();
    window.location.hash = "";
  });
  afterEach(() => {
    cleanup();
    // binding clears on unmount; guard against leakage into the next test.
    expect(getViewChatBinding()).toBeNull();
  });

  it("renders every help entry when the search draft is empty", () => {
    const { container } = render(<HelpView />);
    expect(listItemCount(container)).toBe(HELP_ENTRIES.length);
    expect(container.textContent).toContain("What is Eliza?");
    expect(
      container.querySelector('[data-testid="help-empty-state"]'),
    ).toBeNull();
  });

  it("registers the chat composer takeover (placeholder + live onQuery)", () => {
    render(<HelpView />);
    const binding = getViewChatBinding();
    expect(binding?.placeholder).toBe("Ask a question about Eliza…");
    expect(typeof binding?.onQuery).toBe("function");
  });

  it("expands an answer on click and collapses it on a second click", () => {
    const { container } = render(<HelpView />);
    expect(isOpen(container, "what-is-eliza")).toBe(false);

    toggle(container, "what-is-eliza");
    expect(isOpen(container, "what-is-eliza")).toBe(true);
    expect(entryLi(container, "what-is-eliza").textContent).toContain(
      "Eliza is your personal AI agent",
    );

    toggle(container, "what-is-eliza");
    expect(isOpen(container, "what-is-eliza")).toBe(false);
    expect(entryLi(container, "what-is-eliza").textContent).not.toContain(
      "Eliza is your personal AI agent",
    );
  });

  it("keeps selection exclusive — opening a second entry closes the first", () => {
    const { container } = render(<HelpView />);
    toggle(container, "what-is-eliza");
    expect(isOpen(container, "what-is-eliza")).toBe(true);

    toggle(container, "the-chat-pill");
    expect(isOpen(container, "the-chat-pill")).toBe(true);
    expect(isOpen(container, "what-is-eliza")).toBe(false);
  });

  it("double-click on the same entry is idempotent (nets back to collapsed)", () => {
    const { container } = render(<HelpView />);
    toggle(container, "what-is-eliza");
    toggle(container, "what-is-eliza");
    toggle(container, "what-is-eliza");
    toggle(container, "what-is-eliza");
    expect(isOpen(container, "what-is-eliza")).toBe(false);
  });

  it("filters entries by query and auto-opens the best match", () => {
    const { container } = render(<HelpView />);
    typeQuery("discord");

    // Only entries whose tokens match survive; connect-discord is top score.
    expect(
      container.querySelector('[data-testid="help-entry-connect-discord"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="help-entry-what-is-eliza"]'),
    ).toBeNull();
    expect(listItemCount(container)).toBeLessThan(HELP_ENTRIES.length);

    // Auto-open pulls up the top answer without a manual click.
    expect(isOpen(container, "connect-discord")).toBe(true);
  });

  it("ranks a question-word match above a keyword-only match", () => {
    const { container } = render(<HelpView />);
    typeQuery("model");
    // change-model's question contains "model" (+3) → sorts to the top → auto-open.
    expect(isOpen(container, "change-model")).toBe(true);
  });

  it("shows the empty state when nothing matches", () => {
    const { container } = render(<HelpView />);
    typeQuery("zzzznotarealquery");
    expect(
      container.querySelector('[data-testid="help-empty-state"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("No matches.");
    expect(listItemCount(container)).toBe(0);
  });

  it("requires every token to match — a partial-token miss excludes the entry", () => {
    const { container } = render(<HelpView />);
    typeQuery("discord zzzznope");
    // "discord" matches but "zzzznope" matches nothing → entry excluded → empty.
    expect(
      container.querySelector('[data-testid="help-empty-state"]'),
    ).not.toBeNull();
  });

  it("restores the full list when the query is cleared", () => {
    const { container } = render(<HelpView />);
    typeQuery("discord");
    expect(listItemCount(container)).toBeLessThan(HELP_ENTRIES.length);
    typeQuery("");
    expect(listItemCount(container)).toBe(HELP_ENTRIES.length);
    expect(
      container.querySelector('[data-testid="help-empty-state"]'),
    ).toBeNull();
  });

  it("does not fight a manual close after auto-open (ref guard)", () => {
    const { container } = render(<HelpView />);
    typeQuery("discord");
    expect(isOpen(container, "connect-discord")).toBe(true);

    // User closes it; re-driving the SAME query must not re-open it.
    toggle(container, "connect-discord");
    expect(isOpen(container, "connect-discord")).toBe(false);
    typeQuery("discord");
    expect(isOpen(container, "connect-discord")).toBe(false);
  });

  describe("deep-link routing", () => {
    it("tab-only link switches tab (Launcher → views)", () => {
      const { container } = render(<HelpView />);
      toggle(container, "switch-views");
      const btn = deepLinkButton(container, "switch-views", "Open Launcher");
      expect(btn).not.toBeNull();
      act(() => fireEvent.click(btn as HTMLButtonElement));
      expect(setTab).toHaveBeenCalledWith("views");
    });

    it("settings-section link sets the hash and switches to settings", () => {
      const { container } = render(<HelpView />);
      toggle(container, "change-model");
      const btn = deepLinkButton(
        container,
        "change-model",
        "Open AI Model settings",
      );
      act(() => fireEvent.click(btn as HTMLButtonElement));
      expect(window.location.hash).toBe("#ai-model");
      expect(setTab).toHaveBeenCalledWith("settings");
    });

    it("tutorial link launches the tour and lands on chat", () => {
      const { container } = render(<HelpView />);
      toggle(container, "what-is-eliza");
      const btn = deepLinkButton(
        container,
        "what-is-eliza",
        "Take the 90-second tour",
      );
      act(() => fireEvent.click(btn as HTMLButtonElement));
      expect(startTutorial).toHaveBeenCalledTimes(1);
      expect(setTab).toHaveBeenCalledWith("chat");
      // Tutorial branch returns early — it must not also set a settings hash.
      expect(setTab).not.toHaveBeenCalledWith("settings");
    });

    it("plain-tab settings link switches without touching the hash", () => {
      const { container } = render(<HelpView />);
      toggle(container, "get-to-settings");
      const btn = deepLinkButton(container, "get-to-settings", "Open Settings");
      act(() => fireEvent.click(btn as HTMLButtonElement));
      expect(setTab).toHaveBeenCalledWith("settings");
      expect(window.location.hash).toBe("");
    });

    it("double-click on a deep-link is idempotent (same destination)", () => {
      const { container } = render(<HelpView />);
      toggle(container, "switch-views");
      const btn = deepLinkButton(
        container,
        "switch-views",
        "Open Launcher",
      ) as HTMLButtonElement;
      act(() => fireEvent.click(btn));
      act(() => fireEvent.click(btn));
      expect(setTab).toHaveBeenCalledTimes(2);
      for (const call of setTab.mock.calls) expect(call[0]).toBe("views");
    });

    it("entries without a deep-link render no action button", () => {
      const { container } = render(<HelpView />);
      toggle(container, "the-chat-pill"); // has no deepLink
      const li = entryLi(container, "the-chat-pill");
      // Only the toggle button — no trailing deep-link button.
      expect(li.querySelectorAll("button").length).toBe(1);
    });
  });

  it("survives adversarial regex-ish input without crashing", () => {
    const { container } = render(<HelpView />);
    typeQuery("$^(*)[model");
    // No throw; the unmatched token yields the empty state.
    expect(
      container.querySelector('[data-testid="help-empty-state"]'),
    ).not.toBeNull();
  });
});
