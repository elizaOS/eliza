// @vitest-environment jsdom
//
// Guards the collapse of CharacterHubView to the Personality section only
// (#13591). The hub once rendered all six legacy sections internally (overview
// + the four now-promoted top-level views) and owned its own ViewHeader; this
// test asserts that dual render path is GONE: no overview/EmptyCta grid, no
// embedded Documents/Skills/Experience/Relationships branch, and no in-view
// header (the shared CharacterSectionNav supplies it). The panels are stubbed so
// the test isolates the hub's own structure, not their internals.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../state", () => ({
  useAppSelectorShallow: (selector: (s: unknown) => unknown) =>
    selector({
      setActionNotice: vi.fn(),
      t: (_key: string, opts?: { defaultValue?: string }) =>
        opts?.defaultValue ?? _key,
    }),
}));
vi.mock("../../api/client", () => ({ client: { updateCharacter: vi.fn() } }));
vi.mock("../../widgets/WidgetHost", () => ({ WidgetHost: () => null }));
vi.mock("./CharacterEditorPanels", () => ({
  CharacterIdentityPanel: () => <div data-testid="identity-panel" />,
  CharacterStylePanel: () => <div data-testid="style-panel" />,
  CharacterExamplesPanel: () => <div data-testid="examples-panel" />,
}));

import { CharacterHubView } from "./CharacterHubView";

afterEach(cleanup);

const noop = vi.fn();

function renderHub() {
  return render(
    <CharacterHubView
      d={{}}
      bioText=""
      normalizedMessageExamples={[]}
      pendingStyleEntries={{}}
      styleEntryDrafts={{}}
      handleFieldEdit={noop}
      applyFieldEdit={noop}
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
});
