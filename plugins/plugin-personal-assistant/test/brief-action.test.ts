/**
 * `BRIEF` umbrella action — unit tests (W2-5).
 *
 * Asserts that the morning / evening / weekly briefing surface exposed by
 * the PRD §Daily Operations exists, composes structured sections from the
 * injected loaders, and dispatches via simile names. The narrative tests pin
 * the compose PIPELINE around the canned model reply — the prompt must carry
 * every aggregated section, the reply is trimmed before it lands on the
 * briefing, and a throwing / non-string / whitespace-only model degrades to
 * a narrative-less structured briefing — so they cannot be satisfied by
 * echoing the stub.
 */

vi.mock("@elizaos/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/core")>()),
  hasRoleAccess: mocks.hasOwnerAccess,
}));

import { PGlite } from "@electric-sql/pglite";
import { registerCalendarTimeZoneResolver } from "@elizaos/contracts";
import type {
  HandlerOptions,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { getConnectorAccountManager, ModelType } from "@elizaos/core";
import {
  __resetDefaultTriageServiceForTests,
  getDefaultTriageService,
} from "@elizaos/plugin-assistant";
import { CalendarService } from "@elizaos/plugin-calendar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasOwnerAccess: vi.fn(async () => true),
}));

vi.mock("@elizaos/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/agent")>()),
}));

import {
  __resetBriefComposersForTests,
  briefAction,
  buildNarrativePrompt,
  setBriefComposers,
} from "../src/actions/brief.js";
import {
  resolveConfiguredOwnerTimeZone,
  resolveOwnerFactStore,
} from "../src/lifeops/owner/fact-store.js";
import {
  createLifeOpsReminderAttempt,
  LifeOpsRepository,
} from "../src/lifeops/repository.js";
import type { RawSqlQuery } from "../src/lifeops/sql.js";
import type { LifeOpsBriefing } from "../src/types/briefing.js";
import { createLifeOpsTestRuntime } from "./helpers/runtime.ts";

function makeRuntime(
  options: {
    useModel?: (modelType: string, args: { prompt: string }) => Promise<string>;
    reportError?: (
      scope: string,
      error: unknown,
      context?: Record<string, unknown>,
    ) => void;
  } = {},
): IAgentRuntime {
  return {
    agentId: "agent-brief-test" as UUID,
    getSetting: () => undefined,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    useModel:
      options.useModel ?? (async () => "Composed narrative from the model."),
    // The J4 degrade in loadCompletedTodayFromService reports through the
    // diagnostic boundary; the harness runtime must carry it so the evening
    // composer can run without a LifeOpsService registered.
    reportError: options.reportError ?? (() => undefined),
  } as unknown as IAgentRuntime;
}

function makeMessage(text = "give me my brief"): Memory {
  return {
    id: "msg-brief-1" as UUID,
    entityId: "owner-1" as UUID,
    roomId: "room-brief-1" as UUID,
    content: { text },
  } as Memory;
}

async function callBrief(
  runtime: IAgentRuntime,
  message: Memory,
  parameters: Record<string, unknown>,
) {
  return briefAction.handler(
    runtime,
    message,
    undefined,
    { parameters } as unknown as HandlerOptions,
    async () => undefined,
  );
}

describe("BRIEF umbrella action — Daily Operations", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  beforeEach(() => {
    __resetBriefComposersForTests();
    setBriefComposers({
      loadEngagementSummaries: async () => [],
      recordRenderedImpressions: async () => 0,
    });
    mocks.hasOwnerAccess.mockReset().mockResolvedValue(true);
  });

  describe("metadata", () => {
    it("validates as accessible for an owner-attached message", async () => {
      const ok = await briefAction.validate?.(
        makeRuntime(),
        makeMessage(),
        undefined,
      );
      expect(ok).toBe(true);
    });

    it("rejects calls with no subaction selector", async () => {
      const result = await callBrief(makeRuntime(), makeMessage(), {});
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "MISSING_SUBACTION" });
    });

    it("rejects callers that fail the owner-access check", async () => {
      mocks.hasOwnerAccess.mockResolvedValueOnce(false);
      const result = await callBrief(makeRuntime(), makeMessage(), {
        subaction: "compose_morning",
      });
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({ error: "PERMISSION_DENIED" });
    });
  });

  describe("compose_morning", () => {
    it("collects each captured reminder occurrence once without merging distinct same-title items", async () => {
      // These fixtures drive occurrence and delivery transitions explicitly.
      // A live scheduler would also deliver reminders and infer device travel.
      vi.stubEnv("ELIZA_DISABLE_LIFEOPS_SCHEDULER", "1");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-02T22:00:00.000Z"));
      const fixture = await createLifeOpsTestRuntime();
      try {
        const { LifeOpsService } = await import("../src/lifeops/service.js");
        const service = new LifeOpsService(fixture.runtime);
        const definitions = [];
        for (const [title, dueAt] of [
          ["Check locked-phone notification", "2026-10-02T23:32:12.551Z"],
          ["QA FCM app-absent reminder", "2026-10-03T00:23:25.528Z"],
          ["QA FCM app-absent reminder", "2026-10-03T00:23:25.528Z"],
        ]) {
          definitions.push(
            await service.createDefinition({
              title,
              kind: "habit",
              cadence: { kind: "once", dueAt, visibilityLeadMinutes: 0 },
              timezone: "America/Los_Angeles",
              metadata: {
                ownerSurface: "OWNER_REMINDERS",
                nativeProjection: "in_app_only",
              },
              reminderPlan: {
                steps: [
                  { channel: "in_app", offsetMinutes: 0, label: "Notify" },
                ],
              },
            }),
          );
        }
        vi.setSystemTime(new Date("2026-10-03T01:00:00.000Z"));
        await resolveOwnerFactStore(fixture.runtime).update(
          { timezone: "America/Los_Angeles" },
          { source: "first_run", recordedAt: new Date().toISOString() },
        );
        const prompts: string[] = [];
        vi.spyOn(fixture.runtime, "useModel").mockImplementation(
          async (_model, parameters) => {
            prompts.push((parameters as { prompt: string }).prompt);
            return "Deterministic briefing boundary test" as never;
          },
        );
        const overview = await service.getOverview();
        expect(overview.occurrences).toHaveLength(3);
        expect(overview.reminders).toHaveLength(3);
        expect(
          overview.reminders.map((item) => item.occurrenceId).sort(),
        ).toEqual(overview.occurrences.map((item) => item.id).sort());
        const before = await Promise.all(
          definitions.map((item) =>
            service.repository.listOccurrencesForDefinition(
              fixture.runtime.agentId,
              item.definition.id,
            ),
          ),
        );
        setBriefComposers({
          loadCalendar: async () => [],
          loadInbox: async () => [],
          loadCommitments: async () => [],
        });
        const result = await callBrief(fixture.runtime, makeMessage(), {
          action: "compose_morning",
          format: "narrative",
        });
        const briefing = result.data?.briefing as {
          generatedAt: string;
          sections: {
            life: Array<{ id: string; title: string; dueAt: string }>;
          };
          editorial: {
            items: Array<{ itemId: string; sourceId: string; summary: string }>;
          };
        };
        expect(prompts).toHaveLength(1);
        const payload = JSON.parse(prompts[0].split("Data:\n")[1]);
        expect(payload.asOf).toBe(briefing.generatedAt);
        expect(payload.localAsOf).toBe("Oct 2, 2026, 6:00 PM PDT");
        expect(payload.sections.life).toHaveLength(3);
        expect(
          payload.sections.life.every(
            (item: {
              timeContext: {
                dueAt: { localDate: string; relationToAsOf: string };
              };
            }) =>
              item.timeContext.dueAt.localDate === "2026-10-02" &&
              item.timeContext.dueAt.relationToAsOf === "before_as_of",
          ),
        ).toBe(true);
        expect(
          payload.editorial.items.every(
            (item: {
              summary: string;
              timeContext?: unknown;
              sourceSummary?: unknown;
            }) =>
              item.summary.includes("Oct 2, 2026") &&
              item.summary.includes("before_as_of") &&
              item.timeContext === undefined &&
              item.sourceSummary === undefined,
          ),
        ).toBe(true);
        const dueTimes = new Map(
          overview.occurrences.map((item) => [item.id, item.dueAt]),
        );
        for (const item of briefing.sections.life) {
          expect(item.dueAt).toBe(dueTimes.get(item.id));
          expect(item).not.toHaveProperty("timeContext");
        }
        for (const item of briefing.editorial.items) {
          expect(item.summary).toBe(`due ${dueTimes.get(item.sourceId)}`);
          expect(item).not.toHaveProperty("timeContext");
          expect(item).not.toHaveProperty("sourceSummary");
        }
        expect(briefing.sections.life.map((item) => item.id).sort()).toEqual(
          overview.occurrences.map((item) => item.id).sort(),
        );
        expect(
          briefing.sections.life.filter(
            (item) => item.title === "QA FCM app-absent reminder",
          ),
        ).toHaveLength(2);
        expect(
          new Set(briefing.editorial.items.map((item) => item.itemId)).size,
        ).toBe(3);
        expect(
          await Promise.all(
            definitions.map((item) =>
              service.repository.listOccurrencesForDefinition(
                fixture.runtime.agentId,
                item.definition.id,
              ),
            ),
          ),
        ).toEqual(before);
      } finally {
        await fixture.cleanup();
      }
    });

    it("preserves canonical visible and overdue facts after sent attempts until actual lifecycle transitions", async () => {
      // These fixtures drive occurrence and delivery transitions explicitly.
      // A live scheduler would also deliver reminders and infer device travel.
      vi.stubEnv("ELIZA_DISABLE_LIFEOPS_SCHEDULER", "1");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-02T22:00:00.000Z"));
      const fixture = await createLifeOpsTestRuntime();
      try {
        const { LifeOpsService } = await import("../src/lifeops/service.js");
        const service = new LifeOpsService(fixture.runtime);
        const definitions = [];
        for (const title of [
          "Sent canary A",
          "Sent canary B",
          "Actually completed",
          "Actually skipped",
        ]) {
          definitions.push(
            await service.createDefinition({
              title,
              kind: "habit",
              timezone: "America/Los_Angeles",
              cadence: {
                kind: "once",
                dueAt: "2026-10-02T23:32:12.551Z",
                visibilityLeadMinutes: 0,
              },
              metadata: {
                ownerSurface: "OWNER_REMINDERS",
                nativeProjection: "in_app_only",
              },
              reminderPlan: {
                steps: [
                  { channel: "in_app", offsetMinutes: 0, label: "Notify" },
                ],
              },
            }),
          );
        }
        vi.setSystemTime(new Date("2026-10-03T01:00:00.000Z"));
        const initial = await service.getOverview();
        expect(initial.summary).toMatchObject({
          activeOccurrenceCount: 4,
          overdueOccurrenceCount: 4,
        });
        for (const definition of definitions.slice(0, 2)) {
          const occurrence = initial.occurrences.find(
            (item) => item.definitionId === definition.definition.id,
          );
          if (!occurrence?.dueAt || !definition.reminderPlan)
            throw new Error("Missing persisted reminder fixture");
          await service.repository.createReminderAttempt(
            createLifeOpsReminderAttempt({
              agentId: fixture.runtime.agentId,
              planId: definition.reminderPlan.id,
              ownerType: "occurrence",
              ownerId: occurrence.id,
              occurrenceId: occurrence.id,
              channel: "in_app",
              stepIndex: 0,
              scheduledFor: occurrence.dueAt,
              attemptedAt: new Date().toISOString(),
              outcome: "delivered",
              connectorRef: null,
              deliveryMetadata: {},
            }),
          );
        }
        expect((await service.getOverview()).summary).toEqual(initial.summary);
        const completedId = initial.occurrences.find(
          (item) => item.definitionId === definitions[2].definition.id,
        )?.id;
        const skippedId = initial.occurrences.find(
          (item) => item.definitionId === definitions[3].definition.id,
        )?.id;
        if (!completedId || !skippedId)
          throw new Error("Missing terminal lifecycle fixture");
        await service.completeOccurrence(completedId, {});
        await service.skipOccurrence(skippedId);
        const overview = await service.getOverview();
        expect(overview.summary).toMatchObject({
          activeOccurrenceCount: 2,
          overdueOccurrenceCount: 2,
        });
        expect(overview.occurrences.map((item) => item.state)).toEqual([
          "visible",
          "visible",
        ]);
        const persistedBefore = await Promise.all(
          initial.occurrences.map((item) =>
            service.repository.getOccurrence(fixture.runtime.agentId, item.id),
          ),
        );
        expect(
          persistedBefore.find((item) => item?.id === completedId)?.state,
        ).toBe("completed");
        expect(
          persistedBefore.find((item) => item?.id === skippedId)?.state,
        ).toBe("skipped");
        const attemptsBefore = await service.repository.listReminderAttempts(
          fixture.runtime.agentId,
        );
        expect(attemptsBefore.map((item) => item.outcome)).toEqual([
          "delivered",
          "delivered",
        ]);
        await resolveOwnerFactStore(fixture.runtime).update(
          { timezone: "America/Los_Angeles" },
          { source: "first_run", recordedAt: new Date().toISOString() },
        );
        const prompts: string[] = [];
        vi.spyOn(fixture.runtime, "useModel").mockImplementation(
          async (_model, parameters) => {
            prompts.push((parameters as { prompt: string }).prompt);
            return "Deterministic lifecycle boundary test" as never;
          },
        );
        setBriefComposers({
          loadCalendar: async () => [],
          loadInbox: async () => [],
          loadCommitments: async () => [],
        });
        const result = await callBrief(fixture.runtime, makeMessage(), {
          action: "compose_evening",
          format: "narrative",
        });
        const briefing = result.data?.briefing as LifeOpsBriefing;
        expect(briefing.lifeSummary).toEqual(overview.summary);
        expect(
          briefing.sections.life?.map((item) => ({
            id: item.id,
            state: item.state,
            dueAt: item.dueAt,
          })),
        ).toEqual(
          overview.occurrences.map((item) => ({
            id: item.id,
            state: item.state,
            dueAt: item.dueAt,
          })),
        );
        expect(briefing.sections.completedToday).toContainEqual(
          expect.objectContaining({ id: completedId, state: "completed" }),
        );
        expect(
          briefing.sections.completedToday?.some(
            (item) => item.id === skippedId,
          ),
        ).toBe(false);
        const payload = JSON.parse(prompts[0].split("Data:\n")[1]);
        expect(payload.lifeSummary).toEqual(overview.summary);
        expect(
          payload.sections.life.every(
            (item: { state: string }) => item.state === "visible",
          ),
        ).toBe(true);
        expect(payload.sections.completedToday).toContainEqual(
          expect.objectContaining({ id: completedId, state: "completed" }),
        );
        expect(prompts[0]).toContain(
          "lifeSummary counts are canonical source facts",
        );
        const overviewRead = vi.spyOn(LifeOpsService.prototype, "getOverview");
        const optedOut = await callBrief(fixture.runtime, makeMessage(), {
          action: "compose_morning",
          format: "narrative",
          include: { life: false },
        });
        const optedOutBriefing = optedOut.data?.briefing as LifeOpsBriefing;
        expect(optedOutBriefing.lifeSummary).toBeUndefined();
        expect(optedOutBriefing.sections.life).toBeUndefined();
        expect(JSON.parse(prompts[1].split("Data:\n")[1])).not.toHaveProperty(
          "lifeSummary",
        );
        expect(overviewRead).not.toHaveBeenCalled();
        try {
          // A standalone plan projection carries a delivery-view state, which
          // cannot attest the occurrence lifecycle without its source occurrence.
          overviewRead.mockResolvedValueOnce({ ...overview, occurrences: [] });
          const projections = await callBrief(fixture.runtime, makeMessage(), {
            action: "compose_morning",
            format: "json",
            include: { calendar: false, inbox: false, commitments: false },
          });
          const projectionBriefing = projections.data
            ?.briefing as LifeOpsBriefing;
          expect(projectionBriefing.lifeSummary).toEqual(overview.summary);
          expect(projectionBriefing.sections.life).toHaveLength(2);
          for (const item of projectionBriefing.sections.life ?? []) {
            expect(item).not.toHaveProperty("state");
          }
          expect(overviewRead).toHaveBeenCalledTimes(1);
        } finally {
          overviewRead.mockRestore();
        }
        expect(
          await Promise.all(
            initial.occurrences.map((item) =>
              service.repository.getOccurrence(
                fixture.runtime.agentId,
                item.id,
              ),
            ),
          ),
        ).toEqual(persistedBefore);
        expect(
          await service.repository.listReminderAttempts(
            fixture.runtime.agentId,
          ),
        ).toEqual(attemptsBefore);
      } finally {
        await fixture.cleanup();
      }
    });

    it("keeps raw briefing data immutable and omits unavailable timestamp annotations", () => {
      const sections = {
        calendar: [
          {
            id: "invalid-event",
            title: "Untimed",
            startAt: "invalid",
            endAt: "invalid",
          },
        ],
        life: [
          {
            id: "undated",
            kind: "todo" as const,
            title: "Undated",
            dueAt: null,
          },
          {
            id: "invalid",
            kind: "reminder" as const,
            title: "Invalid",
            dueAt: "invalid",
          },
          {
            id: "valid",
            kind: "reminder" as const,
            title: "Timed",
            dueAt: "2026-10-03T00:23:25.528Z",
          },
        ],
      };
      const editorial = {
        maxItems: 7,
        demotedItemClasses: [],
        pushback: null,
        decisions: [],
        items: [
          {
            itemId: "life:valid",
            source: "life" as const,
            kind: "reminder" as const,
            sourceId: "valid",
            itemClass: "life:reminder",
            title: "Timed",
            summary: "due 2026-10-03T00:23:25.528Z",
            consequenceScore: 65,
          },
        ],
      };
      const before = structuredClone({ sections, editorial });
      const prompt = buildNarrativePrompt({
        kind: "morning",
        period: "today",
        sections,
        editorial,
        timeZone: "America/Los_Angeles",
        asOf: "2026-10-03T01:00:00.000Z",
      });
      const payload = JSON.parse(prompt.split("Data:\n")[1]);
      expect(payload.sections.calendar[0]).not.toHaveProperty("timeContext");
      expect(payload.sections.life[0]).not.toHaveProperty("timeContext");
      expect(payload.sections.life[1]).not.toHaveProperty("timeContext");
      expect(payload.sections.life[2].timeContext.dueAt.localDate).toBe(
        "2026-10-02",
      );
      expect(payload.editorial.items[0].summary).toContain(
        "Oct 2, 2026, 5:23 PM PDT",
      );
      expect(payload.editorial.items[0]).not.toHaveProperty("sourceSummary");
      expect(payload.editorial.items[0]).not.toHaveProperty("timeContext");
      expect({ sections, editorial }).toEqual(before);
    });

    it.each([
      [
        "2026-10-03T01:00:00.000Z",
        "America/Los_Angeles",
        "2026-10-03T00:23:25.528Z",
        "2026-10-02",
        "before_as_of",
        "Oct 2, 2026, 5:23 PM PDT",
      ],
      [
        "2026-10-03T06:59:59.000Z",
        "America/Los_Angeles",
        "2026-10-03T07:00:00.000Z",
        "2026-10-03",
        "after_as_of",
        "Oct 3, 2026, 12:00 AM PDT",
      ],
      [
        "2026-11-01T08:30:00.000Z",
        "America/Los_Angeles",
        "2026-11-01T09:30:00.000Z",
        "2026-11-01",
        "after_as_of",
        "Nov 1, 2026, 1:30 AM PST",
      ],
    ])(
      "grounds %s against %s at %s without model date arithmetic",
      (asOf, timeZone, dueAt, localDate, relationToAsOf, localTime) => {
        const prompt = buildNarrativePrompt({
          kind: "morning",
          period: "today",
          asOf,
          timeZone,
          sections: {
            life: [
              {
                id: "canary",
                kind: "reminder",
                title: "QA FCM app-absent reminder",
                dueAt,
              },
            ],
          },
        });
        const payload = JSON.parse(prompt.split("Data:\n")[1]);
        expect(payload.asOf).toBe(asOf);
        expect(payload.localAsOf).toEqual(expect.any(String));
        expect(payload.sections.life[0]).toMatchObject({
          dueAt,
          timeContext: { dueAt: { localDate, localTime, relationToAsOf } },
        });
        expect(prompt).toContain(
          "Completion and delivery cannot be inferred from a timestamp",
        );
      },
    );

    it.each([
      [
        "2026-10-02T02:00:00Z",
        "America/Los_Angeles",
        "today",
        "2026-10-01T07:00:00Z",
        "2026-10-02T07:00:00Z",
        "narrative",
      ],
      [
        "2026-10-02T02:00:00Z",
        "America/Los_Angeles",
        "tomorrow",
        "2026-10-02T07:00:00Z",
        "2026-10-03T07:00:00Z",
        "json",
      ],
      [
        "2026-10-02T02:00:00Z",
        "America/Los_Angeles",
        "this_week",
        "2026-10-01T07:00:00Z",
        "2026-10-08T07:00:00Z",
        "json",
      ],
      [
        "2026-03-08T12:00:00Z",
        "America/New_York",
        "today",
        "2026-03-08T05:00:00Z",
        "2026-03-09T04:00:00Z",
        "json",
      ],
      [
        "2026-11-01T12:00:00Z",
        "America/New_York",
        "today",
        "2026-11-01T04:00:00Z",
        "2026-11-02T05:00:00Z",
        "json",
      ],
      [
        "2026-03-07T12:00:00Z",
        "America/New_York",
        "tomorrow",
        "2026-03-08T05:00:00Z",
        "2026-03-09T04:00:00Z",
        "json",
      ],
      [
        "2026-03-06T12:00:00Z",
        "America/New_York",
        "this_week",
        "2026-03-06T05:00:00Z",
        "2026-03-13T04:00:00Z",
        "json",
      ],
    ] as const)(
      "reads %s in owner zone %s for %s across the deployment zone",
      async (instant, timeZone, period, expectedStart, expectedEnd, format) => {
        vi.stubEnv("TZ", "UTC");
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(instant));
        const db = await PGlite.create();
        getDefaultTriageService().register({
          source: "slack",
          isAvailable: () => true,
          capabilities: () => ({
            list: true,
            search: false,
            manage: {},
            send: { reply: false, new: false, schedule: false },
            worlds: "single",
            channels: "none",
          }),
        } as never);
        const triage = vi
          .spyOn(getDefaultTriageService(), "triage")
          .mockResolvedValue([]);
        const prompts: string[] = [];
        const ranges: Array<{
          timeMin: string;
          timeMax: string;
          timeZone?: string;
        }> = [];
        await db.exec(`CREATE TABLE fixture_cache (key text PRIMARY KEY, payload jsonb);
          CREATE TABLE fixture_calendar (title text, start_at timestamptz);`);
        await db.query(
          "INSERT INTO fixture_calendar VALUES ($1,$2),($3,$4),($5,$6)",
          [
            "Owner-window event",
            new Date(Date.parse(expectedStart) + 3600000).toISOString(),
            "Before owner window",
            new Date(Date.parse(expectedStart) - 1).toISOString(),
            "At exclusive end",
            new Date(expectedEnd).toISOString(),
          ],
        );
        const calendar = {
          getCalendarFeed: async (
            _url: URL,
            range: { timeMin: string; timeMax: string; timeZone?: string },
          ) => {
            ranges.push(range);
            const result = await db.query<{ title: string; start_at: Date }>(
              "SELECT title,start_at FROM fixture_calendar WHERE start_at >= $1 AND start_at < $2 ORDER BY start_at",
              [range.timeMin, range.timeMax],
            );
            return {
              events: result.rows.map((row) => ({
                id: row.title,
                title: row.title,
                startAt: row.start_at.toISOString(),
              })),
            };
          },
        };
        const runtime = Object.assign(
          makeRuntime({
            useModel: async (_type, params) => {
              prompts.push(params.prompt);
              return "Owner-window event today.";
            },
          }),
          {
            getService: (type: string) =>
              type === CalendarService.serviceType ? calendar : null,
            getCache: async (key: string) =>
              (
                await db.query<{ payload: unknown }>(
                  "SELECT payload FROM fixture_cache WHERE key=$1",
                  [key],
                )
              ).rows[0]?.payload,
            setCache: async (key: string, value: unknown) => {
              await db.query(
                "INSERT INTO fixture_cache VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload",
                [key, JSON.stringify(value)],
              );
              return true;
            },
          },
        );
        registerCalendarTimeZoneResolver(runtime, (_runtime, now) =>
          resolveConfiguredOwnerTimeZone(runtime, now),
        );
        try {
          await resolveOwnerFactStore(runtime).update(
            { timezone: timeZone },
            { source: "first_run", recordedAt: instant },
          );
          const result = await callBrief(runtime, makeMessage(), {
            action: "compose_morning",
            period,
            format,
            include: { life: false, commitments: false },
          });
          expect(ranges).toEqual([
            {
              timeMin: new Date(expectedStart).toISOString(),
              timeMax: new Date(expectedEnd).toISOString(),
              timeZone,
            },
          ]);
          expect(triage).toHaveBeenCalledWith(runtime, {
            sources: ["slack"],
            sinceMs: Date.parse(expectedStart),
          });
          const briefing = result.data?.briefing as {
            sections: { calendar: Array<{ title: string }> };
            sourceErrors?: unknown;
          };
          expect(
            briefing.sections.calendar.map((event) => event.title),
          ).toEqual(["Owner-window event"]);
          expect(briefing.sourceErrors).toBeUndefined();
          if (format === "narrative")
            expect(prompts[0]).toContain(`"timeZone": "${timeZone}"`);
          else expect(prompts).toEqual([]);
        } finally {
          triage.mockRestore();
          await db.close();
        }
      },
    );

    it.each(["json", "narrative"])(
      "preserves a real PGlite requested-source failure in %s output",
      async (format) => {
        const db = await PGlite.create();
        const reportError = vi.fn();
        const prompts: string[] = [];
        const statements: string[] = [];
        const runtime = Object.assign(
          makeRuntime({
            reportError,
            useModel: async (_type, params) => {
              prompts.push(params.prompt);
              return "Life source unavailable.";
            },
          }),
          {
            character: { name: "Brief source fixture" },
            getSetting: () => undefined,
            getService: () => null,
            getCache: async () => undefined,
            setCache: async () => true,
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
          },
        );
        try {
          const result = await callBrief(runtime, makeMessage(), {
            action: "compose_morning",
            format,
            include: { calendar: false, inbox: false, commitments: false },
          });
          const briefing = result.data?.briefing as {
            sections: { life: unknown[]; calendar?: unknown };
            sourceErrors: { life: string };
            narrative?: string;
          };
          expect(result.success).toBe(true);
          expect(statements.length).toBeGreaterThan(0);
          expect(briefing.sections.life).toEqual([]);
          expect(briefing.sections.calendar).toBeUndefined();
          expect(briefing.sourceErrors).toEqual({ life: "unavailable" });
          expect(briefing).not.toHaveProperty("lifeSummary");
          expect(reportError).toHaveBeenCalledWith(
            "Brief.loadLife",
            expect.objectContaining({ code: "42P01" }),
            { source: "life" },
          );
          if (format === "narrative") {
            expect(prompts).toHaveLength(1);
            expect(prompts[0]).toContain('"life": "unavailable"');
            expect(
              JSON.parse(prompts[0].split("Data:\n")[1]),
            ).not.toHaveProperty("lifeSummary");
            expect(prompts[0]).toContain("are unavailable, not empty");
            expect(briefing.narrative).toBe("Life source unavailable.");
          } else {
            expect(prompts).toEqual([]);
            expect(result.text).toContain(
              "requested information could not be checked",
            );
          }
        } finally {
          await db.close();
        }
      },
    );

    it("keeps healthy empty sources distinct from excluded sources", async () => {
      const loadCalendar = vi.fn(async () => []);
      const loadInbox = vi.fn(async () => []);
      setBriefComposers({
        loadCalendar,
        loadInbox,
        loadLife: async () => [],
        loadCommitments: async () => [],
      });
      const result = await callBrief(makeRuntime(), makeMessage(), {
        action: "compose_morning",
        format: "json",
        include: { inbox: false },
      });
      const briefing = result.data?.briefing as {
        sections: {
          calendar: unknown[];
          inbox?: unknown;
          commitments: unknown[];
        };
        sourceErrors?: unknown;
      };
      expect(briefing.sections.calendar).toEqual([]);
      expect(briefing.sections.commitments).toEqual([]);
      expect(briefing.sections.inbox).toBeUndefined();
      expect(briefing.sourceErrors).toBeUndefined();
      expect(loadCalendar).toHaveBeenCalledOnce();
      expect(loadInbox).not.toHaveBeenCalled();
    });

    it("uses persisted ignored-item history to demote that class in the next brief", async () => {
      const runtimeResult = await createLifeOpsTestRuntime();
      try {
        await LifeOpsRepository.bootstrapSchema(runtimeResult.runtime);
        const repository = new LifeOpsRepository(runtimeResult.runtime);
        for (let day = 1; day <= 5; day += 1) {
          await repository.recordBriefItemEngagement({
            agentId: runtimeResult.runtime.agentId,
            briefingId: `brief-${day}`,
            itemId: "inbox:newsletter-1",
            source: "inbox",
            kind: "message",
            sourceId: "newsletter-1",
            itemClass: "inbox:newsletter-digest",
            eventType: "ignored",
            eventAt: new Date(
              Date.now() - day * 24 * 60 * 60 * 1_000,
            ).toISOString(),
            weight: -1,
            metadata: { scenario: "ignore-pattern" },
          });
        }

        // Restore the production engagement loader while keeping unrelated
        // source reads deterministic for this action-level database contract.
        __resetBriefComposersForTests();
        setBriefComposers({
          loadCalendar: async () => [],
          loadInbox: async () => [
            {
              id: "newsletter-1",
              channel: "gmail",
              senderName: "Weekly Digest",
              snippet: "Your weekly newsletter roundup",
              urgency: "low",
              classification: "unread",
            },
          ],
          loadLife: async () => [],
          loadCommitments: async () => [],
          loadCompletedToday: async () => [],
        });

        const result = await callBrief(runtimeResult.runtime, makeMessage(), {
          subaction: "compose_morning",
          format: "json",
        });

        expect(result.success).toBe(true);
        const data = result.data as {
          briefing: {
            editorial: {
              demotedItemClasses: readonly string[];
              decisions: readonly {
                itemId: string;
                action: string;
                reason: string;
              }[];
            };
          };
        };
        expect(data.briefing.editorial.demotedItemClasses).toEqual([
          "inbox:newsletter-digest",
        ]);
        expect(data.briefing.editorial.decisions).toContainEqual({
          itemId: "inbox:newsletter-1",
          action: "demote",
          reason:
            "inbox:newsletter-digest has repeated ignore history with no acted-on signal",
        });
      } finally {
        await runtimeResult.cleanup();
      }
    });

    it("reports unavailable engagement history without blocking the structured brief", async () => {
      const reportError = vi.fn();
      __resetBriefComposersForTests();
      setBriefComposers({
        loadCalendar: async () => [],
        loadInbox: async () => [],
        loadLife: async () => [],
        loadCommitments: async () => [],
        loadCompletedToday: async () => [],
      });

      const result = await callBrief(
        makeRuntime({ reportError }),
        makeMessage(),
        {
          subaction: "compose_morning",
          format: "json",
        },
      );

      expect(result.success).toBe(true);
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        "Brief.loadEngagementSummaries",
        expect.anything(),
        { surface: "brief-editorial-engagement" },
      );
    });

    it("surfaces regret-audited ledger commitments as a briefing section (#14864)", async () => {
      setBriefComposers({
        loadCalendar: async () => [],
        loadInbox: async () => [],
        loadLife: async () => [],
        loadCompletedToday: async () => [],
        loadCommitments: async () => [
          {
            id: "commit-1",
            kind: "commitment",
            summary: "I'll send the deck Friday",
            counterparty: "Dana",
            dueAt: "2026-08-14T17:00:00.000Z",
            status: "open",
            regretScore: 1.19,
            reasons: ["no scheduled tracker", "due within the regret horizon"],
          },
        ],
      });
      const result = await callBrief(makeRuntime(), makeMessage(), {
        subaction: "compose_morning",
        format: "json",
      });
      expect(result.success).toBe(true);
      const data = result.data as {
        briefing: {
          sections: {
            commitments?: readonly { id: string; regretScore: number }[];
          };
        };
      };
      expect(data.briefing.sections.commitments).toHaveLength(1);
      expect(data.briefing.sections.commitments?.[0]).toMatchObject({
        id: "commit-1",
        regretScore: 1.19,
      });
    });

    it("omits the commitments section when include.commitments is false", async () => {
      const loadCommitments = vi.fn(async () => [
        {
          id: "commit-1",
          kind: "commitment" as const,
          summary: "I'll send the deck Friday",
          counterparty: null,
          dueAt: null,
          status: "open" as const,
          regretScore: 1.0,
          reasons: ["no scheduled tracker"],
        },
      ]);
      setBriefComposers({
        loadCalendar: async () => [],
        loadInbox: async () => [],
        loadLife: async () => [],
        loadCompletedToday: async () => [],
        loadCommitments,
      });
      const result = await callBrief(makeRuntime(), makeMessage(), {
        subaction: "compose_morning",
        format: "json",
        include: { commitments: false },
      });
      expect(result.success).toBe(true);
      const data = result.data as {
        briefing: { sections: { commitments?: unknown } };
      };
      expect(data.briefing.sections.commitments).toBeUndefined();
      expect(loadCommitments).not.toHaveBeenCalled();
    });

    it("feeds the loader payload to the model and returns the trimmed narrative", async () => {
      // Padded model reply: the pipeline must return the TRIMMED narrative,
      // so a straight echo of the stub cannot satisfy the assertion.
      const useModel = vi.fn(
        async () => "  Composed narrative from the model.\n",
      );
      const runtime = makeRuntime({ useModel });
      setBriefComposers({
        loadCalendar: async () => [
          {
            id: "evt-1",
            title: "Board sync",
            startAt: "2026-05-11T09:00:00.000Z",
            endAt: "2026-05-11T10:00:00.000Z",
          },
        ],
        loadInbox: async () => [
          {
            id: "msg-1",
            channel: "gmail",
            senderName: "Bob",
            snippet: "Approve the SOW",
            urgency: "high",
            classification: "needs_reply",
          },
        ],
        loadLife: async () => [
          {
            id: "todo-1",
            kind: "todo",
            title: "Send NDA",
            dueAt: "2026-05-11T17:00:00.000Z",
          },
        ],
        loadCommitments: async () => [
          {
            id: "commitment-1",
            kind: "commitment",
            summary: "Send the signed contract",
            counterparty: "Alex",
            dueAt: "2026-05-20T00:00:00.000Z",
            status: "open",
            regretScore: 3,
            reasons: ["promised delivery"],
          },
        ],
      });

      const result = await callBrief(runtime, makeMessage(), {
        subaction: "compose_morning",
      });

      expect(result.success).toBe(true);
      const data = result.data as {
        subaction: string;
        briefing: {
          kind: string;
          period: string;
          sections: Record<string, unknown[]>;
          narrative?: string;
        };
      };
      expect(data.subaction).toBe("compose_morning");
      expect(data.briefing.kind).toBe("morning");
      expect(data.briefing.period).toBe("today");
      expect(data.briefing.sections.calendar).toHaveLength(1);
      expect(data.briefing.sections.inbox).toHaveLength(1);
      expect(data.briefing.sections.life).toHaveLength(1);
      expect(data.briefing.sections.commitments).toHaveLength(1);
      // Trimmed by the compose pass — not the raw model string.
      expect(data.briefing.narrative).toBe(
        "Composed narrative from the model.",
      );

      // The compose prompt must carry EVERY loader section the briefing
      // aggregated, plus the kind/period header — the model is narrating the
      // real payload, not free-associating.
      expect(useModel).toHaveBeenCalledTimes(1);
      const [modelType, args] = useModel.mock.calls[0] as [
        string,
        { prompt: string },
      ];
      expect(modelType).toBe(ModelType.TEXT_LARGE);
      expect(args.prompt).toContain("morning briefing for today");
      expect(args.prompt).toContain("Board sync"); // calendar
      expect(args.prompt).toContain("Approve the SOW"); // inbox
      expect(args.prompt).toContain("Send NDA"); // life
      expect(args.prompt).toContain("Send the signed contract"); // commitments
      expect(args.prompt).toContain('"editorial"');
      expect(args.prompt).toContain('"itemId": "inbox:msg-1"');
      expect(args.prompt).toContain('"action": "lead"');
    });

    it("honors include flags by suppressing whole sections", async () => {
      setBriefComposers({
        loadCalendar: vi.fn(async () => []),
        loadInbox: vi.fn(async () => []),
        loadLife: vi.fn(async () => []),
        loadCommitments: vi.fn(async () => []),
      });
      const result = await callBrief(makeRuntime(), makeMessage(), {
        subaction: "compose_morning",
        include: {
          calendar: true,
          inbox: false,
          life: false,
          commitments: false,
        },
        format: "json",
      });
      expect(result.success).toBe(true);
      const data = result.data as {
        briefing: { sections: Record<string, unknown> };
      };
      expect(data.briefing.sections).toHaveProperty("calendar");
      expect(data.briefing.sections).not.toHaveProperty("inbox");
      expect(data.briefing.sections).not.toHaveProperty("life");
      expect(data.briefing.sections).not.toHaveProperty("commitments");
    });

    it("accepts simile-style action names mapped through the subaction map", async () => {
      const result = await callBrief(makeRuntime(), makeMessage(), {
        action: "WEEKLY_BRIEF",
      });
      expect(result.success).toBe(true);
      const data = result.data as {
        subaction: string;
        briefing: { period: string };
      };
      expect(data.subaction).toBe("compose_weekly");
      expect(data.briefing.period).toBe("this_week");
    });
  });

  describe("compose_evening", () => {
    it("uses the TEXT_LARGE model and skips compose pass in json format", async () => {
      const useModel = vi.fn(async () => "narrative text");
      const runtime = makeRuntime({ useModel });
      const result = await callBrief(runtime, makeMessage(), {
        subaction: "compose_evening",
        format: "json",
      });
      expect(result.success).toBe(true);
      expect(useModel).not.toHaveBeenCalled();
      const data = result.data as { briefing: { narrative?: string } };
      expect(data.briefing.narrative).toBeUndefined();
    });

    it("calls TEXT_LARGE with the structured payload in the prompt", async () => {
      const useModel = vi.fn(async () => "morning narrative");
      const runtime = makeRuntime({ useModel });
      setBriefComposers({
        loadCalendar: async () => [
          {
            id: "evt-7",
            title: "Standup",
            startAt: "2026-05-11T10:00:00.000Z",
            endAt: "2026-05-11T10:15:00.000Z",
          },
        ],
      });
      const result = await callBrief(runtime, makeMessage(), {
        subaction: "compose_morning",
      });
      expect(result.success).toBe(true);
      expect(useModel).toHaveBeenCalledTimes(1);
      const modelCall = useModel.mock.calls[0];
      expect(modelCall).toBeDefined();
      const [modelType, args] = modelCall as [string, { prompt: string }];
      expect(modelType).toBe(ModelType.TEXT_LARGE);
      expect(args.prompt).toContain("Standup");
    });
  });

  describe("configured inbox selection — real account registry", () => {
    it.each([
      "default-disconnected",
      "explicit-disconnected",
      "pending",
      "connected",
      "failed",
      "partial",
      "multiple",
      "agent-only",
      "empty",
      "partial-empty",
      "reauth",
      "service-missing",
      "calendar-only",
      "other-adapter",
      "other-partial",
    ])(
      "handles %s without treating setup absence as a failed inbox",
      async (mode) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-02-05T16:00:00.000Z"));
        __resetDefaultTriageServiceForTests();
        const fixture = await createLifeOpsTestRuntime();
        const { createGoogleConnectorAccountProvider } = await import(
          "../../plugin-google-workspace/src/connector-account-provider.ts"
        );
        const { GoogleGmailAdapter } = await import(
          "../../plugin-google-workspace/src/lifeops-message-adapter.ts"
        );
        const manager = getConnectorAccountManager(fixture.runtime);
        manager.registerProvider(
          createGoogleConnectorAccountProvider(fixture.runtime),
        );
        const calls: string[] = [];
        const accountIds: string[] = [];
        const failingIds = new Set<string>();
        const fetchMessages = vi.fn(
          async ({ accountId }: { accountId: string }) => {
            calls.push(accountId);
            if (failingIds.has(accountId))
              throw new Error("Configured Gmail fetch failed");
            if (mode === "empty" || mode === "partial-empty") return [];
            return [
              {
                externalId: "same-mail-id",
                threadId: "thread",
                subject: `Mail from ${accountId}`,
                from: "Sender",
                fromEmail: "sender@example.test",
                replyTo: null,
                to: ["owner@example.test"],
                cc: [],
                snippet: "A real registered mailbox item",
                receivedAt: "2026-02-05T12:00:00.000Z",
                isUnread: true,
                isImportant: false,
                likelyReplyNeeded: true,
                labels: ["INBOX"],
                metadata: {},
              },
            ];
          },
        );
        const google = {
          listGmailTriageMessages: vi.fn(async () => []),
          searchGmailMessages: fetchMessages,
          getGmailMessageDetail: vi.fn(async () => null),
          getGmailMessageRevision: vi.fn(async () => "v1"),
          sendGmailReply: vi.fn(),
          sendGmailMessage: vi.fn(),
          modifyGmailMessages: vi.fn(),
          createGmailFilterForSender: vi.fn(),
        };
        const originalGetService = fixture.runtime.getService.bind(
          fixture.runtime,
        );
        vi.spyOn(fixture.runtime, "getService").mockImplementation((name) =>
          name === "google"
            ? mode === "service-missing"
              ? null
              : (google as never)
            : originalGetService(name),
        );
        const diagnostic = vi
          .spyOn(fixture.runtime, "reportError")
          .mockImplementation(() => {});
        const model = vi
          .spyOn(fixture.runtime, "useModel")
          .mockImplementation(async () => {
            throw new Error("JSON brief must not call models");
          });
        try {
          const accounts = ["partial", "partial-empty"].includes(mode)
            ? ["good-mail", "failed-mail"]
            : mode === "multiple"
              ? ["good-mail", "other-mail"]
              : ["failed", "reauth", "other-partial"].includes(mode)
                ? ["failed-mail"]
                : [
                      "connected",
                      "pending",
                      "agent-only",
                      "empty",
                      "service-missing",
                      "calendar-only",
                    ].includes(mode)
                  ? ["good-mail"]
                  : [];
          for (const id of accounts) {
            const account = await manager.upsertAccount("google", {
              id,
              provider: "google",
              role: mode === "agent-only" ? "AGENT" : "OWNER",
              purpose: ["messaging"],
              accessGate: "owner",
              status:
                mode === "pending"
                  ? "pending"
                  : mode === "reauth"
                    ? "error"
                    : "connected",
              metadata: {
                grantedCapabilities: [
                  mode === "calendar-only" ? "calendar.read" : "gmail.read",
                ],
              },
            });
            accountIds.push(account.id);
            if (id === "failed-mail") failingIds.add(account.id);
          }
          const registryBefore = await manager.listAccounts("google");
          getDefaultTriageService().register(new GoogleGmailAdapter());
          const otherRead = vi.fn(async () => [
            {
              id: "slack-item",
              source: "slack",
              externalId: "slack-item",
              from: { identifier: "source-user", displayName: "Slack sender" },
              to: [],
              subject: "Other inbox item",
              snippet: "Another configured adapter remains included",
              receivedAtMs: Date.now(),
              hasAttachments: false,
              isRead: false,
            },
          ]);
          if (mode === "other-adapter" || mode === "other-partial")
            getDefaultTriageService().register({
              source: "slack",
              isAvailable: () => true,
              capabilities: () => ({
                list: true,
                search: false,
                manage: {},
                send: { reply: false, new: false, schedule: false },
                worlds: "single",
                channels: "none",
              }),
              listMessages: otherRead,
            } as never);

          setBriefComposers({
            loadCalendar: async () => [],
            loadLife: async () => [],
            loadCompletedToday: async () => [],
            loadCommitments: async () => [],
          });
          const result = await callBrief(fixture.runtime, makeMessage(), {
            action: "compose_morning",
            format: "json",
            ...(mode === "explicit-disconnected"
              ? { include: { inbox: true } }
              : {}),
          });
          const briefing = result.data?.briefing as LifeOpsBriefing;
          expect(result.success).toBe(true);
          // A time-bounded brief filters at the provider before pagination.
          expect(google.listGmailTriageMessages).not.toHaveBeenCalled();
          for (const [request] of fetchMessages.mock.calls) {
            expect(request).toEqual(
              expect.objectContaining({
                query: expect.stringMatching(/^in:inbox after:\d+$/),
              }),
            );
          }
          if (
            [
              "default-disconnected",
              "pending",
              "agent-only",
              "calendar-only",
            ].includes(mode)
          ) {
            expect(briefing.sections).not.toHaveProperty("inbox");
            expect(briefing.sourceErrors).toBeUndefined();
            expect(calls).toEqual([]);
            expect(diagnostic).not.toHaveBeenCalled();
          } else if (mode === "explicit-disconnected") {
            expect(briefing.sections.inbox).toEqual([]);
            expect(briefing.sourceErrors).toEqual({ inbox: "not_connected" });
            expect(result.text).toContain("Your inbox isn't connected");
            expect(result.text).toContain(
              "Connect an email or message account",
            );
            expect(calls).toEqual([]);
            expect(diagnostic).not.toHaveBeenCalled();
          } else if (mode === "service-missing") {
            expect(briefing.sourceErrors?.inbox).toBe("unavailable");
            expect(calls).toEqual([]);
            expect(diagnostic).toHaveBeenCalledWith(
              "Brief.loadInbox",
              expect.objectContaining({
                code: "BRIEF_CONFIGURED_INBOX_UNAVAILABLE",
              }),
              expect.objectContaining({
                source: "inbox",
                messageSource: "gmail",
              }),
            );
          } else {
            expect(calls.sort()).toEqual(accountIds.sort());
            expect(calls).not.toContain("default");
            expect(briefing.sections.inbox).toHaveLength(
              ["failed", "reauth", "empty", "partial-empty"].includes(mode)
                ? 0
                : mode === "multiple"
                  ? 2
                  : 1,
            );
            if (
              [
                "partial",
                "partial-empty",
                "failed",
                "reauth",
                "other-partial",
              ].includes(mode)
            ) {
              expect(briefing.sourceErrors?.inbox).toBe(
                ["partial", "partial-empty", "other-partial"].includes(mode)
                  ? "partial"
                  : "unavailable",
              );
              expect(diagnostic).toHaveBeenCalledWith(
                "Brief.loadInbox",
                expect.objectContaining({
                  message: "Configured Gmail fetch failed",
                }),
                expect.objectContaining({
                  source: "inbox",
                  messageSource: "gmail",
                  accountId: [...failingIds][0],
                }),
              );
            } else expect(briefing.sourceErrors).toBeUndefined();
            if (mode === "multiple")
              expect(
                new Set(briefing.sections.inbox?.map((item) => item.id)).size,
              ).toBe(2);
          }
          if (mode === "other-adapter" || mode === "other-partial") {
            expect(otherRead).toHaveBeenCalledOnce();
            expect(
              briefing.sections.inbox?.some((item) => item.id === "slack-item"),
            ).toBe(true);
          }
          expect(model).not.toHaveBeenCalled();
          expect(await manager.listAccounts("google")).toEqual(registryBefore);
        } finally {
          vi.restoreAllMocks();
          await fixture.cleanup();
          __resetDefaultTriageServiceForTests();
        }
      },
      120000,
    );
  });

  describe("canonical briefing categories — real PGlite", () => {
    it("classifies mixed open and archived completed items without changing source records", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-02-05T16:00:00.000Z"));
      const fixture = await createLifeOpsTestRuntime();
      const { LifeOpsService } = await import("../src/lifeops/service.js");
      const apple = await import("../src/lifeops/apple-reminders.js");
      const native = vi
        .spyOn(apple, "createNativeAppleReminderLikeItem")
        .mockResolvedValue({
          ok: false,
          reason: "unsupported",
          message: "test boundary",
        } as never);
      const model = vi
        .spyOn(fixture.runtime, "useModel")
        .mockImplementation(async () => {
          throw new Error("JSON brief must not call a model");
        });
      try {
        const service = new LifeOpsService(fixture.runtime);
        await resolveOwnerFactStore(fixture.runtime).update(
          { timezone: "Asia/Tokyo" },
          { source: "first_run", recordedAt: new Date().toISOString() },
        );
        const dueAt = "2026-02-05T16:30:00.000Z";
        const kinds = [
          {
            name: "reminder",
            kind: "habit" as const,
            ownerSurface: "OWNER_REMINDERS",
            expected: "reminder",
          },
          {
            name: "habit",
            kind: "habit" as const,
            ownerSurface: "OWNER_ROUTINES",
            expected: "habit",
          },
          {
            name: "routine",
            kind: "routine" as const,
            ownerSurface: "OWNER_ROUTINES",
            expected: "habit",
          },
          {
            name: "todo",
            kind: "habit" as const,
            ownerSurface: "OWNER_TODOS",
            expected: "todo",
          },
        ];
        const expectedOpen = new Map<string, string>();
        const expectedCompleted = new Map<string, string>();
        for (const item of kinds)
          for (const completed of [false, true]) {
            const record = await service.createDefinition({
              title: `${completed ? "Completed" : "Open"} ${item.name}`,
              kind: item.kind,
              timezone: "Asia/Tokyo",
              cadence: { kind: "once", dueAt, visibilityLeadMinutes: 0 },
              metadata: {
                ownerSurface: item.ownerSurface,
                nativeProjection: "in_app_only",
              },
              reminderPlan: null,
            });
            const [occurrence] =
              await service.repository.listOccurrencesForDefinition(
                fixture.runtime.agentId,
                record.definition.id,
              );
            if (!occurrence) throw new Error("Missing stored occurrence");
            if (completed) {
              await service.completeOccurrence(occurrence.id, {});
              await service.updateDefinition(record.definition.id, {
                status: "archived",
              });
              expectedCompleted.set(occurrence.id, item.expected);
            } else expectedOpen.set(occurrence.id, item.expected);
          }
        const peer = new LifeOpsService(fixture.runtime, {
          ownerEntityId: crypto.randomUUID() as UUID,
        });
        const sibling = await peer.createDefinition({
          title: "Sibling private reminder",
          kind: "habit",
          timezone: "Asia/Tokyo",
          cadence: { kind: "once", dueAt },
          metadata: {
            ownerSurface: "OWNER_REMINDERS",
            nativeProjection: "in_app_only",
          },
          reminderPlan: null,
        });
        await expect(
          service.getDefinition(sibling.definition.id),
        ).rejects.toThrow("not found");
        const overview = await service.getOverview();
        const before = await service.listDefinitions();
        const beforeOccurrences =
          await service.repository.listOccurrencesForDefinitions(
            fixture.runtime.agentId,
            before.map((record) => record.definition.id),
          );
        const batches = vi.spyOn(LifeOpsService.prototype, "listDefinitions");
        setBriefComposers({
          loadCalendar: async () => [],
          loadInbox: async () => [],
          loadCommitments: async () => [],
        });
        const result = await callBrief(fixture.runtime, makeMessage(), {
          action: "DAILY_DIGEST",
          format: "json",
        });
        const briefing = result.data?.briefing as LifeOpsBriefing;
        expect(result.success).toBe(true);
        expect(briefing.sourceErrors).toBeUndefined();
        expect(batches).toHaveBeenCalledTimes(2);
        batches.mockRestore();
        expect(briefing.lifeSummary).toEqual(overview.summary);
        expect(
          new Map(briefing.sections.life?.map((item) => [item.id, item.kind])),
        ).toEqual(expectedOpen);
        expect(
          new Map(
            briefing.sections.completedToday?.map((item) => [
              item.id,
              item.kind,
            ]),
          ),
        ).toEqual(expectedCompleted);
        expect(
          briefing.sections.completedToday?.every(
            (item) => item.completedAt === "2026-02-05T16:00:00.000Z",
          ),
        ).toBe(true);
        const completionPrompt = buildNarrativePrompt({
          kind: "evening",
          period: "today",
          sections: briefing.sections,
          timeZone: "Asia/Tokyo",
          asOf: "2026-02-05T16:00:00.000Z",
        });
        const completionPayload = JSON.parse(
          completionPrompt.split("Data:\n")[1],
        );
        expect(
          completionPayload.sections.completedToday[0].timeContext.completedAt
            .localTime,
        ).toBe("Feb 6, 2026, 1:00 AM GMT+9");
        expect(
          completionPayload.sections.completedToday[0].timeContext.completedAt
            .localDate,
        ).toBe("2026-02-06");

        for (const item of [
          ...(briefing.sections.life ?? []),
          ...(briefing.sections.completedToday ?? []),
        ])
          expect(item.dueAt).toBe(dueAt);
        expect(JSON.stringify(briefing)).not.toContain(
          sibling.definition.title,
        );
        expect(await service.listDefinitions()).toEqual(before);
        expect(
          await service.repository.listOccurrencesForDefinitions(
            fixture.runtime.agentId,
            before.map((record) => record.definition.id),
          ),
        ).toEqual(beforeOccurrences);
        expect(native).not.toHaveBeenCalled();
        expect(model).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
        await fixture.cleanup();
      }
    }, 120000);

    it.each(["missing", "sibling", "completed-missing"])(
      "reports unavailable classification for %s references without guessing or disclosing siblings",
      async (reference) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-02-05T16:00:00.000Z"));
        const fixture = await createLifeOpsTestRuntime();
        const { LifeOpsService } = await import("../src/lifeops/service.js");
        const model = vi
          .spyOn(fixture.runtime, "useModel")
          .mockImplementation(async () => {
            throw new Error("JSON brief must not call a model");
          });
        try {
          const service = new LifeOpsService(fixture.runtime);
          const own = await service.createDefinition({
            title: "Own legitimate habit",
            kind: "habit",
            timezone: "Asia/Tokyo",
            cadence: { kind: "once", dueAt: "2026-02-05T16:30:00.000Z" },
            metadata: { ownerSurface: "OWNER_ROUTINES" },
            reminderPlan: null,
          });
          const peer = new LifeOpsService(fixture.runtime, {
            ownerEntityId: crypto.randomUUID() as UUID,
          });
          const sibling = await peer.createDefinition({
            title: "Sibling private title",
            kind: "habit",
            timezone: "Asia/Tokyo",
            cadence: { kind: "once", dueAt: "2026-02-05T16:30:00.000Z" },
            metadata: {
              ownerSurface: "OWNER_REMINDERS",
              nativeProjection: "in_app_only",
            },
            reminderPlan: null,
          });
          const overview = await service.getOverview();
          const source = overview.occurrences.find(
            (occurrence) => occurrence.definitionId === own.definition.id,
          );
          if (!source) throw new Error("Missing own occurrence");
          const fake = {
            ...source,
            definitionId:
              reference === "sibling"
                ? sibling.definition.id
                : "missing-definition",
            title: sibling.definition.title,
          };
          if (reference === "completed-missing")
            vi.spyOn(
              LifeOpsService.prototype,
              "listOwnerOccurrencesCompletedToday",
            ).mockResolvedValueOnce([{ ...fake, state: "completed" }]);
          else
            vi.spyOn(
              LifeOpsService.prototype,
              "getOverview",
            ).mockResolvedValueOnce({
              ...overview,
              occurrences: [fake],
              reminders: [],
            });
          const diagnostic = vi
            .spyOn(fixture.runtime, "reportError")
            .mockImplementation(() => {});
          setBriefComposers({
            loadCalendar: async () => [],
            loadInbox: async () => [],
            loadCommitments: async () => [],
          });
          const result = await callBrief(fixture.runtime, makeMessage(), {
            action:
              reference === "completed-missing"
                ? "compose_evening"
                : "compose_morning",
            format: "json",
          });
          const briefing = result.data?.briefing as LifeOpsBriefing;
          const failedSource =
            reference === "completed-missing" ? "completedToday" : "life";
          expect(result.success).toBe(true);
          expect(briefing.sourceErrors).toMatchObject({
            [failedSource]: "unavailable",
          });
          expect(briefing.sections[failedSource]).toEqual([]);
          expect(JSON.stringify(briefing)).not.toContain(
            sibling.definition.title,
          );
          expect(diagnostic).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
              code: "BRIEF_DEFINITION_CLASSIFICATION_UNAVAILABLE",
            }),
            expect.objectContaining({ source: failedSource }),
          );
          expect(model).not.toHaveBeenCalled();
        } finally {
          vi.restoreAllMocks();
          await fixture.cleanup();
        }
      },
      120000,
    );
  });

  describe("compose_evening — completed-today wins (#16935)", () => {
    it("aggregates completedToday and feeds it to the narrative prompt", async () => {
      const useModel = vi.fn(async () => "evening narrative");
      const runtime = makeRuntime({ useModel });
      const loadCompletedToday = vi.fn(async () => [
        {
          id: "occ-done-1",
          kind: "todo" as const,
          title: "Sorted receipts",
          dueAt: null,
        },
      ]);
      setBriefComposers({
        loadLife: async () => [
          {
            id: "todo-open-1",
            kind: "todo" as const,
            title: "File the invoice",
            dueAt: null,
          },
        ],
        loadCompletedToday,
      });

      const result = await callBrief(runtime, makeMessage(), {
        subaction: "compose_evening",
      });
      expect(result.success).toBe(true);
      const data = result.data as {
        briefing: { sections: Record<string, unknown[]> };
      };
      expect(data.briefing.sections.completedToday).toEqual([
        expect.objectContaining({ title: "Sorted receipts" }),
      ]);
      // The narrative model sees the wins alongside the open items, and the
      // baseline instructions demand wins-first ordering for evening briefs.
      const [, args] = useModel.mock.calls[0] as [string, { prompt: string }];
      expect(args.prompt).toContain("Sorted receipts");
      expect(args.prompt).toContain("completedToday");
      expect(args.prompt).toContain("LEAD with those finished");
    });

    // Regression (#16966 post-merge review): the completed-today catch used
    // to degrade with a log-only warn — a broken load silently read as a
    // win-less day. The J4 degrade must surface through runtime.reportError
    // so RECENT_ERRORS and owner escalation see it.
    it("surfaces a failed completed-today load via reportError while the brief still composes", async () => {
      const reportError = vi.fn();
      // Default composers + a runtime with no LifeOpsService: the DEFAULT
      // loadCompletedTodayFromService path fails for real and must degrade
      // through its own J4 catch, not an injected stand-in.
      const runtime = makeRuntime({ reportError });
      const result = await callBrief(runtime, makeMessage(), {
        subaction: "compose_evening",
        include: {
          calendar: false,
          inbox: false,
          life: true,
          commitments: false,
        },
        format: "json",
      });
      expect(result.success).toBe(true);
      const data = result.data as {
        briefing: { sections: Record<string, unknown> };
      };
      expect(data.briefing.sections.completedToday).toEqual([]);
      expect(result.data?.briefing).toMatchObject({
        sourceErrors: { life: "unavailable", completedToday: "unavailable" },
      });
      expect(reportError).toHaveBeenCalledTimes(2);
      expect(reportError).toHaveBeenCalledWith(
        "Brief.loadCompletedToday",
        expect.anything(),
        { source: "completedToday" },
      );
    });

    it("keeps morning briefs forward-looking (no completedToday load)", async () => {
      const useModel = vi.fn(async () => "morning narrative");
      const runtime = makeRuntime({ useModel });
      const loadCompletedToday = vi.fn(async () => []);
      setBriefComposers({ loadCompletedToday });
      const result = await callBrief(runtime, makeMessage(), {
        subaction: "compose_morning",
      });
      expect(result.success).toBe(true);
      expect(loadCompletedToday).not.toHaveBeenCalled();
      const data = result.data as {
        briefing: { sections: Record<string, unknown[]> };
      };
      expect(data.briefing.sections.completedToday).toBeUndefined();
    });
  });

  describe("narrative compose pass", () => {
    it.each(["narrative", "json"] as const)(
      "licenses %s output without changing source facts or reply text",
      async (format) => {
        const narrative =
          "I'll focus on the open reminder. Screen break is due at 7 pm.";
        const useModel = vi.fn(async () => narrative);
        setBriefComposers({
          loadCalendar: async () => [],
          loadLife: async () => ({
            items: [
              {
                id: "screen-break",
                kind: "reminder",
                title: "Screen break",
                state: "visible",
                dueAt: "2026-10-03T19:00:00.000Z",
              },
            ],
            summary: {
              activeOccurrenceCount: 1,
              overdueOccurrenceCount: 1,
              snoozedOccurrenceCount: 0,
              activeReminderCount: 1,
              activeGoalCount: 0,
            },
          }),
          loadCompletedToday: async () => [],
          loadCommitments: async () => [],
        });
        const result = await callBrief(
          makeRuntime({ useModel }),
          makeMessage(),
          {
            action: "compose_evening",
            format,
            include: {
              calendar: true,
              inbox: false,
              life: true,
              commitments: true,
            },
          },
        );
        expect(result.success).toBe(true);
        expect(result.userFacingText).toBe(result.text);
        expect(result.turnComplete).toBe(true);
        expect(result.data?.briefing).toMatchObject({
          sections: {
            calendar: [],
            completedToday: [],
            life: [
              { title: "Screen break", dueAt: "2026-10-03T19:00:00.000Z" },
            ],
          },
          lifeSummary: { activeReminderCount: 1, activeGoalCount: 0 },
        });
        if (format === "narrative") {
          expect(result.userFacingText).toBe(narrative);
          expect(result.verifiedUserFacing).toBeUndefined();
          expect(useModel).toHaveBeenCalledTimes(1);
        } else {
          expect(result.verifiedUserFacing).toBe(true);
          expect(result.userFacingText).toBe(
            "Composed your evening briefing for today.",
          );
          expect(useModel).not.toHaveBeenCalled();
        }
      },
    );

    it("retains healthy persisted items when the canonical owner-zone read fails before narrative generation", async () => {
      const db = await PGlite.create();
      const reportError = vi.fn();
      const useModel = vi.fn(async () => "Must not guess the owner's timezone");
      const runtime = makeRuntime({ reportError, useModel });
      runtime.getSetting = (key) => (key === "TIMEZONE" ? "UTC" : undefined);
      registerCalendarTimeZoneResolver(runtime, async () => {
        const result = await db.query<{ timezone: string }>(
          "SELECT timezone FROM missing_owner_facts",
        );
        return result.rows[0]?.timezone ?? null;
      });
      await db.exec(`CREATE TABLE healthy_life_items (id text, title text, due_at text);
        INSERT INTO healthy_life_items VALUES ('kept-life', 'Persisted healthy item', '2026-10-03T01:00:00.000Z');`);
      setBriefComposers({
        loadLife: async () =>
          (
            await db.query<{ id: string; title: string; due_at: string }>(
              "SELECT * FROM healthy_life_items",
            )
          ).rows.map((item) => ({
            id: item.id,
            title: item.title,
            kind: "todo" as const,
            dueAt: item.due_at,
          })),
      });
      try {
        const result = await callBrief(runtime, makeMessage(), {
          action: "compose_morning",
          format: "narrative",
          include: {
            calendar: true,
            inbox: false,
            life: true,
            commitments: false,
          },
        });
        expect(result.success).toBe(true);
        const briefing = result.data?.briefing as {
          sections: {
            life: Array<{ id: string; title: string; dueAt: string }>;
          };
          sourceErrors: { calendar: string };
          narrative?: string;
        };
        expect(briefing.sections.life).toEqual([
          {
            id: "kept-life",
            title: "Persisted healthy item",
            kind: "todo",
            dueAt: "2026-10-03T01:00:00.000Z",
          },
        ]);
        expect(briefing.sourceErrors).toEqual({ calendar: "unavailable" });
        expect(briefing.narrative).toBeUndefined();
        expect(useModel).not.toHaveBeenCalled();
        expect(reportError).toHaveBeenCalledWith(
          "Brief.loadCalendar",
          expect.objectContaining({
            code: "CALENDAR_TIME_ZONE_UNAVAILABLE",
            cause: expect.objectContaining({ code: "42P01" }),
          }),
          { source: "calendar" },
        );
        expect(result.text).not.toContain("missing_owner_facts");
      } finally {
        await db.close();
      }
    });

    it("degrades to a narrative-less structured briefing when the model call throws", async () => {
      const useModel = vi.fn(async (): Promise<string> => {
        throw new Error("model unavailable");
      });
      const runtime = makeRuntime({ useModel });
      setBriefComposers({
        loadCalendar: async () => [
          {
            id: "evt-9",
            title: "Investor call",
            startAt: "2026-05-11T15:00:00.000Z",
            endAt: "2026-05-11T15:30:00.000Z",
          },
        ],
      });
      const result = await callBrief(runtime, makeMessage(), {
        subaction: "compose_morning",
      });
      expect(result.success).toBe(true);
      expect(useModel).toHaveBeenCalledTimes(1);
      const data = result.data as {
        briefing: { narrative?: string; sections: { calendar: unknown[] } };
      };
      // The structured briefing survives; only the narrative is dropped.
      expect(data.briefing.narrative).toBeUndefined();
      expect(data.briefing.sections.calendar).toHaveLength(1);
    });

    it("omits the narrative when the model returns a non-string payload", async () => {
      const useModel = vi.fn(
        async () => ({ not: "a string" }) as unknown as string,
      );
      const runtime = makeRuntime({ useModel });
      const result = await callBrief(runtime, makeMessage(), {
        subaction: "compose_morning",
      });
      expect(result.success).toBe(true);
      const data = result.data as { briefing: { narrative?: string } };
      expect(data.briefing.narrative).toBeUndefined();
    });

    it("omits the narrative when the model returns only whitespace", async () => {
      const useModel = vi.fn(async () => "   \n\t");
      const runtime = makeRuntime({ useModel });
      const result = await callBrief(runtime, makeMessage(), {
        subaction: "compose_morning",
      });
      expect(result.success).toBe(true);
      const data = result.data as { briefing: Record<string, unknown> };
      expect(data.briefing).not.toHaveProperty("narrative");
    });
  });

  describe("empty inputs", () => {
    it("still returns a structured briefing when every section is empty", async () => {
      const result = await callBrief(makeRuntime(), makeMessage(), {
        subaction: "compose_weekly",
        format: "json",
      });
      expect(result.success).toBe(true);
      const data = result.data as {
        briefing: { sections: { calendar: unknown[] } };
      };
      expect(data.briefing.sections.calendar).toHaveLength(0);
    });
  });
});
