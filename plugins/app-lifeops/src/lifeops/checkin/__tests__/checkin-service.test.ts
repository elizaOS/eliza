import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetCheckinMissingSourceLog,
  buildCheckinSummaryPrompt,
  CheckinService,
  type CheckinSourceService,
} from "../checkin-service.js";
import type { CheckinReport, SleepRecap } from "../types.js";

interface CheckinTestHarness {
  runtime: IAgentRuntime;
  pgClient: PGlite;
  execute: (statement: string) => Promise<unknown>;
  close: () => Promise<void>;
}

const BOOTSTRAP_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS life_checkin_reports (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    generated_at_ms BIGINT NOT NULL,
    escalation_level INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    acknowledged_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS life_task_definitions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'task',
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS life_task_occurrences (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    definition_id TEXT NOT NULL,
    due_at TEXT,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

async function createCheckinHarness(
  agentId = "00000000-0000-0000-0000-000000000099",
): Promise<CheckinTestHarness> {
  const pgClient = new PGlite();
  const db = drizzle(pgClient);
  for (const statement of BOOTSTRAP_STATEMENTS) {
    await db.execute(sql.raw(statement));
  }
  const runtime = {
    agentId,
    adapter: { db },
  } as unknown as IAgentRuntime;
  return {
    runtime,
    pgClient,
    execute: (statement: string) => db.execute(sql.raw(statement)),
    close: async () => {
      await pgClient.close();
    },
  };
}

describe("CheckinService", () => {
  let harness: CheckinTestHarness;

  beforeEach(async () => {
    __resetCheckinMissingSourceLog();
    harness = await createCheckinHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it("runMorningCheckin lists seeded overdue todos with escalation level 0", async () => {
    const agentId = String(harness.runtime.agentId);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const createdAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await harness.execute(
      `INSERT INTO life_task_definitions (id, agent_id, title, status, created_at)
       VALUES ('def-1', '${agentId}', 'Drink water', 'active', '${createdAt}')`,
    );
    await harness.execute(
      `INSERT INTO life_task_occurrences (id, agent_id, definition_id, due_at, state, created_at, updated_at)
       VALUES ('occ-1', '${agentId}', 'def-1', '${yesterday}', 'pending', '${createdAt}', '${createdAt}')`,
    );

    const service = new CheckinService(harness.runtime);
    const report = await service.runMorningCheckin();

    expect(report.kind).toBe("morning");
    expect(report.escalationLevel).toBe(0);
    expect(report.overdueTodos).toHaveLength(1);
    expect(report.overdueTodos[0]).toMatchObject({
      id: "occ-1",
      title: "Drink water",
    });
    expect(report.todaysMeetings).toEqual([]);
    expect(report.yesterdaysWins).toEqual([]);
    expect(report.reportId).toMatch(/.+/);
    // overdue + wins share life_task_* tables (bootstrapped), so no error.
    expect(report.collectorErrors.overdueTodos).toBeNull();
    expect(report.collectorErrors.yesterdaysWins).toBeNull();
    // life_calendar_events is NOT bootstrapped in this harness, so the
    // meetings collector must surface an error rather than silently [] .
    expect(report.collectorErrors.todaysMeetings).toMatch(/.+/);
  });

  it("recordCheckinAcknowledgement clears unack count so next escalation returns to 0", async () => {
    const service = new CheckinService(harness.runtime);
    const first = await service.runMorningCheckin();
    expect(await service.getEscalationLevel()).toBe(1);
    await service.recordCheckinAcknowledgement({ reportId: first.reportId });
    expect(await service.getEscalationLevel()).toBe(0);
  });

  it("includes social, inbox, Gmail, and rendered briefing sections", async () => {
    const source: CheckinSourceService = {
      syncXDms: async () => ({ synced: 1 }),
      getXDms: async () => [
        {
          id: "dm-1",
          agentId: String(harness.runtime.agentId),
          externalDmId: "dm-1",
          conversationId: "conversation-1",
          senderHandle: "alice",
          senderId: "alice-id",
          isInbound: true,
          text: "Can you review the GitHub PR today?",
          receivedAt: "2026-04-22T15:00:00.000Z",
          readAt: null,
          repliedAt: null,
          metadata: {},
          syncedAt: "2026-04-22T15:00:00.000Z",
          updatedAt: "2026-04-22T15:00:00.000Z",
        },
      ],
      syncXFeed: async () => ({ synced: 1 }),
      getXFeedItems: async (feedType) => [
        {
          id: `feed-${feedType}`,
          agentId: String(harness.runtime.agentId),
          externalTweetId: `tweet-${feedType}`,
          authorHandle: "builder",
          authorId: "builder-id",
          text: "Interesting launch thread with a question?",
          createdAtSource: "2026-04-22T14:00:00.000Z",
          feedType,
          metadata: {
            raw: {
              public_metrics: { like_count: 10, reply_count: 3 },
            },
          },
          syncedAt: "2026-04-22T14:00:00.000Z",
          updatedAt: "2026-04-22T14:00:00.000Z",
        },
      ],
      getInbox: async () => ({
        messages: [
          {
            id: "discord:1",
            channel: "discord",
            sender: {
              id: "bob",
              displayName: "Bob",
              email: null,
              avatarUrl: null,
            },
            subject: null,
            snippet: "Need an answer on the launch room.",
            receivedAt: "2026-04-22T16:00:00.000Z",
            unread: true,
            deepLink: null,
            sourceRef: { channel: "discord", externalId: "1" },
          },
        ],
        channelCounts: {
          gmail: { total: 0, unread: 0 },
          telegram: { total: 0, unread: 0 },
          discord: { total: 1, unread: 1 },
          signal: { total: 0, unread: 0 },
          sms: { total: 0, unread: 0 },
          imessage: { total: 0, unread: 0 },
          whatsapp: { total: 0, unread: 0 },
          x_dm: { total: 0, unread: 0 },
        },
        fetchedAt: "2026-04-22T16:00:00.000Z",
      }),
      getGmailTriage: async () => ({
        messages: [
          {
            id: "gmail-1",
            externalId: "gmail-1",
            agentId: String(harness.runtime.agentId),
            provider: "google",
            side: "owner",
            threadId: "thread-1",
            subject: "GitHub review requested",
            from: "GitHub",
            fromEmail: "noreply@github.com",
            replyTo: null,
            to: [],
            cc: [],
            snippet: "A PR needs your review.",
            receivedAt: "2026-04-22T13:00:00.000Z",
            isUnread: true,
            isImportant: true,
            likelyReplyNeeded: true,
            triageScore: 90,
            triageReason: "review requested",
            labels: ["INBOX", "UNREAD"],
            htmlLink: "https://mail.example/message",
            metadata: {},
            syncedAt: "2026-04-22T13:00:00.000Z",
            updatedAt: "2026-04-22T13:00:00.000Z",
          },
        ],
        source: "synced",
        syncedAt: "2026-04-22T13:00:00.000Z",
        summary: {
          unreadCount: 1,
          importantNewCount: 1,
          likelyReplyNeededCount: 1,
        },
      }),
    };
    const runtime = {
      ...harness.runtime,
      useModel: async () =>
        "Morning brief: X, Discord, Gmail, GitHub, calendar, contacts, and promises are covered.",
    } as unknown as IAgentRuntime;

    const service = new CheckinService(runtime, { sources: source });
    const report = await service.runMorningCheckin({
      now: new Date("2026-04-22T16:05:00.000Z"),
      timezone: "America/Los_Angeles",
    });

    expect(report.summaryText).toContain("GitHub");
    expect(report.briefingSections.map((section) => section.key)).toEqual([
      "x_dms",
      "x_timeline",
      "x_mentions",
      "inbox",
      "gmail",
      "github",
      "calendar_changes",
      "contacts",
      "promises",
    ]);
    expect(
      report.briefingSections.find((section) => section.key === "x_dms")
        ?.items[0]?.detail,
    ).toContain("GitHub PR");
  });

  it("gates check-ins once per owner local day", async () => {
    const service = new CheckinService(harness.runtime);
    const now = new Date("2026-04-22T16:00:00.000Z");

    await service.runMorningCheckin({
      now,
      timezone: "America/Los_Angeles",
    });

    await expect(
      service.hasCheckinForLocalDay({
        kind: "morning",
        now,
        timezone: "America/Los_Angeles",
      }),
    ).resolves.toBe(true);
    await expect(
      service.hasCheckinForLocalDay({
        kind: "morning",
        now: new Date("2026-04-23T16:00:00.000Z"),
        timezone: "America/Los_Angeles",
      }),
    ).resolves.toBe(false);
  });

  it("runMorningCheckin reports habit missed streaks and respects pause windows", async () => {
    const agentId = String(harness.runtime.agentId);
    const now = new Date();
    const firstDue = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const secondDue = new Date(
      now.getTime() - 26 * 60 * 60 * 1000,
    ).toISOString();
    const pausedUntil = new Date(
      now.getTime() + 6 * 60 * 60 * 1000,
    ).toISOString();
    const createdAt = new Date(
      now.getTime() - 48 * 60 * 60 * 1000,
    ).toISOString();
    await harness.execute(
      `INSERT INTO life_task_definitions (id, agent_id, kind, title, status, metadata_json, created_at)
       VALUES ('def-habit', '${agentId}', 'habit', 'Stretch', 'active', '{"pauseUntil":"${pausedUntil}"}', '${createdAt}')`,
    );
    await harness.execute(
      `INSERT INTO life_task_occurrences (id, agent_id, definition_id, due_at, state, created_at, updated_at)
       VALUES ('occ-habit-1', '${agentId}', 'def-habit', '${firstDue}', 'pending', '${createdAt}', '${createdAt}')`,
    );
    await harness.execute(
      `INSERT INTO life_task_occurrences (id, agent_id, definition_id, due_at, state, created_at, updated_at)
       VALUES ('occ-habit-2', '${agentId}', 'def-habit', '${secondDue}', 'pending', '${createdAt}', '${createdAt}')`,
    );

    const service = new CheckinService(harness.runtime);
    const report = await service.runMorningCheckin({ now });

    expect(report.habitEscalationLevel).toBe(0);
    expect(report.habitSummaries).toHaveLength(1);
    expect(report.habitSummaries[0]).toMatchObject({
      title: "Stretch",
      isPaused: true,
    });
    expect(report.overdueTodos).toEqual([]);
  });

  it("runMorningCheckin escalates when a habit misses multiple consecutive windows", async () => {
    const agentId = String(harness.runtime.agentId);
    const now = new Date();
    const firstDue = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const secondDue = new Date(
      now.getTime() - 26 * 60 * 60 * 1000,
    ).toISOString();
    const createdAt = new Date(
      now.getTime() - 48 * 60 * 60 * 1000,
    ).toISOString();
    await harness.execute(
      `INSERT INTO life_task_definitions (id, agent_id, kind, title, status, created_at)
       VALUES ('def-habit-missed', '${agentId}', 'habit', 'Stretch', 'active', '${createdAt}')`,
    );
    await harness.execute(
      `INSERT INTO life_task_occurrences (id, agent_id, definition_id, due_at, state, created_at, updated_at)
       VALUES ('occ-habit-missed-1', '${agentId}', 'def-habit-missed', '${firstDue}', 'pending', '${createdAt}', '${createdAt}')`,
    );
    await harness.execute(
      `INSERT INTO life_task_occurrences (id, agent_id, definition_id, due_at, state, created_at, updated_at)
       VALUES ('occ-habit-missed-2', '${agentId}', 'def-habit-missed', '${secondDue}', 'pending', '${createdAt}', '${createdAt}')`,
    );

    const service = new CheckinService(harness.runtime);
    const report = await service.runMorningCheckin({ now });

    expect(report.habitEscalationLevel).toBe(2);
    expect(report.habitSummaries).toHaveLength(1);
    expect(report.habitSummaries[0]).toMatchObject({
      title: "Stretch",
      missedOccurrenceStreak: 2,
      isPaused: false,
    });
    expect(report.overdueTodos).toHaveLength(2);
  });

  describe("night summary prompt — sleep recap surfacing", () => {
    function emptyReportFor(
      kind: "morning" | "night",
      sleepRecap: SleepRecap | null,
    ): Omit<CheckinReport, "summaryText"> {
      return {
        reportId: "report-test",
        kind,
        generatedAt: "2026-04-22T22:30:00.000Z",
        escalationLevel: 0,
        overdueTodos: [],
        todaysMeetings: [],
        yesterdaysWins: [],
        habitSummaries: [],
        habitEscalationLevel: 0,
        briefingSections: [],
        sleepRecap,
        collectorErrors: {
          overdueTodos: null,
          todaysMeetings: null,
          yesterdaysWins: null,
        },
      };
    }

    it("threads all four sleep-recap fields into the night-summary prompt", () => {
      const recap: SleepRecap = {
        medianBedtimeLocalHour: 23.5,
        medianSleepDurationMin: 420,
        sri: 82,
        regularityClass: "regular",
      };
      const prompt = buildCheckinSummaryPrompt(emptyReportFor("night", recap));

      // The four fields the report identifies as "computed and never
      // surfaced": medianBedtimeLocalHour, medianSleepDurationMin, sri,
      // regularityClass. Pin each one as a load-bearing prompt token.
      expect(prompt).toContain("Sleep recap");
      expect(prompt).toContain("typical bedtime: 23:30 local");
      expect(prompt).toContain("typical sleep duration: 7h");
      expect(prompt).toContain("sleep regularity index (SRI): 82/100");
      expect(prompt).toContain("regularity class: regular");
      // "do not invent facts" baseline must remain so the LLM trusts these
      // numbers as ground truth instead of hallucinating its own.
      expect(prompt).toContain("Do not invent facts");
    });

    it("omits sleep-recap section entirely on morning runs even if a recap is somehow attached", () => {
      const recap: SleepRecap = {
        medianBedtimeLocalHour: 23.5,
        medianSleepDurationMin: 420,
        sri: 82,
        regularityClass: "regular",
      };
      const prompt = buildCheckinSummaryPrompt(
        emptyReportFor("morning", recap),
      );
      expect(prompt).not.toContain("Sleep recap");
      expect(prompt).not.toContain("sleep regularity index");
    });

    it("omits sleep-recap section when recap is null (morning or night)", () => {
      const nightPrompt = buildCheckinSummaryPrompt(
        emptyReportFor("night", null),
      );
      const morningPrompt = buildCheckinSummaryPrompt(
        emptyReportFor("morning", null),
      );
      expect(nightPrompt).not.toContain("Sleep recap");
      expect(morningPrompt).not.toContain("Sleep recap");
    });

    it("drops bedtime + duration lines when baseline is null but still surfaces SRI + class", () => {
      const recap: SleepRecap = {
        medianBedtimeLocalHour: null,
        medianSleepDurationMin: null,
        sri: 0,
        regularityClass: "insufficient_data",
      };
      const prompt = buildCheckinSummaryPrompt(emptyReportFor("night", recap));
      expect(prompt).toContain("Sleep recap");
      expect(prompt).not.toContain("typical bedtime");
      expect(prompt).not.toContain("typical sleep duration");
      expect(prompt).toContain("sleep regularity index (SRI): 0/100");
      expect(prompt).toContain("regularity class: insufficient_data");
    });
  });
});
