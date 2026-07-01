// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillInfo, SkillMarketplaceResult } from "../../api";
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

const MARKET_RESULT: SkillMarketplaceResult = {
  id: "skill-gamma",
  slug: "gamma",
  name: "Gamma Skill",
  description: "A brand new gamma skill",
  repository: "elizaos/skill-gamma",
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

  it("positive search matches on description and narrows the list to the matching skill", () => {
    appMock.value = makeContext({ skills: [SKILL_A, SKILL_B] });

    render(<SkillsView />);

    // "beta things" only appears in SKILL_B's description — the query should
    // keep beta and drop alpha (case-insensitive, description-aware).
    act(() => {
      getViewChatBinding()?.onQuery?.("BETA THINGS");
    });

    expect(screen.getByTestId("skill-row-skill-beta")).toBeTruthy();
    expect(screen.queryByTestId("skill-row-skill-alpha")).toBeNull();
    // Selection follows the filtered set: the surviving skill becomes selected.
    expect(screen.getByTestId("skills-detail-name").textContent).toBe(
      "Beta Skill",
    );
  });

  it("the OFF filter tab shows only disabled skills", () => {
    appMock.value = makeContext({ skills: [SKILL_A, SKILL_B] });

    render(<SkillsView />);

    // filterTabs render "<on> (n)" / "<off> (n)" — click the Off tab, which
    // must narrow the list to the single disabled skill (SKILL_B).
    fireEvent.click(screen.getByText("common.off (1)"));

    expect(screen.queryByTestId("skill-row-skill-alpha")).toBeNull();
    expect(screen.getByTestId("skill-row-skill-beta")).toBeTruthy();
  });

  it("selecting a different skill row swaps the detail pane and retargets the toggle", () => {
    appMock.value = makeContext({ skills: [SKILL_A, SKILL_B] });

    render(<SkillsView />);

    // Alpha auto-selected first; click Beta's row (the inner option button) to
    // expand it in the detail pane.
    fireEvent.click(
      within(screen.getByTestId("skill-row-skill-beta")).getByRole("option"),
    );

    expect(screen.getByTestId("skills-detail-name").textContent).toBe(
      "Beta Skill",
    );

    // SKILL_B is disabled → toggling now enables *beta*, not alpha.
    fireEvent.click(screen.getByRole("switch"));
    expect(appMock.value.handleSkillToggle).toHaveBeenCalledWith(
      "skill-beta",
      true,
    );
  });

  it("does not fire another toggle while one is already in flight (rapid-fire idempotency)", () => {
    // skillToggleAction === the selected skill id means a toggle is pending;
    // the detail switch is disabled so repeated clicks must be swallowed.
    appMock.value = makeContext({
      skills: [SKILL_A],
      skillToggleAction: "skill-alpha",
    });

    render(<SkillsView />);

    const toggle = screen.getByRole("switch") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);

    fireEvent.click(toggle);
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    expect(appMock.value.handleSkillToggle).not.toHaveBeenCalled();
  });

  it("shows the loading label and disables submit while a skill is being created", () => {
    appMock.value = makeContext({
      skillCreateFormOpen: true,
      skillCreateName: "New One",
      skillCreating: true,
    });

    render(<SkillsView />);

    const submit = screen.getByRole("button", {
      name: /Creating\.\.\./,
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("opens the marketplace modal and installs a result with the exact payload", async () => {
    appMock.value = makeContext({
      skills: [SKILL_A],
      skillsMarketplaceResults: [MARKET_RESULT],
    });

    render(<SkillsView />);

    // Toolbar Install button opens the marketplace dialog.
    fireEvent.click(screen.getByRole("button", { name: /^Install$/ }));

    const installBtn = await screen.findByTestId(
      "skill-action-install-skill-gamma",
    );
    fireEvent.click(installBtn);

    // Install fires with the full marketplace item, not just an id.
    expect(appMock.value.installSkillFromMarketplace).toHaveBeenCalledWith(
      MARKET_RESULT,
    );
  });

  it("surfaces a marketplace error inside the install modal", async () => {
    appMock.value = makeContext({
      skills: [SKILL_A],
      skillsMarketplaceError: "GitHub rate limit exceeded",
    });

    render(<SkillsView />);
    fireEvent.click(screen.getByRole("button", { name: /^Install$/ }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("GitHub rate limit exceeded");
  });
});
