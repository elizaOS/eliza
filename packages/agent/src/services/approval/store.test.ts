/**
 * PgApprovalQueue unit test — the raw-SQL approval state machine in store.ts.
 *
 * Drives the exported `PgApprovalQueue` / `createApprovalQueue` directly
 * against an in-memory fake of the `approval_requests` table reached through
 * the real `runtime.adapter.db.execute` boundary, so the store's actual
 * encoders (`sqlText`/`sqlJson`) and parsers run unmodified. The drizzle
 * `sql.raw` shim hands the store our raw SQL text back; the fake interprets
 * only the INSERT / SELECT / UPDATE / DELETE shapes the store emits.
 */

import { randomUUID } from "node:crypto";
import type {
  AgentNotification,
  IAgentRuntime,
  NotificationInput,
  UUID,
} from "@elizaos/core";
import { ServiceType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createApprovalQueue, PgApprovalQueue } from "./store.ts";
import {
  type ApprovalAction,
  type ApprovalEnqueueInput,
  ApprovalIdempotencyConflictError,
  type ApprovalListFilter,
  ApprovalNotFoundError,
  type ApprovalPayload,
  type ApprovalQueue,
  type ApprovalRequestState,
  type ApprovalResolution,
  ApprovalStateTransitionError,
} from "./types.ts";

vi.mock("drizzle-orm", () => ({
  sql: {
    raw: (text: string) => ({ __sql: text, queryChunks: [text] }),
  },
}));

const AGENT_ID = "agent-store-test";
const SUBJECT = "owner-123";
const FUTURE = () => new Date(Date.now() + 60 * 60 * 1000);

function sqlOf(query: unknown): string {
  const direct = query as { __sql?: string };
  return typeof direct.__sql === "string" ? direct.__sql : "";
}

/** Split a parenthesised, comma-separated value list, respecting quotes. */
function splitValues(inner: string): string[] {
  const values: string[] = [];
  let buf = "";
  let inSingle = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (inSingle) {
      buf += ch;
      if (ch === "'") {
        if (inner[i + 1] === "'") {
          buf += "'";
          i += 1;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      buf += ch;
      continue;
    }
    if (ch === ",") {
      values.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) values.push(buf.trim());
  return values;
}

function unquote(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "NULL") return null;
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

interface WhereClause {
  eq: Record<string, string>;
  nullCols: string[];
  notNullCols: string[];
  expiresAtMax?: string;
}

function parseWhere(whereSql: string): WhereClause {
  const clause: WhereClause = { eq: {}, nullCols: [], notNullCols: [] };
  if (!whereSql.trim()) return clause;
  for (const cond of whereSql.split(/\bAND\b/i).map((s) => s.trim())) {
    const isNull = cond.match(/^(\w+)\s+IS\s+NULL$/i);
    if (isNull) {
      clause.nullCols.push(isNull[1]);
      continue;
    }
    const isNotNull = cond.match(/^(\w+)\s+IS\s+NOT\s+NULL$/i);
    if (isNotNull) {
      clause.notNullCols.push(isNotNull[1]);
      continue;
    }
    const le = cond.match(/^expires_at\s*<=\s*('(?:[^']|'')*')$/);
    if (le) {
      const v = unquote(le[1]);
      if (v !== null) clause.expiresAtMax = v;
      continue;
    }
    const eq = cond.match(/^(\w+)\s*=\s*('(?:[^']|'')*')$/);
    if (eq) {
      const value = unquote(eq[2]);
      if (value !== null) clause.eq[eq[1]] = value;
    }
  }
  return clause;
}

function matches(row: Record<string, unknown>, clause: WhereClause): boolean {
  for (const [col, value] of Object.entries(clause.eq)) {
    if (row[col] !== value) return false;
  }
  for (const col of clause.nullCols) {
    if (row[col] !== null && row[col] !== undefined) return false;
  }
  for (const col of clause.notNullCols) {
    if (row[col] === null || row[col] === undefined) return false;
  }
  if (
    clause.expiresAtMax !== undefined &&
    String(row.expires_at) > clause.expiresAtMax
  ) {
    return false;
  }
  return true;
}

/** Parse `col = value` assignments out of a `SET …` fragment.
 *  A bare column reference keeps the stored value, matching SQL semantics for
 *  assignments like `provider_receipt = provider_receipt`; a JSON literal of
 *  `null` decodes on the SQL side exactly like a json-typed column would. */
function parseSet(setSql: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const assign of splitValues(setSql)) {
    const m = assign.match(/^(\w+)\s*=\s*([\s\S]+)$/);
    if (!m) continue;
    const rhs = m[2].trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(rhs) && rhs.toUpperCase() !== "NULL") {
      continue;
    }
    const decoded = unquote(rhs);
    out[m[1]] = decoded === "null" ? null : decoded;
  }
  return out;
}

const SELECT_COLUMNS = [
  "id",
  "state",
  "requested_by",
  "subject_user_id",
  "action",
  "payload",
  "channel",
  "reason",
  "idempotency_key",
  "expires_at",
  "resolved_at",
  "resolved_by",
  "resolution_reason",
  "execution_attempt_id",
  "execution_provider",
  "provider_idempotency_key",
  "execution_claimed_at",
  "dispatch_started_at",
  "provider_receipt",
  "execution_error",
  "reconciliation_resolved_at",
  "reconciliation_resolved_by",
  "reconciliation_reason",
  "created_at",
  "updated_at",
];

function projectSelect(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of SELECT_COLUMNS) out[col] = row[col] ?? null;
  return out;
}

interface NotifierSpy {
  notify: ReturnType<typeof vi.fn>;
  ensureGroupedNotification: ReturnType<typeof vi.fn>;
  markReadByGroupKey: ReturnType<typeof vi.fn>;
  notifications: AgentNotification[];
}

function createNotifierSpy(): NotifierSpy {
  const notifications: AgentNotification[] = [];
  const recordNotification = async (
    input: NotificationInput,
  ): Promise<AgentNotification> => {
    const notification: AgentNotification = {
      ...input,
      id: randomUUID() as UUID,
      category: input.category ?? "general",
      priority: input.priority ?? "normal",
      source: input.source ?? "test",
      createdAt: Date.now(),
      readAt: null,
    } as AgentNotification;
    notifications.unshift(notification);
    return notification;
  };
  return {
    notify: vi.fn(recordNotification),
    ensureGroupedNotification: vi.fn(
      async (
        input: NotificationInput & { groupKey: string },
        isExact: (notification: AgentNotification) => boolean,
      ) => {
        const grouped = notifications.filter(
          (entry) => entry.groupKey === input.groupKey,
        );
        if (grouped.length === 1 && isExact(grouped[0])) return grouped[0];
        for (let i = notifications.length - 1; i >= 0; i -= 1) {
          if (notifications[i]?.groupKey === input.groupKey) {
            notifications.splice(i, 1);
          }
        }
        return recordNotification(input);
      },
    ),
    markReadByGroupKey: vi.fn(async () => 1),
    notifications,
  };
}

interface Harness {
  runtime: IAgentRuntime;
  queue: ApprovalQueue;
  rows: Map<string, Record<string, unknown>>;
  statements: string[];
  reportError: ReturnType<typeof vi.fn>;
  notifier: NotifierSpy;
  seedRow: (overrides?: Record<string, unknown>) => Record<string, unknown>;
  runQuery: (query: unknown) => Promise<Array<Record<string, unknown>>>;
  runQueryQuiet: (query: unknown) => Promise<Array<Record<string, unknown>>>;
  lastStatement: () => string;
  armRaceHook: (hook: (sql: string, rows: Harness["rows"]) => void) => void;
}

function createHarness(): Harness {
  const rows = new Map<string, Record<string, unknown>>();
  const statements: string[] = [];
  const notifier = createNotifierSpy();
  const reportError = vi.fn();
  let raceHook: ((sql: string, table: Harness["rows"]) => void) | null = null;

  function interpret(
    sql: string,
    record = true,
  ): Array<Record<string, unknown>> {
    if (record) statements.push(sql);
    const trimmed = sql.trim();

    if (/^INSERT\s+INTO\s+approval_requests/i.test(trimmed)) {
      const colsMatch = trimmed.match(/\(([\s\S]+?)\)\s*VALUES/i);
      const valsMatch = trimmed.match(
        /VALUES\s*\(([\s\S]+?)\)\s*(?:ON\s+CONFLICT[\s\S]+?)?RETURNING/i,
      );
      if (!colsMatch || !valsMatch) throw new Error("bad INSERT in mock");
      const columns = colsMatch[1].split(",").map((s) => s.trim());
      const values = splitValues(valsMatch[1]);
      const row: Record<string, unknown> = {};
      columns.forEach((col, idx) => {
        row[col] = unquote(values[idx] ?? "NULL");
      });
      const hasConflictClause = /\bON\s+CONFLICT\b/i.test(trimmed);
      if (
        hasConflictClause &&
        row.idempotency_key !== null &&
        row.idempotency_key !== undefined &&
        Array.from(rows.values()).some(
          (existing) =>
            existing.agent_id === row.agent_id &&
            existing.idempotency_key === row.idempotency_key,
        )
      ) {
        return [];
      }
      rows.set(String(row.id), row);
      return [projectSelect(row)];
    }

    if (/^SELECT\s+/i.test(trimmed)) {
      const whereMatch = trimmed.match(
        /WHERE\s+([\s\S]+?)(?:\s+ORDER\s+BY|\s+LIMIT|$)/i,
      );
      const clause = whereMatch ? parseWhere(whereMatch[1]) : parseWhere("");
      let result = Array.from(rows.values()).filter((r) => matches(r, clause));
      result = result.sort((a, b) =>
        String(b.created_at).localeCompare(String(a.created_at)),
      );
      const limitMatch = trimmed.match(/LIMIT\s+(\d+)/i);
      if (limitMatch) result = result.slice(0, Number(limitMatch[1]));
      return result.map(projectSelect);
    }

    if (/^UPDATE\s+approval_requests/i.test(trimmed)) {
      if (raceHook) {
        const hook = raceHook;
        raceHook = null;
        hook(trimmed, rows);
      }
      const setMatch = trimmed.match(/SET\s+([\s\S]+?)\s+WHERE/i);
      const whereMatch = trimmed.match(/WHERE\s+([\s\S]+?)\s+RETURNING/i);
      if (!setMatch || !whereMatch) throw new Error("bad UPDATE in mock");
      const assignments = parseSet(setMatch[1]);
      const clause = parseWhere(whereMatch[1]);
      const returnsId = /RETURNING\s+id\s*$/i.test(trimmed);
      const updated: Array<Record<string, unknown>> = [];
      for (const row of rows.values()) {
        if (!matches(row, clause)) continue;
        for (const [col, val] of Object.entries(assignments)) row[col] = val;
        updated.push(row);
      }
      if (returnsId) return updated.map((r) => ({ id: r.id }));
      return updated.map(projectSelect);
    }

    if (/^DELETE\s+FROM\s+approval_requests/i.test(trimmed)) {
      const whereMatch = trimmed.match(/WHERE\s+([\s\S]+)$/i);
      const clause = whereMatch ? parseWhere(whereMatch[1]) : parseWhere("");
      for (const [id, row] of Array.from(rows.entries())) {
        if (matches(row, clause)) rows.delete(id);
      }
      return [];
    }

    throw new Error(`unsupported SQL in mock: ${trimmed.slice(0, 40)}`);
  }

  const runQuery = async (query: unknown) => interpret(sqlOf(query));
  const runQueryQuiet = async (query: unknown) =>
    interpret(sqlOf(query), false);

  const runtime = {
    agentId: AGENT_ID,
    adapter: { db: { execute: runQuery } },
    getService: (type: string) =>
      type === ServiceType.NOTIFICATION ? notifier : null,
    reportError,
  } as unknown as IAgentRuntime;

  const queue = createApprovalQueue(runtime, { agentId: AGENT_ID });

  function seedRow(overrides: Record<string, unknown> = {}) {
    const nowIso = new Date().toISOString();
    const row: Record<string, unknown> = {
      id: randomUUID(),
      state: "pending",
      requested_by: "agent:lifeops",
      subject_user_id: SUBJECT,
      action: "send_message",
      payload: JSON.stringify(messagePayload()),
      channel: "sms",
      reason: "needs owner approval",
      idempotency_key: null,
      expires_at: FUTURE().toISOString(),
      resolved_at: null,
      resolved_by: null,
      resolution_reason: null,
      execution_attempt_id: null,
      execution_provider: null,
      provider_idempotency_key: null,
      execution_claimed_at: null,
      dispatch_started_at: null,
      provider_receipt: null,
      execution_error: null,
      reconciliation_resolved_at: null,
      reconciliation_resolved_by: null,
      reconciliation_reason: null,
      agent_id: AGENT_ID,
      created_at: nowIso,
      updated_at: nowIso,
      ...overrides,
    };
    rows.set(String(row.id), row);
    return row;
  }

  return {
    runtime,
    queue,
    rows,
    statements,
    reportError,
    notifier,
    seedRow,
    runQuery,
    runQueryQuiet,
    lastStatement: () => statements[statements.length - 1] ?? "",
    armRaceHook: (hook) => {
      raceHook = hook;
    },
  };
}

function messagePayload(): ApprovalPayload {
  return {
    action: "send_message",
    recipient: "+15555551212",
    body: "Hello!",
    replyToMessageId: null,
  };
}

function messageInput(
  overrides: Partial<ApprovalEnqueueInput> = {},
): ApprovalEnqueueInput {
  return {
    requestedBy: "agent:lifeops",
    subjectUserId: SUBJECT,
    action: "send_message",
    payload: messagePayload(),
    channel: "sms",
    reason: "agent wants to confirm before sending",
    idempotencyKey: null,
    expiresAt: FUTURE(),
    ...overrides,
  };
}

const MINIMAL_PAYLOADS: Record<ApprovalAction, ApprovalPayload> = {
  send_message: {
    action: "send_message",
    recipient: "+15555551212",
    body: "Hi",
    replyToMessageId: null,
  },
  send_email: {
    action: "send_email",
    to: ["a@b.c"],
    cc: [],
    bcc: [],
    subject: "S",
    body: "B",
    threadId: null,
  },
  schedule_event: {
    action: "schedule_event",
    calendarId: "cal-1",
    title: "Dentist",
    startsAtMs: 1750000000000,
    endsAtMs: 1750003600000,
    attendees: [{ email: "d@b.c" }],
    location: null,
    description: null,
  },
  modify_event: {
    action: "modify_event",
    calendarId: "cal-1",
    eventId: "evt-1",
    patch: {
      title: null,
      startsAtMs: null,
      endsAtMs: null,
      attendees: null,
      location: null,
      description: null,
    },
  },
  cancel_event: {
    action: "cancel_event",
    calendarId: "cal-1",
    eventId: "evt-1",
    notifyAttendees: false,
  },
  book_travel: {
    action: "book_travel",
    kind: "flight",
    provider: "duffel",
    itineraryRef: "itn-1",
    totalCents: 12345,
    currency: "USD",
  },
  make_call: {
    action: "make_call",
    to: "+15555551212",
    script: "Say hi",
    maxDurationSeconds: 60,
  },
  sign_document: {
    action: "sign_document",
    documentId: "doc-1",
    documentName: "NDA",
    signatureUrl: "https://example.test/sign",
    deadline: "2026-12-01",
  },
  execute_workflow: {
    action: "execute_workflow",
    workflowId: "wf-1",
    input: { runId: "r-1", attempts: 1, dryRun: true },
  },
  spend_money: {
    action: "spend_money",
    vendor: "Acme",
    amountCents: 500,
    currency: "USD",
    memo: "Tools",
  },
};

function resolution(
  overrides: Partial<ApprovalResolution> = {},
): ApprovalResolution {
  return {
    resolvedBy: SUBJECT,
    resolutionReason: "owner agreed",
    ...overrides,
  };
}

describe("PgApprovalQueue construction", () => {
  it("exposes the documented execution capability and protocol version", () => {
    const h = createHarness();
    expect(h.queue).toBeInstanceOf(PgApprovalQueue);
    expect(h.queue.capability).toBe("eliza.approval-execution");
    expect(h.queue.protocolVersion).toBe(2);
  });
});

describe("enqueue and idempotent replay", () => {
  it("inserts a fresh pending request and maps the returned row", async () => {
    const h = createHarness();
    const input = messageInput();
    const result = await h.queue.enqueueWithResult(input);

    expect(result.reused).toBe(false);
    const request = result.request;
    expect(request.state).toBe("pending");
    expect(request.action).toBe("send_message");
    expect(request.channel).toBe("sms");
    expect(request.requestedBy).toBe("agent:lifeops");
    expect(request.subjectUserId).toBe(SUBJECT);
    expect(request.reason).toBe("agent wants to confirm before sending");
    expect(request.idempotencyKey).toBeNull();
    expect(request.createdAt).toBeInstanceOf(Date);
    expect(request.updatedAt).toBeInstanceOf(Date);
    expect(request.expiresAt).toEqual(input.expiresAt);
    expect(request.resolvedAt).toBeNull();
    expect(request.resolvedBy).toBeNull();
    expect(request.resolutionReason).toBeNull();
    expect(request.execution).toBeNull();
    expect(request.payload).toEqual(messagePayload());
    expect(request.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("omits the conflict clause when no idempotency key is provided", async () => {
    const h = createHarness();
    await h.queue.enqueueWithResult(messageInput());
    expect(h.lastStatement()).not.toContain("ON CONFLICT");
  });

  it("attaches the partial conflict clause when an idempotency key is present", async () => {
    const h = createHarness();
    await h.queue.enqueueWithResult(messageInput({ idempotencyKey: "k-1" }));
    expect(h.lastStatement()).toContain(
      "ON CONFLICT (agent_id, idempotency_key)",
    );
  });

  it("treats a blank idempotency key as absent and allows duplicates", async () => {
    const h = createHarness();
    const first = await h.queue.enqueueWithResult(
      messageInput({ idempotencyKey: "   " }),
    );
    const second = await h.queue.enqueueWithResult(
      messageInput({ idempotencyKey: "\t" }),
    );
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(false);
    expect(second.request.id).not.toBe(first.request.id);
    expect(first.request.idempotencyKey).toBeNull();
  });

  it("reuses the identical prior request when the insert conflicts", async () => {
    const h = createHarness();
    const input = messageInput({ idempotencyKey: "replay-1" });
    await h.queue.enqueueWithResult(input);
    h.notifier.notify.mockClear();

    const replay = await h.queue.enqueueWithResult(input);
    expect(replay.reused).toBe(true);
    expect(replay.request.idempotencyKey).toBe("replay-1");
    expect(h.rows.size).toBe(1);
    expect(h.notifier.notify).not.toHaveBeenCalled();
  });

  it("treats reordered payload keys as the same approval", async () => {
    const h = createHarness();
    const base = messageInput({ idempotencyKey: "order-1" });
    await h.queue.enqueueWithResult(base);
    const replay = await h.queue.enqueueWithResult({
      ...base,
      payload: {
        action: "send_message",
        replyToMessageId: null,
        body: "Hello!",
        recipient: "+15555551212",
      } as ApprovalPayload,
    });
    expect(replay.reused).toBe(true);
  });

  it.each([
    [
      "requestedBy differs",
      (input: ApprovalEnqueueInput) => ({
        ...input,
        requestedBy: "agent:other",
      }),
    ],
    [
      "subject differs",
      (input: ApprovalEnqueueInput) => ({
        ...input,
        subjectUserId: "owner-other",
      }),
    ],
    [
      "action differs",
      (input: ApprovalEnqueueInput) => ({
        ...input,
        action: "make_call" as ApprovalAction,
        payload: MINIMAL_PAYLOADS.make_call,
      }),
    ],
    [
      "channel differs",
      (input: ApprovalEnqueueInput) => ({
        ...input,
        channel: "email" as const,
      }),
    ],
    [
      "reason differs",
      (input: ApprovalEnqueueInput) => ({
        ...input,
        reason: "different reason",
      }),
    ],
    [
      "expiry differs",
      (input: ApprovalEnqueueInput) => ({
        ...input,
        expiresAt: new Date(input.expiresAt.getTime() + 1),
      }),
    ],
    [
      "payload differs",
      (input: ApprovalEnqueueInput) => ({
        ...input,
        payload: { ...input.payload, body: "changed" },
      }),
    ],
  ])("rejects replay when %s", async (_label, mutate) => {
    const h = createHarness();
    const input = messageInput({ idempotencyKey: "conflict-1" });
    await h.queue.enqueueWithResult(input);

    await expect(h.queue.enqueueWithResult(mutate(input))).rejects.toThrow(
      ApprovalIdempotencyConflictError,
    );
  });
});

describe("enqueue payload validation", () => {
  it.each(Object.entries(MINIMAL_PAYLOADS))(
    "accepts a minimal valid %s payload",
    async (action, payload) => {
      const h = createHarness();
      const request = await h.queue.enqueue(
        messageInput({
          action: action as ApprovalAction,
          payload,
          channel: action === "send_email" ? "email" : "internal",
        }),
      );
      expect(request.payload).toEqual(payload);
      expect(request.action).toBe(action);
    },
  );

  const invalid: Array<[string, ApprovalEnqueueInput, RegExp]> = [
    [
      "send_message missing body",
      messageInput({
        payload: {
          action: "send_message",
          recipient: "+15555551212",
          replyToMessageId: null,
        } as unknown as ApprovalPayload,
      }),
      /invalid enqueue payload\.body: expected string/,
    ],
    [
      "non-object payload",
      messageInput({
        payload: null as unknown as ApprovalPayload,
      }),
      /invalid enqueue payload: expected object/,
    ],
    [
      "unknown action",
      messageInput({
        payload: {
          action: "teleport",
        } as unknown as ApprovalPayload,
      }),
      /unknown action from db: teleport/,
    ],
    [
      "schedule_event non-finite startsAtMs",
      messageInput({
        action: "schedule_event",
        channel: "google_calendar",
        payload: {
          ...(MINIMAL_PAYLOADS.schedule_event as Extract<
            ApprovalPayload,
            { action: "schedule_event" }
          >),
          startsAtMs: Number.NaN,
        },
      }),
      /invalid enqueue payload\.startsAtMs: expected number/,
    ],
    [
      "book_travel invalid kind",
      messageInput({
        action: "book_travel",
        payload: {
          ...(MINIMAL_PAYLOADS.book_travel as Extract<
            ApprovalPayload,
            { action: "book_travel" }
          >),
          kind: "submarine" as "flight",
        },
      }),
      /invalid enqueue payload\.kind/,
    ],
    [
      "execute_workflow non-primitive input",
      messageInput({
        action: "execute_workflow",
        payload: {
          ...(MINIMAL_PAYLOADS.execute_workflow as Extract<
            ApprovalPayload,
            { action: "execute_workflow" }
          >),
          input: { nested: { x: 1 } } as unknown as Record<string, string>,
        },
      }),
      /invalid enqueue payload\.input\.nested: expected string, number, or boolean/,
    ],
    [
      "send_email cc containing a number",
      messageInput({
        action: "send_email",
        channel: "email",
        payload: {
          ...(MINIMAL_PAYLOADS.send_email as Extract<
            ApprovalPayload,
            { action: "send_email" }
          >),
          cc: [42] as unknown as string[],
        },
      }),
      /invalid enqueue payload\.cc: expected string\[\]/,
    ],
    [
      "modify_event missing patch",
      messageInput({
        action: "modify_event",
        payload: {
          action: "modify_event",
          calendarId: "cal-1",
          eventId: "evt-1",
        } as unknown as ApprovalPayload,
      }),
      /invalid enqueue payload\.patch: expected object/,
    ],
    [
      "schedule_event attendee missing email",
      messageInput({
        action: "schedule_event",
        channel: "google_calendar",
        payload: {
          ...(MINIMAL_PAYLOADS.schedule_event as Extract<
            ApprovalPayload,
            { action: "schedule_event" }
          >),
          attendees: [{ displayName: "No Address" }] as unknown as Extract<
            ApprovalPayload,
            { action: "schedule_event" }
          >["attendees"],
        },
      }),
      /invalid enqueue payload\.attendees\[0\]\.email: expected string/,
    ],
    [
      "spend_money non-finite amountCents",
      messageInput({
        action: "spend_money",
        payload: {
          ...(MINIMAL_PAYLOADS.spend_money as Extract<
            ApprovalPayload,
            { action: "spend_money" }
          >),
          amountCents: Number.POSITIVE_INFINITY,
        },
      }),
      /invalid enqueue payload\.amountCents: expected number/,
    ],
  ];

  it.each(invalid)("rejects %s", async (_label, input, pattern) => {
    const h = createHarness();
    await expect(h.queue.enqueueWithResult(input)).rejects.toThrow(pattern);
    expect(h.rows.size).toBe(0);
  });

  it("rejects an envelope whose action disagrees with its payload", async () => {
    const h = createHarness();
    await expect(
      h.queue.enqueueWithResult(
        messageInput({
          action: "spend_money",
          payload: MINIMAL_PAYLOADS.send_message,
        }),
      ),
    ).rejects.toThrow(
      /payload action send_message does not match request action spend_money/,
    );
    expect(h.rows.size).toBe(0);
  });
});

describe("row parsing", () => {
  it("maps a fully populated executing row including execution metadata", async () => {
    const h = createHarness();
    const claimedAt = new Date(Date.now() - 5000).toISOString();
    const startedAt = new Date(Date.now() - 4000).toISOString();
    h.seedRow({
      id: "req-full",
      state: "executing",
      execution_attempt_id: "attempt-1",
      execution_provider: "twilio",
      provider_idempotency_key: "prov-key-1",
      execution_claimed_at: claimedAt,
      dispatch_started_at: startedAt,
      provider_receipt: JSON.stringify({ sid: "SM123" }),
      execution_error: null,
    });

    const request = await h.queue.byId("req-full", SUBJECT);
    expect(request).not.toBeNull();
    expect(request?.state).toBe("executing");
    expect(request?.execution).toEqual({
      attemptId: "attempt-1",
      provider: "twilio",
      providerIdempotencyKey: "prov-key-1",
      claimedAt: new Date(claimedAt),
      dispatchStartedAt: new Date(startedAt),
      providerReceipt: { sid: "SM123" },
      error: null,
      reconciledAt: null,
      reconciledBy: null,
      reconciliationReason: null,
    });
  });

  it("returns a null execution for a row without attempt metadata", async () => {
    const h = createHarness();
    h.seedRow({ id: "req-plain" });
    const request = await h.queue.byId("req-plain", SUBJECT);
    expect(request?.execution).toBeNull();
  });

  it.each([
    [
      "unknown state",
      { state: "smoldering" },
      /unknown state from db: smoldering/,
    ],
    [
      "unknown action",
      { action: "teleport" },
      /unknown action from db: teleport/,
    ],
    [
      "unknown channel",
      { channel: "carrier_pigeon" },
      /unknown channel from db: carrier_pigeon/,
    ],
    ["missing timestamp", { created_at: "" }, /missing timestamp from db/],
    [
      "unparsable timestamp",
      { updated_at: "not-a-date" },
      /invalid timestamp from db: not-a-date/,
    ],
    [
      "payload whose own action disagrees with the row",
      {
        action: "send_message",
        payload: JSON.stringify({ ...MINIMAL_PAYLOADS.spend_money }),
      },
      /payload action spend_money does not match request action send_message/,
    ],
    [
      "incomplete execution metadata",
      {
        execution_attempt_id: "attempt-x",
        execution_provider: null,
        provider_idempotency_key: "k",
        execution_claimed_at: new Date().toISOString(),
      },
      /incomplete execution metadata for request req-bad/,
    ],
  ])("refuses a row with %s", async (_label, overrides, pattern) => {
    const h = createHarness();
    h.seedRow({ id: "req-bad", ...overrides });
    await expect(h.queue.byId("req-bad", SUBJECT)).rejects.toThrow(pattern);
  });

  it("refuses a stored payload that fails validation for its action", async () => {
    const h = createHarness();
    h.seedRow({
      id: "req-short-payload",
      payload: JSON.stringify({ action: "send_message", recipient: "x" }),
    });
    await expect(h.queue.byId("req-short-payload", SUBJECT)).rejects.toThrow(
      /invalid row req-short-payload payload\.body: expected string/,
    );
  });
});

describe("queries and ownership fences", () => {
  it("lists every scoped row newest-first when all filters are null", async () => {
    const h = createHarness();
    const older = h.seedRow({
      id: "req-old",
      created_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const newer = h.seedRow({
      id: "req-new",
      created_at: new Date().toISOString(),
    });

    const result = await h.queue.list({
      subjectUserId: null,
      state: null,
      action: null,
    });

    expect(result.map((r) => r.id)).toEqual([newer.id, older.id]);
    const sql = h.statements.find((s) => s.startsWith("SELECT"));
    expect(sql).toContain("agent_id = 'agent-store-test'");
    expect(sql).toContain("ORDER BY created_at DESC");
    expect(sql).not.toMatch(/\bLIMIT\b/);
    expect(sql).not.toContain("subject_user_id =");
    expect(sql).not.toContain("state =");
    expect(sql).not.toContain("action =");
  });

  it("combines every provided filter and honors the requested page size", async () => {
    const h = createHarness();
    h.seedRow({ id: "match-1", state: "pending", action: "send_message" });
    h.seedRow({ id: "match-2", state: "pending", action: "send_message" });
    h.seedRow({ id: "wrong-state", state: "done" });
    h.seedRow({ id: "wrong-subject", subject_user_id: "owner-else" });

    const filter: ApprovalListFilter = {
      subjectUserId: SUBJECT,
      state: "pending",
      action: "send_message",
      limit: null,
    };
    const unbounded = await h.queue.list(filter);
    expect(unbounded.map((r) => r.id).sort()).toEqual(["match-1", "match-2"]);

    const paged = await h.queue.list({ ...filter, limit: 1 });
    const sql = h.lastStatement();
    expect(sql).toContain("subject_user_id = 'owner-123'");
    expect(sql).toContain("state = 'pending'");
    expect(sql).toContain("action = 'send_message'");
    expect(sql).toContain("LIMIT 1");
    expect(paged).toHaveLength(1);
    expect(["match-1", "match-2"]).toContain(paged[0]?.id);
  });

  it("emits LIMIT 0 when an explicit zero page size is requested", async () => {
    const h = createHarness();
    h.seedRow();
    const result = await h.queue.list({
      subjectUserId: null,
      state: null,
      action: null,
      limit: 0,
    });
    expect(h.lastStatement()).toContain("LIMIT 0");
    expect(result).toHaveLength(0);
  });

  it("fences byId on agent and subject", async () => {
    const h = createHarness();
    h.seedRow({ id: "mine" });
    h.seedRow({ id: "foreign-agent", agent_id: "agent-someone-else" });

    expect(await h.queue.byId("mine", SUBJECT)).not.toBeNull();
    expect(await h.queue.byId("mine", "owner-else")).toBeNull();
    expect(await h.queue.byId("foreign-agent", SUBJECT)).toBeNull();
  });

  it("resolves byIdempotencyKey after trimming and fences on subject", async () => {
    const h = createHarness();
    h.seedRow({ id: "keyed", idempotency_key: "replay-key" });

    const found = await h.queue.byIdempotencyKey("  replay-key  ", SUBJECT);
    expect(found?.id).toBe("keyed");

    expect(
      await h.queue.byIdempotencyKey("replay-key", "owner-else"),
    ).toBeNull();

    await expect(h.queue.byIdempotencyKey("   ", SUBJECT)).rejects.toThrow(
      /idempotency key is required/,
    );
  });

  it("ignores idempotency keys owned by another agent", async () => {
    const h = createHarness();
    h.seedRow({ id: "foreign", idempotency_key: "k", agent_id: "other-agent" });
    expect(await h.queue.byIdempotencyKey("k", SUBJECT)).toBeNull();
  });

  it("removes only the caller's pending row and resolves regardless of effect", async () => {
    const h = createHarness();
    h.seedRow({ id: "pending-row", state: "pending" });
    h.seedRow({ id: "approved-row", state: "approved" });

    await h.queue.removePending("pending-row", SUBJECT);
    expect(h.rows.has("pending-row")).toBe(false);

    await h.queue.removePending("approved-row", SUBJECT);
    expect(h.rows.has("approved-row")).toBe(true);

    const sql = h.statements.find((s) => s.startsWith("DELETE"));
    expect(sql).toContain("state = 'pending'");
    expect(sql).toContain(`subject_user_id = '${SUBJECT}'`);
    expect(sql).toContain(`agent_id = '${AGENT_ID}'`);

    await expect(
      h.queue.removePending("missing-id", SUBJECT),
    ).resolves.toBeUndefined();
  });
});

describe("resolution transitions", () => {
  it("approves a pending request with persisted resolution metadata and auto-reads its notification", async () => {
    const h = createHarness();
    h.seedRow({ id: "req-a", state: "pending" });

    const approved = await h.queue.approve("req-a", SUBJECT, resolution());
    expect(approved.state).toBe("approved");
    expect(approved.resolvedBy).toBe(SUBJECT);
    expect(approved.resolutionReason).toBe("owner agreed");
    expect(approved.resolvedAt).toBeInstanceOf(Date);
    expect(h.notifier.markReadByGroupKey).toHaveBeenCalledWith(
      "approval:req-a",
    );
    expect(h.lastStatement()).toContain("AND state = 'pending'");
  });

  it("rejects an already-approved request", async () => {
    const h = createHarness();
    h.seedRow({ id: "req-r", state: "approved" });
    const rejected = await h.queue.reject("req-r", SUBJECT, resolution());
    expect(rejected.state).toBe("rejected");
  });

  it("expires an approved request without fabricating resolution fields", async () => {
    const h = createHarness();
    h.seedRow({ id: "req-e", state: "approved" });
    const expired = await h.queue.markExpired("req-e", SUBJECT);
    expect(expired.state).toBe("expired");
    expect(expired.resolvedAt).toBeNull();
    expect(expired.resolvedBy).toBeNull();
    expect(expired.resolutionReason).toBeNull();
    expect(h.notifier.markReadByGroupKey).toHaveBeenCalledWith(
      "approval:req-e",
    );
  });

  it.each([
    ["approve", "done", "approved"],
    ["approve", "executing", "approved"],
    ["claimExecution-style pending gate", "pending", "executing"],
    ["expire a rejected request", "rejected", "expired"],
  ] as Array<[string, ApprovalRequestState, ApprovalRequestState]>)(
    "refuses %s (%s -> %s) before issuing any update",
    async (_label, from, to) => {
      const h = createHarness();
      h.seedRow({ id: "req-t", state: from });
      const before = h.statements.length;

      if (to === "executing") {
        await expect(
          h.queue.claimExecution({
            requestId: "req-t",
            subjectUserId: SUBJECT,
            provider: "twilio",
            providerIdempotencyKey: "pk",
          }),
        ).rejects.toThrow(ApprovalStateTransitionError);
      } else if (to === "expired") {
        await expect(h.queue.markExpired("req-t", SUBJECT)).rejects.toThrow(
          ApprovalStateTransitionError,
        );
      } else {
        await expect(
          h.queue.approve("req-t", SUBJECT, resolution()),
        ).rejects.toThrow(
          new ApprovalStateTransitionError("req-t", from, to).message,
        );
      }
      expect(
        h.statements.slice(before).some((s) => s.startsWith("UPDATE")),
      ).toBe(false);
    },
  );

  it("throws ApprovalNotFoundError for unknown ids on every transition entry point", async () => {
    const h = createHarness();
    await expect(
      h.queue.approve("ghost", SUBJECT, resolution()),
    ).rejects.toThrow(ApprovalNotFoundError);
    await expect(
      h.queue.reject("ghost", SUBJECT, resolution()),
    ).rejects.toThrow(ApprovalNotFoundError);
    await expect(h.queue.markExpired("ghost", SUBJECT)).rejects.toThrow(
      ApprovalNotFoundError,
    );
    await expect(
      h.queue.claimExecution({
        requestId: "ghost",
        subjectUserId: SUBJECT,
        provider: "twilio",
        providerIdempotencyKey: "pk",
      }),
    ).rejects.toThrow(ApprovalNotFoundError);
  });

  it("surfaces a lost compare-and-swap race as a transition error from the latest state", async () => {
    const h = createHarness();
    const row = h.seedRow({ id: "req-race", state: "pending" });
    h.armRaceHook((_sql, table) => {
      const live = table.get("req-race");
      if (live) live.state = "executing";
    });

    await expect(
      h.queue.approve("req-race", SUBJECT, resolution()),
    ).rejects.toThrow(
      new ApprovalStateTransitionError("req-race", "executing", "approved")
        .message,
    );
    expect(row.state).toBe("executing");
  });

  it("reports a vanished row from a lost race as not found", async () => {
    const h = createHarness();
    h.seedRow({ id: "req-gone", state: "pending" });
    h.armRaceHook((_sql, table) => {
      table.delete("req-gone");
    });

    await expect(
      h.queue.reject("req-gone", SUBJECT, resolution()),
    ).rejects.toThrow(ApprovalNotFoundError);
  });

  describe("lazy expiry at the transition boundary", () => {
    const fixed = new Date("2026-03-01T12:00:00.000Z");

    it("flips a lapsed pending row to expired and refuses the attempted transition", async () => {
      vi.useFakeTimers({ now: fixed });
      try {
        const h = createHarness();
        h.seedRow({
          id: "req-lapsed",
          state: "pending",
          expires_at: fixed.toISOString(),
        });

        await expect(
          h.queue.approve("req-lapsed", SUBJECT, resolution()),
        ).rejects.toThrow(
          new ApprovalStateTransitionError("req-lapsed", "expired", "approved")
            .message,
        );

        const lapsed = await h.queue.byId("req-lapsed", SUBJECT);
        expect(lapsed?.state).toBe("expired");
        expect(lapsed?.resolvedAt).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("still approves a request whose expiry is one millisecond in the future", async () => {
      vi.useFakeTimers({ now: fixed });
      try {
        const h = createHarness();
        h.seedRow({
          id: "req-live",
          state: "pending",
          expires_at: new Date(fixed.getTime() + 1).toISOString(),
        });
        const approved = await h.queue.approve(
          "req-live",
          SUBJECT,
          resolution(),
        );
        expect(approved.state).toBe("approved");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("execution lifecycle", () => {
  function claimFor(requestId: string) {
    return {
      requestId,
      subjectUserId: SUBJECT,
      provider: "twilio",
      providerIdempotencyKey: `approval:${requestId}:twilio`,
    };
  }

  it("claims an approved request into executing with fresh attempt metadata", async () => {
    const h = createHarness();
    const attemptId = "stale-attempt";
    h.seedRow({
      id: "req-claim",
      state: "approved",
      execution_attempt_id: attemptId,
      execution_provider: "old-provider",
      provider_idempotency_key: "old-key",
      execution_claimed_at: new Date(Date.now() - 99_000).toISOString(),
      dispatch_started_at: new Date(Date.now() - 98_000).toISOString(),
      provider_receipt: JSON.stringify({ old: true }),
      execution_error: "old failure",
    });

    const executing = await h.queue.claimExecution(claimFor("req-claim"));
    expect(executing.state).toBe("executing");
    expect(executing.execution?.attemptId).toBeTruthy();
    expect(executing.execution?.attemptId).not.toBe(attemptId);
    expect(executing.execution?.provider).toBe("twilio");
    expect(executing.execution?.providerIdempotencyKey).toBe(
      "approval:req-claim:twilio",
    );
    expect(executing.execution?.claimedAt).toBeInstanceOf(Date);
    expect(executing.execution?.dispatchStartedAt).toBeNull();
    expect(executing.execution?.providerReceipt).toBeNull();
    expect(executing.execution?.error).toBeNull();
    expect(h.notifier.markReadByGroupKey).not.toHaveBeenCalled();
  });

  it("claims a retryable request after a failed attempt", async () => {
    const h = createHarness();
    h.seedRow({
      id: "req-retry",
      state: "retryable",
      execution_error: "earlier failure",
    });
    const executing = await h.queue.claimExecution(claimFor("req-retry"));
    expect(executing.state).toBe("executing");
    expect(executing.execution?.attemptId).toBeTruthy();
  });

  it("marks dispatch started once and reports a duplicate start as a conflict", async () => {
    const h = createHarness();
    h.seedRow({
      id: "req-dispatch",
      state: "executing",
      execution_attempt_id: "attempt-9",
      execution_provider: "twilio",
      provider_idempotency_key: "pk-9",
      execution_claimed_at: new Date().toISOString(),
    });

    const started = await h.queue.markDispatchStarted({
      requestId: "req-dispatch",
      subjectUserId: SUBJECT,
      attemptId: "attempt-9",
    });
    expect(started.execution?.dispatchStartedAt).toBeInstanceOf(Date);

    await expect(
      h.queue.markDispatchStarted({
        requestId: "req-dispatch",
        subjectUserId: SUBJECT,
        attemptId: "attempt-9",
      }),
    ).rejects.toThrow(ApprovalStateTransitionError);
  });

  it("completes a dispatched attempt as done with the receipt persisted", async () => {
    const h = createHarness();
    h.seedRow({
      id: "req-done",
      state: "executing",
      execution_attempt_id: "attempt-10",
      execution_provider: "twilio",
      provider_idempotency_key: "pk-10",
      execution_claimed_at: new Date().toISOString(),
      dispatch_started_at: new Date().toISOString(),
      execution_error: "stale error",
    });

    const done = await h.queue.markDone({
      requestId: "req-done",
      subjectUserId: SUBJECT,
      attemptId: "attempt-10",
      providerReceipt: { sid: "SM999" },
    });
    expect(done.state).toBe("done");
    expect(done.execution?.providerReceipt).toEqual({ sid: "SM999" });
    expect(done.execution?.error).toBeNull();
  });

  it("refuses completion of an attempt that never dispatched", async () => {
    const h = createHarness();
    h.seedRow({
      id: "req-unstarted-done",
      state: "executing",
      execution_attempt_id: "attempt-11",
      execution_provider: "twilio",
      provider_idempotency_key: "pk-11",
      execution_claimed_at: new Date().toISOString(),
      dispatch_started_at: null,
    });

    await expect(
      h.queue.markDone({
        requestId: "req-unstarted-done",
        subjectUserId: SUBJECT,
        attemptId: "attempt-11",
        providerReceipt: {},
      }),
    ).rejects.toThrow(
      new ApprovalStateTransitionError(
        "req-unstarted-done",
        "executing",
        "done",
      ).message,
    );
  });

  it("records a retryable failure with an explicit receipt", async () => {
    const h = createHarness();
    h.seedRow({
      id: "req-fail",
      state: "executing",
      execution_attempt_id: "attempt-12",
      execution_provider: "twilio",
      provider_idempotency_key: "pk-12",
      execution_claimed_at: new Date().toISOString(),
      dispatch_started_at: new Date().toISOString(),
    });

    const failed = await h.queue.markRetryableFailure({
      requestId: "req-fail",
      subjectUserId: SUBJECT,
      attemptId: "attempt-12",
      error: "provider 503",
      providerReceipt: { status: 503 },
    });
    expect(failed.state).toBe("retryable");
    expect(failed.execution?.error).toBe("provider 503");
    expect(failed.execution?.providerReceipt).toEqual({ status: 503 });
  });

  it("preserves the existing receipt when the failure omits one and JSON-encodes it when one is provided", async () => {
    const h = createHarness();
    h.seedRow({
      id: "req-keep",
      state: "executing",
      execution_attempt_id: "attempt-13",
      execution_provider: "twilio",
      provider_idempotency_key: "pk-13",
      execution_claimed_at: new Date().toISOString(),
      dispatch_started_at: new Date().toISOString(),
      provider_receipt: JSON.stringify({ kept: true }),
    });

    const failed = await h.queue.markReconciliationRequired({
      requestId: "req-keep",
      subjectUserId: SUBJECT,
      attemptId: "attempt-13",
      error: "needs human eyes",
    });
    expect(failed.state).toBe("reconciliation_required");
    expect(failed.execution?.providerReceipt).toEqual({ kept: true });

    const updateSql = h.lastStatement();
    expect(updateSql).toContain("provider_receipt = provider_receipt");

    h.seedRow({
      id: "req-replace",
      state: "executing",
      execution_attempt_id: "attempt-14",
      execution_provider: "twilio",
      provider_idempotency_key: "pk-14",
      execution_claimed_at: new Date().toISOString(),
      dispatch_started_at: new Date().toISOString(),
      provider_receipt: JSON.stringify({ stale: true }),
    });
    await h.queue.markRetryableFailure({
      requestId: "req-replace",
      subjectUserId: SUBJECT,
      attemptId: "attempt-14",
      error: "provider 503 after receipt",
      providerReceipt: { status: 503 },
    });
    expect(h.lastStatement()).toContain(`provider_receipt = '{"status":503}'`);
  });

  it("recovers an unstarted claim to retryable with the fixed recovery error", async () => {
    const h = createHarness();
    h.seedRow({
      id: "req-recover",
      state: "executing",
      execution_attempt_id: "attempt-15",
      execution_provider: "twilio",
      provider_idempotency_key: "pk-15",
      execution_claimed_at: new Date().toISOString(),
      dispatch_started_at: null,
    });

    const recovered = await h.queue.recoverUnstartedExecution({
      requestId: "req-recover",
      subjectUserId: SUBJECT,
      attemptId: "attempt-15",
    });
    expect(recovered.state).toBe("retryable");
    expect(recovered.execution?.error).toBe(
      "execution claim recovered before dispatch start",
    );

    await expect(
      h.queue.recoverUnstartedExecution({
        requestId: "ghost",
        subjectUserId: SUBJECT,
        attemptId: "nope",
      }),
    ).rejects.toThrow(ApprovalNotFoundError);
  });

  it("refuses recovery once dispatch has started", async () => {
    const h = createHarness();
    h.seedRow({
      id: "req-started",
      state: "executing",
      execution_attempt_id: "attempt-16",
      execution_provider: "twilio",
      provider_idempotency_key: "pk-16",
      execution_claimed_at: new Date().toISOString(),
      dispatch_started_at: new Date().toISOString(),
    });

    await expect(
      h.queue.recoverUnstartedExecution({
        requestId: "req-started",
        subjectUserId: SUBJECT,
        attemptId: "attempt-16",
      }),
    ).rejects.toThrow(
      new ApprovalStateTransitionError("req-started", "executing", "retryable")
        .message,
    );
  });

  it("reconciles a delivered outcome to done, clearing the error while keeping an omitted receipt", async () => {
    const h = createHarness();
    h.seedRow({
      id: "rec-keep",
      state: "reconciliation_required",
      execution_attempt_id: "attempt-17",
      execution_provider: "twilio",
      provider_idempotency_key: "pk-17",
      execution_claimed_at: new Date().toISOString(),
      dispatch_started_at: new Date().toISOString(),
      provider_receipt: JSON.stringify({ partial: true }),
      execution_error: "uncertain delivery",
    });

    const done = await h.queue.reconcileExecution({
      requestId: "rec-keep",
      subjectUserId: SUBJECT,
      attemptId: "attempt-17",
      outcome: "delivered",
      reconciledBy: "ops-bot",
      reconciliationReason: "webhook confirmed",
    });
    expect(done.state).toBe("done");
    expect(done.execution?.error).toBeNull();
    expect(done.execution?.providerReceipt).toEqual({ partial: true });
    expect(done.execution?.reconciledBy).toBe("ops-bot");
    expect(done.execution?.reconciliationReason).toBe("webhook confirmed");
    expect(done.execution?.reconciledAt).toBeInstanceOf(Date);
  });

  it("reconciles a non-delivery to retryable with the fixed error and replaces the receipt when given", async () => {
    const h = createHarness();
    h.seedRow({
      id: "rec-miss",
      state: "reconciliation_required",
      execution_attempt_id: "attempt-18",
      execution_provider: "twilio",
      provider_idempotency_key: "pk-18",
      execution_claimed_at: new Date().toISOString(),
      dispatch_started_at: new Date().toISOString(),
      provider_receipt: JSON.stringify({ partial: true }),
    });

    const retried = await h.queue.reconcileExecution({
      requestId: "rec-miss",
      subjectUserId: SUBJECT,
      attemptId: "attempt-18",
      outcome: "not_delivered",
      reconciledBy: "ops-bot",
      reconciliationReason: "provider confirms loss",
      providerReceipt: { final: false },
    });
    expect(retried.state).toBe("retryable");
    expect(retried.execution?.error).toBe(
      "provider reconciliation confirmed non-delivery",
    );
    expect(retried.execution?.providerReceipt).toEqual({ final: false });
  });

  it("refuses reconciliation mutations against a foreign attempt or missing row", async () => {
    const h = createHarness();
    h.seedRow({
      id: "rec-wrong",
      state: "reconciliation_required",
      execution_attempt_id: "attempt-19",
      execution_provider: "twilio",
      provider_idempotency_key: "pk-19",
      execution_claimed_at: new Date().toISOString(),
      dispatch_started_at: new Date().toISOString(),
    });

    await expect(
      h.queue.reconcileExecution({
        requestId: "rec-wrong",
        subjectUserId: SUBJECT,
        attemptId: "attempt-other",
        outcome: "delivered",
        reconciledBy: "ops-bot",
        reconciliationReason: "irrelevant",
      }),
    ).rejects.toThrow(ApprovalStateTransitionError);

    await expect(
      h.queue.reconcileExecution({
        requestId: "ghost",
        subjectUserId: SUBJECT,
        attemptId: "attempt-other",
        outcome: "delivered",
        reconciledBy: "ops-bot",
        reconciliationReason: "irrelevant",
      }),
    ).rejects.toThrow(ApprovalNotFoundError);
  });
});

describe("purgeExpired", () => {
  it("expires only pending rows whose expiry has passed, preserving order and auto-reading each", async () => {
    const h = createHarness();
    const pastA = h.seedRow({
      id: "past-a",
      expires_at: new Date(Date.now() - 2000).toISOString(),
    });
    h.seedRow({
      id: "future",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const pastB = h.seedRow({
      id: "past-b",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    h.seedRow({
      id: "approved-past",
      state: "approved",
      expires_at: new Date(Date.now() - 3000).toISOString(),
    });

    const now = new Date();
    const purged = await h.queue.purgeExpired(now);

    expect(purged).toEqual([String(pastA.id), String(pastB.id)]);
    expect(h.rows.get("past-a")?.state).toBe("expired");
    expect(h.rows.get("past-b")?.state).toBe("expired");
    expect(h.rows.get("future")?.state).toBe("pending");
    expect(h.rows.get("approved-past")?.state).toBe("approved");

    const sql = h.lastStatement();
    expect(sql).toContain("state = 'pending'");
    expect(sql).toContain("expires_at <=");

    expect(h.notifier.markReadByGroupKey).toHaveBeenCalledTimes(2);
    expect(h.notifier.markReadByGroupKey).toHaveBeenCalledWith(
      "approval:past-a",
    );
    expect(h.notifier.markReadByGroupKey).toHaveBeenCalledWith(
      "approval:past-b",
    );
  });

  it("performs no notification work when nothing is expirable", async () => {
    const h = createHarness();
    h.seedRow({ id: "still-live", expires_at: FUTURE().toISOString() });

    const purged = await h.queue.purgeExpired(new Date());
    expect(purged).toEqual([]);
    expect(h.notifier.markReadByGroupKey).not.toHaveBeenCalled();
  });
});

describe("notification side channels", () => {
  it("enqueues successfully when no notification service is registered", async () => {
    const h = createHarness();
    h.runtime.getService = () => null;
    const request = await h.queue.enqueue(messageInput());
    expect(request.state).toBe("pending");
    expect(h.notifier.notify).not.toHaveBeenCalled();
  });

  it("notifies fire-and-forget with the exact approval projection", async () => {
    const h = createHarness();
    const request = await h.queue.enqueue(messageInput());

    expect(h.notifier.notify).toHaveBeenCalledTimes(1);
    const input = h.notifier.notify.mock.calls[0][0];
    expect(input.title).toBe("Approval needed");
    expect(input.body).toBe("agent wants to confirm before sending");
    expect(input.category).toBe("approval");
    expect(input.priority).toBe("high");
    expect(input.source).toBe("lifeops");
    expect(input.deepLink).toBe("/chat");
    expect(input.groupKey).toBe(`approval:${request.id}`);
    expect(input.data).toEqual({
      requestId: request.id,
      kind: "send_message",
    });
  });

  it("keeps the enqueue successful when the fire-and-forget notification write rejects", async () => {
    const h = createHarness();
    h.notifier.notify.mockRejectedValue(new Error("smtp down"));

    const request = await h.queue.enqueue(messageInput());
    expect(request.state).toBe("pending");

    await vi.waitFor(() => {
      expect(h.reportError).toHaveBeenCalledWith(
        "ApprovalQueue.notify",
        expect.any(Error),
        { requestId: request.id, action: "send_message" },
      );
    });
  });

  it("keeps the resolve committed when the auto-read write rejects", async () => {
    const h = createHarness();
    h.seedRow({ id: "req-read-fail", state: "pending" });
    h.notifier.markReadByGroupKey.mockRejectedValue(new Error("read failed"));

    const approved = await h.queue.approve(
      "req-read-fail",
      SUBJECT,
      resolution(),
    );
    expect(approved.state).toBe("approved");

    await vi.waitFor(() => {
      expect(h.reportError).toHaveBeenCalledWith(
        "ApprovalQueue.notificationRead",
        expect.any(Error),
        { requestId: "req-read-fail" },
      );
    });
  });
});

describe("awaited notification projection", () => {
  const enqueueAwaited = (h: Harness, input: ApprovalEnqueueInput) => {
    if (!h.queue.enqueueWithResultAndNotification) {
      throw new Error("enqueueWithResultAndNotification is not implemented");
    }
    return h.queue.enqueueWithResultAndNotification(input);
  };

  it("awaits the grouped projection for a brand-new request", async () => {
    const h = createHarness();
    const result = await enqueueAwaited(
      h,
      messageInput({ idempotencyKey: "await-1" }),
    );

    expect(result.reused).toBe(false);
    expect(h.notifier.ensureGroupedNotification).toHaveBeenCalledTimes(1);
    const [input] = h.notifier.ensureGroupedNotification.mock.calls[0];
    expect(input.groupKey).toBe(`approval:${result.request.id}`);
  });

  it("re-projects on idempotent reuse instead of duplicating the notification", async () => {
    const h = createHarness();
    const input = messageInput({ idempotencyKey: "await-2" });
    await enqueueAwaited(h, input);
    const replay = await enqueueAwaited(h, input);

    expect(replay.reused).toBe(true);
    expect(h.notifier.ensureGroupedNotification).toHaveBeenCalledTimes(2);
    expect(h.notifier.notifications).toHaveLength(1);
    expect(h.notifier.notify).not.toHaveBeenCalled();
  });

  it("refuses before inserting when the notification service cannot project groups", async () => {
    const h = createHarness();
    const partial = { notify: vi.fn() };
    h.runtime.getService = ((type: string) =>
      type === ServiceType.NOTIFICATION
        ? partial
        : null) as typeof h.runtime.getService;

    await expect(enqueueAwaited(h, messageInput())).rejects.toThrow(
      /notification service unavailable for awaited approval projection/,
    );
    expect(h.rows.size).toBe(0);
  });

  it("accepts only the exact unread projection in the equality predicate", async () => {
    const h = createHarness();
    const result = await enqueueAwaited(h, messageInput());
    const [, isExact] = h.notifier.ensureGroupedNotification.mock.calls[0];
    const requestId = result.request.id;

    const matching = {
      id: randomUUID() as UUID,
      title: "Approval needed",
      body: "agent wants to confirm before sending",
      category: "approval",
      priority: "high",
      source: "lifeops",
      deepLink: "/chat",
      groupKey: `approval:${requestId}`,
      data: { requestId, kind: "send_message" },
      createdAt: Date.now(),
      readAt: null,
      expiresAt: null,
    } as AgentNotification;
    expect(isExact(matching)).toBe(true);

    expect(isExact({ ...matching, body: "mutated" })).toBe(false);
    expect(isExact({ ...matching, priority: "normal" })).toBe(false);
    expect(isExact({ ...matching, readAt: Date.now() })).toBe(false);
    expect(isExact({ ...matching, icon: "icon.png" })).toBe(false);
    expect(isExact({ ...matching, data: {} })).toBe(false);
    expect(isExact({ ...matching, groupKey: "approval:other" })).toBe(false);
    expect(isExact({ ...matching, source: "elsewhere" })).toBe(false);
    expect(isExact({ ...matching, deepLink: "/settings" })).toBe(false);
  });
});

describe("confirmed enqueue", () => {
  it("persists an owner-confirmed approval directly without a redundant prompt", async () => {
    const h = createHarness();
    const approved = await h.queue.enqueueConfirmed(
      messageInput({ idempotencyKey: "confirmed-1" }),
      resolution(),
    );

    expect(approved.state).toBe("approved");
    expect(approved.resolvedBy).toBe(SUBJECT);
    expect(approved.resolvedAt).toBeInstanceOf(Date);
    const row = h.rows.get(approved.id);
    expect(row?.state).toBe("approved");
    expect(row?.resolved_by).toBe(SUBJECT);
    expect(row?.resolution_reason).toBe("owner agreed");
    expect(h.notifier.notify).not.toHaveBeenCalled();
  });

  it("drives a reused pending row through approval on the confirmed path", async () => {
    const h = createHarness();
    const input = messageInput({ idempotencyKey: "confirmed-2" });
    const initial = await h.queue.enqueueWithResult(input);
    expect(initial.request.state).toBe("pending");

    const confirmed = await h.queue.enqueueConfirmed(input, resolution());
    expect(confirmed.state).toBe("approved");
    expect(confirmed.id).toBe(initial.request.id);
  });

  it("returns the current row when confirmation loses a race into executing", async () => {
    const h = createHarness();
    const input = messageInput({ idempotencyKey: "confirmed-3" });
    const initial = await h.queue.enqueueWithResult(input);
    h.armRaceHook((_sql, table) => {
      const live = table.get(initial.request.id);
      if (live) live.state = "executing";
    });

    const confirmed = await h.queue.enqueueConfirmed(input, resolution());
    expect(confirmed.state).toBe("executing");
  });

  it("rethrows when confirmation loses a race into rejected", async () => {
    const h = createHarness();
    const input = messageInput({ idempotencyKey: "confirmed-4" });
    const initial = await h.queue.enqueueWithResult(input);
    h.armRaceHook((_sql, table) => {
      const live = table.get(initial.request.id);
      if (live) live.state = "rejected";
    });

    await expect(h.queue.enqueueConfirmed(input, resolution())).rejects.toThrow(
      ApprovalStateTransitionError,
    );
  });
});

describe("transactional enqueue", () => {
  it("inserts through the caller transaction without touching the ambient connection or notifying", async () => {
    const h = createHarness();
    const txStatements: string[] = [];
    const tx = {
      execute: async (query: unknown) => {
        txStatements.push(sqlOf(query));
        return h.runQueryQuiet(query);
      },
    };

    const before = h.statements.length;
    const result = await h.queue.enqueueTransactional(messageInput(), tx);

    expect(result.reused).toBe(false);
    expect(result.request.state).toBe("pending");
    expect(txStatements).toHaveLength(1);
    expect(txStatements[0]).toContain("INSERT INTO approval_requests");
    expect(h.statements.length).toBe(before);
    expect(h.notifier.notify).not.toHaveBeenCalled();
    expect(h.rows.size).toBe(1);
  });
});
