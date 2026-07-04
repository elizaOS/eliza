// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pins Help's deep-link contract: settings-section links ("Open AI Model
// settings" → the ai-model section) must land the user on the target section,
// not the generic Settings hub. The section is routed through the
// `eliza:navigate:view` `subview` channel (the same path the agent +
// slash-command flows use; App.tsx maps it to SettingsView's `initialSection`)
// rather than `window.location.hash`, since setTab pushes the bare `/settings`
// path and would clear a fragment before SettingsView mounts to read it.

const appMock = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock("../../../state", () => ({
  useAppSelector: (sel: (value: Record<string, unknown>) => unknown) =>
    sel(appMock.value),
}));

vi.mock("../../../agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

// Structural wrapper only — pass the body through without the agent surface.
vi.mock("../../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children?: React.ReactNode }) =>
    children,
}));

vi.mock("../../composites/chat", () => ({
  ChatEmptyStateWithRecommendations: () => null,
}));

const startTutorial = vi.hoisted(() => vi.fn());
vi.mock("../tutorial/tutorial-controller", () => ({
  startTutorial,
}));

import { HelpView } from "./HelpView";

function openEntry(question: string): void {
  fireEvent.click(screen.getByRole("button", { name: question }));
}

describe("HelpView deep links", () => {
  let setTab: ReturnType<typeof vi.fn>;
  let navigateEvents: CustomEvent[];
  const captureNavigate = (event: Event) => {
    navigateEvents.push(event as CustomEvent);
  };

  beforeEach(() => {
    setTab = vi.fn();
    appMock.value = { setTab };
    navigateEvents = [];
    window.addEventListener("eliza:navigate:view", captureNavigate);
    window.location.hash = "";
  });

  afterEach(() => {
    window.removeEventListener("eliza:navigate:view", captureNavigate);
    cleanup();
    vi.clearAllMocks();
  });

  it("routes a settings-section link through the navigate-view subview channel", () => {
    render(<HelpView />);
    openEntry("How do I change the AI model?");
    fireEvent.click(
      screen.getByRole("button", { name: /Open AI Model settings/ }),
    );

    expect(navigateEvents).toHaveLength(1);
    expect(navigateEvents[0].detail).toEqual({
      viewId: "settings",
      viewPath: "/settings",
      subview: "ai-model",
    });
    // The navigate-view handler owns the tab switch; Help must not race it
    // with its own setTab (the old path's pushState cleared the section).
    expect(setTab).not.toHaveBeenCalled();
  });

  it("does not smuggle the section through the URL fragment", () => {
    render(<HelpView />);
    openEntry("How do I change the AI model?");
    fireEvent.click(
      screen.getByRole("button", { name: /Open AI Model settings/ }),
    );

    // The old implementation wrote `#ai-model` here; setTab's pushState then
    // wiped it before SettingsView could read it. The section now travels in
    // the event detail, so the fragment stays untouched.
    expect(window.location.hash).toBe("");
  });

  it("keeps plain tab links on the direct setTab path", () => {
    render(<HelpView />);
    openEntry("How do I get to Settings?");
    fireEvent.click(screen.getByRole("button", { name: /Open Settings/ }));

    expect(setTab).toHaveBeenCalledWith("settings");
    expect(navigateEvents).toHaveLength(0);
  });

  it("starts the tutorial and returns to chat for tour links", () => {
    render(<HelpView />);
    openEntry("What is Eliza?");
    fireEvent.click(
      screen.getByRole("button", { name: /Take the 90-second tour/ }),
    );

    expect(startTutorial).toHaveBeenCalledTimes(1);
    expect(setTab).toHaveBeenCalledWith("chat");
  });
});
