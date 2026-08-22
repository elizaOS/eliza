/** Production adapter for LifeOps connection management over canonical local APIs. */

import type { CalendarClientMethods } from "@elizaos/plugin-calendar/api/client-calendar";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarSummary,
  LifeOpsGoogleCapability,
  LifeOpsGoogleConnectorStatus,
} from "@elizaos/shared";
import { client } from "@elizaos/ui/api";
import { navigateBrowserPath } from "@elizaos/ui/app-navigate-view";
import type { LifeOpsElizaClientMethods } from "../../api/client-lifeops.js";
import type {
  LifeOpsConnectionsAdapter,
  LifeOpsConnectionsSnapshot,
  LifeOpsSeedReceipt,
} from "./types.js";

// Renderer boot imports this plugin's register entry before the page can be
// selected. That entry installs the LifeOps and Calendar client extensions;
// keeping this remote view type-only avoids bundling a host-private API path.
const lifeOpsClient = client as typeof client &
  LifeOpsElizaClientMethods &
  CalendarClientMethods;

function connectedGoogleAccounts(
  accounts: readonly LifeOpsGoogleConnectorStatus[],
): LifeOpsGoogleConnectorStatus[] {
  return accounts.filter(
    (account) => account.connected && account.grant !== null,
  );
}

function calendarIdentity(calendar: LifeOpsCalendarSummary): string {
  return JSON.stringify([
    calendar.provider,
    calendar.side,
    calendar.grantId,
    calendar.connectorAccountId,
    calendar.calendarId,
  ]);
}

function eventIdentity(event: LifeOpsCalendarEvent): string {
  return JSON.stringify([
    event.provider,
    event.side,
    event.grantId ?? "",
    event.connectorAccountId ?? "",
    event.calendarId,
    event.externalId,
    event.recurringEventId ?? "",
    event.startAt,
  ]);
}

async function loadSnapshot(
  forceSync = false,
): Promise<LifeOpsConnectionsSnapshot> {
  const [{ accounts }, calendarsResponse, applePermission] = await Promise.all([
    lifeOpsClient.getLifeOpsGoogleConnectorAccounts({ side: "owner" }),
    lifeOpsClient.getLifeOpsCalendars({ side: "owner" }),
    lifeOpsClient.getPermission("calendar"),
  ]);
  const now = new Date();
  const timeMin = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const timeMax = new Date(now.getTime() + 90 * 86_400_000).toISOString();
  const calendarFeed = await lifeOpsClient.getLifeOpsCalendarFeed({
    side: "owner",
    timeMin,
    timeMax,
    forceSync,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const gmailHealthEntries = await Promise.all(
    connectedGoogleAccounts(accounts)
      .filter((account) =>
        account.grantedCapabilities.includes("google.gmail.triage"),
      )
      .map(async (account) => {
        const grantId = account.grant?.id;
        if (!grantId) {
          throw new Error("Connected Google account is missing its grant id.");
        }
        return [
          grantId,
          await lifeOpsClient.getLifeOpsGmailSyncHealth({
            grantId,
            side: "owner",
            mode: "local",
          }),
        ] as const;
      }),
  );
  return {
    googleAccounts: accounts,
    calendars: calendarsResponse.calendars,
    calendarFeed,
    gmailHealthByGrantId: Object.fromEntries(gmailHealthEntries),
    applePermission,
    observedAt: new Date().toISOString(),
  };
}

export const defaultLifeOpsConnectionsAdapter: LifeOpsConnectionsAdapter = {
  load: ({ forceSync = false } = {}) => loadSnapshot(forceSync),
  async connectGoogle(capabilities: LifeOpsGoogleCapability[]) {
    const result = await lifeOpsClient.startLifeOpsGoogleConnector({
      side: "owner",
      mode: "local",
      createNewGrant: true,
      capabilities,
      redirectUrl: window.location.href,
    });
    if (!result.authUrl) {
      throw new Error("Google OAuth did not return an authorization URL.");
    }
    window.location.assign(result.authUrl);
  },
  async disconnectGoogle(grantId: string) {
    await lifeOpsClient.disconnectLifeOpsGoogleConnector({
      side: "owner",
      mode: "local",
      grantId,
    });
  },
  async setCalendarIncluded(calendar, includeInFeed) {
    const response = await lifeOpsClient.setLifeOpsCalendarIncluded({
      provider: calendar.provider,
      side: calendar.side,
      grantId: calendar.grantId,
      connectorAccountId: calendar.connectorAccountId,
      calendarId: calendar.calendarId,
      includeInFeed,
      expectedVersion: calendar.selectionVersion,
    });
    return response.calendar;
  },
  async seed(request, onProgress): Promise<LifeOpsSeedReceipt> {
    onProgress("preparing");
    let gmailMessageCount = 0;
    if (request.includeGmail) {
      onProgress("gmail");
      const gmail = await lifeOpsClient.getLifeOpsGmailSearch({
        side: "owner",
        mode: "local",
        grantId: request.grantId,
        query: `newer_than:${request.rangeDays}d`,
        maxResults: 100,
        forceSync: true,
      });
      gmailMessageCount = gmail.messages.length;
    }
    onProgress("calendar");
    const now = new Date();
    const calendar = await lifeOpsClient.getLifeOpsCalendarFeed({
      side: "owner",
      timeMin: new Date(
        now.getTime() - request.rangeDays * 86_400_000,
      ).toISOString(),
      timeMax: new Date(now.getTime() + 90 * 86_400_000).toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      forceSync: true,
    });
    onProgress("deduplicating");
    const selected = new Set(request.calendarKeys);
    const selectedEvents = calendar.events.filter((event) =>
      selected.has(
        JSON.stringify([
          event.provider,
          event.side,
          event.grantId ?? "",
          event.connectorAccountId ?? "",
          event.calendarId,
        ]),
      ),
    );
    const uniqueEvents = new Set(selectedEvents.map(eventIdentity));
    onProgress("complete");
    return {
      grantId: request.grantId,
      rangeDays: request.rangeDays,
      gmailMessageCount,
      calendarEventCount: uniqueEvents.size,
      calendarSourceCount: selected.size,
      duplicateEventCount: selectedEvents.length - uniqueEvents.size,
      completedAt: new Date().toISOString(),
    };
  },
  async purgeImportedData({
    grantId,
    connectorAccountId,
    includeGmail,
    calendars,
  }) {
    if (includeGmail && !connectorAccountId) {
      throw new Error(
        "This legacy Google connection has no stable account identity. Reconnect it before purging imported Gmail data.",
      );
    }
    const gmail = includeGmail
      ? await lifeOpsClient.purgeLifeOpsGmailImportedData({
          side: "owner",
          grantId,
          connectorAccountId: connectorAccountId as string,
          confirmAction: true,
        })
      : null;
    const calendarReceipts = [];
    for (const calendar of calendars) {
      if (
        calendar.provider !== "google" &&
        calendar.provider !== "apple_calendar"
      ) {
        continue;
      }
      calendarReceipts.push(
        await lifeOpsClient.purgeLifeOpsCalendarImportedData({
          provider: calendar.provider,
          side: calendar.side,
          grantId: calendar.grantId,
          connectorAccountId: calendar.connectorAccountId,
          confirmAction: true,
        }),
      );
    }
    return { gmail, calendars: calendarReceipts };
  },
  requestApplePermission: () => lifeOpsClient.requestPermission("calendar"),
  openApplePermissionSettings: () =>
    lifeOpsClient.openPermissionSettings("calendar"),
  navigate(path) {
    navigateBrowserPath(path);
  },
};

export { calendarIdentity };
