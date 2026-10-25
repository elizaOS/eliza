import { PGlite } from "@electric-sql/pglite";
import {
  type Action,
  ChannelType,
  type ContextEvent,
  type ContextObject,
  conversationClientUserMemoryId,
  type IAgentRuntime,
  type Memory,
  normalizeEffectReceipt,
  type State,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { appendPriorDialogueEvents } from "./dialogue-context";
import { historicalReceiptGroups } from "./navigation-history";
import { renderMessageHandlerModelInput } from "./stage1-input";

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

it("retains observation admission and complete ordered mutation receipts after JSONB storage and model rendering", async () => {
  const database = new PGlite();
  try {
    await database.exec(
      "CREATE TABLE observation_audit (position integer, result jsonb NOT NULL)",
    );
    const mutations = [
      {
        outcome: "applied",
        commit: {
          kind: "durable",
          id: "local-commit",
          committedAt: read.observedAt,
        },
      },
      {
        outcome: "applied",
        commit: {
          kind: "provider_accepted",
          id: "accepted-commit",
          committedAt: read.observedAt,
        },
      },
      {
        outcome: "noop",
        reason: "Verified earlier commit",
        idempotency: { key: "earlier-operation", replayed: true },
      },
      {
        outcome: "failed",
        failure: { code: "REJECTED", retryable: false, acceptance: "rejected" },
      },
      {
        outcome: "failed",
        failure: { code: "TIMEOUT", retryable: true, acceptance: "unknown" },
      },
      {
        outcome: "rolled_back",
        rollback: {
          receiptId: "compensation",
          revertedReceiptIds: ["mutation-0", "mutation-1"],
          rolledBackAt: read.observedAt,
        },
      },
      { outcome: "preview" },
    ];
    const inputs = [
      result(),
      ...Array.from({ length: 28 }, (_, index) => {
        const variant = mutations[index % mutations.length];
        const receipt = normalizeEffectReceipt({
          ...read,
          receiptId: `mutation-${index}`,
          operation: "calendar.event.create",
          resource: {
            kind: "calendar.event",
            id: `event-${index}`,
            ...(index % 2 ? { version: "v2" } : {}),
          },
          artifacts:
            index % 2
              ? [
                  {
                    kind: "calendar.child",
                    id: `child-${index}`,
                    version: "v1",
                  },
                ]
              : [],
          ...variant,
        });
        return result(receipt, {
          success: receipt.outcome !== "failed",
          // Mixed observation and mutation results retain their separate lanes.
          effectReceipts: index === 0 ? [read, receipt] : [receipt],
        });
      }),
    ];
    for (const [position, input] of inputs.entries())
      await database.query(
        "INSERT INTO observation_audit VALUES ($1, $2::jsonb)",
        [position, JSON.stringify(input)],
      );
    const stored = await database.query<{ result: Record<string, unknown> }>(
      "SELECT result FROM observation_audit ORDER BY position",
    );
    const grouped = historicalReceiptGroups(
      stored.rows.map((row) => row.result),
      [owner],
    );
    expect(grouped.observations).toEqual([
      { actionName: owner.name, success: true, receipt: read },
      { actionName: owner.name, success: true, receipt: read },
    ]);
    expect(grouped.effects).toHaveLength(28);
    const scope = "agent:room:owner";
    const originals = stored.rows.map(({ result: actionResult }, index) => {
      const clientMessageId = `stored-${index}`;
      const id = conversationClientUserMemoryId(scope, clientMessageId);
      return {
        id,
        agentId: "agent",
        roomId: "room",
        entityId: "owner",
        createdAt: index,
        content: {
          text: `Original request ${index}.`,
          source: "client_chat",
          channelType: ChannelType.DM,
          chatIdempotency: {
            version: 1,
            scope,
            clientMessageId,
            fingerprint: "a".repeat(64),
            outcomeJson: JSON.stringify({
              userMessageId: id,
              actionResults: [actionResult],
            }),
          },
        },
      } as Memory;
    });
    const before = structuredClone(originals);
    const events: ContextEvent[] = [];
    appendPriorDialogueEvents(
      events,
      { agentId: "agent", actions: [owner] } as IAgentRuntime,
      {
        data: {
          providers: {
            RECENT_MESSAGES: { data: { recentMessages: originals } },
          },
        },
      } as State,
      {
        id: "current",
        agentId: "agent",
        roomId: "room",
        entityId: "owner",
        content: { text: "What happened to the original requests?" },
      } as Memory,
    );
    const context: ContextObject = { id: "stored-receipts", events };
    // These opaque/future shapes exercise the existing rendering boundary,
    // not admission of malformed records as normalized effect receipts.
    for (const shape of [
      "stored",
      "future-child",
      "opaque-child",
      "future-top",
      "malformed",
    ]) {
      const wireContext = structuredClone(context);
      for (const event of wireContext.events) {
        if (
          event.type !== "segment" ||
          event.segment.label !== "runtime:historical_effects"
        )
          continue;
        const record = JSON.parse(event.segment.content);
        for (const outcome of record.outcomes) {
          if (shape === "future-child")
            outcome.receipt.resource = {
              ...outcome.receipt.resource,
              futureField: null,
              opaqueArray: ["Ω", null, {}],
              emptyObject: {},
            };
          if (shape === "opaque-child") {
            outcome.receipt.resource = {};
            outcome.receipt.idempotency = null;
            if ("commit" in outcome.receipt) outcome.receipt.commit = [];
          }
          if (shape === "future-top")
            outcome.receipt.futureField = {
              original: "  Ω  ",
              values: [null, [], {}],
            };
          if (shape === "malformed")
            outcome.receipt = "Opaque malformed receipt — unchanged";
        }
        event.segment.content = JSON.stringify(record);
      }
      const canonical = wireContext.events.flatMap((event) =>
        event.type === "segment" &&
        event.segment.label === "runtime:historical_effects"
          ? [JSON.parse(event.segment.content)]
          : [],
      );
      const contextBefore = structuredClone(wireContext);
      for (const directMessage of [true, false]) {
        const rendered = renderMessageHandlerModelInput(
          { character: { name: "Eliza" } },
          wireContext,
          [],
          { directMessage },
        );
        const legends = new Map();
        const decoded = [];
        let sawNestedShape = false;
        for (const segment of rendered.promptSegments) {
          if (!segment.label?.startsWith("runtime:historical_")) continue;
          const body = JSON.parse(segment.content.trim());
          if (segment.label === "runtime:historical_receipt_encoding") {
            legends.set(body.id, { ...body, decodedReceipts: [] });
            continue;
          }
          if (!segment.label.startsWith("runtime:historical_effects")) continue;
          if (!Array.isArray(body) && !body.rows) {
            decoded.push(body);
            continue;
          }
          const table = Array.isArray(body)
            ? legends.get(body[0])
            : { ...body, decodedReceipts: [] };
          expect(table).toBeDefined();
          expect(table.columns).toEqual(["requestSourceEventId", "outcomes"]);
          const rows = Array.isArray(body) ? [body[1]] : body.rows;
          for (const [requestSourceEventId, outcomes] of rows) {
            const completeOutcomes = outcomes.map((columns: unknown[]) =>
              Object.fromEntries(
                table.receiptColumns.map((column: string, index: number) => {
                  let value = columns[index];
                  if (column === "receipt" && table.receiptShapes) {
                    const encoded = value as unknown[];
                    if (encoded.length === 1) {
                      value = table.decodedReceipts[Number(encoded[0])];
                    } else {
                      const shape = table.receiptShapes[Number(encoded[0])];
                      const values = encoded[1] as unknown[];
                      value = Object.fromEntries(
                        shape.map(
                          (
                            field: string | [string, string[]],
                            fieldIndex: number,
                          ) => {
                            if (typeof field === "string")
                              return [field, values[fieldIndex]];
                            sawNestedShape = true;
                            expect([
                              "resource",
                              "idempotency",
                              "commit",
                              "failure",
                              "rollback",
                            ]).toContain(field[0]);
                            const childValues = values[fieldIndex] as unknown[];
                            expect(childValues).toHaveLength(field[1].length);
                            return [
                              field[0],
                              Object.fromEntries(
                                field[1].map((key, childIndex) => [
                                  key,
                                  childValues[childIndex],
                                ]),
                              ),
                            ];
                          },
                        ),
                      );
                    }
                    table.decodedReceipts.push(value);
                  }
                  return [column, value];
                }),
              ),
            );
            decoded.push({
              requestSourceEventId,
              scope: table.scope,
              outcomes: completeOutcomes,
            });
          }
        }
        if (shape === "stored" || shape === "future-child")
          expect(sawNestedShape).toBe(true);
        if (shape === "future-top" || shape === "malformed")
          expect(sawNestedShape).toBe(false);
        // JSON equality additionally proves original ordered object keys, arrays,
        // null idempotency keys, empty artifacts and every source/occurrence.
        expect(JSON.stringify(decoded)).toBe(JSON.stringify(canonical));
        expect(wireContext).toEqual(contextBefore);
      }
    }
    expect(originals).toEqual(before);
  } finally {
    await database.close();
  }
});
