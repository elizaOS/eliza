// @vitest-environment jsdom
//
// Guards the collapse of CharacterHubView to the Personality section only
// (#13591). The hub once rendered all six legacy sections internally (overview
// + the four now-promoted top-level views) and owned its own ViewHeader; this
// test asserts that dual render path is GONE: no overview/EmptyCta grid, no
// embedded Documents/Skills/Experience/Relationships branch, and no in-view
// header (the shared CharacterSectionNav supplies it). The panels are stubbed so
// the test isolates the hub's own structure, not their internals.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setActionNotice: vi.fn(),
  updateCharacter: vi.fn(),
}));

vi.mock("../../state", () => ({
  useAppSelectorShallow: (selector: (s: unknown) => unknown) =>
    selector({
      setActionNotice: mocks.setActionNotice,
      t: (_key: string, opts?: { defaultValue?: string }) =>
        opts?.defaultValue ?? _key,
    }),
}));
vi.mock("../../api/client", () => ({
  client: { updateCharacter: mocks.updateCharacter },
}));
vi.mock("../../widgets/WidgetHost", () => ({ WidgetHost: () => null }));
vi.mock("./CharacterEditorPanels", () => ({
  CharacterIdentityPanel: ({
    handleFieldEdit,
  }: {
    handleFieldEdit: (field: string, value: unknown) => void;
  }) => (
    <div data-testid="identity-panel">
      <button type="button" onClick={() => handleFieldEdit("bio", "new bio")}>
        Edit bio
      </button>
    </div>
  ),
  CharacterStylePanel: () => <div data-testid="style-panel" />,
  CharacterExamplesPanel: () => <div data-testid="examples-panel" />,
}));

import { CharacterHubView } from "./CharacterHubView";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const noop = vi.fn();

function renderHub(
  overrides: Partial<Parameters<typeof CharacterHubView>[0]> = {},
) {
  return render(
    <CharacterHubView
      d={{}}
      bioText=""
      normalizedMessageExamples={[]}
      pendingStyleEntries={{}}
      styleEntryDrafts={{}}
      applyFieldEdit={noop}
      handlePendingStyleEntryChange={noop}
      applyStyleEdit={noop}
      handleStyleEntryDraftChange={noop}
      characterSaveError={null}
      {...overrides}
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

  it("autosaves identity edits after the debounce", async () => {
    vi.useFakeTimers();
    const applyFieldEdit = vi.fn();

    renderHub({ applyFieldEdit });
    fireEvent.click(screen.getByRole("button", { name: "Edit bio" }));

    expect(applyFieldEdit).toHaveBeenCalledWith("bio", "new bio");
    expect(mocks.updateCharacter).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });

    expect(mocks.updateCharacter).toHaveBeenCalledWith({ bio: "new bio" });
  });
});
