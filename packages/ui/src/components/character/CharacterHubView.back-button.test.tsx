// @vitest-environment jsdom
//
// Character personality view (#13591): the endless single-page form is now a
// top-bar section nav (About / Style Rules / Chat Examples / Post Examples)
// under a shared ViewHeader. Guards (a) the in-context back affordance that
// replaced the removed global shell back button, (b) the four ordered section
// tabs, (c) path-driven active section + section switching, including the
// popstate dispatch that keeps the shell router in sync after a tab click,
// (d) that the deleted overview CTA grid is gone, and (e) the autosave status
// lifecycle: saving to saved on success, and on failure the patch is requeued
// behind a visible Retry control (no silent data loss now that the manual
// Save button is gone). Panels are stubbed so the test isolates the
// nav/routing/save wiring, not the (separately story-tested) editor panels.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../state", () => ({
  useAppSelectorShallow: (selector: (s: unknown) => unknown) =>
    selector({
      t: (_key: string, opts?: { defaultValue?: string }) =>
        opts?.defaultValue ?? _key,
    }),
}));

const updateCharacter = vi.fn();
vi.mock("../../api/client", () => ({
  client: { updateCharacter: (patch: unknown) => updateCharacter(patch) },
}));
vi.mock("../../widgets/WidgetHost", () => ({ WidgetHost: () => null }));
vi.mock("./CharacterEditorPanels", () => ({
  CharacterIdentityPanel: ({
    handleFieldEdit,
  }: {
    handleFieldEdit?: (field: string, value: unknown) => void;
  }) => (
    <div data-testid="panel-about">
      <button
        type="button"
        data-testid="edit-bio"
        onClick={() => handleFieldEdit?.("bio", ["a sun-forged bio"])}
      />
    </div>
  ),
  CharacterStylePanel: () => <div data-testid="panel-style" />,
  CharacterChatExamplesPanel: () => <div data-testid="panel-chat" />,
  CharacterPostExamplesPanel: () => <div data-testid="panel-post" />,
}));

import { CharacterHubView } from "./CharacterHubView";

afterEach(() => {
  cleanup();
  updateCharacter.mockReset();
  vi.useRealTimers();
});

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

  it("dispatches popstate after a tab click so the shell router observes the new route", () => {
    window.history.replaceState(null, "", "/character");
    renderHub();
    const seen: string[] = [];
    const listener = () => {
      seen.push(window.location.pathname);
    };
    window.addEventListener("popstate", listener);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Style Rules" }));
      // The router notification fires AFTER pushState, so a listener deriving
      // state from the path sees the new route, never the stale one.
      expect(seen).toEqual(["/character/style"]);
    } finally {
      window.removeEventListener("popstate", listener);
    }
  });

  it("no longer renders the removed overview CTA grid or the shell back button", () => {
    window.history.replaceState(null, "", "/character");
    renderHub();
    expect(screen.queryByTestId("shell-back-button")).toBeNull();
    expect(screen.queryByText("Define your voice")).toBeNull();
    expect(screen.queryByText("Browse skills")).toBeNull();
  });
});

describe("CharacterHubView autosave status", () => {
  it("debounces an edit into one patch and reports saving then saved", async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/character");
    updateCharacter.mockResolvedValue(undefined);
    renderHub();

    fireEvent.click(screen.getByTestId("edit-bio"));
    expect(updateCharacter).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(updateCharacter).toHaveBeenCalledTimes(1);
    expect(updateCharacter).toHaveBeenCalledWith({
      bio: ["a sun-forged bio"],
    });
    expect(screen.getByTestId("character-save-status").textContent).toBe(
      "Saved",
    );

    // The "Saved" chip clears back to idle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.queryByTestId("character-save-status")).toBeNull();
  });

  it("requeues a failed patch and retries it from the visible Retry control", async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/character");
    updateCharacter.mockRejectedValueOnce(new Error("offline"));
    updateCharacter.mockResolvedValueOnce(undefined);
    renderHub();

    fireEvent.click(screen.getByTestId("edit-bio"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(updateCharacter).toHaveBeenCalledTimes(1);

    // Failure path: visible error status + explicit retry affordance
    // (error-policy:J4 -- never a fabricated "saved", never silent loss).
    const status = screen.getByTestId("character-save-status");
    expect(status.textContent).toContain("Save failed");
    const retry = screen.getByTestId("character-save-retry");

    // Retry re-sends the SAME requeued patch -- the edit was not dropped.
    await act(async () => {
      fireEvent.click(retry);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(updateCharacter).toHaveBeenCalledTimes(2);
    expect(updateCharacter).toHaveBeenLastCalledWith({
      bio: ["a sun-forged bio"],
    });
    expect(screen.getByTestId("character-save-status").textContent).toBe(
      "Saved",
    );
  });
});
