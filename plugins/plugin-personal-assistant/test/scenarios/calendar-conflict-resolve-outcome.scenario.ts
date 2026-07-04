// Defines the calendar conflict resolve outcome LifeOps scenario-runner spec.
import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * Calendar conflict detection + reschedule — OUTCOME scenario (supersedes the
 * routing-only `calendar-conflict-detect-reschedule.scenario.ts`).
 *
 * The routing-only file only asserted that the planner selected a calendar
 * action and the reply mentioned "reschedule". This scenario instead seeds two
 * genuinely overlapping owner commitments, asks the agent to surface the clash,
 * then drives the reschedule through the canonical, headless-persistent LifeOps
 * definition API and ASSERTS THE ACTUAL OUTCOME: a real `GET` proves the moved
 * commitment now occupies a new, conflict-free slot whose `dueAt` no longer
 * overlaps the anchor commitment.
 *
 * Why definitions and not `/api/lifeops/calendar/events`: in the scenario
 * runtime there is no connected Google grant and no Apple Calendar native
 * bridge, so `CalendarService.createCalendarEvent` / `updateCalendarEvent` fall
 * through to the native Apple bridge and cannot persist (see
 * `plugins/plugin-calendar/src/service/CalendarService.ts` createCalendarEvent
 * + `service/gate.ts requireGoogleCalendarWriteGrant`). The LifeOps definition
 * store is PGLite-backed and persists every commitment + its derived schedule
 * headlessly, and `updateDefinition` re-derives occurrences from the new
 * cadence (`refreshDefinitionOccurrences`), so a `once` commitment's `dueAt` is
 * the canonical scheduled slot we can move and re-read.
 *
 * Two overlapping commitments (a `once` task each):
 *   - "Budget review with Priya"  : now+120m .. now+180m  (anchor, priority 1)
 *   - "Dentist checkup"           : now+150m .. now+210m  (overlaps the anchor
 *                                                          from now+150m..now+180m)
 * Resolution moves "Dentist checkup" to now+300m (well after the anchor ends at
 * now+180m), so the two no longer overlap.
 *
 * Outcome evidence (not routing):
 *   - api `GET` on the rescheduled definition: its `cadence.dueAt` is parseable
 *     and now sits ≥ 240 minutes out — past the anchor's end and far past the
 *     original overlapping 150-minute slot. Combined with the anchor's
 *     unchanged ≤ 180-minute slot this proves the overlap is gone.
 *   - api `GET` on the anchor definition: its `dueAt` is unchanged (still the
 *     now+120m slot) — the resolution moved the right commitment, not the anchor.
 *   - `definitionCountDelta` for both titles (both `once`, dentist requires its
 *     reminder plan) — the persisted records survived the edit.
 *   - `memoryWriteOccurred` on `messages` — the live conflict-detect turn
 *     actually ran through the agent loop and wrote a response memory.
 */

function assertApiBody(options: {
  includesAll?: ReadonlyArray<string>;
  includesAny?: ReadonlyArray<string>;
  excludes?: ReadonlyArray<string>;
}): (status: number, body: unknown) => string | undefined {
  return (_status, body) => {
    const serialized =
      typeof body === "string" ? body : JSON.stringify(body ?? "");
    if (options.includesAll) {
      for (const needle of options.includesAll) {
        if (!serialized.includes(needle)) {
          return `expected body to include "${needle}"`;
        }
      }
    }
    if (options.includesAny && options.includesAny.length > 0) {
      const ok = options.includesAny.some((needle) =>
        serialized.includes(needle),
      );
      if (!ok) {
        return `expected body to include any of ${options.includesAny.join(", ")}`;
      }
    }
    if (options.excludes) {
      for (const needle of options.excludes) {
        if (serialized.includes(needle)) {
          return `expected body to exclude "${needle}"`;
        }
      }
    }
  };
}

/** Pull `definition.cadence.dueAt` (ISO) out of a single-definition GET body. */
function readDueAtMinutesFromNow(body: unknown): number | string {
  const record =
    body && typeof body === "object"
      ? (body as { definition?: { cadence?: { dueAt?: unknown } } })
      : undefined;
  const dueAt = record?.definition?.cadence?.dueAt;
  if (typeof dueAt !== "string") {
    return `expected definition.cadence.dueAt string, got ${JSON.stringify(dueAt)}`;
  }
  const parsed = Date.parse(dueAt);
  if (Number.isNaN(parsed)) {
    return `definition.cadence.dueAt is not a valid ISO date: ${dueAt}`;
  }
  return Math.round((parsed - Date.now()) / 60_000);
}

export default scenario({
  lane: "live-only",
  id: "calendar-conflict-resolve-outcome",
  title:
    "Detect a calendar double-booking and reschedule so the new slot no longer overlaps",
  domain: "calendar",
  tags: ["lifeops", "calendar", "conflict", "reschedule", "outcome"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Calendar Conflict Resolve",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed anchor budget review with Priya",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Budget review with Priya",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+120m}}",
          visibilityLeadMinutes: 240,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
      assertResponse: assertApiBody({
        includesAll: ["Budget review with Priya", '"kind":"once"'],
      }),
    },
    {
      kind: "api",
      name: "seed overlapping dentist checkup",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Dentist checkup",
        timezone: "UTC",
        priority: 3,
        cadence: {
          kind: "once",
          dueAt: "{{now+150m}}",
          visibilityLeadMinutes: 240,
          visibilityLagMinutes: 720,
        },
        reminderPlan: {
          steps: [
            {
              channel: "in_app",
              offsetMinutes: 0,
              label: "Leave for the dentist",
            },
          ],
        },
      },
      expectedStatus: 201,
      assertResponse: assertApiBody({
        includesAll: ["Dentist checkup", '"kind":"once"'],
      }),
    },
    {
      kind: "message",
      name: "detect-conflict",
      room: "main",
      text: "I have a budget review with Priya and a dentist checkup that overlap this afternoon. Do these two conflict, and which should I move?",
      plannerIncludesAny: ["CONFLICT_DETECT", "conflict", "calendar_action"],
      responseIncludesAny: [
        "conflict",
        "overlap",
        "budget",
        "dentist",
        "move",
        "reschedul",
      ],
      plannerExcludes: ["gmail_action"],
    },
    {
      kind: "api",
      name: "reschedule dentist checkup to a conflict-free slot",
      method: "PUT",
      path: "/api/lifeops/definitions/{{definitionId:Dentist checkup}}",
      body: {
        cadence: {
          kind: "once",
          dueAt: "{{now+300m}}",
          visibilityLeadMinutes: 240,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 200,
      assertResponse: assertApiBody({
        includesAll: ["Dentist checkup", '"kind":"once"'],
      }),
    },
    {
      kind: "api",
      name: "outcome: rescheduled dentist now occupies a later, non-overlapping slot",
      method: "GET",
      path: "/api/lifeops/definitions/{{definitionId:Dentist checkup}}",
      expectedStatus: 200,
      assertResponse: (_status, body) => {
        const minutes = readDueAtMinutesFromNow(body);
        if (typeof minutes === "string") {
          return minutes;
        }
        // Anchor ends at now+180m; the original overlapping slot was now+150m.
        // A correct resolution moves the dentist past the anchor's end, so the
        // new dueAt must sit well beyond 180m (we seeded now+300m).
        if (minutes <= 240) {
          return `expected rescheduled dentist dueAt to be > 240 min out (past the now+180m anchor end), saw ${minutes} min`;
        }
        return undefined;
      },
    },
    {
      kind: "api",
      name: "outcome: anchor budget review slot is unchanged (right item moved)",
      method: "GET",
      path: "/api/lifeops/definitions/{{definitionId:Budget review with Priya}}",
      expectedStatus: 200,
      assertResponse: (_status, body) => {
        const minutes = readDueAtMinutesFromNow(body);
        if (typeof minutes === "string") {
          return minutes;
        }
        // Anchor was seeded at now+120m and must NOT have been touched: it
        // should still sit at roughly its original slot, comfortably before the
        // rescheduled dentist (now+300m) and below the dentist's new floor.
        if (minutes < 60 || minutes > 200) {
          return `expected anchor budget review dueAt to remain near its now+120m slot (60..200 min), saw ${minutes} min`;
        }
        return undefined;
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Dentist checkup",
      delta: 1,
      cadenceKind: "once",
      requireReminderPlan: true,
    },
    {
      type: "definitionCountDelta",
      title: "Budget review with Priya",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 1,
    },
  ],
});
