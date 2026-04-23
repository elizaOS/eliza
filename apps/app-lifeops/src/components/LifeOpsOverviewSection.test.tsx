// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  LifeOpsCapabilitiesStatus,
  LifeOpsGoogleConnectorStatus,
  LifeOpsInboxMessage,
  LifeOpsOverview,
  LifeOpsXConnectorStatus,
} from "@elizaos/shared/contracts/lifeops";
import type {
  LifeOpsScreenTimeSummary,
  LifeOpsSocialHabitSummary,
} from "../api/client-lifeops.js";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  calendarState,
  capabilitiesState,
  clientMock,
  googleConnectorState,
  mailInboxState,
  messageInboxState,
  reactJsxDevRuntimePath,
  reactJsxRuntimePath,
  reactModulePath,
  selectMock,
  tMock,
  xConnectorState,
} = vi.hoisted(() => {
  const cwd = process.cwd();
  const workspaceRoot = cwd.endsWith("/eliza") ? cwd.slice(0, -6) : cwd;
  const reactRoot = `${workspaceRoot}/node_modules/react`;
  return {
    calendarState: {
      error: null as string | null,
      events: [] as Array<Record<string, unknown>>,
      goNext: vi.fn(),
      goPrevious: vi.fn(),
      goToToday: vi.fn(),
      loading: false,
      refresh: vi.fn(),
      setViewMode: vi.fn(),
      viewMode: "week" as const,
      windowEnd: new Date("2026-04-24T00:00:00.000Z"),
      windowStart: new Date("2026-04-23T00:00:00.000Z"),
    },
    capabilitiesState: {
      error: null as string | null,
      loading: false,
      refresh: vi.fn(),
      status: null as LifeOpsCapabilitiesStatus | null,
    },
    clientMock: {
      getLifeOpsOverview: vi.fn<() => Promise<LifeOpsOverview>>(),
      getLifeOpsScreenTimeSummary:
        vi.fn<() => Promise<LifeOpsScreenTimeSummary>>(),
      getLifeOpsSocialHabitSummary:
        vi.fn<() => Promise<LifeOpsSocialHabitSummary>>(),
    },
    googleConnectorState: {
      actionPending: false,
      connect: vi.fn(),
      connectAdditional: vi.fn(),
      disconnect: vi.fn(),
      disconnectAccount: vi.fn(),
      error: null as string | null,
      loading: false,
      modeOptions: ["cloud_managed", "local"],
      pendingAuthUrl: null as string | null,
      refresh: vi.fn(),
      selectMode: vi.fn(),
      selectedMode: "cloud_managed" as const,
      side: "owner" as const,
      status: null as LifeOpsGoogleConnectorStatus | null,
    },
    mailInboxState: {
      channel: "gmail" as const,
      error: null as string | null,
      loading: false,
      messages: [] as LifeOpsInboxMessage[],
      refresh: vi.fn(),
      searchQuery: "",
      setChannel: vi.fn(),
      setSearchQuery: vi.fn(),
    },
    messageInboxState: {
      channel: "all" as const,
      error: null as string | null,
      loading: false,
      messages: [] as LifeOpsInboxMessage[],
      refresh: vi.fn(),
      searchQuery: "",
      setChannel: vi.fn(),
      setSearchQuery: vi.fn(),
    },
    reactJsxDevRuntimePath: `${reactRoot}/jsx-dev-runtime.js`,
    reactJsxRuntimePath: `${reactRoot}/jsx-runtime.js`,
    reactModulePath: `${reactRoot}/index.js`,
    selectMock: vi.fn(),
    tMock: vi.fn(
      (
        key: string,
        options?: Record<string, unknown> & { defaultValue?: string },
      ) => options?.defaultValue ?? key,
    ),
    xConnectorState: {
      actionPending: false,
      connect: vi.fn(),
      disconnect: vi.fn(),
      error: null as string | null,
      lastPost: null,
      loading: false,
      pendingAuthUrl: null as string | null,
      post: vi.fn(),
      refresh: vi.fn(),
      status: null as LifeOpsXConnectorStatus | null,
    },
  };
});

vi.mock("react", () => require(reactModulePath));
vi.mock("react/jsx-runtime", () => require(reactJsxRuntimePath));
vi.mock("react/jsx-dev-runtime", () => require(reactJsxDevRuntimePath));

vi.mock("@elizaos/app-core", () => ({
  client: clientMock,
  useApp: () => ({
    t: tMock,
  }),
}));

vi.mock("../hooks/useCalendarWeek.js", () => ({
  useCalendarWeek: () => calendarState,
}));

vi.mock("../hooks/useGoogleLifeOpsConnector.js", () => ({
  useGoogleLifeOpsConnector: () => googleConnectorState,
}));

vi.mock("../hooks/useLifeOpsCapabilitiesStatus.js", () => ({
  useLifeOpsCapabilitiesStatus: () => capabilitiesState,
}));

vi.mock("../hooks/useLifeOpsXConnector.js", () => ({
  useLifeOpsXConnector: () => xConnectorState,
}));

vi.mock("../hooks/useInbox.js", () => ({
  useInbox: (options?: { channel?: string }) =>
    options?.channel === "gmail" ? mailInboxState : messageInboxState,
}));

vi.mock("./LifeOpsSelectionContext.js", () => ({
  useLifeOpsSelection: () => ({
    select: selectMock,
  }),
}));

vi.mock("./LifeOpsInboxSection.js", () => ({
  LIFEOPS_MAIL_CHANNELS: ["gmail"],
  LIFEOPS_MESSAGE_CHANNELS: ["x_dm"],
}));

import { LifeOpsOverviewSection } from "./LifeOpsOverviewSection.js";

const React = require(reactModulePath) as typeof import("react");

function buildOverview(
  overrides: Partial<LifeOpsOverview> = {},
): LifeOpsOverview {
  const summary = {
    activeGoalCount: 0,
    activeOccurrenceCount: 0,
    activeReminderCount: 0,
    overdueOccurrenceCount: 0,
    snoozedOccurrenceCount: 0,
  };
  return {
    agentOps: {
      goals: [],
      occurrences: [],
      reminders: [],
      summary,
    },
    goals: [],
    occurrences: [],
    owner: {
      goals: [],
      occurrences: [],
      reminders: [],
      summary,
    },
    reminders: [],
    schedule: null,
    summary,
    ...overrides,
  };
}

function buildInboxMessage(
  overrides: Partial<LifeOpsInboxMessage> = {},
): LifeOpsInboxMessage {
  return {
    channel: "x_dm",
    deepLink: null,
    id: "message-1",
    receivedAt: "2026-04-23T12:00:00.000Z",
    sender: {
      avatarUrl: null,
      displayName: "Taylor",
      id: "sender-1",
    },
    snippet: "Need your call back.",
    sourceRef: {
      channel: "x_dm",
      externalId: "external-message-1",
    },
    subject: null,
    unread: true,
    ...overrides,
  };
}

function buildCapabilitiesStatus(
  overrides: Partial<LifeOpsCapabilitiesStatus> = {},
): LifeOpsCapabilitiesStatus {
  return {
    appEnabled: true,
    capabilities: [],
    generatedAt: "2026-04-23T12:00:00.000Z",
    relativeTime: null,
    summary: {
      blockedCount: 0,
      degradedCount: 0,
      notConfiguredCount: 0,
      totalCount: 0,
      workingCount: 0,
    },
    ...overrides,
  };
}

function buildGoogleConnectorStatus(
  overrides: Partial<LifeOpsGoogleConnectorStatus> = {},
): LifeOpsGoogleConnectorStatus {
  return {
    availableModes: ["cloud_managed", "local"],
    cloudConnectionId: null,
    configured: false,
    connected: false,
    defaultMode: "cloud_managed",
    executionTarget: "local",
    expiresAt: null,
    grant: null,
    grantedCapabilities: [],
    grantedScopes: [],
    hasRefreshToken: false,
    identity: null,
    mode: "cloud_managed",
    preferredByAgent: false,
    provider: "google",
    reason: "disconnected",
    side: "owner",
    sourceOfTruth: "local_storage",
    ...overrides,
  };
}

function buildXConnectorStatus(
  overrides: Partial<LifeOpsXConnectorStatus> = {},
): LifeOpsXConnectorStatus {
  return {
    cloudConnectionId: null,
    configured: false,
    connected: false,
    defaultMode: "cloud_managed",
    dmInbound: false,
    dmRead: false,
    dmWrite: false,
    executionTarget: "local",
    feedRead: false,
    feedWrite: false,
    grant: null,
    grantedCapabilities: [],
    grantedScopes: [],
    hasCredentials: false,
    identity: null,
    mode: "cloud_managed",
    provider: "x",
    reason: "disconnected",
    side: "owner",
    sourceOfTruth: "local_storage",
    ...overrides,
  };
}

function renderSection() {
  const onNavigate = vi.fn();
  render(React.createElement(LifeOpsOverviewSection, { onNavigate }));
  return { onNavigate };
}

beforeEach(() => {
  vi.clearAllMocks();

  capabilitiesState.loading = false;
  capabilitiesState.error = null;
  capabilitiesState.refresh.mockResolvedValue(undefined);
  capabilitiesState.status = buildCapabilitiesStatus({
    capabilities: [
      {
        confidence: 0.9,
        domain: "schedule",
        evidence: [],
        id: "sleep.relative_time",
        label: "Sleep",
        lastCheckedAt: "2026-04-23T12:00:00.000Z",
        state: "working",
        summary: "Awake clock is running",
      },
      {
        confidence: 0.9,
        domain: "activity",
        evidence: [],
        id: "activity.browser",
        label: "Browser activity",
        lastCheckedAt: "2026-04-23T12:00:00.000Z",
        state: "not_configured",
        summary: "No browser activity access",
      },
      {
        confidence: 0.9,
        domain: "reminders",
        evidence: [],
        id: "reminders.scheduler",
        label: "Reminder scheduler",
        lastCheckedAt: "2026-04-23T12:00:00.000Z",
        state: "working",
        summary: "Scheduler is active",
      },
    ],
    summary: {
      blockedCount: 0,
      degradedCount: 0,
      notConfiguredCount: 1,
      totalCount: 3,
      workingCount: 2,
    },
  });

  googleConnectorState.loading = false;
  googleConnectorState.error = null;
  googleConnectorState.refresh.mockResolvedValue(undefined);
  googleConnectorState.status = buildGoogleConnectorStatus();

  xConnectorState.loading = false;
  xConnectorState.error = null;
  xConnectorState.refresh.mockResolvedValue(undefined);
  xConnectorState.status = buildXConnectorStatus();

  calendarState.events = [];
  calendarState.loading = false;
  calendarState.error = null;
  calendarState.refresh.mockResolvedValue(undefined);

  messageInboxState.loading = false;
  messageInboxState.error = null;
  messageInboxState.messages = [];
  messageInboxState.refresh.mockResolvedValue(undefined);

  mailInboxState.loading = false;
  mailInboxState.error = null;
  mailInboxState.messages = [];
  mailInboxState.refresh.mockResolvedValue(undefined);

  clientMock.getLifeOpsOverview.mockResolvedValue(buildOverview());
  clientMock.getLifeOpsScreenTimeSummary.mockRejectedValue(
    new Error("Screen time unavailable."),
  );
  clientMock.getLifeOpsSocialHabitSummary.mockRejectedValue(
    new Error("Social unavailable."),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("LifeOpsOverviewSection", () => {
  it("renders available widgets without the setup gate and links warnings to settings", async () => {
    googleConnectorState.status = buildGoogleConnectorStatus({
      configured: true,
      connected: true,
      grantedCapabilities: ["google.calendar.read"],
      hasRefreshToken: true,
      identity: { email: "owner@example.test" },
      reason: "connected",
    });
    calendarState.events = [
      {
        attendees: [],
        calendarId: "primary",
        conferenceLink: null,
        description: "",
        endAt: "2026-04-23T18:00:00.000Z",
        externalId: "external-event-1",
        agentId: "agent-1",
        htmlLink: null,
        id: "event-1",
        isAllDay: false,
        location: "",
        metadata: {},
        organizer: null,
        provider: "google",
        side: "owner",
        startAt: "2026-04-23T17:00:00.000Z",
        status: "confirmed",
        syncedAt: "2026-04-23T12:00:00.000Z",
        timezone: "America/Los_Angeles",
        title: "Founder sync",
        updatedAt: "2026-04-23T12:00:00.000Z",
      },
    ];
    clientMock.getLifeOpsOverview.mockResolvedValue(
      buildOverview({
        reminders: [
          {
            calendarId: null,
            calendarTitle: null,
            dueAt: null,
            eventId: null,
            eventStartAt: null,
            htmlLink: null,
            occurrenceId: "occurrence-1",
            ownerId: "reminder-1",
            ownerType: "occurrence",
            scheduledFor: "2099-04-23T14:00:00.000Z",
            state: "visible",
            stepIndex: 0,
            stepLabel: "Visible",
            title: "Drink water",
          },
        ],
        summary: {
          activeGoalCount: 0,
          activeOccurrenceCount: 1,
          activeReminderCount: 1,
          overdueOccurrenceCount: 0,
          snoozedOccurrenceCount: 0,
        },
      }),
    );

    const { onNavigate } = renderSection();

    await waitFor(() =>
      expect(screen.getByTestId("lifeops-overview-setup-warning")).toBeTruthy(),
    );

    expect(screen.queryByText("Set up LifeOps")).toBeNull();
    expect(screen.getByText("Overview is partial.")).toBeTruthy();
    expect(screen.getByText("Upcoming")).toBeTruthy();
    expect(screen.getAllByText("Reminders").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Sleep").length).toBeGreaterThan(0);
    expect(screen.queryByText("Priority Messages")).toBeNull();
    expect(screen.queryByText("Priority Mail")).toBeNull();
    expect(screen.queryByText("Work")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(onNavigate).toHaveBeenCalledWith("setup");
  });

  it("shows the no-access empty state instead of the setup gate when nothing is connected", async () => {
    capabilitiesState.status = buildCapabilitiesStatus({
      capabilities: [
        {
          confidence: 0.5,
          domain: "schedule",
          evidence: [],
          id: "sleep.relative_time",
          label: "Sleep",
          lastCheckedAt: "2026-04-23T12:00:00.000Z",
          state: "not_configured",
          summary: "No sleep signal",
        },
        {
          confidence: 0.5,
          domain: "activity",
          evidence: [],
          id: "activity.browser",
          label: "Browser activity",
          lastCheckedAt: "2026-04-23T12:00:00.000Z",
          state: "not_configured",
          summary: "No browser activity access",
        },
        {
          confidence: 0.5,
          domain: "reminders",
          evidence: [],
          id: "reminders.scheduler",
          label: "Reminder scheduler",
          lastCheckedAt: "2026-04-23T12:00:00.000Z",
          state: "not_configured",
          summary: "No reminders yet",
        },
      ],
      summary: {
        blockedCount: 0,
        degradedCount: 0,
        notConfiguredCount: 3,
        totalCount: 3,
        workingCount: 0,
      },
    });

    const { onNavigate } = renderSection();

    await waitFor(() =>
      expect(screen.getByTestId("lifeops-overview-empty-access")).toBeTruthy(),
    );

    expect(screen.queryByText("Set up LifeOps")).toBeNull();
    expect(screen.getByText("Overview needs access.")).toBeTruthy();
    expect(
      screen.getByText("Add some access to populate Overview"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));

    expect(onNavigate).toHaveBeenCalledWith("setup");
  });

  it("shows priority messages when inbox access is available", async () => {
    xConnectorState.status = buildXConnectorStatus({
      configured: true,
      connected: true,
      dmInbound: true,
      dmRead: true,
      grantedCapabilities: ["x.dm.read"],
      hasCredentials: true,
      reason: "connected",
    });
    messageInboxState.messages = [
      buildInboxMessage({
        id: "message-older-read",
        receivedAt: "2026-04-23T11:00:00.000Z",
        unread: false,
      }),
      buildInboxMessage({
        id: "message-new-unread",
        receivedAt: "2026-04-23T12:30:00.000Z",
        unread: true,
      }),
    ];

    renderSection();

    await waitFor(() =>
      expect(screen.getByText("Priority Messages")).toBeTruthy(),
    );

    const rows = screen.getAllByText(/Taylor/);
    expect(rows.length).toBeGreaterThan(0);
    expect(screen.getByText("Priority Messages")).toBeTruthy();
  });
});
