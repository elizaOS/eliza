import { PGlite } from "@electric-sql/pglite";
import {
  type Action,
  ChannelType,
  type ContextEvent,
  conversationClientUserMemoryId,
  type IAgentRuntime,
  type Memory,
  normalizeEffectReceipt,
  type State,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { appendPriorDialogueEvents } from "./dialogue-context";
import { historicalReceiptGroups } from "./navigation-history";

const read = normalizeEffectReceipt({
  receiptId: "read-1",
  operation: "calendar.event.next.read",
  resource: { kind: "calendar.next_event", id: "snapshot", version: "v1" },
  artifacts: [],
  idempotency: { key: null, replayed: false },
  observedAt: "2026-09-25T00:00:00.000Z",
  outcome: "noop",
  reason: "Observed without changes.",
});
const owner = {
  name: "CALENDAR_NEXT_EVENT",
  historicalObservationOperations: ["calendar.event.next.read"],
} as Action;
function result(receipt: unknown = read, extra = {}) {
  return {
    actionName: owner.name,
    success: true,
    effectReceipts: [receipt],
    ...extra,
  };
}

it("projects only successful canonical non-replayed noops for exact currently registered owner declarations", () => {
  const input = [result()];
  const before = structuredClone(input);
  expect(historicalReceiptGroups(input, [owner])).toEqual({
    effects: [],
    observations: [{ actionName: owner.name, success: true, receipt: read }],
  });
  for (const actions of [
    [],
    [{ ...owner, name: "CALENDARNEXTEVENT" }],
    [{ ...owner, historicalObservationOperations: ["calendar.event.next"] }],
    [owner, owner],
  ]) {
    const grouped = historicalReceiptGroups(input, actions);
    expect(grouped.observations).toEqual([]);
    expect(grouped.effects).toHaveLength(1);
  }
  expect(input).toEqual(before);
});
it("keeps mutations, previews, failed results, undeclared noops, replayed noops and noncanonical source evidence inline", () => {
  const applied = normalizeEffectReceipt({
    ...read,
    receiptId: "write-1",
    outcome: "applied",
    commit: { kind: "durable", id: "row", committedAt: read.observedAt },
  });
  const replayed = normalizeEffectReceipt({
    ...read,
    idempotency: { key: "known-operation", replayed: true },
  });
  const cases = [
    result(applied),
    result(replayed),
    result(normalizeEffectReceipt({ ...read, outcome: "preview" })),
    result(read, { success: false }),
    result({ ...read, operation: "calendar.event.create" }),
    result(read, { actionName: "UNREGISTERED" }),
    result({ ...read, unexpectedCommit: { id: "do-not-silently-project" } }),
  ];
  for (const input of cases) {
    const grouped = historicalReceiptGroups([input], [owner]);
    expect(grouped.observations).toEqual([]);
    expect(grouped.effects).toHaveLength(1);
  }
  // Malformed receipts retain the pre-existing core normalization rejection.
  expect(
    historicalReceiptGroups([result({ malformed: true })], [owner]),
  ).toEqual({ effects: [], observations: [] });
  const mixed = historicalReceiptGroups(
    [{ ...result(), effectReceipts: [read, applied] }],
    [owner],
  );
  expect(mixed.observations.map((value) => value.receipt)).toEqual([read]);
  expect(mixed.effects.map((value) => value.receipt)).toEqual([applied]);
});
it("emits bound observation segments without changing original request results or committed evidence", () => {
  const scope = "agent:room:owner";
  const id = conversationClientUserMemoryId(scope, "prior");
  const applied = normalizeEffectReceipt({
    ...read,
    receiptId: "write-1",
    operation: "calendar.event.create",
    outcome: "applied",
    commit: { kind: "durable", id: "row", committedAt: read.observedAt },
  });
  const prior = {
    id,
    agentId: "agent",
    roomId: "room",
    entityId: "owner",
    createdAt: 1,
    content: {
      text: "Previous request.",
      source: "client_chat",
      channelType: ChannelType.DM,
      chatIdempotency: {
        version: 1,
        scope,
        clientMessageId: "prior",
        fingerprint: "a".repeat(64),
        outcomeJson: JSON.stringify({
          userMessageId: id,
          actionResults: [{ ...result(), effectReceipts: [read, applied] }],
        }),
      },
    },
  } as Memory;
  const before = structuredClone(prior);
  const events: ContextEvent[] = [];
  appendPriorDialogueEvents(
    events,
    { agentId: "agent", actions: [owner] } as IAgentRuntime,
    {
      data: {
        providers: { RECENT_MESSAGES: { data: { recentMessages: [prior] } } },
      },
    } as State,
    {
      id: "current",
      agentId: "agent",
      roomId: "room",
      entityId: "owner",
      content: { text: "Current request." },
    } as Memory,
  );
  const segments = events.flatMap((event) =>
    event.type === "segment" ? [event.segment] : [],
  );
  const observation = segments.find(
    (segment) => segment.label === "runtime:historical_observations",
  );
  const effects = segments.find(
    (segment) => segment.label === "runtime:historical_effects",
  );
  expect(JSON.parse(observation?.content ?? "{}")).toMatchObject({
    requestSourceEventId: `history:${id}`,
    observations: [{ actionName: owner.name, success: true, receipt: read }],
  });
  expect(JSON.parse(effects?.content ?? "{}")).toMatchObject({
    requestSourceEventId: `history:${id}`,
    outcomes: [{ actionName: owner.name, success: true, receipt: applied }],
  });
  expect(prior).toEqual(before);
});

it("accepts persisted JSON object-key reordering but rejects extra fields, duplicate IDs and coerced values", () => {
  const reorder = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(reorder)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([key, nested]) => [key, reorder(nested)]),
          )
        : value;
  const persisted = JSON.parse(JSON.stringify(reorder(result()))) as Record<
    string,
    unknown
  >;
  const grouped = historicalReceiptGroups([persisted], [owner]);
  expect(grouped.observations).toEqual([
    { actionName: owner.name, success: true, receipt: read },
  ]);
  expect(grouped.effects).toEqual([]);
  for (const input of [
    result({ ...read, unrecognized: null }),
    { ...result(), effectReceipts: [read, read] },
    result({ ...read, operation: ` ${read.operation} ` }),
  ])
    expect(historicalReceiptGroups([input], [owner]).observations).toEqual([]);
});

it("retains the observation declaration after a real JSONB storage roundtrip", async () => {
  const database = new PGlite();
  try {
    await database.exec(
      "CREATE TABLE observation_audit (result jsonb NOT NULL)",
    );
    await database.query("INSERT INTO observation_audit VALUES ($1::jsonb)", [
      JSON.stringify(result()),
    ]);
    const stored = await database.query<{ result: Record<string, unknown> }>(
      "SELECT result FROM observation_audit",
    );
    const grouped = historicalReceiptGroups(
      stored.rows.map((row) => row.result),
      [owner],
    );
    expect(grouped.observations).toEqual([
      { actionName: owner.name, success: true, receipt: read },
    ]);
    expect(grouped.effects).toEqual([]);
  } finally {
    await database.close();
  }
});
