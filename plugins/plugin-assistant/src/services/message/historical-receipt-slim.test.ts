/** What a later step reads from the outcome records of earlier requests, as
 * Stage 1 (one table per record kind) and the planner and evaluator (each
 * record above its request) print them. Records come from the real
 * dialogue-context producer and the real proposal-terminal reconciler; the
 * printed text is decoded with nothing but the legend it carries. */
import {
  type Action,
  ChannelType,
  type ContextEvent,
  type ContextObject,
  type ContextObjectPromptSegment,
  compactHistoricalReceiptSegments,
  conversationClientUserMemoryId,
  historicalRequestSourceIds,
  type IAgentRuntime,
  type Memory,
  normalizeEffectReceipt,
  renderContextObject,
  segmentBlock,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendPriorDialogueEvents } from "./dialogue-context.ts";
import { reconcileHistoricalProposalTerminals } from "./historical-proposal-terminals.ts";
import { renderMessageHandlerModelInput } from "./stage1-input.ts";

const mocks = vi.hoisted(() => ({ read: vi.fn(), access: vi.fn() }));
vi.mock("../approval/store.ts", () => ({
  readApprovalRequestsForOriginalSources: mocks.read,
}));
vi.mock("@elizaos/core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  revalidateOwnerExclusiveDisclosure: mocks.access,
}));
beforeEach(() => {
  mocks.read.mockReset();
  mocks.access.mockReset();
  mocks.access.mockResolvedValue({
    allowed: true,
    audience: { canonicalOwnerEntityId: owner },
  });
});

const agent = "a0000000-0000-4000-8000-000000000001",
  room = "a0000000-0000-4000-8000-000000000002",
  owner = "a0000000-0000-4000-8000-000000000003",
  scope = `${agent}:${room}:${owner}`;
const READ_OWNER = {
  name: "CALENDAR_NEXT_EVENT",
  historicalObservationOperations: ["calendar.event.next.read"],
} as unknown as Action;
const runtime = {
  agentId: agent,
  actions: [READ_OWNER, { name: "DEVICE_BROWSER_OPEN" }],
} as unknown as IAgentRuntime;
const T0 = Date.UTC(2026, 10, 20, 21, 15, 0);

function requestMemory(
  key: string,
  text: string,
  createdAt: number,
  actionResults: unknown[],
): Memory {
  const id = conversationClientUserMemoryId(scope, key);
  return {
    id,
    agentId: agent,
    roomId: room,
    entityId: owner,
    createdAt,
    content: {
      text,
      source: "client_chat",
      channelType: ChannelType.DM,
      chatIdempotency: {
        version: 1,
        scope,
        clientMessageId: key,
        fingerprint: "a".repeat(64),
        outcomeJson: JSON.stringify({ userMessageId: id, actionResults }),
      },
    },
  } as Memory;
}
function replyMemory(key: string, text: string, createdAt: number): Memory {
  return {
    id: `${key}-reply` as Memory["id"],
    agentId: agent,
    roomId: room,
    entityId: agent,
    createdAt,
    content: { text, source: "client_chat" },
  } as Memory;
}
const current = (createdAt: number) =>
  ({
    id: "current",
    agentId: agent,
    roomId: room,
    entityId: owner,
    createdAt,
    content: { text: "What happened?" },
  }) as Memory;

const receipt = (fields: Record<string, unknown>) =>
  normalizeEffectReceipt({
    artifacts: [],
    idempotency: { key: null, replayed: false },
    observedAt: "2026-11-20T21:15:04.179Z",
    ...fields,
  });
const preview = (id: string, operation = "device.browser_navigate") =>
  receipt({
    receiptId: id,
    operation,
    resource: { kind: "device.approval", id },
    idempotency: { key: `device:${"7".repeat(64)}`, replayed: false },
    outcome: "preview",
  });
const applied = (kind: string, id: string, operation: string) =>
  receipt({
    receiptId: `receipt-${id}`,
    operation,
    resource: { kind, id, version: "3" },
    outcome: "applied",
    commit: { kind: "durable", id, committedAt: "2026-11-20T21:15:04.179Z" },
  });
const failed = (id: string) =>
  receipt({
    receiptId: `receipt-${id}`,
    operation: "calendar.event.create",
    resource: { kind: "calendar.event", id },
    outcome: "failed",
    failure: {
      code: "PROVIDER_REJECTED",
      retryable: false,
      acceptance: "rejected",
    },
  });
const observed = (id: string) =>
  receipt({
    receiptId: `read-${id}`,
    operation: "calendar.event.next.read",
    resource: { kind: "calendar.next_event", id, version: "v1" },
    outcome: "noop",
    reason: "Observed without changes.",
  });
const navigation = (index: number) => ({
  actionName: "VIEWS_SHOW",
  success: true,
  text: JSON.stringify({
    effect: "view_navigation",
    status: "delivered",
    viewId: "notes",
    stepId: `step-${index}`,
    handoffId: `handoff-${index}`,
    label: "Notes",
  }),
  values: {
    completedActionDelivered: true,
    completedActionHandoffId: `handoff-${index}`,
  },
});
const result = (actionName: string, ...effectReceipts: unknown[]) => ({
  actionName,
  success: !effectReceipts.some(
    (each) => (each as { outcome?: string }).outcome === "failed",
  ),
  effectReceipts,
});

function contextOf(memories: Memory[], at: number) {
  const events: ContextEvent[] = [];
  appendPriorDialogueEvents(
    events,
    runtime,
    {
      data: {
        providers: { RECENT_MESSAGES: { data: { recentMessages: memories } } },
      },
    } as never,
    current(at),
    { includeOwnReplies: true },
  );
  return {
    id: "turn",
    events,
    metadata: { displayTimeZone: "America/New_York" },
  } as ContextObject;
}

/** The planner's and evaluator's composition: rendered context, then the wire. */
function positioned(context: ContextObject) {
  return compactHistoricalReceiptSegments(
    renderContextObject(context).promptSegments,
    { sourceIds: historicalRequestSourceIds(context) },
  );
}
/** Stage 1's own renderer; its receipt region is one table per record kind. */
function table(context: ContextObject) {
  return renderMessageHandlerModelInput(
    { character: { name: "Alpha" } },
    context,
    [],
    { directMessage: true },
  ).promptSegments.map((segment) => ({
    ...segment,
    content: segment.content.trim(),
  }));
}

type Printed = {
  label: string;
  key: string;
  outcomes: Record<string, unknown>[];
  /** Index of the printed segment holding this row. */
  at: number;
};
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
/** Reads printed records with only what the prompt says: each legend's row
 * and receipt templates. */
function decode(segments: ContextObjectPromptSegment[]): Printed[] {
  const legends = new Map<string, Record<string, unknown>>();
  const out: Printed[] = [];
  const record = (
    legend: Record<string, unknown>,
    label: string,
    [key, outcomes]: [string, unknown[][]],
    at: number,
  ) => {
    const encoding = legend.encoding as string;
    const [, [columns]] = legendTemplate(encoding, "row=") as [
      string,
      [string[]],
    ];
    out.push({
      label,
      key,
      at,
      outcomes: outcomes.map((values) =>
        Object.fromEntries(
          columns.map((column, index) => {
            const value = values[index];
            return column === "receipt" && Array.isArray(value)
              ? [column, decodeReceipt(encoding, value as [number, unknown[]])]
              : [column, value];
          }),
        ),
      ),
    });
  };
  segments.forEach((segment, at) => {
    const label = segment.label ?? "";
    if (label === "runtime:historical_receipt_encoding") {
      const legend = JSON.parse(segment.content);
      legends.set(legend.id, legend);
      return;
    }
    const kind =
      /^runtime:historical_(effects|observations|navigation)(_table)?$/.exec(
        label,
      );
    if (!kind) return;
    const base = `runtime:historical_${kind[1]}`;
    const body = JSON.parse(segment.content);
    if (kind[2]) {
      for (const row of body.rows) record(body, base, row, at);
      return;
    }
    if (Array.isArray(body)) {
      const legend = legends.get(body[0]);
      expect(legend).toBeDefined();
      record(legend as Record<string, unknown>, base, body[1], at);
      return;
    }
    const field = Object.keys(body)[Object.keys(body).length - 1];
    out.push({
      label: base,
      key: body.requestSourceEventId,
      outcomes: body[field],
      at,
    });
  });
  return out;
}

const recordEvents = (context: ContextObject) =>
  context.events.flatMap((event) => {
    const segment =
      event.type === "segment" && "segment" in event
        ? (event.segment as ContextObjectPromptSegment)
        : undefined;
    return segment &&
      /^runtime:historical_(effects|observations|navigation)$/.test(
        segment.label ?? "",
      )
      ? [
          {
            id: event.id,
            label: segment.label as string,
            record: JSON.parse(segment.content),
          },
        ]
      : [];
  });

const recordText = (segments: ContextObjectPromptSegment[]) =>
  segments
    .filter((segment) => segment.label?.startsWith("runtime:historical_"))
    .map(segmentBlock)
    .join("\n\n");

describe("records a later step can act on", () => {
  it("prints the kind and id of a note, event and reminder created earlier, bound to its request", () => {
    const made = [
      ["notes.note", "note-3d39eec0", "notes.note.create", "NOTES_CREATE"],
      ["calendar.event", "evt-dentist-1", "calendar.event.create", "CALENDAR"],
      ["lifeops.reminder", "rem-call-mom", "lifeops.reminder.create", "LIFE"],
    ] as const;
    const memories = made.flatMap(([kind, id, operation, action], index) => [
      requestMemory(`make-${index}`, `Make ${id}.`, T0 + index * 2_000, [
        result(action, applied(kind, id, operation)),
      ]),
      replyMemory(`make-${index}`, "Done.", T0 + index * 2_000 + 500),
    ]);
    const context = contextOf(memories, T0 + 60_000);
    const sources = historicalRequestSourceIds(context);
    for (const segments of [positioned(context), table(context)]) {
      const printed = decode(segments);
      expect(printed).toHaveLength(3);
      made.forEach(([kind, id, operation, action], index) => {
        expect(printed[index].key).toBe(
          `history:${sources.get(`history:${memories[index * 2].id}`)}`,
        );
        expect(printed[index].outcomes).toEqual([
          {
            actionName: action,
            success: true,
            // An update or delete names exactly this kind and id.
            receipt: {
              operation,
              resource: { kind, id },
              outcome: "applied",
              commit: { kind: "durable" },
            },
          },
        ]);
      });
      const text = recordText(segments);
      for (const memory of memories)
        expect(text).not.toContain(String(memory.id));
      expect(text).not.toMatch(/receipt-|observedAt|idempotency|committedAt/);
    }
  });

  it("tells pending, done, rejected, expired and failed apart in both layouts", async () => {
    const states = [
      "pending",
      "done",
      "rejected",
      "expired",
      "failed",
    ] as const;
    const proposals = states.map(
      (_, index) =>
        `b0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    const memories = states.flatMap((state, index) => [
      requestMemory(
        `state-${state}`,
        `Open example ${index}.`,
        T0 + index * 3_000,
        [
          state === "failed"
            ? result("CALENDAR", failed("evt-failed"))
            : result("DEVICE_BROWSER_OPEN", preview(proposals[index])),
        ],
      ),
      replyMemory(`state-${state}`, "Review it.", T0 + index * 3_000 + 400),
    ]);
    mocks.read.mockResolvedValue(
      ["done", "rejected", "expired"].map((state) => {
        const index = states.indexOf(state as (typeof states)[number]);
        return approvalRow(
          proposals[index],
          String(memories[index * 2].id),
          state,
        );
      }),
    );
    const base = contextOf(memories, T0 + 60_000);
    const context = {
      ...base,
      events: await reconcileHistoricalProposalTerminals(
        runtime,
        current(T0 + 60_000),
        base.events,
        memories,
      ),
    };
    expect(
      context.events.filter((event) =>
        event.id.startsWith("historical-proposal-terminal:"),
      ),
    ).toHaveLength(3);
    const classify = (outcome: Record<string, unknown>) => {
      const receipt = outcome.receipt as Record<string, unknown>;
      if (receipt.outcome === "preview") return "pending";
      if (receipt.outcome === "failed") return "failed";
      if (outcome.success === true && receipt.outcome === "applied")
        return "done";
      const reason = String(receipt.reason ?? "");
      if (outcome.success === false && reason.endsWith("state is rejected."))
        return "rejected";
      if (outcome.success === false && reason.endsWith("state is expired."))
        return "expired";
      return "unknown";
    };
    for (const segments of [positioned(context), table(context)]) {
      const printed = decode(segments);
      // Each request keeps one row; an ending replaced its preview in place.
      expect(printed.map((row) => row.key)).toEqual(
        memories
          .filter((_, index) => index % 2 === 0)
          .map(
            (memory) =>
              `history:${historicalRequestSourceIds(context).get(`history:${memory.id}`)}`,
          ),
      );
      expect(printed.map((row) => classify(row.outcomes[0]))).toEqual([
        ...states,
      ]);
      expect(printed[4].outcomes[0].receipt).toMatchObject({
        failure: {
          code: "PROVIDER_REJECTED",
          retryable: false,
          acceptance: "rejected",
        },
      });
      expect(recordText(segments)).not.toContain(
        "Authoritative later proposal state",
      );
    }
  });
});

/** An approval-store row the terminal reconciler accepts for a browser open. */
function approvalRow(id: string, requestMessageId: string, state: string) {
  return {
    id,
    requestedBy: agent,
    subjectUserId: "original-owner-account",
    action: "device_action",
    idempotencyKey: `device:${"7".repeat(64)}`,
    state,
    updatedAt: new Date("2026-11-20T21:20:00Z"),
    payload: {
      action: "device_action",
      version: 1,
      installationId: "installation",
      enrollmentId: "enrollment",
      requestMessageId,
      operation: { type: "browser_navigate", url: "https://example.test/" },
    },
    execution:
      state === "done"
        ? {
            attemptId: `attempt-${id}`,
            providerIdempotencyKey: `device:${"7".repeat(64)}`,
            providerReceipt: {
              outcome: "applied",
              operationId: `operation-${id}`,
              result: {},
            },
          }
        : null,
  };
}

/** A seeded room: requests seconds or minutes apart, each with zero to three
 * outcomes of every kind, and zero to two replies. */
function randomRoom(seed: number) {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const memories: Memory[] = [];
  let at = T0 + Math.floor(next() * 50) * 1_000;
  const requests = 2 + Math.floor(next() * 10);
  for (let index = 0; index < requests; index++) {
    at +=
      next() < 0.6
        ? 1_000 + Math.floor(next() * 4_000)
        : 60_000 * (1 + Math.floor(next() * 9));
    const key = `room-${seed}-${index}`;
    const results: unknown[] = [];
    const outcomes = Math.floor(next() * 4);
    for (let outcome = 0; outcome < outcomes; outcome++) {
      const id = `${key}-${outcome}`;
      const pick = Math.floor(next() * 6);
      results.push(
        pick === 0
          ? result(
              "PROPOSE_DEVICE_ACTION",
              preview(`approval-${id}`, "device.sms_compose"),
            )
          : pick === 1
            ? result(
                "NOTES_CREATE",
                applied("notes.note", `note-${id}`, "notes.note.create"),
              )
            : pick === 2
              ? result("CALENDAR", failed(`evt-${id}`))
              : pick === 3
                ? result(READ_OWNER.name, observed(`snapshot-${id}`))
                : pick === 4
                  ? navigation(seed * 100 + index * 10 + outcome)
                  : result(
                      "NOTES_CREATE",
                      receipt({
                        receiptId: `replay-${id}`,
                        operation: "notes.note.create",
                        resource: { kind: "notes.note", id: `note-${id}` },
                        idempotency: { key: `note-${id}`, replayed: true },
                        outcome: "noop",
                        reason: "An identical note already exists.",
                      }),
                    ),
      );
    }
    memories.push(
      requestMemory(key, `Request ${index} of room ${seed}.`, at, results),
    );
    const replies = Math.floor(next() * 3);
    for (let reply = 0; reply < replies; reply++) {
      at += 300;
      memories.push(replyMemory(`${key}-${reply}`, `Reply ${reply}.`, at));
    }
  }
  return { memories, end: at + 1_000 };
}

describe("binding and cache properties over 200 seeded rooms", () => {
  it("binds each printed outcome to exactly its own request, same-minute requests included", () => {
    let rows = 0;
    let sameMinute = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const { memories, end } = randomRoom(seed);
      const context = contextOf(memories, end);
      const sources = historicalRequestSourceIds(context);
      const expected = recordEvents(context).map(({ label, record }) => ({
        label,
        key: `history:${sources.get(record.requestSourceEventId)}`,
        count: (record.outcomes ?? record.observations ?? record.navigation)
          .length,
      }));
      for (const id of expected.map(({ key }) => key))
        expect(id).toMatch(/^history:h\d+$/);
      // Stamps print to the minute, so requests seconds apart share one.
      const stamps = renderContextObject(context)
        .promptSegments.filter(
          (segment) => segment.label === "prior_message:user",
        )
        .map(
          (segment) =>
            /^\[message_at=([^\]]+)\]/.exec(segmentBlock(segment))?.[1],
        );
      if (new Set(stamps).size < stamps.length) sameMinute++;
      for (const [layout, segments] of [
        ["positioned", positioned(context)],
        ["table", table(context)],
      ] as const) {
        const printed = decode(segments);
        const byLabel = (
          label: string,
          list: { label: string; key: string }[],
        ) => list.filter((row) => row.label === label).map((row) => row.key);
        for (const label of [
          "runtime:historical_effects",
          "runtime:historical_observations",
          "runtime:historical_navigation",
        ]) {
          expect(byLabel(label, printed)).toEqual(byLabel(label, expected));
          // One row per request and kind: a key names exactly one request.
          const keys = byLabel(label, printed);
          expect(new Set(keys).size).toBe(keys.length);
        }
        // Positioned rows keep event order; Stage 1 tables keep it per kind.
        const counts = (list: { label: string }[], label?: string) =>
          list
            .filter((row) => label === undefined || row.label === label)
            .map((row) =>
              "count" in row
                ? (row as { count: number }).count
                : (row as Printed).outcomes.length,
            );
        if (layout === "positioned")
          expect(counts(printed)).toEqual(counts(expected));
        else
          for (const label of new Set(expected.map((row) => row.label)))
            expect(counts(printed, label)).toEqual(counts(expected, label));
        if (layout === "positioned")
          // Each row stands above its request: the next message is the request.
          for (const row of printed) {
            const message = segments
              .slice(row.at + 1)
              .find((segment) => segment.label?.startsWith("prior_message:"));
            expect(message?.label).toBe("prior_message:user");
            expect(`history:${sources.get(String(message?.id))}`).toBe(row.key);
          }
        const text = recordText(segments);
        for (const memory of memories)
          expect(text).not.toContain(String(memory.id));
        rows += printed.length;
      }
    }
    expect(sameMinute).toBeGreaterThan(100);
    expect(rows).toBeGreaterThan(1_000);
  });

  it("gives the same bytes for the same input and, inside the dialogue window, only appends when a request's outcome is recorded", () => {
    const legends = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const { memories, end } = randomRoom(seed);
      const last = memories.findLastIndex(
        (memory) => memory.entityId === owner,
      );
      // Turn A: the last request is the current message; turn B: it is history.
      const before = contextOf(
        memories.slice(0, last),
        Number(memories[last].createdAt),
      );
      const after = contextOf(memories, end);
      const wire = (segments: ContextObjectPromptSegment[]) =>
        segments.map(segmentBlock).join("\n\n");
      expect(wire(positioned(before))).toBe(
        wire(positioned(structuredClone(before))),
      );
      expect(wire(table(before))).toBe(wire(table(structuredClone(before))));
      const a = wire(positioned(before));
      const b = wire(positioned(after));
      expect(b.startsWith(a)).toBe(true);
      // Stage 1: each table of turn A is a byte prefix of the same table in B,
      // up to its closing brackets.
      const tables = (segments: ContextObjectPromptSegment[]) =>
        new Map(
          segments
            .filter((segment) => segment.label?.endsWith("_table"))
            .map((segment) => [segment.label, segment.content]),
        );
      const later = tables(table(after));
      for (const [label, content] of tables(table(before))) {
        expect(later.get(label)?.startsWith(content.slice(0, -2))).toBe(true);
      }
      for (const segment of positioned(after))
        if (segment.label === "runtime:historical_receipt_encoding")
          legends.add(
            segment.content.replace(/receipt_wire_\d+/, "receipt_wire_N"),
          );
    }
    // The legend never depends on which records a room holds.
    expect(legends.size).toBeLessThanOrEqual(3);
  });

  it("names an interrupted request by the same key in its note and its record", () => {
    const request = requestMemory("cut", "Make note-cut.", T0, [
      result(
        "NOTES_CREATE",
        applied("notes.note", "note-cut", "notes.note.create"),
      ),
    ]);
    const interrupted = {
      ...replyMemory("cut", "", T0 + 500),
      content: { text: "", interrupted: true, inReplyTo: request.id },
    } as Memory;
    const context = contextOf(
      [request, interrupted, replyMemory("other", "Hi.", T0 + 900)],
      T0 + 60_000,
    );
    const key = `history:${historicalRequestSourceIds(context).get(`history:${request.id}`)}`;
    expect(key).toBe("history:h1");
    const layouts: ContextObjectPromptSegment[][] = [
      positioned(context),
      table(context),
    ];
    for (const segments of layouts) {
      expect(decode(segments).map((row) => row.key)).toEqual([key]);
      const note = segments.find(
        (segment) => segment.label === "runtime:interrupted_turn",
      );
      expect(JSON.parse(note?.content ?? "{}")).toMatchObject({
        requestSourceEventId: key,
        responseGeneration: "interrupted",
      });
      expect(note?.content).not.toContain(String(request.id));
      expect(recordText(segments)).not.toContain(String(request.id));
    }
  });

  it("keys rows by dialogue-window position: a slide shifts every key, and each row still binds to its own request", () => {
    const notes = Array.from(
      { length: 8 },
      (_, index) => `note-slide-${index}`,
    );
    const memories = notes.flatMap((id, index) => [
      requestMemory(`slide-${index}`, `Make ${id}.`, T0 + index * 2_000, [
        result("NOTES_CREATE", applied("notes.note", id, "notes.note.create")),
      ]),
      replyMemory(`slide-${index}`, "Done.", T0 + index * 2_000 + 500),
    ]);
    const window = 10;
    // Turn A's window is messages 4-13; one request and reply later, turn B's
    // is messages 6-15. The window holds five requests in both turns.
    const turnA = contextOf(memories.slice(4, 4 + window), T0 + 13_000);
    const turnB = contextOf(memories.slice(6, 6 + window), T0 + 15_000);
    const wire = (segments: ContextObjectPromptSegment[]) =>
      segments.map(segmentBlock).join("\n\n");
    const rowsOf = new Map<ContextObject, Map<string, Printed>>();
    for (const context of [turnA, turnB]) {
      expect(wire(positioned(context))).toBe(
        wire(positioned(structuredClone(context))),
      );
      expect(wire(table(context))).toBe(wire(table(structuredClone(context))));
      const sources = historicalRequestSourceIds(context);
      const requestOf = new Map(
        [...sources].map(([eventId, label]) => [`history:${label}`, eventId]),
      );
      for (const [layout, segments] of [
        ["positioned", positioned(context)],
        ["table", table(context)],
      ] as const) {
        const printed = decode(segments);
        expect(printed).toHaveLength(window / 2);
        const byNote = new Map<string, Printed>();
        for (const row of printed) {
          // The key names the request that made exactly this row's note.
          const { resource } = row.outcomes[0].receipt as {
            resource: { id: string };
          };
          const request = memories.find(
            (memory) => `history:${memory.id}` === requestOf.get(row.key),
          );
          expect(request?.content.text).toBe(`Make ${resource.id}.`);
          byNote.set(resource.id, row);
          if (layout === "positioned") {
            const message = segments
              .slice(row.at + 1)
              .find((segment) => segment.label?.startsWith("prior_message:"));
            expect(message?.id).toBe(requestOf.get(row.key));
          }
        }
        if (layout === "positioned") rowsOf.set(context, byNote);
      }
    }
    // The same request is h3 in turn A and h1 in turn B: only its key moved,
    // so its row's bytes change (the rows re-send from the first one) while
    // the legend stays the same.
    const sameNote = notes[3];
    const before = rowsOf.get(turnA)?.get(sameNote);
    const after = rowsOf.get(turnB)?.get(sameNote);
    expect([before?.key, after?.key]).toEqual(["history:h3", "history:h1"]);
    expect(after?.outcomes).toEqual(before?.outcomes);
    const legendOf = (segments: ContextObjectPromptSegment[]) =>
      segments.find(
        (segment) => segment.label === "runtime:historical_receipt_encoding",
      )?.content;
    expect(legendOf(positioned(turnB))).toBe(legendOf(positioned(turnA)));
    expect(legendOf(positioned(turnA))).toBeDefined();
  });

  it("rewrites exactly one row when a proposal ends and adds none", async () => {
    for (const state of ["done", "rejected", "expired"]) {
      const memories = [0, 1, 2, 3].flatMap((index) => [
        requestMemory(
          `end-${state}-${index}`,
          `Open site ${index}.`,
          T0 + index * 2_000,
          [
            result(
              "DEVICE_BROWSER_OPEN",
              preview(`c0000000-0000-4000-8000-00000000000${index}`),
            ),
          ],
        ),
        replyMemory(
          `end-${state}-${index}`,
          "Review it.",
          T0 + index * 2_000 + 300,
        ),
      ]);
      const context = contextOf(memories, T0 + 60_000);
      mocks.read.mockResolvedValue([
        approvalRow(
          "c0000000-0000-4000-8000-000000000001",
          String(memories[2].id),
          state,
        ),
      ]);
      const ended = {
        ...context,
        events: await reconcileHistoricalProposalTerminals(
          runtime,
          current(T0 + 60_000),
          context.events,
          memories,
        ),
      };
      expect(ended.events).toHaveLength(context.events.length + 1);
      for (const render of [positioned, table]) {
        const a = render(context).map(segmentBlock);
        const b = render(ended).map(segmentBlock);
        expect(b).toHaveLength(a.length);
        const changed = a.flatMap((block, index) =>
          block === b[index] ? [] : [index],
        );
        expect(changed).toHaveLength(1);
        const [index] = changed;
        if (render === positioned) {
          // The changed block is that request's own row and nothing else.
          expect(a[index].replace(/"history:h\d+"/, "")).not.toBe(
            b[index].replace(/"history:h\d+"/, ""),
          );
          expect(decode(render(ended))[1].outcomes[0].success).toBe(
            state === "done",
          );
        } else {
          const rows = (block: string) =>
            JSON.parse(block.slice(block.indexOf("\n") + 1)).rows.map(
              (row: unknown) => JSON.stringify(row),
            );
          const before = rows(a[index]);
          const after = rows(b[index]);
          expect(after).toHaveLength(before.length);
          expect(
            before.filter((row: string, at: number) => row !== after[at]),
          ).toHaveLength(1);
          expect(before[1]).not.toBe(after[1]);
        }
      }
    }
  });

  it("keeps an ending that matches no shown preview as its own row", async () => {
    const memories = [
      requestMemory("orphan", "Open the site.", T0, [
        result(
          "DEVICE_BROWSER_OPEN",
          preview("d0000000-0000-4000-8000-000000000001"),
        ),
      ]),
    ];
    const context = contextOf(memories, T0 + 60_000);
    mocks.read.mockResolvedValue([
      approvalRow(
        "d0000000-0000-4000-8000-000000000001",
        String(memories[0].id),
        "expired",
      ),
    ]);
    const ended = await reconcileHistoricalProposalTerminals(
      runtime,
      current(T0 + 60_000),
      context.events,
      memories,
    );
    // The preview is not in this rendering: only the terminal remains.
    const terminalOnly = {
      ...context,
      events: ended.filter(
        (event) => event.id !== `historical-effects:${memories[0].id}`,
      ),
    };
    const printed = decode(positioned(terminalOnly));
    expect(printed).toHaveLength(1);
    expect(printed[0].outcomes[0]).toMatchObject({ success: false });
  });
});
