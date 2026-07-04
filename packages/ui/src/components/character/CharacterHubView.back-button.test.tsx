// @vitest-environment jsdom
//
// Guards the per-view back affordance that replaced the global corner back
// button (removed from the app shell in App.tsx). The Character view now renders
// a shared `ViewHeader` whose chromeless "Back to launcher" control is the
// in-context way back — it must be present so removing the shell button never
// strands the user. See CharacterHubView (ViewHeader) + components/shared/ViewHeader.

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Peripheral collaborators of the subpage — mocked so the test isolates the
// back-button rendering logic under test, not these data/section modules.
vi.mock("../../state", () => ({
  useAppSelectorShallow: (selector: (s: unknown) => unknown) =>
    selector({
      setActionNotice: vi.fn(),
      setTab: vi.fn(),
      tab: "documents",
      t: (_key: string, opts?: { defaultValue?: string }) =>
        opts?.defaultValue ?? _key,
    }),
}));

const emptySlice = <T,>(data: T) => ({
  data,
  loading: false,
  error: null,
  refetch: vi.fn(),
  mutate: vi.fn(),
});

vi.mock("./useCharacterHubData", () => ({
  useCharacterHubData: () => ({
    documents: emptySlice([]),
    history: emptySlice([]),
    experiences: emptySlice([]),
    relationshipActivity: emptySlice([]),
    learnedSkills: emptySlice([]),
  }),
}));

vi.mock("../../api/client", () => ({ client: {} }));
vi.mock("../../widgets/WidgetHost", () => ({
  WidgetHost: () => null,
}));
vi.mock("../pages/DocumentsView", () => ({
  DocumentsView: () => <div data-testid="documents-view-stub" />,
}));
vi.mock("../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

import { CharacterHubView } from "./CharacterHubView";

afterEach(cleanup);

const noop = vi.fn();

function renderKnowledgeSubpage() {
  return render(
    <CharacterHubView
      initialSection="documents"
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
      characterSaving={false}
      characterSaveSuccess={null}
      characterSaveError={null}
      hasPendingChanges={false}
      onSave={async () => undefined}
    />,
  );
}

describe("CharacterHubView in-context back affordance", () => {
  it("renders its own ViewHeader 'Back to launcher' control (the shell no longer supplies a global corner back button)", () => {
    renderKnowledgeSubpage();

    const back = screen.getByRole("button", { name: "Back to launcher" });
    expect(back).toBeTruthy();
    // The ViewHeader shows the view's title (derived from the active tab).
    expect(screen.getByText("Knowledge")).toBeTruthy();
    // The section body still mounts under the header.
    expect(screen.getByTestId("documents-view-stub")).toBeTruthy();
  });

  it("does not render the removed global shell back button", () => {
    renderKnowledgeSubpage();

    expect(screen.queryByTestId("shell-back-button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
  });
});
