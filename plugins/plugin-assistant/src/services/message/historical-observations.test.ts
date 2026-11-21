import { PGlite } from "@electric-sql/pglite";
import {
  type Action,
  ChannelType,
  type ContextEvent,
  type ContextObject,
  conversationClientUserMemoryId,
  historicalRequestSourceIds,
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
/** The template a legend's encoding prints after `marker`: a word, or a
 * bracketed list such as [operation,[resourceKind,resourceId],outcome] read
 * as nested name lists. */
function legendTemplate(encoding: string, marker: string): unknown {
  const start = encoding.indexOf(marker) + marker.length;
  expect(start).toBeGreaterThanOrEqual(marker.length);
  if (encoding[start] !== "[") return /^\w+/.exec(encoding.slice(start))?.[0];
  let depth = 0;
  for (let at = start; at < encoding.length; at++) {
    if (encoding[at] === "[") depth++;
    else if (encoding[at] === "]" && --depth === 0)
      return JSON.parse(
        encoding
          .slice(start, at + 1)
          .replace(",...", "")
          .replace(/\w+/g, '"$&"'),
      );
  }
  throw new Error(`legend has no ${marker} template`);
}
/** A [shape,values] receipt read with the legend's receipt template and the
 * detail its shape adds; [resourceKind,resourceId] is resource's kind and id. */
function decodeReceipt(encoding: string, [shape, values]: [number, unknown[]]) {
  const [, base] = legendTemplate(encoding, "receipt=") as [string, unknown[]];
  const fields =
    shape === 0 ? base : [...base, legendTemplate(encoding, `${shape} adds `)];
  expect(fields).toHaveLength(values.length);
  return Object.fromEntries(
    fields.map((field, at) => {
      if (typeof field === "string") return [field, values[at]];
      const children = field as string[];
      const parent = /^[a-z]+/.exec(children[0])?.[0] ?? "";
      expect(["resource", "commit", "failure"]).toContain(parent);
      expect(values[at]).toHaveLength(children.length);
      return [
        parent,
        Object.fromEntries(
          children.map((child, index) => [
            child[parent.length].toLowerCase() + child.slice(parent.length + 1),
            (values[at] as unknown[])[index],
          ]),
        ),
      ];
    }),
  );
}

/** The fields a later step reads, written independently of the wire. */
function slimRecord(
  record: {
    requestSourceEventId: string;
    scope: string;
    outcomes: {
      actionName: string;
      success: boolean;
      receipt: ReturnType<typeof normalizeEffectReceipt>;
    }[];
  },
  context: ContextObject,
) {
  const rollback = record.outcomes.some(
    ({ receipt }) => receipt.outcome === "rolled_back",
  );
  return {
    requestSourceEventId: `history:${historicalRequestSourceIds(context).get(record.requestSourceEventId)}`,
    scope: record.scope,
    outcomes: record.outcomes.map(({ actionName, success, receipt }) => ({
      actionName,
      success,
      receipt: {
        ...(rollback ? { receiptId: receipt.receiptId } : {}),
        operation: receipt.operation,
        resource: { kind: receipt.resource.kind, id: receipt.resource.id },
        ...(receipt.artifacts.length
          ? {
              artifacts: receipt.artifacts.map(
                ({ kind, id }: { kind: string; id: string }) => ({ kind, id }),
              ),
            }
          : {}),
        outcome: receipt.outcome,
        ...(receipt.outcome === "noop" ? { reason: receipt.reason } : {}),
        ...(receipt.outcome === "applied"
          ? {
              commit:
                receipt.commit.id === receipt.resource.id
                  ? { kind: receipt.commit.kind }
                  : { kind: receipt.commit.kind, id: receipt.commit.id },
            }
          : {}),
        ...(receipt.outcome === "failed" ? { failure: receipt.failure } : {}),
        ...(receipt.outcome === "rolled_back"
          ? { rollback: receipt.rollback }
          : {}),
      },
    })),
  };
}
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

it("retains observation admission and every ordered mutation outcome a later step reads after JSONB storage and model rendering", async () => {
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
            legends.set(body.id, body);
            continue;
          }
          if (!segment.label.startsWith("runtime:historical_effects")) continue;
          if (!Array.isArray(body) && !body.rows) {
            decoded.push(body);
            continue;
          }
          const table = Array.isArray(body) ? legends.get(body[0]) : body;
          expect(table).toBeDefined();
          const [key, [columns]] = legendTemplate(table.encoding, "row=") as [
            string,
            [string[]],
          ];
          expect(key).toBe("requestSourceEventId");
          const rows = Array.isArray(body) ? [body[1]] : body.rows;
          for (const [requestSourceEventId, outcomes] of rows) {
            const completeOutcomes = outcomes.map((values: unknown[]) =>
              Object.fromEntries(
                columns.map((column, index) => {
                  const value = values[index];
                  // A shaped receipt is [shape, values]; any other is an object.
                  if (column !== "receipt" || !Array.isArray(value))
                    return [column, value];
                  const receipt = decodeReceipt(
                    table.encoding,
                    value as [number, unknown[]],
                  );
                  sawNestedShape ||= Object.values(receipt).some(
                    (field) => typeof field === "object" && field !== null,
                  );
                  return [column, receipt];
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
        // Only normalized receipts are written slim; the opaque, future and
        // malformed shapes stay exactly as stored.
        expect(sawNestedShape).toBe(shape === "stored");
        // JSON equality additionally proves ordered object keys, arrays and
        // every source/occurrence of the projection a later step reads.
        expect(JSON.stringify(decoded)).toBe(
          JSON.stringify(
            shape === "stored"
              ? canonical.map((record) => slimRecord(record, wireContext))
              : canonical,
          ),
        );
        expect(wireContext).toEqual(contextBefore);
      }
    }
    expect(originals).toEqual(before);
  } finally {
    await database.close();
  }
});
