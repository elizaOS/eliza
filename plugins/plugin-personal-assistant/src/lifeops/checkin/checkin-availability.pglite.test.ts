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

      expect(summary).toBe(modelResponse);
      expect(prompts).toHaveLength(1);
      const payload = JSON.parse(
        prompts[0].split("Report JSON:\n")[1].split("\n\nSummary:")[0],
      );
      expect(
        payload.todaysMeetings.map(
          (meeting: { title: string }) => meeting.title,
        ),
      ).toEqual(["Owner-zone meeting"]);
      const inbox = payload.briefingSections.available.find(
        (section: { key: string }) => section.key === "inbox",
      );
      expect(inbox.error).toBeNull();
      expect(JSON.stringify(inbox.items)).toContain(
        "Existing inbox adapter proof",
      );
      expect(
        payload.briefingSections.unavailable.find(
          (section: { key: string }) => section.key === "gmail",
        ).error,
      ).toEqual(expect.any(String));
      const stored = await db.query<{ payload_json: { summaryText: string } }>(
        "SELECT payload_json FROM app_lifeops.life_checkin_reports",
      );
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
      await expect(
        new CheckinService(runtime).runMorningCheckin({
          timezone,
          now: new Date(instant),
        }),
      ).rejects.toThrow("text provider is not configured");
      const winsQuery = statements.find((statement) =>
        statement.includes("AS completed_at"),
      );
      expect(winsQuery).toContain(`occ.updated_at >= '${start}'`);
      expect(winsQuery).toContain(`occ.updated_at <= '${end}'`);
      expect(prompts).toHaveLength(1);
      const payload = JSON.parse(
        prompts[0].split("Report JSON:\n")[1].split("\n\nSummary:")[0],
      );
      expect(payload.overdueTodos).toBeNull();
      expect(payload.todaysMeetings).toBeNull();
      expect(payload.yesterdaysWins).toBeNull();
      expect(payload.habitSummaries).toBeNull();
      expect(payload.collectorErrors.habitSummaries).toContain(
        "does not exist",
      );
      expect(
        (await db.query("SELECT id FROM app_lifeops.life_checkin_reports"))
          .rows,
      ).toEqual([]);
    },
  );

  it("rejects blank model output without persisting a completion marker", async () => {
    modelResponse = "   ";
    await expect(
      new CheckinService(runtime).runMorningCheckin({
        timezone: "UTC",
        now: new Date("2026-10-01T12:00:00Z"),
      }),
    ).rejects.toMatchObject({ code: "CHECKIN_SUMMARY_EMPTY" });
    expect(
      (await db.query("SELECT id FROM app_lifeops.life_checkin_reports")).rows,
    ).toEqual([]);
  });

  it("rejects the captured stale introduction year before saving a report", async () => {
    modelResponse =
      "Good morning. Here is the brief for Saturday, October 3, 2025.";
    await expect(
      new CheckinService(runtime).runMorningCheckin({
        timezone: "America/Los_Angeles",
        now: new Date("2026-10-03T20:23:00Z"),
      }),
    ).rejects.toMatchObject({ code: "CHECKIN_SUMMARY_YEAR_MISMATCH" });
    expect(
      (await db.query("SELECT id FROM app_lifeops.life_checkin_reports")).rows,
    ).toEqual([]);
  });

  it("validates the introduction against the collector's local year at a UTC boundary", async () => {
    modelResponse =
      "Good morning. Here is the brief for Wednesday, December 31, 2025.";
    const report = await new CheckinService(runtime).runMorningCheckin({
      timezone: "America/Los_Angeles",
      now: new Date("2026-01-01T01:00:00Z"),
    });
    expect(report.summaryText).toBe(modelResponse);
    expect(report.timezone).toBe("America/Los_Angeles");
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
