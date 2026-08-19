/** Proves CALENDAR creates a built-in event with an applied receipt and reads it back durably. */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

const TITLE = "Connector contract product review";
const START = "2026-08-20T16:00:00-07:00";
const END = "2026-08-20T16:30:00-07:00";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function assertCalendarCreateAndReadback(
  ctx: ScenarioContext,
): string | undefined {
  const calls = ctx.actionsCalled.filter(
    (candidate) => candidate.actionName === "CALENDAR",
  );
  if (calls.length !== 2)
    return `expected two CALENDAR calls, saw ${calls.length}`;
  const create = calls[0]?.result;
  const createData = record(create?.data);
  const event = record(createData.event);
  if (
    create?.success !== true ||
    createData.approvalRequired !== false ||
    event.title !== TITLE ||
    event.grantId !== "eliza-calendar" ||
    event.calendarId !== "primary"
  ) {
    return `CALENDAR create omitted its exact built-in event: ${JSON.stringify(create)}`;
  }
  const receipts = Array.isArray(record(create?.raw).effectReceipts)
    ? (record(create?.raw).effectReceipts as Array<Record<string, unknown>>)
    : [];
  const receipt = receipts.find(
    (candidate) => candidate.operation === "calendar.event.create",
  );
  const resource = record(receipt?.resource);
  const commit = record(receipt?.commit);
  if (
    receipt?.outcome !== "applied" ||
    resource.kind !== "calendar.event" ||
    resource.id !== event.id ||
    commit.kind !== "durable" ||
    commit.id !== event.id
  ) {
    return `CALENDAR create omitted an applied durable receipt: ${JSON.stringify(create?.raw)}`;
  }

  const read = calls[1]?.result;
  const readSurface = JSON.stringify({ data: read?.data, raw: read?.raw });
  if (read?.success !== true || !readSurface.includes(String(event.id))) {
    return `CALENDAR readback did not return created event ${String(event.id)}: ${readSurface}`;
  }
  if (!readSurface.includes(TITLE)) {
    return `CALENDAR readback did not preserve the exact title: ${readSurface}`;
  }
  return undefined;
}

const routing = {
  metadata: { __responseContext: { primaryContext: "calendar" } },
};

export default scenario({
  lane: "pr-deterministic",
  id: "connector.google-calendar.contract-core",
  title: "Calendar create returns a durable receipt and exact readback",
  domain: "connector-contract",
  evidenceScope: "domain-contract",
  executionProfile: "simulated",
  tags: [
    "connector-contract",
    "google-calendar",
    "calendar-lifecycle",
    "durable-readback",
  ],
  description:
    "Executes production CALENDAR against the built-in first-party calendar source. It proves exact event creation, an applied durable effect receipt, and read-after-write visibility without claiming an external Google API write.",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Calendar contract",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "create-calendar-event",
      room: "main",
      actionName: "CALENDAR",
      text: "Create the fixed product-review event in the built-in calendar.",
      content: routing,
      options: {
        parameters: {
          subaction: "create_event",
          title: TITLE,
          details: {
            grantId: "eliza-calendar",
            calendarId: "primary",
            startAt: START,
            endAt: END,
            timeZone: "America/Los_Angeles",
          },
        },
      },
    },
    {
      kind: "action",
      name: "read-calendar-event-back",
      room: "main",
      actionName: "CALENDAR",
      text: "Read back the exact product-review event from the built-in calendar.",
      content: routing,
      options: {
        parameters: {
          subaction: "search_events",
          query: TITLE,
          details: {
            grantId: "eliza-calendar",
            calendarId: "primary",
            timeMin: "2026-08-20T00:00:00-07:00",
            timeMax: "2026-08-21T00:00:00-07:00",
            timeZone: "America/Los_Angeles",
          },
        },
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "CALENDAR",
      status: "success",
      minCount: 2,
    },
    {
      type: "custom",
      name: "calendar-applied-receipt-and-readback",
      predicate: assertCalendarCreateAndReadback,
    },
  ],
});
