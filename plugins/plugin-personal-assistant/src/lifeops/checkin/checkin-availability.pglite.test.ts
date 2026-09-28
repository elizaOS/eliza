/** Exercises missing collectors, failed generation, and report persistence against real PGlite. No provider request is made. */
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RawSqlQuery } from "../sql.js";
import { CheckinService } from "./checkin-service.js";
import type { CheckinReport } from "./types.js";

describe("check-in source availability and generation failures", () => {
  let db: PGlite;
  let runtime: IAgentRuntime;
  const prompts: string[] = [];
  let modelResponse: string | undefined;
  beforeEach(async () => {
    prompts.length = 0;
    modelResponse = undefined;
    db = await PGlite.create();
    await db.exec(`CREATE SCHEMA app_lifeops;
      CREATE TABLE app_lifeops.life_checkin_reports (
        id text PRIMARY KEY, agent_id text, kind text, generated_at text,
        generated_at_ms bigint, escalation_level text, payload_json jsonb,
        acknowledged_at text
      );`);
    runtime = {
      agentId: "checkin-availability",
      getService: () => null,
      adapter: {
        db: {
          execute: (query: RawSqlQuery) =>
            db.query(
              query.queryChunks.map((chunk) => chunk.value ?? "").join(""),
            ),
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
  });

  it("does not persist a successful check-in when generation fails and preserves collector failures in model input", async () => {
    await expect(
      new CheckinService(runtime).runMorningCheckin({ timezone: "UTC" }),
    ).rejects.toThrow("text provider is not configured");
    expect(prompts).toHaveLength(1);
    const payload = JSON.parse(
      prompts[0].split("Report JSON:\n")[1].split("\n\nSummary:")[0],
    );
    expect(payload.overdueTodos).toBeNull();
    expect(payload.todaysMeetings).toBeNull();
    expect(payload.yesterdaysWins).toBeNull();
    expect(payload.habitSummaries).toBeNull();
    expect(payload.collectorErrors.habitSummaries).toContain("does not exist");
    expect(
      (await db.query("SELECT id FROM app_lifeops.life_checkin_reports")).rows,
    ).toEqual([]);
  });

  it("rejects blank model output without persisting a completion marker", async () => {
    modelResponse = "   ";
    await expect(
      new CheckinService(runtime).runMorningCheckin({ timezone: "UTC" }),
    ).rejects.toMatchObject({ code: "CHECKIN_SUMMARY_EMPTY" });
    expect(
      (await db.query("SELECT id FROM app_lifeops.life_checkin_reports")).rows,
    ).toEqual([]);
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
