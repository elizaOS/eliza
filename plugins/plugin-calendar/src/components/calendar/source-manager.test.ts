/**
 * Verifies calendar discovery and feed-health joins preserve full account
 * identity while emitting privacy-safe, deterministic action handles.
 */

import type {
  LifeOpsCalendarSourceHealth,
  LifeOpsCalendarSummary,
} from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  calendarSourceIdentityKey,
  toCalendarSourceManagerModel,
} from "./source-manager.js";

function calendar(
  over: Partial<LifeOpsCalendarSummary> = {},
): LifeOpsCalendarSummary {
  return {
    provider: "google",
    side: "owner",
    grantId: "grant-one",
    connectorAccountId: "account-one",
    accountEmail: "one@example.com",
    calendarId: "shared-id",
    summary: "Work",
    description: null,
    primary: true,
    accessRole: "owner",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: "UTC",
    selected: true,
    includeInFeed: true,
    selectionVersion: 0,
    ...over,
  };
}

function health(
  calendarSummary: LifeOpsCalendarSummary,
  over: Partial<LifeOpsCalendarSourceHealth> = {},
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
    syncedAt: "2026-07-26T12:00:00.000Z",
    error: null,
    ...over,
  };
}

describe("calendar source manager model", () => {
  it("keeps identical provider calendar IDs separate across connector accounts", () => {
    const first = calendar();
    const second = calendar({
      grantId: "grant-two",
      connectorAccountId: "account-two",
      accountEmail: "two@example.com",
      summary: "Family",
      primary: false,
      includeInFeed: false,
    });
    const model = toCalendarSourceManagerModel(
      [first, second],
      [health(first), health(second)],
      new Date("2026-07-26T12:01:00.000Z"),
    );

    expect(model.rows).toHaveLength(2);
    expect(model.rows.map((row) => row.accountLabel)).toEqual([
      "one@example.com",
      "two@example.com",
    ]);
    expect(model.rows.map((row) => row.included)).toEqual([true, false]);
    expect(new Set(model.rows.map((row) => row.actionId)).size).toBe(2);
    for (const row of model.rows) {
      expect(row.actionId).not.toContain("grant-");
      expect(row.actionId).not.toContain("account-");
      expect(row.actionId).not.toContain("shared-id");
    }
  });

  it("retains failed health-only sources without offering an inclusion write", () => {
    const disconnected: LifeOpsCalendarSourceHealth = {
      key: {
        provider: "google",
        side: "owner",
        grantId: "grant-retired",
        connectorAccountId: "account-retired",
        calendarId: "travel",
      },
      summary: "Travel",
      accessRole: "reader",
      visibility: "busy_only",
      status: "disconnected",
      syncedAt: null,
      error: {
        code: "OAUTH_REVOKED",
        message: "Sensitive provider detail",
        retryable: true,
      },
    };
    const model = toCalendarSourceManagerModel([], [disconnected]);

    expect(model.rows).toEqual([
      expect.objectContaining({
        providerLabel: "Google Calendar",
        accountLabel: "Account details unavailable",
        calendarLabel: "Travel",
        accessLabel: "Can read details",
        visibilityLabel: "Busy only",
        statusLabel: "Disconnected",
        freshnessLabel: "Sync unavailable",
        included: null,
        toggleAvailable: false,
        reconnectConnectorId: "google",
      }),
    ]);
    expect(JSON.stringify(model.rows)).not.toContain(
      "Sensitive provider detail",
    );
  });

  it("labels opted-out calendars honestly when no feed-health row exists", () => {
    const excluded = calendar({ includeInFeed: false });
    const model = toCalendarSourceManagerModel([excluded], []);

    expect(model.rows[0]).toEqual(
      expect.objectContaining({
        included: false,
        statusLabel: "Not in current feed",
        freshnessLabel: "Excluded from combined calendar",
        visibilityLabel: "Visibility not reported",
      }),
    );
    expect(model.calendarsByActionId.get(model.rows[0].actionId)).toEqual(
      excluded,
    );
    expect(calendarSourceIdentityKey(excluded)).toContain("grant-one");
  });

  it("presents the built-in calendar as local instead of a connector account", () => {
    const builtIn = calendar({
      provider: "eliza",
      grantId: "eliza-calendar",
      connectorAccountId: "eliza-calendar",
      accountEmail: null,
      calendarId: "primary",
      summary: "My calendar",
    });
    const model = toCalendarSourceManagerModel(
      [builtIn],
      [health(builtIn, { syncedAt: null })],
    );

    expect(model.rows).toEqual([
      expect.objectContaining({
        providerLabel: "Eliza Calendar",
        accountLabel: "Built in",
        calendarLabel: "My calendar",
        statusLabel: "Current",
        freshnessLabel: "stored locally",
        included: true,
        toggleAvailable: true,
        reconnectConnectorId: null,
        reconnectUnavailable: false,
      }),
    ]);
  });
});
