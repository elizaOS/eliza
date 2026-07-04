// @vitest-environment jsdom

// Renders the real SkillsView against a mocked state barrel to cover load-on-
// mount + empty state, rendering installed skills from context, the enable
// toggle calling handleSkillToggle with the new value, background refresh
// polling (no manual refresh control), and search filtering to the empty state.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillInfo } from "../../api";
import { getViewChatBinding } from "../../state/view-chat-binding";
import { SkillsView } from "./SkillsView";

// SkillsView reads all of its data + handlers from the app context (useApp).
// That context is the seam the Q2 data-layer refactor will reshape, so the
// tests drive the view through a controllable mock context and assert both the
// rendered output and that the right handlers fire with the right arguments.
const appMock = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock("../../state", () => ({
  useApp: () => appMock.value,
  useAppSelector: (sel: (value: Record<string, unknown>) => unknown) =>
    sel(appMock.value),
  useAppSelectorShallow: (sel: (value: Record<string, unknown>) => unknown) =>
    sel(appMock.value),
}));

// Translation passthrough: return the provided defaultValue (or key) so we can
// assert on human-readable copy where the component supplies one.
function t(key: string, options?: { defaultValue?: string }) {
  return options?.defaultValue ?? key;
}

function makeContext(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    skills: [] as SkillInfo[],
    skillCreateFormOpen: false,
    skillCreateName: "",
    skillCreateDescription: "",
    skillCreating: false,
    skillReviewReport: null,
    skillReviewId: "",
    skillReviewLoading: false,
    skillToggleAction: "",
    skillsMarketplaceQuery: "",
    skillsMarketplaceResults: [],
    skillsMarketplaceError: "",
    skillsMarketplaceLoading: false,
    skillsMarketplaceAction: "",
    skillsMarketplaceManualGithubUrl: "",
    loadSkills: vi.fn(async () => {}),
    refreshSkills: vi.fn(async () => {}),
    handleSkillToggle: vi.fn(async () => {}),
    handleCreateSkill: vi.fn(async () => {}),
    handleDeleteSkill: vi.fn(async () => {}),
    handleReviewSkill: vi.fn(),
    handleAcknowledgeSkill: vi.fn(),
    searchSkillsMarketplace: vi.fn(),
    installSkillFromMarketplace: vi.fn(),
    uninstallMarketplaceSkill: vi.fn(),
    installSkillFromGithubUrl: vi.fn(),
    enableMarketplaceSkill: vi.fn(),
    disableMarketplaceSkill: vi.fn(),
    copyMarketplaceSkillSource: vi.fn(),
    setState: vi.fn(),
    t,
    ...overrides,
  };
}

const SKILL_A: SkillInfo = {
  id: "skill-alpha",
  name: "Alpha Skill",
  description: "Does alpha things",
  enabled: true,
  scanStatus: "clean",
};
const SKILL_B: SkillInfo = {
  id: "skill-beta",
  name: "Beta Skill",
  description: "Does beta things",
  enabled: false,
  scanStatus: "clean",
};

beforeEach(() => {
  appMock.value = makeContext();
});

afterEach(() => cleanup());

describe("SkillsView", () => {
  it("calls loadSkills on mount and renders the empty state when no skills exist", async () => {
    render(<SkillsView />);

    await waitFor(() => {
      expect(appMock.value.loadSkills).toHaveBeenCalled();
    });
    // Zero skills → the "No Skills Installed" empty surface, not a skill list.
    expect(screen.getByTestId("skills-empty-state")).toBeTruthy();
    expect(screen.queryByTestId("skill-row-skill-alpha")).toBeNull();
  });

  it("renders the installed skills once the context provides them", () => {
    appMock.value = makeContext({ skills: [SKILL_A, SKILL_B] });

    render(<SkillsView />);

    // Both skills appear in the sidebar list; the empty state is gone.
    expect(screen.getByTestId("skill-row-skill-alpha")).toBeTruthy();
    expect(screen.getByTestId("skill-row-skill-beta")).toBeTruthy();
    expect(screen.queryByTestId("skills-empty-state")).toBeNull();
    // First skill is auto-selected and its name shows in the detail pane.
    expect(screen.getByTestId("skills-detail-name").textContent).toBe(
      "Alpha Skill",
    );
  });

  it("toggling the selected skill's switch calls handleSkillToggle with the new enabled value", () => {
    appMock.value = makeContext({ skills: [SKILL_A] });

    render(<SkillsView />);

    // SKILL_A is enabled; flipping the detail-pane switch should disable it.
    const toggle = screen.getByRole("switch");
    fireEvent.click(toggle);

    expect(appMock.value.handleSkillToggle).toHaveBeenCalledWith(
      "skill-alpha",
      false,
    );
  });

  it("polls refreshSkills in the background instead of exposing a manual refresh control", () => {
    vi.useFakeTimers();
    try {
      appMock.value = makeContext({ skills: [SKILL_A] });

      render(<SkillsView />);

      // No user-facing refresh control exists anymore.
      expect(screen.queryByLabelText("Refresh Skills List")).toBeNull();

      // The list revalidates itself on a slow interval.
      expect(appMock.value.refreshSkills).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(appMock.value.refreshSkills).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters the list to nothing and shows the filter-empty state when the search excludes all skills", () => {
    appMock.value = makeContext({ skills: [SKILL_A, SKILL_B] });

    render(<SkillsView />);

    // Search is driven by the floating chat composer now (SkillsView registers a
    // view→chat binding); drive its onQuery the way the composer would.
    act(() => {
      getViewChatBinding()?.onQuery?.("zzz-no-match");
    });

    expect(screen.queryByTestId("skill-row-skill-alpha")).toBeNull();
    expect(screen.getByTestId("skills-filter-empty")).toBeTruthy();
  });
});
