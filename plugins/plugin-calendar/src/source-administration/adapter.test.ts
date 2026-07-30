/**
 * Exact source-administration tests compose fake provider discovery with real
 * PGlite preference rows, so identity and CAS assertions exercise durable
 * state while external calendar transports stay outside this adapter suite.
 */

import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsCalendarFeed,
  LifeOpsCalendarSourceHealth,
  LifeOpsCalendarSummary,
  SetLifeOpsCalendarIncludedRequest,
} from "@elizaos/shared";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarService } from "../service/CalendarService.js";
import {
  getCalendarFeedPreference,
  setCalendarFeedIncluded,
} from "../service/feed-preferences.js";
import {
  ensureCalendarFeedPreferenceTable,
  ensureIcsCalendarSourceTable,
  type SqlExecutor,
} from "../service/migration.js";
import {
  listCalendarSourceAdministration,
  setCalendarSourceSelection,
} from "./adapter.js";

const AGENT_ID = "calendar-source-administration-agent";
const openDatabases: PGlite[] = [];

function summary(args: {
  accountId: string;
  grantId?: string;
  provider?: "google" | "ics";
  includeInFeed?: boolean;
}): LifeOpsCalendarSummary {
  const provider = args.provider ?? "google";
  const grantId = args.grantId ?? `connector-account:${args.accountId}`;
  return {
    provider,
    side: "owner",
    grantId,
    connectorAccountId: args.accountId,
    accountEmail:
      provider === "google" ? `${args.accountId}@example.test` : null,
    calendarId: provider === "ics" ? grantId : "primary",
    summary: provider === "ics" ? "Family subscription" : "Primary",
    description: null,
    primary: provider === "google",
    accessRole: provider === "ics" ? "reader" : "owner",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: "UTC",
    selected: true,
    includeInFeed: args.includeInFeed ?? true,
    selectionVersion: 0,
  };
}

function health(
  calendar: LifeOpsCalendarSummary,
  status: LifeOpsCalendarSourceHealth["status"] = "fresh",
): LifeOpsCalendarSourceHealth {
  return {
    key: {
      provider: calendar.provider,
      side: calendar.side,
      grantId: calendar.grantId,
      connectorAccountId: calendar.connectorAccountId,
      calendarId: calendar.calendarId,
    },
    summary: calendar.summary,
    accessRole: calendar.accessRole,
    visibility: "details",
    status,
    syncedAt: status === "fresh" ? "2026-07-27T12:00:00.000Z" : null,
    error:
      status === "fresh"
        ? null
        : {
            code: "SOURCE_DOWN",
            message: "Provider unavailable",
            retryable: true,
          },
  };
}

function feed(sources: LifeOpsCalendarSourceHealth[]): LifeOpsCalendarFeed {
  return {
    calendarId: "all",
    events: [],
    source: "cache",
    state: sources.every((source) => source.status === "fresh")
      ? "complete"
      : "partial",
    sources,
    timeMin: "2026-07-27T00:00:00.000Z",
    timeMax: "2026-07-28T00:00:00.000Z",
    syncedAt: "2026-07-27T12:00:00.000Z",
  };
}

async function fixture(calendars: LifeOpsCalendarSummary[]) {
  const pg = new PGlite();
  openDatabases.push(pg);
  await pg.exec("CREATE SCHEMA app_calendar");
  const execute: SqlExecutor = async (statement) =>
    (await pg.query<Record<string, unknown>>(statement)).rows;
  await ensureCalendarFeedPreferenceTable(execute);
  await ensureIcsCalendarSourceTable(execute);
  for (const calendar of calendars.filter(
    (candidate) => candidate.provider === "ics",
  )) {
    await pg.query(
      `INSERT INTO app_calendar.life_calendar_sources (
         id, agent_id, provider, side, name, enabled, secret_ref,
         url_fingerprint, origin, created_at, updated_at
       ) VALUES (
         $1, $2, 'ics', 'owner', $3, $4, $5, $6, $7, $8, $8
       )`,
      [
        calendar.grantId,
        AGENT_ID,
        calendar.summary,
        calendar.includeInFeed,
        `secret:${calendar.grantId}`,
        `fingerprint:${calendar.grantId}`,
        "https://calendar.example.test",
        "2026-07-27T00:00:00.000Z",
      ],
    );
  }
  let runtime: IAgentRuntime;
  const service = {
    getCalendarFeed: vi.fn(async () =>
      feed(calendars.map((calendar) => health(calendar))),
    ),
    listCalendars: vi.fn(async () => calendars),
    setCalendarIncluded: vi.fn(
      async (_url: URL, request: SetLifeOpsCalendarIncludedRequest) => {
        const calendar = calendars.find(
          (candidate) =>
            candidate.provider === request.provider &&
            candidate.side === request.side &&
            candidate.grantId === request.grantId &&
            candidate.connectorAccountId === request.connectorAccountId &&
            candidate.calendarId === request.calendarId,
        );
        if (!calendar) throw new Error("fixture calendar missing");
        const receipt = await setCalendarFeedIncluded(
          runtime,
          {
            provider: calendar.provider,
            side: calendar.side,
            grantId: calendar.grantId,
            connectorAccountId: calendar.connectorAccountId,
            calendarId: calendar.calendarId,
            initialIncluded: calendar.includeInFeed,
          },
          request.includeInFeed,
          request.expectedVersion,
        );
        return {
          calendar: {
            ...calendar,
            includeInFeed: receipt.included,
            selectionVersion: receipt.currentVersion,
          },
          previousVersion: receipt.previousVersion,
          currentVersion: receipt.currentVersion,
          changed: receipt.changed,
          acceptedAt: receipt.updatedAt,
        };
      },
    ),
  };
  runtime = {
    agentId: AGENT_ID,
    adapter: { db: drizzle(pg) },
    getService: (serviceType: string) =>
      serviceType === CalendarService.serviceType ? service : null,
    getCache: async () => undefined,
  } as unknown as IAgentRuntime;
  return { runtime, service, pg };
}

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map((pg) => pg.close()));
});

describe("calendar source administration adapter", { timeout: 30_000 }, () => {
  it("keeps same-named primary calendars distinct by exact account and grant", async () => {
    const accountA = summary({ accountId: "account-a" });
    const accountB = summary({ accountId: "account-b" });
    const { runtime } = await fixture([accountA, accountB]);

    const snapshot = await listCalendarSourceAdministration(runtime);

    expect(snapshot.state).toBe("complete");
    expect(
      snapshot.sources.map((source) => ({
        grantId: source.key.grantId,
        accountId: source.key.connectorAccountId,
        version: source.selectionVersion,
      })),
    ).toEqual([
      {
        grantId: "connector-account:account-a",
        accountId: "account-a",
        version: 0,
      },
      {
        grantId: "connector-account:account-b",
        accountId: "account-b",
        version: 0,
      },
    ]);
  });

  it("preserves a disconnected health-only identity as unselectable", async () => {
    const connected = summary({ accountId: "account-a" });
    const disconnected = summary({ accountId: "account-b" });
    const { runtime, service } = await fixture([connected]);
    service.getCalendarFeed.mockResolvedValue(
      feed([health(connected), health(disconnected, "disconnected")]),
    );

    const snapshot = await listCalendarSourceAdministration(runtime);
    expect(
      snapshot.sources.find(
        (source) => source.key.connectorAccountId === "account-b",
      ),
    ).toMatchObject({
      includeInFeed: null,
      selectionVersion: null,
      health: { status: "disconnected" },
    });
  });

  it("updates only the exact listed identity and returns a revision receipt", async () => {
    const accountA = summary({ accountId: "account-a" });
    const accountB = summary({ accountId: "account-b" });
    const { runtime } = await fixture([accountA, accountB]);

    const receipt = await setCalendarSourceSelection(runtime, {
      key: {
        provider: "google",
        side: "owner",
        grantId: accountB.grantId,
        connectorAccountId: accountB.connectorAccountId,
        calendarId: accountB.calendarId,
      },
      includeInFeed: false,
      expectedVersion: 0,
    });

    expect(receipt).toMatchObject({
      previousVersion: 0,
      currentVersion: 1,
      changed: true,
      source: {
        key: { connectorAccountId: "account-b" },
        includeInFeed: false,
        selectionVersion: 1,
      },
    });
    await expect(
      getCalendarFeedPreference(runtime, accountA),
    ).resolves.toMatchObject({ included: true, version: 0 });
  });

  it("commits ICS provider enablement and selection version atomically", async () => {
    const calendar = summary({
      accountId: "ics-source",
      grantId: "ics-source",
      provider: "ics",
    });
    const { runtime, pg } = await fixture([calendar]);

    await setCalendarSourceSelection(runtime, {
      key: {
        provider: "ics",
        side: "owner",
        grantId: "ics-source",
        connectorAccountId: "ics-source",
        calendarId: "ics-source",
      },
      includeInFeed: false,
      expectedVersion: 0,
    });

    const provider = await pg.query<{ enabled: boolean }>(
      "SELECT enabled FROM app_calendar.life_calendar_sources WHERE id = 'ics-source'",
    );
    expect(provider.rows).toEqual([{ enabled: false }]);
    await expect(
      getCalendarFeedPreference(runtime, calendar),
    ).resolves.toMatchObject({ included: false, version: 1 });
  });

  it("propagates an explicit atomic failure without manufacturing a receipt", async () => {
    const calendar = summary({ accountId: "account-a" });
    const { runtime, service } = await fixture([calendar]);
    service.setCalendarIncluded.mockRejectedValue(
      new Error("forced persistence failure"),
    );

    await expect(
      setCalendarSourceSelection(runtime, {
        key: {
          provider: "google",
          side: "owner",
          grantId: calendar.grantId,
          connectorAccountId: calendar.connectorAccountId,
          calendarId: calendar.calendarId,
        },
        includeInFeed: false,
        expectedVersion: 0,
      }),
    ).rejects.toThrow("forced persistence failure");
  });

  it("rejects an identity whose account field was altered after listing", async () => {
    const calendar = summary({ accountId: "account-a" });
    const { runtime } = await fixture([calendar]);

    await expect(
      setCalendarSourceSelection(runtime, {
        key: {
          provider: "google",
          side: "owner",
          grantId: calendar.grantId,
          connectorAccountId: "different-account",
          calendarId: calendar.calendarId,
        },
        includeInFeed: false,
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({
      code: "CALENDAR_SOURCE_NOT_FOUND",
      status: 404,
    });
  });
});
