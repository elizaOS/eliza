// @vitest-environment jsdom
//
// Character personality view (#13591): the endless single-page form is now a
// top-bar section nav (About / Style Rules / Chat Examples / Post Examples)
// under a shared ViewHeader. Guards (a) the in-context back affordance that
// replaced the removed global shell back button, (b) the four ordered section
// tabs, (c) path-driven active section + section switching, and (d) that the
// deleted overview CTA grid is gone. Panels are stubbed so the test isolates
// the nav/routing, not the (separately story-tested) editor panels.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../state", () => ({
  useAppSelectorShallow: (selector: (s: unknown) => unknown) =>
    selector({
      t: (_key: string, opts?: { defaultValue?: string }) =>
        opts?.defaultValue ?? _key,
    }),
}));

vi.mock("../../api/client", () => ({ client: { updateCharacter: vi.fn() } }));
vi.mock("../../widgets/WidgetHost", () => ({ WidgetHost: () => null }));
vi.mock("./CharacterEditorPanels", () => ({
  CharacterIdentityPanel: () => <div data-testid="panel-about" />,
  CharacterStylePanel: () => <div data-testid="panel-style" />,
  CharacterChatExamplesPanel: () => <div data-testid="panel-chat" />,
  CharacterPostExamplesPanel: () => <div data-testid="panel-post" />,
}));

import { CharacterHubView } from "./CharacterHubView";

afterEach(cleanup);

const noop = vi.fn();

function renderHub(initialSection?: undefined) {
  return render(
    <CharacterHubView
      initialSection={initialSection}
      d={{}}
      bioText=""
      normalizedMessageExamples={[]}
      pendingStyleEntries={{}}
      styleEntryDrafts={{}}
      applyFieldEdit={noop}
      handlePendingStyleEntryChange={noop}
      applyStyleEdit={noop}
      handleStyleEntryDraftChange={noop}
    />,
  );
}

describe("CharacterHubView personality section nav", () => {
  it("renders the shared 'Back to launcher' control and centered 'Character' title", () => {
    window.history.replaceState(null, "", "/character");
    renderHub();
    expect(
      screen.getByRole("button", { name: "Back to launcher" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Character" })).toBeTruthy();
  });

  it("renders the four ordered section tabs and defaults to About", () => {
    window.history.replaceState(null, "", "/character");
    renderHub();
    const nav = screen.getByTestId("section-nav-character");
    const tabs = nav.querySelectorAll("button");
    expect([...tabs].map((b) => b.textContent)).toEqual([
      "About",
      "Style Rules",
      "Chat Examples",
      "Post Examples",
    ]);
    expect(screen.getByTestId("panel-about")).toBeTruthy();
    // The About tab is marked active.
    const about = screen.getByRole("button", { name: "About" });
    expect(about.getAttribute("aria-current")).toBe("page");
  });

  it("opens the section its /character/* path selects", () => {
    window.history.replaceState(null, "", "/character/chat-examples");
    renderHub();
    expect(screen.getByTestId("panel-chat")).toBeTruthy();
    expect(screen.queryByTestId("panel-about")).toBeNull();
  });

  it("switches sections when a tab is clicked", () => {
    window.history.replaceState(null, "", "/character");
    renderHub();
    fireEvent.click(screen.getByRole("button", { name: "Post Examples" }));
    expect(screen.getByTestId("panel-post")).toBeTruthy();
    expect(window.location.pathname).toBe("/character/post-examples");
  });

  it("no longer renders the removed overview CTA grid or the shell back button", () => {
    window.history.replaceState(null, "", "/character");
    renderHub();
    expect(screen.queryByTestId("shell-back-button")).toBeNull();
    expect(screen.queryByText("Define your voice")).toBeNull();
    expect(screen.queryByText("Browse skills")).toBeNull();
  });
});
