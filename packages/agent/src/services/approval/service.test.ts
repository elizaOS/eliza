/**
 * ApprovalService unit test — the runtime-owned owner-approval queue.
 *
 * Drives the promoted `PgApprovalQueue` through the registered service's
 * `getQueue()` accessor against an in-memory fake of the `approval_requests`
 * table (the public-schema table owned by `@elizaos/plugin-sql`). The raw SQL
 * is unchanged from the LifeOps source, so this exercises the exact INSERT /
 * SELECT / UPDATE … RETURNING shapes the queue emits and asserts the
 * state-machine contract is preserved across the promotion to a runtime
 * service.
 *
 * The drizzle `sql.raw` shim hands the store our raw SQL text directly; the
 * fake `adapter.db.execute` interprets it against an in-memory row map. We only
 * model the query shapes the store emits — not a general SQL engine.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  APPROVAL_SERVICE,
  type ApprovalEnqueueInput,
  ApprovalNotFoundError,
  ApprovalService,
  ApprovalStateTransitionError,
  resolveApprovalService,
} from "./index.ts";

vi.mock("drizzle-orm", () => ({
  sql: {
    raw: (text: string) => ({ __sql: text, queryChunks: [text] }),
  },
}));

const SELECT_COLUMNS = [
  "id",
  "state",
  "requested_by",
  "subject_user_id",
  "action",
  "payload",
  "channel",
  "reason",
  "expires_at",
  "resolved_at",
  "resolved_by",
  "resolution_reason",
  "created_at",
  "updated_at",
];

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
  id?: string;
  agent_id?: string;
  subject_user_id?: string;
  state?: string;
  action?: string;
  expiresAtMax?: string;
}

function parseWhere(whereSql: string): WhereClause {
  const clause: WhereClause = {};
  for (const cond of whereSql.split(/\bAND\b/i).map((s) => s.trim())) {
    const eq = cond.match(/^(\w+)\s*=\s*('(?:[^']|'')*')$/);
    if (eq) {
      const [, col, val] = eq;
      const value = unquote(val);
      if (value !== null) (clause as Record<string, string>)[col] = value;
      continue;
    }
    const le = cond.match(/^expires_at\s*<=\s*('(?:[^']|'')*')$/);
    if (le) {
      const v = unquote(le[1]);
      if (v !== null) clause.expiresAtMax = v;
    }
  }
  return clause;
}

function matches(row: Record<string, unknown>, clause: WhereClause): boolean {
  if (clause.id !== undefined && row.id !== clause.id) return false;
  if (clause.agent_id !== undefined && row.agent_id !== clause.agent_id) {
    return false;
  }
  if (
    clause.subject_user_id !== undefined &&
    row.subject_user_id !== clause.subject_user_id
  ) {
    return false;
  }
  if (clause.state !== undefined && row.state !== clause.state) return false;
  if (clause.action !== undefined && row.action !== clause.action) return false;
  if (
    clause.expiresAtMax !== undefined &&
    String(row.expires_at) > clause.expiresAtMax
  ) {
    return false;
  }
  return true;
}

/** Parse `col = value` assignments out of a `SET …` fragment. */
function parseSet(setSql: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const assign of splitValues(setSql)) {
    const m = assign.match(/^(\w+)\s*=\s*([\s\S]+)$/);
    if (m) out[m[1]] = unquote(m[2]);
  }
  return out;
}

function createApprovalTableRuntime(agentId: string): IAgentRuntime {
  const rows = new Map<string, Record<string, unknown>>();

  const execute = (
    sqlText: string,
  ): { rows: Array<Record<string, unknown>> } => {
    const trimmed = sqlText.trim();

    if (/^INSERT\s+INTO\s+approval_requests/i.test(trimmed)) {
      const colsMatch = trimmed.match(/\(([\s\S]+?)\)\s*VALUES/i);
      const valsMatch = trimmed.match(/VALUES\s*\(([\s\S]+?)\)\s*RETURNING/i);
      if (!colsMatch || !valsMatch) throw new Error("bad INSERT in mock");
      const columns = colsMatch[1].split(",").map((s) => s.trim());
      const values = splitValues(valsMatch[1]);
      const row: Record<string, unknown> = {};
      columns.forEach((col, idx) => {
        row[col] = unquote(values[idx] ?? "NULL");
      });
      rows.set(String(row.id), row);
      return { rows: [projectSelect(row)] };
    }

    if (/^SELECT\s+/i.test(trimmed)) {
      const whereMatch = trimmed.match(
        /WHERE\s+([\s\S]+?)(?:\s+ORDER\s+BY|\s+LIMIT|$)/i,
      );
      const clause = whereMatch ? parseWhere(whereMatch[1]) : {};
      let result = Array.from(rows.values()).filter((r) => matches(r, clause));
      result = result.sort((a, b) =>
        String(b.created_at).localeCompare(String(a.created_at)),
      );
      const limitMatch = trimmed.match(/LIMIT\s+(\d+)/i);
      if (limitMatch) result = result.slice(0, Number(limitMatch[1]));
      return { rows: result.map(projectSelect) };
    }

    if (/^UPDATE\s+approval_requests/i.test(trimmed)) {
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
      if (returnsId) return { rows: updated.map((r) => ({ id: r.id })) };
      return { rows: updated.map(projectSelect) };
    }

    throw new Error(
      `unsupported SQL in approval mock: ${trimmed.slice(0, 40)}`,
    );
  };

  function projectSelect(
    row: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const col of SELECT_COLUMNS) out[col] = row[col] ?? null;
    return out;
  }

  return {
    agentId,
    adapter: {
      db: {
        execute: async (chunks: { __sql?: string }) =>
          execute(chunks.__sql ?? ""),
      },
    },
    getService: () => null,
  } as unknown as IAgentRuntime;
}

function messageInput(
  overrides: Partial<ApprovalEnqueueInput> = {},
): ApprovalEnqueueInput {
  return {
    requestedBy: "agent:lifeops",
    subjectUserId: "owner-123",
    action: "send_message",
    payload: {
      action: "send_message",
      recipient: "+15555551212",
      body: "Hello!",
      replyToMessageId: null,
    },
    channel: "sms",
    reason: "agent wants to confirm before sending",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  };
}

describe("ApprovalService", () => {
  it("exposes the canonical serviceType literal", () => {
    expect(ApprovalService.serviceType).toBe("eliza_approval");
    expect(APPROVAL_SERVICE).toBe("eliza_approval");
  });

  it("resolveApprovalService returns null when unregistered", () => {
    const runtime = { getService: () => null } as unknown as IAgentRuntime;
    expect(resolveApprovalService(runtime)).toBeNull();
  });

  it("enqueue → approve → markExecuting → markDone happy path", async () => {
    const runtime = createApprovalTableRuntime("agent-1");
    const queue = (await ApprovalService.start(runtime)).getQueue();

    const enqueued = await queue.enqueue(messageInput());
    expect(enqueued.state).toBe("pending");
    expect(enqueued.resolvedAt).toBeNull();
    expect(enqueued.action).toBe("send_message");

    const fetched = await queue.byId(enqueued.id);
    expect(fetched?.id).toBe(enqueued.id);

    const approved = await queue.approve(enqueued.id, {
      resolvedBy: "owner-123",
      resolutionReason: "looks good",
    });
    expect(approved.state).toBe("approved");
    expect(approved.resolvedBy).toBe("owner-123");
    expect(approved.resolvedAt).toBeInstanceOf(Date);

    const executing = await queue.markExecuting(enqueued.id);
    expect(executing.state).toBe("executing");

    const done = await queue.markDone(enqueued.id);
    expect(done.state).toBe("done");

    const pendingList = await queue.list({
      subjectUserId: "owner-123",
      state: "pending",
      action: null,
      limit: 10,
    });
    expect(pendingList.every((r) => r.id !== enqueued.id)).toBe(true);
  });

  it("enqueue → reject records the resolver", async () => {
    const runtime = createApprovalTableRuntime("agent-1");
    const queue = (await ApprovalService.start(runtime)).getQueue();
    const enqueued = await queue.enqueue(
      messageInput({ subjectUserId: "owner-reject" }),
    );
    const rejected = await queue.reject(enqueued.id, {
      resolvedBy: "owner-reject",
      resolutionReason: "not now",
    });
    expect(rejected.state).toBe("rejected");
    expect(rejected.resolutionReason).toBe("not now");
  });

  it("purgeExpired moves past-due pending rows to expired", async () => {
    const runtime = createApprovalTableRuntime("agent-1");
    const queue = (await ApprovalService.start(runtime)).getQueue();
    const enqueued = await queue.enqueue(
      messageInput({
        subjectUserId: "owner-expire",
        expiresAt: new Date(Date.now() - 5 * 60 * 1000),
      }),
    );
    const purgedIds = await queue.purgeExpired(new Date());
    expect(purgedIds).toContain(enqueued.id);
    const after = await queue.byId(enqueued.id);
    expect(after?.state).toBe("expired");
  });

  it("rejects invalid state transitions hard", async () => {
    const runtime = createApprovalTableRuntime("agent-1");
    const queue = (await ApprovalService.start(runtime)).getQueue();
    const enqueued = await queue.enqueue(
      messageInput({ subjectUserId: "owner-invalid" }),
    );
    // pending -> executing is illegal; must go through approved first.
    await expect(queue.markExecuting(enqueued.id)).rejects.toBeInstanceOf(
      ApprovalStateTransitionError,
    );
    await expect(queue.markDone(enqueued.id)).rejects.toBeInstanceOf(
      ApprovalStateTransitionError,
    );
  });

  it("throws ApprovalNotFoundError on unknown id", async () => {
    const runtime = createApprovalTableRuntime("agent-1");
    const queue = (await ApprovalService.start(runtime)).getQueue();
    await expect(
      queue.approve("00000000-0000-0000-0000-000000000000", {
        resolvedBy: "owner-123",
        resolutionReason: "x",
      }),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError);
  });

  it("scopes rows by agentId (no cross-agent reads)", async () => {
    const runtime = createApprovalTableRuntime("agent-1");
    const service = await ApprovalService.start(runtime);
    const enqueued = await service.getQueue("agent-1").enqueue(messageInput());
    // A queue for a different agentId must not see agent-1's row.
    const otherQueue = service.getQueue("agent-2");
    expect(await otherQueue.byId(enqueued.id)).toBeNull();
  });
});
