/**
 * No-provider browser fixture for the real LifeOps connection-manager view.
 * Session storage models disconnect/reconnect while all provider-facing work
 * stays inside this deterministic adapter.
 */

import type {
  LifeOpsCalendarSourceHealth,
  LifeOpsCalendarSummary,
  LifeOpsConnectorGrant,
  LifeOpsGoogleConnectorStatus,
} from "@elizaos/shared";
import { createRoot } from "react-dom/client";
import { LifeOpsConnectionsView } from "../../src/components/lifeops-connections/LifeOpsConnectionsView.js";
import type {
  LifeOpsConnectionsAdapter,
  LifeOpsConnectionsSnapshot,
} from "../../src/components/lifeops-connections/types.js";

const GRANT_ID = "connector-account:fixture-account";
const ACCOUNT_ID = "fixture-account";
let healthRecovered = false;

function isConnected(): boolean {
  return sessionStorage.getItem("lifeops-fixture-connected") !== "false";
}

function grant(): LifeOpsConnectorGrant {
  return {
    id: GRANT_ID,
    agentId: "fixture-agent",
    provider: "google",
    connectorAccountId: ACCOUNT_ID,
    side: "owner",
    identity: { email: "fixture-owner@example.test" },
    identityEmail: "fixture-owner@example.test",
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
    tokenRef: "protected:fixture-reference",
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

function googleStatus(connected: boolean): LifeOpsGoogleConnectorStatus {
  return {
    provider: "google",
    side: "owner",
    mode: "local",
    defaultMode: "local",
    availableModes: ["local"],
    executionTarget: "local",
    sourceOfTruth: "local_storage",
    configured: true,
    connected,
    reason: connected ? "connected" : "disconnected",
    preferredByAgent: connected,
    cloudConnectionId: null,
    identity: connected ? { email: "fixture-owner@example.test" } : null,
    grantedCapabilities: connected
      ? ["google.gmail.triage", "google.gmail.compose", "google.calendar.read"]
      : [],
    grantedScopes: connected ? grant().grantedScopes : [],
    expiresAt: connected ? "2026-08-22T10:00:00.000Z" : null,
    hasRefreshToken: connected,
    grant: connected ? grant() : null,
  };
}

function calendar(provider: "google" | "apple_calendar") {
  const google = provider === "google";
  return {
    provider,
    side: "owner",
    grantId: google ? GRANT_ID : "apple-calendar",
    connectorAccountId: google ? ACCOUNT_ID : "apple-calendar",
    accountEmail: google ? "fixture-owner@example.test" : null,
    calendarId: google ? "primary" : "fixture-apple",
    summary: google ? "Work" : "Personal",
    description: null,
    primary: true,
    accessRole: "writer",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: "America/Los_Angeles",
    selected: true,
    includeInFeed: true,
    selectionVersion: 1,
  } satisfies LifeOpsCalendarSummary;
}

function source(item: LifeOpsCalendarSummary): LifeOpsCalendarSourceHealth {
  const degraded = item.provider === "google" && !healthRecovered;
  return {
    key: {
      provider: item.provider,
      side: item.side,
      grantId: item.grantId,
      connectorAccountId: item.connectorAccountId,
      calendarId: item.calendarId,
    },
    summary: item.summary,
    accessRole: item.accessRole,
    visibility: "details",
    status: degraded ? "stale" : "fresh",
    syncedAt: "2026-08-22T08:00:00.000Z",
    error: degraded
      ? {
          code: "FIXTURE_RATE_LIMIT",
          message: "Fixture quota retry is pending.",
          retryable: true,
        }
      : null,
    changeDelivery:
      item.provider === "google"
        ? {
            mode: "polling",
            status: degraded ? "degraded" : "active",
            expiresAt: null,
            lastNotificationAt: null,
            lastSuccessfulSyncAt: "2026-08-22T08:00:00.000Z",
            error: null,
          }
        : undefined,
  };
}

function snapshot(): LifeOpsConnectionsSnapshot {
  const connected = isConnected();
  const calendars = [calendar("google"), calendar("apple_calendar")];
  const visibleCalendars = connected
    ? calendars
    : calendars.filter((item) => item.provider === "apple_calendar");
  return {
    googleAccounts: [googleStatus(connected)],
    calendars: visibleCalendars,
    calendarFeed: {
      calendarId: "all",
      events: [],
      source: "cache",
      state: healthRecovered ? "complete" : "partial",
      sources: visibleCalendars.map(source),
      timeMin: "2026-07-23T00:00:00.000Z",
      timeMax: "2026-11-20T00:00:00.000Z",
      syncedAt: "2026-08-22T08:00:00.000Z",
    },
    gmailHealthByGrantId: connected
      ? {
          [GRANT_ID]: {
            provider: "google",
            side: "owner",
            grantId: GRANT_ID,
            connectorAccountId: ACCOUNT_ID,
            mailbox: "me",
            state: "current",
            cursorStatus: "incremental",
            historyCursorPresent: true,
            fullResyncReason: null,
            cachedMessageCount: 6,
            syncedAt: "2026-08-22T08:00:00.000Z",
          },
        }
      : {},
    applePermission: {
      id: "calendar",
      status: "denied",
      lastChecked: Date.parse("2026-08-22T08:00:00.000Z"),
      canRequest: false,
      platform: "darwin",
      reason: "Fixture denial: recover in System Settings.",
    },
    observedAt: new Date().toISOString(),
  };
}

const adapter: LifeOpsConnectionsAdapter = {
  async load({ forceSync = false } = {}) {
    if (forceSync) healthRecovered = true;
    return snapshot();
  },
  async connectGoogle() {
    sessionStorage.setItem("lifeops-fixture-connected", "true");
    window.location.reload();
  },
  async disconnectGoogle() {
    sessionStorage.setItem("lifeops-fixture-connected", "false");
  },
  async setCalendarIncluded(item, includeInFeed) {
    return {
      ...item,
      includeInFeed,
      selectionVersion: item.selectionVersion + 1,
    };
  },
  async seed(request, onProgress) {
    for (const phase of [
      "preparing",
      "gmail",
      "calendar",
      "deduplicating",
      "complete",
    ] as const) {
      onProgress(phase);
    }
    return {
      grantId: request.grantId,
      rangeDays: request.rangeDays,
      gmailMessageCount: 6,
      calendarEventCount: 5,
      calendarSourceCount: request.calendarKeys.length,
      duplicateEventCount: 1,
      completedAt: new Date().toISOString(),
    };
  },
  async purgeImportedData({ grantId, includeGmail, calendars }) {
    return {
      gmail: includeGmail
        ? {
            provider: "google",
            side: "owner",
            grantId,
            connectorAccountId: ACCOUNT_ID,
            deletedMessageCount: 6,
            deletedSpamReviewCount: 1,
            deletedSyncCursor: true,
            providerMutation: false,
            purgedAt: new Date().toISOString(),
          }
        : null,
      calendars: calendars.map((item) => ({
        provider: item.provider as "google" | "apple_calendar",
        side: item.side,
        grantId: item.grantId,
        connectorAccountId: item.connectorAccountId,
        deletedEventCount: 3,
        deletedSyncStateCount: 1,
        providerMutation: false,
        purgedAt: new Date().toISOString(),
      })),
    };
  },
  async requestApplePermission() {
    return snapshot().applePermission;
  },
  async openApplePermissionSettings() {
    document.documentElement.dataset.permissionSettingsOpened = "true";
  },
  navigate(path) {
    document.documentElement.dataset.lastNavigation = path;
  },
};

const root = document.getElementById("root");
if (!root) throw new Error("LifeOps fixture requires #root.");
createRoot(root).render(<LifeOpsConnectionsView adapter={adapter} />);
