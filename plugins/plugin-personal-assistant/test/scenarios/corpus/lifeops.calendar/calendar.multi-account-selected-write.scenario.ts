/**
 * Exercises account clarification followed by an explicitly selected Google
 * write with a live model. Provider transport and credentials are simulated.
 */
import { AgentRuntime, getConnectorAccountManager } from "@elizaos/core";
import { scenario } from "@elizaos/testing";
import { z } from "zod";
import { CalendarRepository } from "../../../../../plugin-calendar/src/service/CalendarRepository.ts";
import { createApprovalQueue } from "../../../../src/lifeops/approval-queue.ts";
import clarification, {
  calendarRequestsSinceSeed,
} from "./calendar.multi-account-selection.scenario.ts";

const unchanged = clarification.finalChecks?.find(
  (check) =>
    check.type === "custom" &&
    check.name === "calendar-unchanged-before-account-choice",
);
if (unchanged?.type !== "custom")
  throw new Error(
    "Selected-account journey requires the clarification mutation oracle",
  );
const assertUnchanged = unchanged.predicate;
const title = "Cedar focus block";
const startAt = "2027-02-05T15:00:00.000Z";
const endAt = "2027-02-05T15:30:00.000Z";

export async function eventProposals(runtime: AgentRuntime) {
  const queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
  return (
    await queue.list({
      subjectUserId: null,
      state: null,
      action: "schedule_event",
      limit: null,
    })
  ).filter(
    (request) =>
      request.payload.action === "schedule_event" &&
      request.payload.title === title,
  );
}

export default scenario({
  ...clarification,
  id: "calendar.multi-account-selected-write",
  title:
    "Clarify the Google account, then persist the user's selected destination",
  lane: "live-only",
  turns: [
    {
      kind: "message",
      name: "request-google-event-without-account",
      room: "main",
      text: `Create a solo Google Calendar event titled ${title} on February 5, 2027 from 15:00 to 15:30 UTC.`,
      responseJudge: {
        rubric:
          "Ask which of the two connected Google accounts, personal@example.test or work@company.test, to use. Do not select an account or claim the event was created. A clear personal-versus-work account choice satisfies this, including when calendar names are shown; exact email-address wording is not required.",
        minimumScore: 1,
      },
      timeoutMs: 120_000,
    },
    {
      kind: "wait",
      name: "no-write-before-account-choice",
      timeoutMs: 5_000,
      until: async (ctx) => {
        const result = await assertUnchanged(ctx);
        if (result !== undefined && result !== true)
          throw new Error(
            `Calendar changed before account selection: ${JSON.stringify(result)}`,
          );
        if (!(ctx.runtime instanceof AgentRuntime))
          throw new Error("Real runtime required");
        if ((await eventProposals(ctx.runtime)).length !== 0)
          throw new Error("Calendar proposal queued before account selection");
        return true;
      },
    },
    {
      kind: "message",
      name: "select-work-account",
      room: "main",
      text: `Use work@company.test, its primary Google calendar. Yes, create ${title} on February 5, 2027 from 15:00 to 15:30 UTC, with no guests.`,
      timeoutMs: 120_000,
    },
    {
      kind: "wait",
      name: "no-write-before-proposal-approval",
      timeoutMs: 5_000,
      until: async (ctx) => {
        const result = await assertUnchanged(ctx);
        if (result !== undefined && result !== true)
          throw new Error(
            `Calendar changed before approval: ${JSON.stringify(result)}`,
          );
        return true;
      },
    },
    {
      kind: "message",
      name: "approve-selected-account-proposal",
      room: "main",
      text: "Yes, approve the pending Cedar focus block proposal for work@company.test, primary Google calendar, February 5, 2027 from 15:00 to 15:30 UTC. Execute it once.",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "selected-account-event-and-provider-readback",
      predicate: async (ctx) => {
        if (!(ctx.runtime instanceof AgentRuntime))
          throw new Error("Real runtime required");
        const runtime = ctx.runtime;
        const account = (
          await getConnectorAccountManager(runtime).listAccounts("google")
        ).find((candidate) => candidate.externalId === "work@company.test");
        if (!account) return "Selected Google account is missing";
        const proposals = await eventProposals(runtime);
        if (proposals.length !== 1 || proposals[0].state !== "done")
          return "Expected exactly one completed Calendar proposal";
        const payload = proposals[0].payload;
        if (
          payload.action !== "schedule_event" ||
          payload.grantId !== `connector-account:${account.id}` ||
          payload.calendarId !== "primary"
        )
          return "Completed proposal was not bound to the selected account/calendar";
        const writes = (await calendarRequestsSinceSeed(runtime)).filter(
          (request) =>
            request.method !== "GET" &&
            /\/calendars\/[^/]+\/events(?:\/|$)/.test(request.path),
        );
        if (writes.length !== 1 || writes[0].method !== "POST")
          return `Expected one provider event creation, observed ${writes.length} mutations`;
        const repo = new CalendarRepository(runtime);
        const rows = (
          await repo.listCalendarEvents(runtime.agentId, "google")
        ).filter((event) => event.title === title);
        if (rows.length !== 1)
          return `Expected one created Google event, observed ${rows.length}`;
        const event = rows[0];
        if (
          event.grantId !== `connector-account:${account.id}` ||
          event.startAt !== startAt ||
          event.endAt !== endAt
        )
          return "Created event has the wrong selected account or time range";
        if (
          (await repo.listCalendarEvents(runtime.agentId, "eliza")).some(
            (event) => event.title === title,
          )
        )
          return "Created an unwanted built-in Calendar fallback";
        const base = process.env.ELIZA_MOCK_GOOGLE_BASE;
        if (!base) throw new Error("Google fixture server required");
        const response = await fetch(
          new URL(
            `/calendar/v3/calendars/primary/events/${encodeURIComponent(event.externalId)}`,
            base,
          ),
          {
            headers: {
              Authorization: "Bearer mock-google-access-token-work-grant-1",
            },
          },
        );
        if (!response.ok)
          return `Provider readback returned ${response.status}`;
        const wire = z
          .object({
            id: z.string(),
            summary: z.string(),
            start: z.object({ dateTime: z.string() }),
            end: z.object({ dateTime: z.string() }),
          })
          .parse(await response.json());
        return wire.id === event.externalId &&
          wire.summary === title &&
          Date.parse(wire.start.dateTime) === Date.parse(startAt) &&
          Date.parse(wire.end.dateTime) === Date.parse(endAt)
          ? undefined
          : "Provider event differs from persisted selected-account result";
      },
    },
  ],
});
