// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "react",
  async () =>
    await import(
      "../../../../node_modules/.bun/react@19.2.5/node_modules/react/index.js"
    ),
);

const lifeOpsClient = vi.hoisted(() => ({
  getLifeOpsAppState: vi.fn(),
  updateLifeOpsAppState: vi.fn(),
  getLifeOpsOverview: vi.fn(),
  listLifeOpsDefinitions: vi.fn(),
  completeLifeOpsOccurrence: vi.fn(),
  skipLifeOpsOccurrence: vi.fn(),
  snoozeLifeOpsOccurrence: vi.fn(),
}));

vi.mock("@elizaos/ui", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
  client: lifeOpsClient,
  AppWorkspaceChrome: (props: React.HTMLAttributes<HTMLDivElement>) =>
    React.createElement("div", props),
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", props),
  PagePanel: (props: React.HTMLAttributes<HTMLDivElement>) =>
    React.createElement("div", props),
  PageScopedChatPane: (props: React.HTMLAttributes<HTMLDivElement>) =>
    React.createElement("div", props),
  isAppWindowRoute: () => false,
  isWebPlatform: () => true,
  openExternalUrl: vi.fn(),
  useApp: () => ({
    agentStatus: null,
    backendConnection: null,
    elizaCloudConnected: false,
    setActionNotice: vi.fn(),
    startupCoordinator: null,
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? "",
  }),
  useMediaQuery: () => false,
}));

vi.mock("./LifeOpsOperationalPanels", () => ({
  LifeOpsXPanel: () => null,
}));
vi.mock("./LifeOpsPageSections", () => ({
  LifeOpsSectionContent: () => null,
}));
vi.mock("./LifeOpsSectionContent.js", () => ({
  LifeOpsSectionContent: () => null,
}));
vi.mock("./LifeOpsSettingsSection", () => ({
  LifeOpsSettingsSection: () => null,
}));
vi.mock("./LifeOpsSetupGate.js", () => ({
  clearLifeOpsSetupGateDismissed: vi.fn(),
}));
vi.mock("./LifeOpsWorkspaceShell.js", () => ({
  LifeOpsWorkspaceShell: (props: React.HTMLAttributes<HTMLDivElement>) =>
    React.createElement("div", props),
}));
vi.mock("./MessagingConnectorCards", () => ({
  MessagingConnectorGrid: () => null,
}));
vi.mock("./LifeOpsSelectionContext.js", () => ({
  LifeOpsSelectionProvider: (props: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, props.children),
  useLifeOpsSelection: () => ({ selection: {} }),
}));
vi.mock("../hooks/useLifeOpsAppState.js", () => ({
  useLifeOpsAppState: () => ({
    enabled: true,
    loading: false,
    saving: false,
    error: null,
    refresh: vi.fn(),
    updateEnabled: vi.fn(),
  }),
}));
vi.mock("../hooks/useLifeOpsSection.js", () => ({
  useLifeOpsSection: () => ({ section: "overview", setSection: vi.fn() }),
}));
vi.mock("../platform/lifeops-github.js", () => ({
  consumeQueuedLifeOpsGithubCallback: vi.fn(),
  dispatchLifeOpsGithubCallbackFromWindowMessage: vi.fn(),
  drainLifeOpsGithubCallbacks: vi.fn(),
}));

import { interact, LifeOpsTuiView } from "./LifeOpsPageView";

const overview = {
  summary: {
    activeOccurrenceCount: 2,
    overdueOccurrenceCount: 1,
    snoozedOccurrenceCount: 0,
    activeReminderCount: 3,
    activeGoalCount: 1,
  },
  occurrences: [
    {
      id: "occ-1",
      title: "Morning check-in",
      state: "active",
      dueAt: "2026-05-19T15:00:00.000Z",
      definitionKind: "checkin",
      priority: 8,
    },
    {
      id: "occ-2",
      title: "Review inbox",
      state: "overdue",
      dueAt: "2026-05-19T14:00:00.000Z",
      definitionKind: "watcher",
      priority: 9,
    },
  ],
  owner: {
    occurrences: [],
    goals: [{ id: "goal-1", title: "Stay on top of inbox", status: "active" }],
    reminders: [],
  },
};

const definitions = {
  definitions: [
    {
      definition: {
        id: "def-1",
        title: "Morning check-in",
        kind: "checkin",
        status: "active",
        priority: 8,
      },
    },
  ],
};

function mockClient() {
  lifeOpsClient.getLifeOpsAppState.mockResolvedValue({ enabled: true });
  lifeOpsClient.updateLifeOpsAppState.mockResolvedValue({ enabled: false });
  lifeOpsClient.getLifeOpsOverview.mockResolvedValue(overview);
  lifeOpsClient.listLifeOpsDefinitions.mockResolvedValue(definitions);
  lifeOpsClient.completeLifeOpsOccurrence.mockResolvedValue({ ok: true });
  lifeOpsClient.skipLifeOpsOccurrence.mockResolvedValue({ ok: true });
  lifeOpsClient.snoozeLifeOpsOccurrence.mockResolvedValue({ ok: true });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LifeOpsTuiView", () => {
  it("mounts ScheduledTask state and completes occurrences through LifeOps APIs", async () => {
    mockClient();

    const { container } = render(React.createElement(LifeOpsTuiView));

    expect(await screen.findAllByText("Morning check-in")).toHaveLength(2);
    expect(screen.getByText("Review inbox")).toBeTruthy();
    expect(screen.getByText("Stay on top of inbox")).toBeTruthy();

    const stateElement = container.querySelector("[data-view-state]");
    expect(
      JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
    ).toMatchObject({
      viewType: "tui",
      viewId: "lifeops",
      enabled: true,
      occurrenceCount: 2,
      activeOccurrenceCount: 2,
      overdueOccurrenceCount: 1,
      activeReminderCount: 3,
      activeGoalCount: 1,
      definitionCount: 1,
      loading: false,
    });

    fireEvent.click(screen.getAllByText("complete")[0]);
    await waitFor(() =>
      expect(lifeOpsClient.completeLifeOpsOccurrence).toHaveBeenCalledWith(
        "occ-1",
        {},
      ),
    );
  });

  it("supports terminal capabilities through existing LifeOps APIs", async () => {
    mockClient();

    await expect(
      interact("terminal-lifeops-state", { limit: 1 }),
    ).resolves.toMatchObject({
      viewType: "tui",
      appState: { enabled: true },
      summary: overview.summary,
      definitions: [definitions.definitions[0]],
      occurrences: [overview.occurrences[0]],
    });

    await expect(
      interact("terminal-lifeops-enable", { enabled: false }),
    ).resolves.toEqual({
      viewType: "tui",
      appState: { enabled: false },
    });
    expect(lifeOpsClient.updateLifeOpsAppState).toHaveBeenCalledWith({
      enabled: false,
    });

    await expect(
      interact("terminal-lifeops-complete", { occurrenceId: "occ-1" }),
    ).resolves.toEqual({ viewType: "tui", result: { ok: true } });
    await expect(
      interact("terminal-lifeops-skip", { occurrenceId: "occ-1" }),
    ).resolves.toEqual({ viewType: "tui", result: { ok: true } });
    await expect(
      interact("terminal-lifeops-snooze", {
        occurrenceId: "occ-1",
        minutes: 45,
      }),
    ).resolves.toEqual({ viewType: "tui", result: { ok: true } });
    expect(lifeOpsClient.snoozeLifeOpsOccurrence).toHaveBeenCalledWith(
      "occ-1",
      {
        minutes: 45,
      },
    );
  });
});
