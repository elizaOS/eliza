/** Exercises missing collectors, failed generation, and report persistence against real PGlite. No provider request is made. */
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOwnerFactStore } from "../owner/fact-store.js";
import { composeOwnerFacingScheduledTaskText } from "../scheduled-task/runtime-wiring.js";
import type { RawSqlQuery } from "../sql.js";
import { CheckinService } from "./checkin-service.js";
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
    modelResponse = undefined;
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
    expect(prompts).toHaveLength(0);
  });

  it.each([
    { ownerTimezone: "America/Los_Angeles", configuredTimezone: "Asia/Tokyo" },
    { ownerTimezone: undefined, configuredTimezone: "America/Los_Angeles" },
  ])(
    "composes the scheduled brief with owner zone $ownerTimezone before configured zone $configuredTimezone",
    async ({ ownerTimezone, configuredTimezone }) => {
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
        status text, html_link text, updated_at text
      );
      INSERT INTO app_calendar.life_calendar_events VALUES
        ('owner-day', 'checkin-availability', 'Owner-zone meeting',
         '2026-10-03T05:00:00.000Z', '2026-10-03T06:00:00.000Z',
         'confirmed', NULL, '2026-10-02T18:00:00.000Z'),
        ('deployment-day', 'checkin-availability', 'Previous owner-day meeting',
         '2026-10-02T01:00:00.000Z', '2026-10-02T02:00:00.000Z',
         'confirmed', NULL, '2026-10-01T18:00:00.000Z');
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
      modelResponse = "Owner-local meeting and the existing inbox item.";
      const summary = await composeOwnerFacingScheduledTaskText(runtime, {
        taskId: "managed-brief",
        kind: "watcher",
        firedAtIso: now.toISOString(),
        channelKey: "in_app",
        intensity: "normal",
        promptInstructions: "Assemble the managed morning brief.",
        ownerVisible: true,
        metadata: { delegatesAssemblyTo: "lifeops:checkin:morning" },
      });

      expect(summary).toContain("Owner-zone meeting");
      expect(summary).toContain("Existing inbox adapter proof");
      expect(prompts).toHaveLength(0);
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
        payload.briefingSections.find((section) => section.key === "gmail")
          ?.error,
      ).toEqual(expect.any(String));
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
      expect(prompts).toHaveLength(0);
      expect(report.collectorErrors.habitSummaries).toContain("does not exist");
      expect(report.summaryText).toContain("unavailable.");
      expect(report.summaryText).not.toContain("No meetings listed");
      expect(report.summaryText).not.toContain("Your calendar is clear");
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
      expect(prompts).toHaveLength(0);
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
        expect(report.summaryText).not.toContain("tracked items");
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
        expect(report.summaryText).toContain(
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

  it("rejects blank model output without persisting a completion marker", async () => {
    modelResponse = "   ";
    await expect(
      new CheckinService(runtime).runNightCheckin({
        timezone: "UTC",
        now: new Date("2026-10-01T12:00:00Z"),
      }),
    ).rejects.toMatchObject({ code: "CHECKIN_SUMMARY_EMPTY" });
    expect(
      (await db.query("SELECT id FROM app_lifeops.life_checkin_reports")).rows,
    ).toEqual([]);
  });

  it("renders the source year without asking a model that would return the captured stale year", async () => {
    modelResponse =
      "Good morning. Here is the brief for Saturday, October 3, 2025.";
    const report = await new CheckinService(runtime).runMorningCheckin({
      timezone: "America/Los_Angeles",
      now: new Date("2026-10-03T20:23:00Z"),
    });
    expect(report.summaryText).toContain("Oct 3, 2026");
    expect(report.summaryText).not.toContain("October 3, 2025");
    expect(prompts).toHaveLength(0);
  });

  it("renders the collector's local year at a UTC boundary", async () => {
    const report = await new CheckinService(runtime).runMorningCheckin({
      timezone: "America/Los_Angeles",
      now: new Date("2026-01-01T01:00:00Z"),
    });
    expect(report.summaryText).toContain("Dec 31, 2025");
    expect(report.timezone).toBe("America/Los_Angeles");
    expect(prompts).toHaveLength(0);
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
