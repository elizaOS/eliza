/** Exercises missing collectors, failed generation, and report persistence against real PGlite. No provider request is made. */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { LIFEOPS_INBOX_CHANNELS, type LifeOpsInbox } from "@elizaos/contracts";
import type { IAgentRuntime } from "@elizaos/core";
import { buildFallbackDefaultPack } from "@elizaos/plugin-scheduling";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOwnerFactStore } from "../owner/fact-store.js";
import { composeOwnerFacingScheduledTaskText } from "../scheduled-task/runtime-wiring.js";
import { LifeOpsService } from "../service.js";
import type { RawSqlQuery } from "../sql.js";
import {
  buildCheckinSummaryPrompt,
  CheckinService,
  renderMorningCheckinReport,
} from "./checkin-service.js";
import type { CheckinReport } from "./types.js";

describe("check-in source availability and generation failures", () => {
  let db: PGlite;
  let runtime: IAgentRuntime;
  const prompts: string[] = [];
  const statements: string[] = [];
  let modelResponse: string | undefined;
  beforeEach(async () => {
    prompts.length = 0;
    statements.length = 0;
    modelResponse = "Model-generated fixture summary.";
    db = await PGlite.create();
    await db.exec(`CREATE SCHEMA app_lifeops;
      CREATE TABLE fixture_cache (key text PRIMARY KEY, payload jsonb);
      CREATE TABLE app_lifeops.life_checkin_reports (
        id text PRIMARY KEY, agent_id text, kind text, generated_at text,
        generated_at_ms bigint, escalation_level text, payload_json jsonb,
        acknowledged_at text
      );`);
    runtime = {
      agentId: "checkin-availability",
      character: { name: "Brief fixture" },
      getSetting: () => undefined,
      getService: () => null,
      reportError: () => {},
      getCache: async (key: string) =>
        (
          await db.query<{ payload: unknown }>(
            "SELECT payload FROM fixture_cache WHERE key = $1",
            [key],
          )
        ).rows[0]?.payload,
      setCache: async (key: string, value: unknown) => {
        await db.query(
          "INSERT INTO fixture_cache (key, payload) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload",
          [key, JSON.stringify(value)],
        );
        return true;
      },
      adapter: {
        db: {
          execute: (query: RawSqlQuery) => {
            const statement = query.queryChunks
              .map((chunk) => chunk.value ?? "")
              .join("");
            statements.push(statement);
            return db.query(statement);
          },
        },
      },
      useModel: async (_type: string, params: { prompt: string }) => {
        prompts.push(params.prompt);
        if (modelResponse !== undefined) return modelResponse;
        throw new Error("text provider is not configured");
      },
    } as unknown as IAgentRuntime;
  });
  afterEach(async () => {
    await db.close();
    vi.unstubAllEnvs();
  });

  it("includes the current managed Gmail mailbox through the canonical Inbox service", async () => {
    const token = "a".repeat(64);
    const server = createServer((request, response) => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          items: [
            {
              id: `alpha-gmail:${"b".repeat(64)}:one`,
              platform: "gmail",
              channel: "Inbox",
              senderName: "Managed sender",
              snippet: "Existing owner mailbox",
              threadTopic: "Managed morning mail",
              receivedAt: "2026-11-12T12:00:00.000Z",
              unread: true,
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test listener");
    vi.stubEnv(
      "ELIZA_MANAGED_GMAIL_READ_BROKER",
      `http://127.0.0.1:${address.port}/__alpha-owner-gmail`,
    );
    vi.stubEnv("ELIZA_API_TOKEN", token);
    try {
      const service = new LifeOpsService(runtime);
      const report = await new CheckinService(runtime, {
        sources: {
          getGoogleConnectorAccounts: async () => [],
          getInbox: (request) =>
            service.getInbox({ ...request, channels: ["gmail"] }),
        },
      }).runMorningCheckin({
        now: new Date("2026-11-12T12:30:00.000Z"),
        timezone: "America/Los_Angeles",
      });
      expect(renderMorningCheckinReport(report)).toContain(
        "Managed morning mail",
      );
      expect(
        report.briefingSections.find((section) => section.key === "inbox")
          ?.error,
      ).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("includes ordinary Gmail through the Inbox when triage is not available", async () => {
    const inbox: LifeOpsInbox = {
      fetchedAt: "2026-11-10T16:00:00Z",
      sources: [],
      channelCounts: Object.fromEntries(
        LIFEOPS_INBOX_CHANNELS.map((channel) => [
          channel,
          {
            total: channel === "gmail" ? 1 : 0,
            unread: channel === "gmail" ? 1 : 0,
          },
        ]),
      ) as LifeOpsInbox["channelCounts"],
      messages: [
        {
          id: "gmail:proof",
          channel: "gmail",
          sender: {
            id: "sender",
            displayName: "QA sender",
            email: null,
            avatarUrl: null,
          },
          subject: "Connected Inbox proof",
          snippet: "Existing readable Gmail",
          receivedAt: "2026-11-10T15:00:00Z",
          unread: true,
          deepLink: null,
          sourceRef: { channel: "gmail", externalId: "proof" },
        },
      ],
    };
    const getInbox = vi.fn(async () => inbox);
    const report = await new CheckinService(runtime, {
      sources: {
        getGoogleConnectorAccounts: async () => [],
        getInbox,
      },
    }).runMorningCheckin({
      now: new Date("2026-11-10T16:00:00Z"),
      timezone: "America/Los_Angeles",
    });
    expect(getInbox).toHaveBeenCalledWith(
      expect.objectContaining({ channels: expect.arrayContaining(["gmail"]) }),
    );
    expect(renderMorningCheckinReport(report)).toContain(
      "Connected Inbox proof",
    );
    expect(
      renderMorningCheckinReport(report).match(/Connected Inbox proof/g),
    ).toHaveLength(1);
  });

  it.each(["complete", "partial"] as const)(
    "reads a %s canonical Calendar feed without requiring a legacy copy",
    async (state) => {
      const now = new Date("2026-11-10T16:00:00Z");
      const requests: unknown[] = [];
      const report = await new CheckinService(runtime, {
        sources: {
          getCalendarFeed: async (_url, request) => {
            requests.push(request);
            return {
              calendarId: "unified",
              source: "synced",
              state,
              sources: [],
              timeMin: request?.timeMin ?? "",
              timeMax: request?.timeMax ?? "",
              syncedAt: now.toISOString(),
              events: [
                {
                  id: "connected-event",
                  calendarId: "primary",
                  provider: "google",
                  side: "owner",
                  title: "Connected meeting",
                  description: null,
                  location: null,
                  status: "confirmed",
                  startAt: "2026-11-10T19:00:00Z",
                  endAt: "2026-11-10T19:30:00Z",
                  isAllDay: false,
                  timezone: "America/New_York",
                  htmlLink: null,
                  conferenceLink: null,
                  organizer: null,
                  attendees: [],
                  metadata: {},
                  syncedAt: now.toISOString(),
                  updatedAt: now.toISOString(),
                },
              ],
            };
          },
        },
      }).runMorningCheckin({ now, timezone: "America/Los_Angeles" });
      expect(requests).toEqual([
        expect.objectContaining({
          side: "owner",
          timeZone: "America/Los_Angeles",
          timeMin: "2026-11-10T08:00:00.000Z",
          timeMax: "2026-11-11T08:00:00.000Z",
        }),
      ]);
      expect(report.todaysMeetings[0]?.id).toBe("connected-event");
      expect(renderMorningCheckinReport(report)).toContain("Connected meeting");
      expect(renderMorningCheckinReport(report)).toContain("11:00 AM");
      expect(renderMorningCheckinReport(report)).toContain("11:30 AM PST");
      expect(renderMorningCheckinReport(report)).not.toContain(
        "No Calendar events",
      );
    },
  );

  it("does not report old Google cache refreshes as recent Calendar changes", async () => {
    await db.exec(`CREATE SCHEMA app_calendar;
      CREATE TABLE app_calendar.life_calendar_events (
        id text, agent_id text, side text, title text,
        start_at text, end_at text, status text, html_link text,
        updated_at text, is_all_day boolean,
        provider text, metadata_json text
      );
      INSERT INTO app_calendar.life_calendar_events VALUES
        ('old', 'checkin-availability', 'owner', 'Old cached event',
         '2026-12-01T18:00:00.000Z', '2026-12-01T19:00:00.000Z', 'confirmed', null,
         '2026-11-12T15:00:00.000Z', false, 'google', '{"createdAt":"2025-01-01T00:00:00.000Z"}'),
        ('unknown', 'checkin-availability', 'owner', 'Unknown provider revision',
         '2026-12-01T18:00:00.000Z', '2026-12-01T19:00:00.000Z', 'confirmed', null,
         '2026-11-12T15:00:00.000Z', false, 'google', '{}'),
        ('changed', 'checkin-availability', 'owner', 'Provider edit',
         '2026-12-01T18:00:00.000Z', '2026-12-01T19:00:00.000Z', 'confirmed', null,
         '2026-11-12T15:00:00.000Z', false, 'google', '{"updatedAt":"2026-11-12T15:00:00.000Z"}'),
        ('local', 'checkin-availability', 'owner', 'Local edit',
         '2026-12-01T18:00:00.000Z', '2026-12-01T19:00:00.000Z', 'confirmed', null,
         '2026-11-12T15:00:00.000Z', false, 'eliza', '{}'),
        ('today', 'checkin-availability', 'owner', 'Today',
         '2026-11-12T18:00:00.000Z', '2026-11-12T19:00:00.000Z', 'confirmed', null,
         '2026-11-12T15:00:00.000Z', false, 'google', '{}');`);
    const before = await db.query(
      "SELECT * FROM app_calendar.life_calendar_events ORDER BY id",
    );
    const report = await new CheckinService(runtime).runMorningCheckin({
      now: new Date("2026-11-12T16:00:00.000Z"),
      timezone: "America/Los_Angeles",
    });
    const section = report.briefingSections.find(
      (item) => item.key === "calendar_changes",
    );
    expect(section?.items.map((item) => item.title).sort()).toEqual([
      "Local edit",
      "Provider edit",
      "Today",
    ]);
    expect(section?.summary).toContain("2 calendar items added or updated");
    expect(
      await db.query(
        "SELECT * FROM app_calendar.life_calendar_events ORDER BY id",
      ),
    ).toEqual(before);
  });

  it("binds Calendar source identity and times before rendering one owner-local agenda entry", async () => {
    await db.exec(`
      CREATE SCHEMA app_calendar;
      CREATE TABLE app_calendar.life_calendar_events (
        id text PRIMARY KEY, agent_id text, side text, title text,
        start_at text, end_at text, status text, html_link text, updated_at text,
        is_all_day boolean NOT NULL DEFAULT false, provider text NOT NULL DEFAULT 'eliza', metadata_json text NOT NULL DEFAULT '{}'
      );
      INSERT INTO app_calendar.life_calendar_events (id, agent_id, side, title, start_at, end_at, status, html_link, updated_at, is_all_day) VALUES (
        'calendar-event', 'checkin-availability', 'owner', 'QA walkthrough',
        '2026-10-06T18:00:00.000Z', '2026-10-06T18:15:00.000Z',
        'confirmed', null, '2026-10-06T14:00:00.000Z', false
      );
    `);
    const report = await new CheckinService(runtime).runMorningCheckin({
      now: new Date("2026-10-06T15:00:32.103Z"),
      timezone: "America/Los_Angeles",
    });
    const item = report.briefingSections.find(
      (section) => section.key === "calendar_changes",
    )?.items[0];
    expect(item?.calendarEvent).toEqual({
      id: "calendar-event",
      startAt: "2026-10-06T18:00:00.000Z",
      endAt: "2026-10-06T18:15:00.000Z",
      status: "confirmed",
      isAllDay: false,
    });
    expect(item?.detail).toBe(
      "2026-10-06T18:00:00.000Z - 2026-10-06T18:15:00.000Z (confirmed)",
    );
    expect(
      renderMorningCheckinReport(report).match(/QA walkthrough/g),
    ).toHaveLength(1);
    expect(renderMorningCheckinReport(report)).toContain(
      "Oct 6, 2026, 11:00 AM – 11:15 AM PDT",
    );
    expect(renderMorningCheckinReport(report)).toContain("11:15 AM PDT");
    expect(renderMorningCheckinReport(report)).toContain("added or updated");
    expect(renderMorningCheckinReport(report)).not.toContain("confirmed");
    expect(prompts).toHaveLength(1);
    const stored = (
      await db.query<{ payload_json: CheckinReport }>(
        "SELECT payload_json FROM app_lifeops.life_checkin_reports WHERE id = $1",
        [report.reportId],
      )
    ).rows[0].payload_json;
    expect(stored.briefingSections).toEqual(report.briefingSections);
  });

  it.each(["UTC", "America/Los_Angeles"])(
    "binds stored all-day classification without rendering midnight as a local hour in %s",
    async (timezone) => {
      await db.exec(`
        CREATE SCHEMA app_calendar;
        CREATE TABLE app_calendar.life_calendar_events (
          id text PRIMARY KEY, agent_id text, side text, title text,
          start_at text, end_at text, status text, html_link text, updated_at text,
          is_all_day boolean NOT NULL DEFAULT false, provider text NOT NULL DEFAULT 'eliza', metadata_json text NOT NULL DEFAULT '{}'
        );
        INSERT INTO app_calendar.life_calendar_events (id, agent_id, side, title, start_at, end_at, status, html_link, updated_at, is_all_day) VALUES (
          'all-day-event', 'checkin-availability', 'owner', 'All-day source',
          '2026-10-06T00:00:00.000Z', '2026-10-07T00:00:00.000Z',
          'confirmed', null, '2026-10-06T14:00:00.000Z', true
        );
      `);
      const before = await db.query(
        "SELECT * FROM app_calendar.life_calendar_events",
      );
      const report = await new CheckinService(runtime).runMorningCheckin({
        now: new Date("2026-10-06T15:00:00.000Z"),
        timezone,
      });
      expect(
        report.briefingSections.find(
          (section) => section.key === "calendar_changes",
        )?.items[0].calendarEvent,
      ).toEqual({
        id: "all-day-event",
        startAt: "2026-10-06T00:00:00.000Z",
        endAt: "2026-10-07T00:00:00.000Z",
        status: "confirmed",
        isAllDay: true,
      });
      expect(report.todaysMeetings[0]?.isAllDay).toBe(true);
      expect(renderMorningCheckinReport(report)).toContain(
        "Calendar today: 1.",
      );
      expect(renderMorningCheckinReport(report)).toContain(
        "1 event on today's calendar",
      );
      expect(
        renderMorningCheckinReport(report).match(/All-day source/g),
      ).toHaveLength(1);
      expect(renderMorningCheckinReport(report)).toContain("all day");
      expect(renderMorningCheckinReport(report)).not.toContain("5:00 PM");
      expect(renderMorningCheckinReport(report)).not.toContain("12:00 AM");
      expect(prompts).toHaveLength(1);
      const stored = (
        await db.query<{ payload_json: CheckinReport }>(
          "SELECT payload_json FROM app_lifeops.life_checkin_reports WHERE id = $1",
          [report.reportId],
        )
      ).rows[0].payload_json;
      expect(stored.briefingSections).toEqual(report.briefingSections);
      expect(
        (await db.query("SELECT * FROM app_calendar.life_calendar_events"))
          .rows,
      ).toEqual(before.rows);
    },
  );

  it.each([
    {
      timezone: "America/Los_Angeles",
      now: "2026-10-06T15:00:00.000Z",
      previous: "2026-10-05",
      day: "2026-10-06",
      next: "2026-10-07",
      after: "2026-10-08",
      timed: "2026-10-07T06:30:00.000Z",
      timedEnd: "2026-10-07T06:45:00.000Z",
      boundary: "2026-10-07T07:00:00.000Z",
    },
    {
      timezone: "Asia/Kolkata",
      now: "2026-10-06T20:00:00.000Z",
      previous: "2026-10-06",
      day: "2026-10-07",
      next: "2026-10-08",
      after: "2026-10-09",
      timed: "2026-10-07T18:00:00.000Z",
      timedEnd: "2026-10-07T18:15:00.000Z",
      boundary: "2026-10-07T18:30:00.000Z",
    },
    {
      timezone: "America/New_York",
      now: "2026-11-01T15:00:00.000Z",
      previous: "2026-10-31",
      day: "2026-11-01",
      next: "2026-11-02",
      after: "2026-11-03",
      timed: "2026-11-02T04:30:00.000Z",
      timedEnd: "2026-11-02T04:45:00.000Z",
      boundary: "2026-11-02T05:00:00.000Z",
    },
  ])(
    "keeps civil all-day overlap and timed owner-day membership distinct in $timezone",
    async (fixture) => {
      await db.exec(`CREATE SCHEMA app_calendar;
        CREATE TABLE app_calendar.life_calendar_events (
          id text PRIMARY KEY, agent_id text, side text, title text,
          start_at text, end_at text, status text, html_link text, updated_at text,
          is_all_day boolean NOT NULL DEFAULT false, provider text NOT NULL DEFAULT 'eliza', metadata_json text NOT NULL DEFAULT '{}'
        );`);
      const midnight = (date: string) => `${date}T00:00:00.000Z`;
      const rows = [
        [
          "today",
          "Single-day source",
          midnight(fixture.day),
          midnight(fixture.next),
          "confirmed",
          true,
        ],
        [
          "multi",
          "Spanning source",
          midnight(fixture.previous),
          midnight(fixture.after),
          "confirmed",
          true,
        ],
        [
          "expired",
          "Exclusive-end source",
          midnight(fixture.previous),
          midnight(fixture.day),
          "confirmed",
          true,
        ],
        [
          "future",
          "Future source",
          midnight(fixture.next),
          midnight(fixture.after),
          "confirmed",
          true,
        ],
        [
          "cancelled",
          "Cancelled source",
          midnight(fixture.day),
          midnight(fixture.next),
          "cancelled",
          true,
        ],
        [
          "timed",
          "Late timed source",
          fixture.timed,
          fixture.timedEnd,
          "confirmed",
          false,
        ],
        [
          "boundary",
          "Next-day timed source",
          fixture.boundary,
          fixture.boundary,
          "confirmed",
          false,
        ],
      ];
      for (const [id, title, start, end, status, allDay] of rows)
        await db.query(
          `INSERT INTO app_calendar.life_calendar_events (id, agent_id, side, title, start_at, end_at, status, html_link, updated_at, is_all_day) VALUES
           ($1, 'checkin-availability', 'owner', $2, $3, $4, $5, NULL, $6, $7)`,
          [
            id,
            title,
            start,
            end,
            status,
            id === "cancelled" ? fixture.now : "2025-01-01T00:00:00.000Z",
            allDay,
          ],
        );
      const before = await db.query(
        "SELECT * FROM app_calendar.life_calendar_events ORDER BY id",
      );
      const report = await new CheckinService(runtime).runMorningCheckin({
        now: new Date(fixture.now),
        timezone: fixture.timezone,
      });
      expect(report.collectorErrors.todaysMeetings).toBeNull();
      expect(report.todaysMeetings.map((row) => row.id).sort()).toEqual([
        "cancelled",
        "multi",
        "timed",
        "today",
      ]);
      const section = report.briefingSections.find(
        (item) => item.key === "calendar_changes",
      );
      expect(section?.error).toBeNull();
      expect(section?.summary).toContain("4 events on today's calendar");
      expect(
        section?.items.map((item) => item.calendarEvent?.id).sort(),
      ).toEqual(["cancelled", "multi", "timed", "today"]);
      expect(renderMorningCheckinReport(report)).toContain(
        "Calendar today: 4.",
      );
      expect(renderMorningCheckinReport(report)).toContain("cancelled");
      expect(renderMorningCheckinReport(report)).toContain("removed/cancelled");
      expect(renderMorningCheckinReport(report)).not.toContain(
        "Exclusive-end source",
      );
      expect(renderMorningCheckinReport(report)).not.toContain("Future source");
      expect(renderMorningCheckinReport(report)).not.toContain(
        "Next-day timed source",
      );
      expect(prompts).toHaveLength(1);
      expect(
        (
          await db.query(
            "SELECT * FROM app_calendar.life_calendar_events ORDER BY id",
          )
        ).rows,
      ).toEqual(before.rows);
    },
  );

  it("keeps morning wins on their actual owner-local completion day despite refreshes", async () => {
    const now = new Date("2026-10-04T06:14:13.975Z");
    await db.exec(`
      CREATE TABLE app_lifeops.life_task_definitions (id text PRIMARY KEY, title text);
      CREATE TABLE app_lifeops.life_task_occurrences (
        id text PRIMARY KEY, agent_id text, definition_id text, state text,
        completion_payload_json jsonb, updated_at text
      );
      INSERT INTO app_lifeops.life_task_definitions VALUES ('definition', 'Completed item');
    `);
    const records = [
      [
        "actual-yesterday-refreshed-today",
        { completedAt: "2026-10-03T04:12:14.140Z" },
      ],
      ["yesterday-start", { completedAt: "2026-10-02T07:00:00.000Z" }],
      ["today-midnight", { completedAt: "2026-10-03T07:00:00.000Z" }],
      ["prior-day", { completedAt: "2026-10-02T06:59:59.999Z" }],
      ["missing", null],
      ["invalid", { completedAt: "invalid" }],
      ["relative", { completedAt: "today" }],
      ["wrong-type", { completedAt: 42 }],
    ];
    for (const [id, payload] of records)
      await db.query(
        "INSERT INTO app_lifeops.life_task_occurrences VALUES ($1,$2,'definition','completed',$3,$4)",
        [
          id,
          String(runtime.agentId),
          JSON.stringify(payload),
          now.toISOString(),
        ],
      );
    const before = (
      await db.query(
        "SELECT * FROM app_lifeops.life_task_occurrences ORDER BY id",
      )
    ).rows;
    const report = await new CheckinService(runtime).runMorningCheckin({
      timezone: "America/Los_Angeles",
      now,
    });
    expect(report.collectorErrors.yesterdaysWins).toBeNull();
    expect(report.yesterdaysWins).toEqual([
      {
        id: "actual-yesterday-refreshed-today",
        title: "Completed item",
        completedAt: "2026-10-03T04:12:14.140Z",
      },
      {
        id: "yesterday-start",
        title: "Completed item",
        completedAt: "2026-10-02T07:00:00.000Z",
      },
    ]);
    expect(
      (
        await db.query(
          "SELECT * FROM app_lifeops.life_task_occurrences ORDER BY id",
        )
      ).rows,
    ).toEqual(before);
    expect(prompts).toHaveLength(1);
  });

  it("keeps customized morning defaults on their chosen prompt", async () => {
    const task = buildFallbackDefaultPack({
      agentId: runtime.agentId,
    }).tasks.find((entry) => entry.metadata?.recordKey === "gm");
    if (!task) throw new Error("Default morning reminder missing");
    modelResponse = "Remember the chosen morning task.";
    const summary = await composeOwnerFacingScheduledTaskText(runtime, {
      taskId: "customized-morning",
      kind: task.kind,
      firedAtIso: "2026-10-02T18:30:00.000Z",
      channelKey: "in_app",
      ownerVisible: true,
      promptInstructions: "Remind me to water the basil.",
      metadata: task.metadata,
    });
    expect(summary).toBe(modelResponse);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Remind me to water the basil.");
    const reports = await db.query(
      "SELECT * FROM app_lifeops.life_checkin_reports",
    );
    expect(reports.rows).toHaveLength(0);
  });

  it.each([
    {
      ownerTimezone: "America/Los_Angeles",
      configuredTimezone: "Asia/Tokyo",
      fallback: false,
    },
    {
      ownerTimezone: undefined,
      configuredTimezone: "America/Los_Angeles",
      fallback: false,
    },
    {
      ownerTimezone: "America/Los_Angeles",
      configuredTimezone: "Asia/Tokyo",
      fallback: true,
    },
    {
      ownerTimezone: undefined,
      configuredTimezone: "America/Los_Angeles",
      fallback: true,
    },
  ])(
    "composes the scheduled brief with owner zone $ownerTimezone before configured zone $configuredTimezone (fallback $fallback)",
    async ({ ownerTimezone, configuredTimezone, fallback }) => {
      vi.stubEnv("TZ", "UTC");
      const now = new Date("2026-10-02T18:30:00.000Z");
      runtime.getSetting = (key) =>
        key === "TIMEZONE" ? configuredTimezone : undefined;
      if (ownerTimezone) {
        await resolveOwnerFactStore(runtime).update(
          { timezone: ownerTimezone },
          { source: "first_run", recordedAt: now.toISOString() },
        );
      }
      await db.exec(`CREATE SCHEMA app_calendar;
      CREATE TABLE app_calendar.life_calendar_events (
        id text, agent_id text, title text, start_at text, end_at text,
        side text NOT NULL DEFAULT 'owner', status text, html_link text, updated_at text,
        is_all_day boolean NOT NULL DEFAULT false, provider text NOT NULL DEFAULT 'eliza', metadata_json text NOT NULL DEFAULT '{}'
      );
      INSERT INTO app_calendar.life_calendar_events (id, agent_id, title, start_at, end_at, status, html_link, updated_at, is_all_day) VALUES
        ('owner-day', 'checkin-availability', 'Owner-zone meeting',
         '2026-10-03T05:00:00.000Z', '2026-10-03T06:00:00.000Z',
         'confirmed', NULL, '2026-10-02T18:00:00.000Z', false),
        ('deployment-day', 'checkin-availability', 'Previous owner-day meeting',
         '2026-10-02T01:00:00.000Z', '2026-10-02T02:00:00.000Z',
         'confirmed', NULL, '2026-10-01T18:00:00.000Z', false);
      CREATE TABLE app_lifeops.life_inbox_messages (
        id text, agent_id text, channel text, external_id text,
        sender_id text, sender_display text, snippet text, received_at text,
        is_unread boolean, source_ref_json jsonb, cached_at text, updated_at text
      );`);
      const cachedAt = new Date().toISOString();
      await db.query(
        `INSERT INTO app_lifeops.life_inbox_messages VALUES
        ('inbox-proof', 'checkin-availability', 'telegram', 'source-proof',
         'sender-proof', 'Source sender', 'Existing inbox adapter proof', $1,
         true, '{"channel":"telegram","externalId":"source-proof"}', $1, $1)`,
        [cachedAt],
      );
      const originalService = runtime.getService.bind(runtime);
      Object.assign(runtime, {
        getService: (type: string) =>
          type === "calendar"
            ? {
                getCalendarFeed: async (
                  _url: URL,
                  request: {
                    timeMin: string;
                    timeMax: string;
                    timeZone: string;
                  },
                ) => {
                  const rows = (
                    await db.query<Record<string, unknown>>(
                      "SELECT * FROM app_calendar.life_calendar_events WHERE start_at >= $1 AND start_at < $2 ORDER BY start_at",
                      [request.timeMin, request.timeMax],
                    )
                  ).rows;
                  return {
                    calendarId: "unified",
                    source: "cache",
                    state: "complete",
                    sources: [],
                    timeMin: request.timeMin,
                    timeMax: request.timeMax,
                    syncedAt: null,
                    events: rows.map((row) => ({
                      id: row.id,
                      title: row.title,
                      startAt: row.start_at,
                      endAt: row.end_at,
                      status: row.status,
                      isAllDay: row.is_all_day,
                    })),
                  };
                },
              }
            : originalService(type),
      });
      modelResponse = "Owner-local meeting and the existing inbox item.";
      const defaultMorning = buildFallbackDefaultPack({
        agentId: runtime.agentId,
      }).tasks.find((task) => task.metadata?.recordKey === "gm");
      if (!defaultMorning) throw new Error("Default morning reminder missing");
      const summary = await composeOwnerFacingScheduledTaskText(runtime, {
        taskId: "managed-brief",
        kind: fallback ? defaultMorning.kind : "watcher",
        firedAtIso: now.toISOString(),
        channelKey: "in_app",
        intensity: "normal",
        promptInstructions: fallback
          ? defaultMorning.promptInstructions
          : "Assemble the managed morning brief.",
        ownerVisible: true,
        metadata: fallback
          ? defaultMorning.metadata
          : { delegatesAssemblyTo: "lifeops:checkin:morning" },
      });

      expect(summary).toBe(modelResponse);
      expect(prompts[0]).toContain("Owner-zone meeting");
      expect(prompts[0]).toContain("Existing inbox adapter proof");
      expect(prompts).toHaveLength(1);
      const stored = await db.query<{ payload_json: CheckinReport }>(
        "SELECT payload_json FROM app_lifeops.life_checkin_reports",
      );
      const payload = stored.rows[0].payload_json;
      expect(payload.todaysMeetings.map((meeting) => meeting.title)).toEqual([
        "Owner-zone meeting",
      ]);
      const inbox = payload.briefingSections.find(
        (section) => section.key === "inbox",
      );
      expect(inbox?.error).toBeNull();
      expect(JSON.stringify(inbox?.items)).toContain(
        "Existing inbox adapter proof",
      );
      expect(
        payload.briefingSections.find((section) => section.key === "gmail"),
      ).toBeUndefined();
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0].payload_json.summaryText).toBe(summary);
    },
  );

  it.each([
    [
      "2026-10-01T12:00:00Z",
      "UTC",
      "2026-09-30T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
    ],
    [
      "2026-12-31T12:00:00Z",
      "UTC",
      "2026-12-30T00:00:00.000Z",
      "2026-12-31T00:00:00.000Z",
    ],
    [
      "2027-01-01T12:00:00Z",
      "UTC",
      "2026-12-31T00:00:00.000Z",
      "2027-01-01T00:00:00.000Z",
    ],
    [
      "2028-03-01T12:00:00Z",
      "UTC",
      "2028-02-29T00:00:00.000Z",
      "2028-03-01T00:00:00.000Z",
    ],
    [
      "2026-11-02T04:30:00Z",
      "America/New_York",
      "2026-10-31T04:00:00.000Z",
      "2026-11-01T04:00:00.000Z",
    ],
    [
      "2026-03-09T04:30:00Z",
      "America/New_York",
      "2026-03-08T05:00:00.000Z",
      "2026-03-09T04:00:00.000Z",
    ],
  ])(
    "preserves collector failure and yesterday's local calendar window at %s in %s",
    async (instant, timezone, start, end) => {
      const report = await new CheckinService(runtime).runMorningCheckin({
        timezone,
        now: new Date(instant),
      });
      const winsQuery = statements.find((statement) =>
        statement.includes("AS completed_at"),
      );
      expect(winsQuery).toContain(`->> 'completedAt') >= '${start}'`);
      expect(winsQuery).toContain(`->> 'completedAt') < '${end}'`);
      expect(prompts).toHaveLength(1);
      expect(report.collectorErrors.habitSummaries).toContain("does not exist");
      expect(renderMorningCheckinReport(report)).toContain("unavailable.");
      expect(renderMorningCheckinReport(report)).not.toContain(
        "No meetings listed",
      );
      expect(renderMorningCheckinReport(report)).not.toContain(
        "Your calendar is clear",
      );
      expect(
        (await db.query("SELECT id FROM app_lifeops.life_checkin_reports"))
          .rows,
      ).toHaveLength(1);
    },
  );

  it.each(["mixed", "mixed-legacy", "reminders-only"])(
    "keeps reminder delivery history outside habit counts for %s",
    async (fixtureKind) => {
      const now = new Date("2026-02-05T10:00:00.000Z");
      const timezone = "Asia/Tokyo";
      const service = new CheckinService(runtime);
      const priorReport = await service.runMorningCheckin({ now, timezone });
      const priorStored = (
        await db.query(
          "SELECT * FROM app_lifeops.life_checkin_reports WHERE id = $1",
          [priorReport.reportId],
        )
      ).rows[0];
      await db.exec(`
        CREATE TABLE app_lifeops.life_task_definitions (
          id text PRIMARY KEY, agent_id text, title text, kind text, status text,
          metadata_json jsonb, cadence_json jsonb
        );
        CREATE TABLE app_lifeops.life_task_occurrences (
          id text PRIMARY KEY, agent_id text, definition_id text, state text,
          due_at text, updated_at text, completion_payload_json jsonb
        );
        CREATE TABLE app_lifeops.life_task_progress_events (
          agent_id text, occurrence_id text, quantity integer
        );`);
      const dueAt = new Date(now.getTime() - 3600000).toISOString();
      const nativeReminder = {
        kind: "reminder",
        provider: "apple_reminders",
        source: "llm",
        reminderId: null,
      };
      const rows = Array.from({ length: 19 }, (_, index) => ({
        id: `tracked-${index}`,
        kind: index === 18 ? "routine" : "habit",
        metadata:
          fixtureKind === "reminders-only"
            ? {
                ownerSurface: "OWNER_REMINDERS",
                ...(index === 0
                  ? {
                      pauseUntil: new Date(
                        now.getTime() + 3600000,
                      ).toISOString(),
                    }
                  : {}),
              }
            : index === 0
              ? {
                  ownerSurface: "OWNER_ROUTINES",
                  nativeAppleReminder: nativeReminder,
                }
              : index === 2
                ? { ownerSurface: "unrecognized" }
                : {},
        cadence:
          index === 0
            ? { kind: "once", dueAt }
            : { kind: "daily", windows: ["morning"] },
        state:
          index === 18
            ? "completed"
            : fixtureKind === "reminders-only" && index !== 0
              ? "visible"
              : "pending",
      }));
      rows.push({
        id: "notification",
        kind: "habit",
        metadata: {
          ownerSurface: "OWNER_REMINDERS",
          nativeAppleReminder: nativeReminder,
        },
        cadence: { kind: "once", dueAt },
        state: "visible",
      });
      if (fixtureKind === "mixed-legacy")
        rows.push({
          id: "legacy-notification",
          kind: "habit",
          metadata: { nativeAppleReminder: nativeReminder },
          cadence: { kind: "once", dueAt },
          state: "visible",
        });
      if (fixtureKind === "mixed-legacy")
        rows.push({
          id: "legacy-recurring-notification",
          kind: "routine",
          metadata: { nativeAppleReminder: nativeReminder },
          cadence: { kind: "daily", windows: ["morning"] },
          state: "visible",
        });
      rows.push({
        id: "unknown-kind",
        kind: "unrecognized",
        metadata: {},
        cadence: { kind: "once", dueAt },
        state: "visible",
      });
      for (const row of rows) {
        // Identical wording prevents title/name heuristics from passing this proof.
        await db.query(
          "INSERT INTO app_lifeops.life_task_definitions VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [
            row.id,
            String(runtime.agentId),
            "Same reminder text",
            row.kind,
            "active",
            JSON.stringify(row.metadata),
            JSON.stringify(row.cadence),
          ],
        );
        await db.query(
          "INSERT INTO app_lifeops.life_task_occurrences (id,agent_id,definition_id,state,due_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            `occurrence-${row.id}`,
            String(runtime.agentId),
            row.id,
            row.state,
            dueAt,
            dueAt,
          ],
        );
      }
      const beforeDefinitions = (
        await db.query(
          "SELECT * FROM app_lifeops.life_task_definitions ORDER BY id",
        )
      ).rows;
      const beforeOccurrences = (
        await db.query(
          "SELECT * FROM app_lifeops.life_task_occurrences ORDER BY id",
        )
      ).rows;
      const selectedCount = beforeDefinitions.filter(
        (row) => row.kind === "habit" || row.kind === "routine",
      ).length;
      expect(selectedCount).toBe(fixtureKind === "mixed-legacy" ? 22 : 20);
      const report = await service.runMorningCheckin({ now, timezone });
      expect(report.collectorErrors.habitSummaries).toBeNull();
      expect(report.timezone).toBe(timezone);
      expect(report.generatedAt).toBe(now.toISOString());
      expect(prompts).toHaveLength(2);
      expect(
        report.habitSummaries.some(
          (summary) =>
            summary.definitionId === "notification" ||
            summary.definitionId === "legacy-notification" ||
            summary.definitionId === "legacy-recurring-notification" ||
            summary.definitionId === "unknown-kind",
        ),
      ).toBe(false);
      if (fixtureKind === "reminders-only") {
        expect(report.habitSummaries).toEqual([]);
        expect(renderMorningCheckinReport(report)).not.toContain(
          "tracked items",
        );
        // Keep the existing pause exclusion used by the overdue collector.
        expect(report.overdueTodos).toEqual([]);
      } else {
        expect(report.habitSummaries).toHaveLength(19);
        expect(
          report.habitSummaries.find(
            (summary) => summary.definitionId === "tracked-2",
          ),
        ).toBeDefined();
        expect(
          report.habitSummaries.filter(
            (summary) => summary.missedOccurrenceStreak > 0,
          ),
        ).toHaveLength(18);
        expect(renderMorningCheckinReport(report)).toContain(
          "18 of 19 tracked items have missed check-ins.",
        );
        expect(
          report.habitSummaries.find(
            (summary) => summary.definitionId === "tracked-0",
          ),
        ).toMatchObject({ kind: "habit", missedOccurrenceStreak: 1 });
        expect(
          report.habitSummaries.find(
            (summary) => summary.definitionId === "tracked-18",
          ),
        ).toMatchObject({
          kind: "routine",
          currentOccurrenceStreak: 1,
          missedOccurrenceStreak: 0,
        });
      }
      expect(
        (
          await db.query(
            "SELECT * FROM app_lifeops.life_task_definitions ORDER BY id",
          )
        ).rows,
      ).toEqual(beforeDefinitions);
      expect(
        (
          await db.query(
            "SELECT * FROM app_lifeops.life_task_occurrences ORDER BY id",
          )
        ).rows,
      ).toEqual(beforeOccurrences);
      const stored = await db.query<{
        id: string;
        generated_at: string;
        payload_json: Pick<
          CheckinReport,
          "habitSummaries" | "summaryText" | "collectorErrors"
        >;
      }>("SELECT * FROM app_lifeops.life_checkin_reports");
      expect(stored.rows).toHaveLength(2);
      expect(
        stored.rows.find((row) => row.id === priorReport.reportId),
      ).toEqual(priorStored);
      const currentStored = stored.rows.find(
        (row) => row.id === report.reportId,
      );
      expect(currentStored?.generated_at).toBe(report.generatedAt);
      expect(currentStored?.payload_json.habitSummaries).toEqual(
        report.habitSummaries,
      );
      expect(currentStored?.payload_json.summaryText).toBe(report.summaryText);
      expect(currentStored?.payload_json.collectorErrors).toEqual(
        report.collectorErrors,
      );
    },
  );

  it("rejects a model summary that gives the current briefing a stale calendar date", async () => {
    modelResponse =
      "Good morning. Here is the brief for Saturday, October 3, 2025.";
    await expect(
      new CheckinService(runtime).runMorningCheckin({
        timezone: "America/Los_Angeles",
        now: new Date("2026-10-03T20:23:00Z"),
      }),
    ).rejects.toMatchObject({ code: "CHECKIN_SUMMARY_DATE_MISMATCH" });
    expect(
      (await db.query("SELECT id FROM app_lifeops.life_checkin_reports")).rows,
    ).toEqual([]);
  });

  it("uses the configured text model for the morning message and retains its result", async () => {
    modelResponse =
      "Your calendar is clear today. Pick one task to focus on this morning.";
    const report = await new CheckinService(runtime).runMorningCheckin({
      timezone: "America/Los_Angeles",
      now: new Date("2026-11-12T16:45:00Z"),
    });
    expect(report.summaryText).toBe(modelResponse);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(
      "Write the owner's morning personal-assistant intro summary.",
    );
    expect(prompts[0]).toContain("Thursday, November 12, 2026 at 8:45 AM");
    const stored = await db.query<{ payload_json: CheckinReport }>(
      "SELECT payload_json FROM app_lifeops.life_checkin_reports",
    );
    expect(stored.rows[0].payload_json.summaryText).toBe(modelResponse);
  });

  const summaryCases: Array<{
    outcome: number;
    called: boolean;
    writes: number;
  }> = process.env.ELIZA_CHECKIN_SUMMARY_MODEL_CASES
    ? JSON.parse(
        readFileSync(process.env.ELIZA_CHECKIN_SUMMARY_MODEL_CASES, "utf8"),
      )
    : [
        { outcome: 0, called: true, writes: 1 },
        { outcome: 1, called: true, writes: 0 },
        { outcome: 2, called: false, writes: 0 },
        { outcome: 3, called: true, writes: 0 },
        { outcome: 4, called: true, writes: 0 },
      ];
  it.each(summaryCases)(
    "matches the generated summary persistence outcome $outcome",
    async ({ outcome, called, writes }) => {
      modelResponse = outcome === 1 ? "   " : "A concise morning summary.";
      if (outcome === 2)
        Object.defineProperty(runtime, "useModel", { value: undefined });
      if (outcome === 3) modelResponse = undefined;
      if (outcome === 4) {
        const adapter = runtime.adapter as unknown as {
          db: { execute: (query: RawSqlQuery) => Promise<unknown> };
        };
        const execute = adapter.db.execute;
        vi.spyOn(adapter.db, "execute").mockImplementation((query) => {
          const statement = query.queryChunks
            .map((chunk) => chunk.value ?? "")
            .join("");
          if (
            statement.includes("INSERT INTO app_lifeops.life_checkin_reports")
          ) {
            throw new Error("Report storage unavailable");
          }
          return execute(query);
        });
      }
      const result = new CheckinService(runtime).runMorningCheckin({
        timezone: "America/Los_Angeles",
        now: new Date("2026-11-12T16:45:00Z"),
      });
      if (outcome === 0) expect((await result).summaryText).toBe(modelResponse);
      else await expect(result).rejects.toThrow();
      expect(prompts.length).toBe(called ? 1 : 0);
      const stored = await db.query(
        "SELECT id FROM app_lifeops.life_checkin_reports",
      );
      expect(stored.rows).toHaveLength(writes);
    },
  );

  it.each(["morning", "night"] as const)(
    "rejects blank %s model output without persisting a completion marker",
    async (kind) => {
      modelResponse = "   ";
      const service = new CheckinService(runtime);
      const request = {
        timezone: "UTC",
        now: new Date("2026-10-01T12:00:00Z"),
      };
      const result =
        kind === "morning"
          ? service.runMorningCheckin(request)
          : service.runNightCheckin(request);
      await expect(result).rejects.toMatchObject({
        code: "CHECKIN_SUMMARY_EMPTY",
      });
      expect(
        (await db.query("SELECT id FROM app_lifeops.life_checkin_reports"))
          .rows,
      ).toEqual([]);
    },
  );

  it.each(["morning", "night"] as const)(
    "requires a configured model for the %s summary",
    async (kind) => {
      Object.defineProperty(runtime, "useModel", { value: undefined });
      const service = new CheckinService(runtime);
      const request = {
        timezone: "UTC",
        now: new Date("2026-10-01T12:00:00Z"),
      };
      const result =
        kind === "morning"
          ? service.runMorningCheckin(request)
          : service.runNightCheckin(request);
      await expect(result).rejects.toMatchObject({
        code: "CHECKIN_MODEL_UNAVAILABLE",
      });
      expect(
        (await db.query("SELECT id FROM app_lifeops.life_checkin_reports"))
          .rows,
      ).toEqual([]);
    },
  );

  it("supplies the source year to the model and preserves the returned summary", async () => {
    modelResponse = "Your morning brief is ready.";
    const report = await new CheckinService(runtime).runMorningCheckin({
      timezone: "America/Los_Angeles",
      now: new Date("2026-10-03T20:23:00Z"),
    });
    expect(renderMorningCheckinReport(report)).toContain("Oct 3, 2026");
    expect(report.summaryText).toBe(modelResponse);
    expect(prompts[0]).toContain("Saturday, October 3, 2026");
    expect(prompts[0]).not.toContain("October 3, 2025");
    expect(prompts).toHaveLength(1);
  });

  it("renders the collector's local year at a UTC boundary", async () => {
    const report = await new CheckinService(runtime).runMorningCheckin({
      timezone: "America/Los_Angeles",
      now: new Date("2026-01-01T01:00:00Z"),
    });
    expect(renderMorningCheckinReport(report)).toContain("Dec 31, 2025");
    expect(report.timezone).toBe("America/Los_Angeles");
    expect(prompts[0]).toContain("Wednesday, December 31, 2025");
    expect(prompts).toHaveLength(1);
  });

  it("stores collector availability with the report so reload cannot turn failure into zero", async () => {
    const report: CheckinReport = {
      reportId: "availability-report",
      kind: "morning",
      generatedAt: "2026-09-28T12:00:00.000Z",
      escalationLevel: 0,
      habitEscalationLevel: 0,
      overdueTodos: [],
      todaysMeetings: [],
      yesterdaysWins: [],
      habitSummaries: [],
      briefingSections: [],
      sleepRecap: null,
      summaryText: "Calendar is unavailable.",
      collectorErrors: {
        overdueTodos: null,
        todaysMeetings: "calendar unavailable",
        yesterdaysWins: null,
        habitSummaries: "habits unavailable",
      },
    };
    await new CheckinService(runtime).persistCheckinReport(report);
    const stored = await db.query<{
      payload_json: {
        collectorErrors: CheckinReport["collectorErrors"];
        sleepRecap: null;
      };
    }>("SELECT payload_json FROM app_lifeops.life_checkin_reports");
    expect(stored.rows[0].payload_json.collectorErrors).toEqual(
      report.collectorErrors,
    );
    expect(stored.rows[0].payload_json.sleepRecap).toBeNull();
  });
});

describe("automatic morning configured source selection", () => {
  it.each([
    "uninstalled",
    "unconfigured",
    "pending",
    "agent-only",
    "calendar-only",
    "reauth",
    "google-reauth",
    "connected-failure",
    "multiple",
    "partial",
    "partial-empty",
    "probe-failure",
    "dm-only",
  ])(
    "collects %s using actual owner account/status methods",
    async (mode) => {
      const { createLifeOpsTestRuntime } = await import(
        "../../../test/helpers/runtime.js"
      );
      const { LifeOpsService } = await import("../service.js");
      const { getConnectorAccountManager } = await import("@elizaos/core");
      const { createGoogleConnectorAccountProvider } = await import(
        "../../../../plugin-google-workspace/src/connector-account-provider.ts"
      );
      const fixture = await createLifeOpsTestRuntime();
      const service = new LifeOpsService(fixture.runtime);
      const manager = getConnectorAccountManager(fixture.runtime);
      manager.registerProvider(
        createGoogleConnectorAccountProvider(fixture.runtime),
      );
      const originalGetService = fixture.runtime.getService.bind(
        fixture.runtime,
      );
      const getAccountStatus = vi.fn(async () => {
        if (mode === "probe-failure") throw new Error("X status probe failed");
        return {
          configured: ![
            "unconfigured",
            "pending",
            "agent-only",
            "calendar-only",
          ].includes(mode),
          connected: ![
            "unconfigured",
            "pending",
            "agent-only",
            "calendar-only",
            "reauth",
          ].includes(mode),
          reason:
            mode === "reauth"
              ? "needs_reauth"
              : [
                    "unconfigured",
                    "pending",
                    "agent-only",
                    "calendar-only",
                  ].includes(mode)
                ? "config_missing"
                : "connected",
          grantedCapabilities:
            mode === "dm-only" ? ["x.dm.read"] : ["x.dm.read", "x.read"],
          grantedScopes: [],
          identity: null,
        };
      });
      vi.spyOn(fixture.runtime, "getService").mockImplementation((type) =>
        type === "x"
          ? mode === "uninstalled"
            ? null
            : ({ getAccountStatus } as never)
          : originalGetService(type),
      );
      const model = vi
        .spyOn(fixture.runtime, "useModel")
        .mockResolvedValue("Configured source selection summary.");
      const gmail = vi
        .spyOn(service, "getGmailTriage")
        .mockImplementation(async (_url, request) => {
          if (
            mode === "connected-failure" ||
            mode === "google-reauth" ||
            (mode.startsWith("partial") && request?.grantId === failedGrant)
          )
            throw new Error("Connected Gmail fetch failed");
          return {
            messages:
              mode === "partial-empty"
                ? []
                : [
                    {
                      from: "Sender",
                      subject: request?.grantId,
                      snippet: "Useful owner mail",
                      receivedAt: "2026-10-04T05:00:00.000Z",
                      isUnread: true,
                      isImportant: false,
                      likelyReplyNeeded: true,
                      triageScore: 1,
                      triageReason: "Reply needed",
                      htmlLink: null,
                    },
                  ],
            summary: {
              unreadCount: mode === "partial-empty" ? 0 : 1,
              importantNewCount: 0,
              likelyReplyNeededCount: mode === "partial-empty" ? 0 : 1,
            },
          } as never;
        });
      const dms = vi.spyOn(service, "syncXDms").mockImplementation(async () => {
        if (mode === "connected-failure")
          throw new Error("Connected X DM fetch failed");
        return { synced: 0 };
      });
      vi.spyOn(service, "getXDms").mockResolvedValue([]);
      const feeds = vi
        .spyOn(service, "syncXFeed")
        .mockImplementation(async () => {
          if (mode === "connected-failure")
            throw new Error("Connected X feed failed");
          return { synced: 0 };
        });
      vi.spyOn(service, "getXFeedItems").mockResolvedValue([]);
      const grants: string[] = [];
      let failedGrant = "";
      try {
        if (!["uninstalled", "unconfigured"].includes(mode)) {
          const count = ["multiple", "partial", "partial-empty"].includes(mode)
            ? 2
            : 1;
          for (let index = 0; index < count; index++) {
            const account = await manager.upsertAccount("google", {
              id: `mail-${index}`,
              provider: "google",
              role: mode === "agent-only" ? "AGENT" : "OWNER",
              purpose: ["messaging"],
              accessGate: "owner",
              status:
                mode === "pending"
                  ? "pending"
                  : mode === "google-reauth"
                    ? "error"
                    : "connected",
              metadata: {
                grantedCapabilities: [
                  mode === "calendar-only" ? "calendar.read" : "gmail.read",
                ],
              },
            });
            const status = (
              await service.getGoogleConnectorAccounts(
                new URL("http://127.0.0.1/"),
                "owner",
              )
            ).find((item) => item.grant?.connectorAccountId === account.id);
            if (mode === "google-reauth")
              expect(status).toMatchObject({
                configured: true,
                connected: false,
                reason: "needs_reauth",
              });
            if (mode !== "agent-only") {
              if (!status?.grant) throw new Error("Missing real account grant");
              grants.push(status.grant.id);
            }
          }
          failedGrant = grants[1] ?? "";
        }
        const before = await manager.listAccounts("google");
        const report = await new CheckinService(fixture.runtime, {
          sources: service,
        }).runMorningCheckin({
          now: new Date("2026-10-04T15:00:00.000Z"),
          timezone: "America/Los_Angeles",
        });
        const googleSection = report.briefingSections.find(
          (section) => section.key === "gmail",
        );
        const xSections = report.briefingSections.filter(
          (section) => section.key === "x" || section.key.startsWith("x_"),
        );
        if (
          [
            "uninstalled",
            "unconfigured",
            "pending",
            "agent-only",
            "calendar-only",
          ].includes(mode)
        ) {
          expect(googleSection).toBeUndefined();
          expect(xSections).toEqual([]);
          await expect(service.getXConnectorStatus()).resolves.toMatchObject({
            connected: false,
          });
          expect(gmail).not.toHaveBeenCalled();
          expect(dms).not.toHaveBeenCalled();
          expect(feeds).not.toHaveBeenCalled();
          expect(renderMorningCheckinReport(report)).not.toContain("Gmail");
          expect(renderMorningCheckinReport(report)).not.toContain("X isn't");
        } else {
          expect(
            gmail.mock.calls.map(([, request]) => request?.grantId).sort(),
          ).toEqual(grants.sort());
          expect(
            gmail.mock.calls.every(([, request]) => request?.side === "owner"),
          ).toBe(true);
          if (mode === "connected-failure") {
            expect(googleSection?.error).toBe("Connected Gmail fetch failed");
            expect(xSections.map((section) => section.error)).toEqual([
              "Connected X DM fetch failed",
              "Connected X feed failed",
              "Connected X feed failed",
            ]);
          } else if (mode === "google-reauth") {
            expect(googleSection?.error).toBe("Connected Gmail fetch failed");
            expect(googleSection?.items).toEqual([]);
            expect(renderMorningCheckinReport(report)).toContain(
              "Gmail unavailable",
            );
          } else if (mode.startsWith("partial")) {
            expect(googleSection?.coverage).toBe("partial");
            expect(googleSection?.error).toBe("Connected Gmail fetch failed");
            expect(googleSection?.items).toHaveLength(
              mode === "partial-empty" ? 0 : 1,
            );
            expect(renderMorningCheckinReport(report)).toMatch(
              /Some Gmail inboxes|some connected inboxes/,
            );
            const prompt = buildCheckinSummaryPrompt(report);
            const payload = JSON.parse(
              prompt.split("Report JSON:\n")[1].split("\n")[0],
            );
            expect(
              payload.briefingSections.available.find(
                (section: { key: string }) => section.key === "gmail",
              ),
            ).toMatchObject({
              coverage: "partial",
              error: "Connected Gmail fetch failed",
            });
            expect(
              payload.briefingSections.unavailable.some(
                (section: { key: string }) => section.key === "gmail",
              ),
            ).toBe(false);
            expect(renderMorningCheckinReport(report)).not.toContain(
              "No Gmail",
            );
          } else
            expect(googleSection?.items).toHaveLength(
              mode === "multiple" ? 2 : 1,
            );
          if (mode === "probe-failure" || mode === "reauth") {
            expect(xSections.map((section) => section.key)).toEqual(["x"]);
            expect(renderMorningCheckinReport(report)).toContain(
              "X unavailable",
            );
            expect(renderMorningCheckinReport(report)).not.toContain("X (DMs)");
          }
          if (mode === "probe-failure") {
            expect(xSections[0]?.error).toBe("X status probe failed");
            expect(dms).not.toHaveBeenCalled();
            expect(feeds).not.toHaveBeenCalled();
          }
          if (mode === "reauth") {
            expect(xSections[0]?.error).toContain("needs reauthorization");
            expect(dms).not.toHaveBeenCalled();
            expect(feeds).not.toHaveBeenCalled();
          }
          if (mode === "probe-failure") {
            await expect(service.getXConnectorStatus()).resolves.toMatchObject({
              connected: false,
              probeError: "X status probe failed",
            });
            const { createXConnectorContribution } = await import(
              "../connectors/x.js"
            );
            await expect(
              createXConnectorContribution(fixture.runtime).verify(),
            ).resolves.toBe(false);
          }
          if (mode === "dm-only") {
            expect(xSections.map((section) => section.key)).toEqual(["x_dms"]);
            expect(feeds).not.toHaveBeenCalled();
          }
        }
        expect(await manager.listAccounts("google")).toEqual(before);
        expect(model).toHaveBeenCalledTimes(1);
        expect(report.timezone).toBe("America/Los_Angeles");
      } finally {
        vi.restoreAllMocks();
        await fixture.cleanup();
      }
    },
    120000,
  );
});
