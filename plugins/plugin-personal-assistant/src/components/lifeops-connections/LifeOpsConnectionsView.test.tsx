// @vitest-environment jsdom

/**
 * Deterministic first-five-minutes and recovery tests for the LifeOps
 * connection manager. The injected adapter is local-only: no OAuth flow,
 * provider mutation, native permission prompt, or network request can run.
 */

import type {
  LifeOpsCalendarSourceHealth,
  LifeOpsCalendarSummary,
  LifeOpsConnectorGrant,
  LifeOpsGoogleConnectorStatus,
} from "@elizaos/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LifeOpsConnectionsAdapter,
  LifeOpsConnectionsSnapshot,
} from "./types.js";

vi.mock("./adapter.js", () => ({
  defaultLifeOpsConnectionsAdapter: {},
}));

import { LifeOpsConnectionsView } from "./LifeOpsConnectionsView.js";

const GRANT_ID = "connector-account:account-1";
const CONNECTOR_ACCOUNT_ID = "account-1";

function grant(): LifeOpsConnectorGrant {
  return {
    id: GRANT_ID,
    agentId: "agent-1",
    provider: "google",
    connectorAccountId: CONNECTOR_ACCOUNT_ID,
    side: "owner",
    identity: { email: "owner@example.test" },
    identityEmail: "owner@example.test",
    grantedScopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/calendar.readonly",
    ],
    capabilities: [
      "google.gmail.triage",
      "google.gmail.compose",
      "google.calendar.read",
    ],
    tokenRef: "protected:test-reference",
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "local_storage",
    preferredByAgent: true,
    cloudConnectionId: null,
    metadata: {},
    lastRefreshAt: "2026-08-22T08:00:00.000Z",
    createdAt: "2026-08-22T07:00:00.000Z",
    updatedAt: "2026-08-22T08:00:00.000Z",
  };
}

function googleStatus(): LifeOpsGoogleConnectorStatus {
  return {
    provider: "google",
    side: "owner",
    mode: "local",
    defaultMode: "local",
    availableModes: ["local"],
    executionTarget: "local",
    sourceOfTruth: "local_storage",
    configured: true,
    connected: true,
    reason: "connected",
    preferredByAgent: true,
    cloudConnectionId: null,
    identity: { email: "owner@example.test" },
    grantedCapabilities: [
      "google.gmail.triage",
      "google.gmail.compose",
      "google.calendar.read",
    ],
    grantedScopes: grant().grantedScopes,
    expiresAt: "2026-08-22T10:00:00.000Z",
    hasRefreshToken: true,
    grant: grant(),
  };
}

function calendar(
  provider: "google" | "apple_calendar",
): LifeOpsCalendarSummary {
  const isGoogle = provider === "google";
  return {
    provider,
    side: "owner",
    grantId: isGoogle ? GRANT_ID : "apple-calendar",
    connectorAccountId: isGoogle ? CONNECTOR_ACCOUNT_ID : "apple-calendar",
    accountEmail: isGoogle ? "owner@example.test" : null,
    calendarId: isGoogle ? "primary" : "apple-personal",
    summary: isGoogle ? "Google primary" : "Apple personal",
    description: null,
    primary: true,
    accessRole: "writer",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: "America/Los_Angeles",
    selected: true,
    includeInFeed: true,
    selectionVersion: 3,
  };
}

function source(
  calendarSummary: LifeOpsCalendarSummary,
  overrides: Partial<LifeOpsCalendarSourceHealth> = {},
): LifeOpsCalendarSourceHealth {
  return {
    key: {
      provider: calendarSummary.provider,
      side: calendarSummary.side,
      grantId: calendarSummary.grantId,
      connectorAccountId: calendarSummary.connectorAccountId,
      calendarId: calendarSummary.calendarId,
    },
    summary: calendarSummary.summary,
    accessRole: calendarSummary.accessRole,
    visibility: "details",
    status: "fresh",
    syncedAt: "2026-08-22T08:00:00.000Z",
    error: null,
    ...overrides,
  };
}

function snapshot(): LifeOpsConnectionsSnapshot {
  const google = calendar("google");
  const apple = calendar("apple_calendar");
  return {
    googleAccounts: [googleStatus()],
    calendars: [google, apple],
    calendarFeed: {
      calendarId: "all",
      events: [],
      source: "cache",
      state: "partial",
      sources: [
        source(google, {
          status: "stale",
          error: {
            code: "RATE_LIMITED",
            message: "Google Calendar retry is pending.",
            retryable: true,
          },
          changeDelivery: {
            mode: "polling",
            status: "degraded",
            expiresAt: null,
            lastNotificationAt: null,
            lastSuccessfulSyncAt: "2026-08-22T08:00:00.000Z",
            error: null,
          },
        }),
        source(apple),
      ],
      timeMin: "2026-08-15T00:00:00.000Z",
      timeMax: "2026-11-20T00:00:00.000Z",
      syncedAt: "2026-08-22T08:00:00.000Z",
    },
    gmailHealthByGrantId: {
      [GRANT_ID]: {
        provider: "google",
        side: "owner",
        grantId: GRANT_ID,
        connectorAccountId: CONNECTOR_ACCOUNT_ID,
        mailbox: "me",
        state: "current",
        cursorStatus: "incremental",
        historyCursorPresent: true,
        fullResyncReason: null,
        cachedMessageCount: 12,
        syncedAt: "2026-08-22T08:00:00.000Z",
      },
    },
    applePermission: {
      id: "calendar",
      status: "denied",
      lastChecked: Date.parse("2026-08-22T08:00:00.000Z"),
      canRequest: false,
      platform: "darwin",
      reason: "Allow Calendar access in System Settings.",
    },
    observedAt: "2026-08-22T08:00:00.000Z",
  };
}

function adapter(): LifeOpsConnectionsAdapter {
  return {
    load: vi.fn(async () => snapshot()),
    connectGoogle: vi.fn(async () => undefined),
    disconnectGoogle: vi.fn(async () => undefined),
    setCalendarIncluded: vi.fn(async (item, includeInFeed) => ({
      ...item,
      includeInFeed,
      selectionVersion: item.selectionVersion + 1,
    })),
    seed: vi.fn(async (request, onProgress) => {
      onProgress("preparing");
      onProgress("gmail");
      onProgress("calendar");
      onProgress("deduplicating");
      onProgress("complete");
      return {
        grantId: request.grantId,
        rangeDays: request.rangeDays,
        gmailMessageCount: 12,
        calendarEventCount: 8,
        calendarSourceCount: request.calendarKeys.length,
        duplicateEventCount: 1,
        completedAt: "2026-08-22T09:00:00.000Z",
      };
    }),
    purgeImportedData: vi.fn(async ({ grantId, includeGmail, calendars }) => ({
      gmail: includeGmail
        ? {
            provider: "google",
            side: "owner",
            grantId,
            connectorAccountId: CONNECTOR_ACCOUNT_ID,
            deletedMessageCount: 12,
            deletedSpamReviewCount: 1,
            deletedSyncCursor: true,
            providerMutation: false,
            purgedAt: "2026-08-22T09:00:00.000Z",
          }
        : null,
      calendars: calendars.map((item) => ({
        provider: item.provider as "google" | "apple_calendar",
        side: item.side,
        grantId: item.grantId,
        connectorAccountId: item.connectorAccountId,
        deletedEventCount: 4,
        deletedSyncStateCount: 1,
        providerMutation: false,
        purgedAt: "2026-08-22T09:00:00.000Z",
      })),
    })),
    requestApplePermission: vi.fn(async () => ({
      id: "calendar",
      status: "granted",
      lastChecked: Date.now(),
      canRequest: false,
      platform: "darwin",
    })),
    openApplePermissionSettings: vi.fn(async () => undefined),
    navigate: vi.fn(),
  };
}

describe("LifeOpsConnectionsView", () => {
  afterEach(cleanup);

  it("explains scopes and renders partial, permission, provenance, and cursor states", async () => {
    const localAdapter = adapter();
    render(<LifeOpsConnectionsView adapter={localAdapter} />);

    expect(await screen.findByText("owner@example.test")).toBeTruthy();
    expect(screen.getByText(/Some calendar sources failed/)).toBeTruthy();
    expect(screen.getByText(/History cursor: incremental/)).toBeTruthy();
    expect(screen.getByText(/retry is pending/)).toBeTruthy();
    expect(screen.getByText("Permission denied")).toBeTruthy();
    expect(
      screen.getByText(/Title and time alone are never used/),
    ).toBeTruthy();

    expect(
      (
        screen.getByRole("checkbox", {
          name: /Read and search Gmail/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (
        screen.getByRole("checkbox", {
          name: /Send approved email/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Open System Settings" }),
    );
    expect(localAdapter.openApplePermissionSettings).toHaveBeenCalledOnce();
  });

  it("seeds a bounded cross-provider selection and shows real phase counts", async () => {
    const localAdapter = adapter();
    render(<LifeOpsConnectionsView adapter={localAdapter} />);
    await screen.findByText("owner@example.test");

    fireEvent.click(screen.getByRole("radio", { name: "7 days" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Seed selected context" }),
    );

    await waitFor(() => expect(localAdapter.seed).toHaveBeenCalledOnce());
    expect(localAdapter.seed).toHaveBeenCalledWith(
      expect.objectContaining({
        grantId: GRANT_ID,
        rangeDays: 7,
        includeGmail: true,
        calendarKeys: expect.arrayContaining([
          expect.stringContaining("google"),
          expect.stringContaining("apple_calendar"),
        ]),
      }),
      expect.any(Function),
    );
    expect((await screen.findByTestId("seed-receipt")).textContent).toContain(
      "12 Gmail messages and 8 calendar events from 2 sources. 1 duplicate deliveries ignored.",
    );
  });

  it("keeps disconnect and local purge separate and confirms exact identity", async () => {
    const localAdapter = adapter();
    render(<LifeOpsConnectionsView adapter={localAdapter} />);
    await screen.findByText("owner@example.test");

    fireEvent.click(
      screen.getByRole("button", { name: /Purge imported Google data/ }),
    );
    expect(localAdapter.purgeImportedData).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm purge" }));

    await waitFor(() =>
      expect(localAdapter.purgeImportedData).toHaveBeenCalledWith(
        expect.objectContaining({
          grantId: GRANT_ID,
          connectorAccountId: CONNECTOR_ACCOUNT_ID,
          includeGmail: true,
        }),
      ),
    );
    expect((await screen.findByTestId("purge-receipt")).textContent).toContain(
      "Providers were not changed",
    );
    expect(localAdapter.disconnectGoogle).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: /Disconnect Google account/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));
    await waitFor(() =>
      expect(localAdapter.disconnectGoogle).toHaveBeenCalledWith(GRANT_ID),
    );
  });
});
