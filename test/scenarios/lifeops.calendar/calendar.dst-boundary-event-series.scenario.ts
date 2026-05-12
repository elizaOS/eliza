/**
 * DST boundary on a recurring event series — modify-this-instance must not
 * silently retime sibling instances on the other side of the boundary.
 *
 * Seeds a daily 8am Pacific standup recurring across the 2025 fall-back day.
 * The pre-DST instances should land at 15:00Z, post-DST at 16:00Z. The user
 * asks the agent to "move tomorrow's standup to 9am" — only the named
 * instance should move; the rest of the series must stay anchored at 8am
 * local on their respective dates.
 *
 * Cited: docs/audits/lifeops-2026-05-09/03-coverage-gap-matrix.md — recurring
 * series + DST has no scenario coverage today.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import { seedGoogleConnectorGrant } from "../../mocks/helpers/seed-grants.ts";

const PACIFIC_TZ = "America/Los_Angeles";

function describeAgentRespectedInstanceScope(
  ctx: ScenarioContext,
): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (!reply) return "empty reply on series-vs-instance request";
  // Must indicate the agent handled this as a single instance, not a series
  // sweep. Either it explicitly says "this instance", "just this one", "only
  // today/tomorrow", OR it asked a disambiguation question.
  const instanceSignals = [
    "this instance",
    "just this one",
    "just tomorrow",
    "only this",
    "only tomorrow",
    "single occurrence",
    "this occurrence",
    "single instance",
    "just the one",
  ];
  const clarifySignals = [
    "all of them",
    "every standup",
    "the whole series",
    "every day",
    "future occurrences",
  ];
  const hasInstance = instanceSignals.some((s) => reply.includes(s));
  const askedAboutSeries = clarifySignals.some((s) => reply.includes(s));
  if (!hasInstance && !askedAboutSeries) {
    return `Agent didn't distinguish single-instance vs series. Reply: ${reply.slice(0, 300)}`;
  }
  return undefined;
}

export default scenario({
  id: "calendar.dst-boundary-event-series",
  title: "Daily recurring series across DST boundary respects this-instance scope",
  domain: "lifeops.calendar",
  tags: ["lifeops", "calendar", "dst", "recurring", "robustness"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  mockoon: ["calendar"],
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "DST Series Boundary",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-recurring-standup-across-dst",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await seedGoogleConnectorGrant(runtime, {
          capabilities: ["google.calendar.read", "google.calendar.write"],
        });
        const repo = new LifeOpsRepository(runtime);
        const agentId = String(runtime.agentId);
        // Pre-DST instance — 2025-10-31 08:00 Pacific = 15:00Z (PDT, UTC-7)
        // Post-DST instance — 2025-11-03 08:00 Pacific = 16:00Z (PST, UTC-8)
        const instances = [
          { id: "standup-2025-10-31", startUtc: "2025-10-31T15:00:00.000Z" },
          { id: "standup-2025-11-03", startUtc: "2025-11-03T16:00:00.000Z" },
          { id: "standup-2025-11-04", startUtc: "2025-11-04T16:00:00.000Z" },
        ];
        for (const inst of instances) {
          await repo.upsertCalendarEvent({
            id: inst.id,
            externalId: `${inst.id}-external`,
            agentId,
            provider: "google",
            side: "owner",
            calendarId: "primary",
            title: "Daily standup",
            description: "Daily team standup (recurring)",
            location: "",
            status: "confirmed",
            startAt: inst.startUtc,
            endAt: new Date(Date.parse(inst.startUtc) + 30 * 60_000).toISOString(),
            isAllDay: false,
            timezone: PACIFIC_TZ,
            htmlLink: null,
            conferenceLink: null,
            organizer: null,
            attendees: [],
            metadata: { recurringSeriesId: "standup-series-1" },
            syncedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "move-tomorrow-only",
      room: "main",
      text: "Move tomorrow's daily standup to 9am — just that one instance, not the whole series.",
      expectedActions: ["CALENDAR"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    { type: "actionCalled", actionName: "CALENDAR", minCount: 1 },
    {
      type: "custom",
      name: "agent-respects-single-instance-scope",
      predicate: describeAgentRespectedInstanceScope,
    },
    judgeRubric({
      name: "calendar-dst-series-rubric",
      threshold: 0.6,
      description: `Daily standup recurring across DST fall-back. User asked to move ONLY tomorrow's instance. Correct: agent moves the named instance only and confirms the rest of the series is unchanged. Incorrect: agent retimes the whole series, or silently shifts other instances when computing the new UTC, or fails to acknowledge the single-instance scope. Score 0 if the reply describes changing the series.`,
    }),
  ],
});
