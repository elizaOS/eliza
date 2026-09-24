/**
 * Builds live-model DST journeys over the real built-in calendar repository.
 * A mandatory between-turn read proves that clarification precedes mutation;
 * final readback checks the chosen instant, duration, identity and other rows.
 * The runner's surrounding connector fixtures are not provider certification.
 */
import { isDeepStrictEqual } from "node:util";
import { AgentRuntime } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/core/contracts/calendar";
import { CalendarRepository } from "@elizaos/plugin-calendar/service/CalendarRepository";
import type { CalendarService } from "@elizaos/plugin-calendar/service/CalendarService";
import { type ScenarioContext, scenario } from "@elizaos/testing";
import { inspectCalendarReschedule } from "./calendar-reschedule-check.js";

interface DstJourney {
  id: string;
  date: string;
  initialStart: string;
  initialEnd: string;
  requestedTime: string;
  clarificationRubric: string;
  choice: string;
  expectedStart: string;
  expectedEnd: string;
}

interface Snapshot {
  rows: LifeOpsCalendarEvent[];
  eventId: string;
  clarificationObserved: boolean;
}

function runtimeFor(ctx: ScenarioContext): AgentRuntime {
  if (!(ctx.runtime instanceof AgentRuntime)) {
    throw new Error("DST journey requires the real scenario AgentRuntime");
  }
  return ctx.runtime;
}

export function calendarDstClarificationJourney(input: DstJourney) {
  const snapshots = new WeakMap<AgentRuntime, Snapshot>();
  const readRows = (runtime: AgentRuntime) =>
    new CalendarRepository(runtime).listCalendarEvents(
      String(runtime.agentId),
      "eliza",
    );
  return scenario({
    id: input.id,
    title: `Clarify ${input.requestedTime} on ${input.date} before rescheduling`,
    domain: "lifeops.calendar",
    lane: "live-only",
    executionProfile: "simulated",
    evidenceScope: "model-behavior",
    tags: ["CAL-16", "calendar", "dst", "clarification", "persisted-state"],
    isolation: "per-scenario",
    requires: {
      plugins: ["@elizaos/plugin-calendar/plugin"],
      services: ["calendar"],
    },
    rooms: [
      {
        id: "main",
        source: "dashboard",
        channelType: "DM",
        title: "DST clarification",
      },
    ],
    seed: [
      {
        type: "custom",
        name: "seed-built-in-calendar",
        apply: async (ctx) => {
          const runtime = runtimeFor(ctx);
          const service = runtime.getService<CalendarService>("calendar");
          if (!service) throw new Error("Calendar service was not started");
          const common = {
            grantId: "eliza-calendar",
            calendarId: "primary",
            timeZone: "America/Los_Angeles",
            notifyAttendees: false,
          };
          const target = await service.createCalendarEventMutation(
            new URL("http://internal.local/api/calendar"),
            {
              ...common,
              title: "Cedar review",
              startAt: input.initialStart,
              endAt: input.initialEnd,
              idempotencyKey: `${input.id}:target`,
            },
          );
          if (!target.event)
            throw new Error("Seed event did not produce a readable receipt");
          await service.createCalendarEventMutation(
            new URL("http://internal.local/api/calendar"),
            {
              ...common,
              title: "Unrelated Cedar afternoon appointment",
              startAt: `${input.date}T22:00:00.000Z`,
              endAt: `${input.date}T22:15:00.000Z`,
              idempotencyKey: `${input.id}:unrelated`,
            },
          );
          snapshots.set(runtime, {
            rows: await readRows(runtime),
            eventId: target.event.id,
            clarificationObserved: false,
          });
          return undefined;
        },
      },
    ],
    turns: [
      {
        kind: "message",
        name: "request-unresolved-local-time",
        room: "main",
        text: `Move my Cedar review in the built-in Eliza Calendar on ${input.date} to ${input.requestedTime}, America/Los_Angeles. Keep its 15-minute duration.`,
        responseJudge: { rubric: input.clarificationRubric, minimumScore: 1 },
        timeoutMs: 120_000,
      },
      {
        kind: "wait",
        name: "persisted-calendar-unchanged-before-choice",
        timeoutMs: 5_000,
        until: async (ctx) => {
          const runtime = runtimeFor(ctx);
          const before = snapshots.get(runtime);
          if (!before) throw new Error("Missing pre-request calendar snapshot");
          if (!isDeepStrictEqual(await readRows(runtime), before.rows)) {
            throw new Error(
              "Calendar changed before the user resolved the local time",
            );
          }
          before.clarificationObserved = true;
          return true;
        },
      },
      {
        kind: "message",
        name: "user-resolves-local-time",
        room: "main",
        text: input.choice,
        timeoutMs: 120_000,
      },
    ],
    finalChecks: [
      {
        type: "custom",
        name: "exact-reschedule-after-clarification",
        predicate: async (ctx) => {
          const runtime = runtimeFor(ctx);
          const before = snapshots.get(runtime);
          if (!before?.clarificationObserved)
            return "Pre-choice persistence check did not run";
          return inspectCalendarReschedule(
            before.rows,
            await readRows(runtime),
            {
              eventId: before.eventId,
              startAt: input.expectedStart,
              endAt: input.expectedEnd,
            },
          );
        },
      },
    ],
  });
}
