// @vitest-environment jsdom
//
// Guards the collapse of CharacterHubView to the Personality section only
// (#13591). The hub once rendered all six legacy sections internally (overview
// + the four now-promoted top-level views) and owned its own ViewHeader; this
// test asserts that dual render path is GONE: no overview/EmptyCta grid, no
// embedded Documents/Skills/Experience/Relationships branch, and no in-view
// header (the shared CharacterSectionNav supplies it). The panels are stubbed so
// the test isolates the hub's own structure, not their internals.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { updateCharacter } = vi.hoisted(() => ({ updateCharacter: vi.fn() }));

vi.mock("../../state", () => ({
  useAppSelectorShallow: (selector: (s: unknown) => unknown) =>
    selector({
      setActionNotice: vi.fn(),
      t: (_key: string, opts?: { defaultValue?: string }) =>
        opts?.defaultValue ?? _key,
    }),
}));
vi.mock("../../api/client", () => ({ client: { updateCharacter } }));
vi.mock("../../widgets/WidgetHost", () => ({ WidgetHost: () => null }));
// The identity-panel stub exposes a button that drives the `handleFieldEdit`
// prop the hub passes in, so the bio-autosave wiring can be exercised without
// rendering the real Textarea/agent-surface machinery.
vi.mock("./CharacterEditorPanels", () => ({
  CharacterIdentityPanel: ({
    handleFieldEdit,
  }: {
    handleFieldEdit: (field: string, value: unknown) => void;
  }) => (
    <button
      type="button"
      data-testid="identity-panel"
      onClick={() => handleFieldEdit("bio", "new bio text")}
    >
      identity
    </button>
  ),
  CharacterStylePanel: () => <div data-testid="style-panel" />,
  CharacterExamplesPanel: () => <div data-testid="examples-panel" />,
}));

import { CharacterHubView } from "./CharacterHubView";

afterEach(() => {
  cleanup();
  updateCharacter.mockReset();
  vi.useRealTimers();
});

const noop = vi.fn();

function renderHub(
  applyFieldEdit: (field: string, value: unknown) => void = noop,
) {
  return render(
    <CharacterHubView
      d={{}}
      bioText=""
      normalizedMessageExamples={[]}
      pendingStyleEntries={{}}
      styleEntryDrafts={{}}
      applyFieldEdit={applyFieldEdit}
      handlePendingStyleEntryChange={noop}
      applyStyleEdit={noop}
      handleStyleEntryDraftChange={noop}
      characterSaveError={null}
    />,
  );
}

describe("CharacterHubView (Personality-only collapse)", () => {
  it("renders only the Personality panels", () => {
    renderHub();
    expect(screen.getByTestId("identity-panel")).toBeTruthy();
    expect(screen.getByTestId("style-panel")).toBeTruthy();
    expect(screen.getByTestId("examples-panel")).toBeTruthy();
  });

  it("no longer renders its own ViewHeader (the section strip owns it)", () => {
    renderHub();
    expect(screen.queryByTestId("view-header")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Back to launcher" }),
    ).toBeNull();
  });

  it("does not render the deleted overview CTA grid or any EmptyCta chip", () => {
    renderHub();
    for (const cta of [
      "Define your voice",
      "Introduce someone in chat",
      "Browse skills",
      "Upload your first document",
      "Teach Eliza in chat",
    ]) {
      expect(screen.queryByText(cta)).toBeNull();
    }
  });

  it("does not render the collapsed embedded sub-view branches (dual path is gone)", () => {
    renderHub();
    // The old renderSection() mounted DocumentsView / the relationships /
    // skills / experience workspaces inline; those branches were removed, so
    // none of their surfaces appear on the Personality hub.
    expect(screen.queryByTestId("documents-view-stub")).toBeNull();
    expect(screen.queryByText("Loading experiences…")).toBeNull();
    expect(screen.queryByText("Review queue")).toBeNull();
  });

  it("has no manual Save button (edits autosave)", () => {
    renderHub();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  // With the manual Save button gone, an identity (bio) edit must debounce-persist
  // on its own — otherwise it would be lost on section-switch (the regression this
  // guards). The style/examples panels already autosaved; bio did not.
  it("autosaves a bio edit (debounced PATCH), applying the draft immediately", () => {
    vi.useFakeTimers();
    const applyFieldEdit = vi.fn();
    renderHub(applyFieldEdit);

    fireEvent.click(screen.getByTestId("identity-panel"));
    // Draft update is synchronous; the network patch is debounced.
    expect(applyFieldEdit).toHaveBeenCalledWith("bio", "new bio text");
    expect(updateCharacter).not.toHaveBeenCalled();

    vi.advanceTimersByTime(700);
    expect(updateCharacter).toHaveBeenCalledWith({ bio: "new bio text" });
  });
});
