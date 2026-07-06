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
import { ServiceType } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/core/testing";
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

interface NotifierSpy {
  notify: ReturnType<typeof vi.fn>;
  markReadByGroupKey: ReturnType<typeof vi.fn>;
}

function createNotifierSpy(): NotifierSpy {
  return {
    notify: vi.fn(async () => ({})),
    markReadByGroupKey: vi.fn(async () => 1),
  };
}

function createApprovalTableRuntime(
  agentId: string,
  notifier: NotifierSpy | null = null,
): IAgentRuntime {
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
    // The store resolves the NotificationService via ServiceType.NOTIFICATION;
    // return the spy when one is supplied so enqueue/resolve wiring is testable.
    getService: (type: string) =>
      notifier && type === ServiceType.NOTIFICATION ? notifier : null,
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
    const runtime = createMockRuntime({ getService: () => null });
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

  it("enqueue surfaces an approval notification under the approval:<id> groupKey", async () => {
    const notifier = createNotifierSpy();
    const runtime = createApprovalTableRuntime("agent-notif", notifier);
    const queue = (await ApprovalService.start(runtime)).getQueue();

    const enqueued = await queue.enqueue(messageInput());
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    const arg = notifier.notify.mock.calls[0][0];
    expect(arg.category).toBe("approval");
    expect(arg.priority).toBe("high"); // interrupt tier (§C.1)
    expect(arg.groupKey).toBe(`approval:${enqueued.id}`);
  });

  it("approving an approval auto-reads its notification by groupKey (§C.5)", async () => {
    const notifier = createNotifierSpy();
    const runtime = createApprovalTableRuntime("agent-autoread", notifier);
    const queue = (await ApprovalService.start(runtime)).getQueue();

    const enqueued = await queue.enqueue(messageInput());
    expect(notifier.markReadByGroupKey).not.toHaveBeenCalled();

    await queue.approve(enqueued.id, {
      resolvedBy: "owner-123",
      resolutionReason: "ok",
    });
    // The done thing must not keep nagging: the pointing notification is read.
    expect(notifier.markReadByGroupKey).toHaveBeenCalledWith(
      `approval:${enqueued.id}`,
    );
  });

  it("rejecting an approval also auto-reads its notification (§C.5)", async () => {
    const notifier = createNotifierSpy();
    const runtime = createApprovalTableRuntime("agent-reject-read", notifier);
    const queue = (await ApprovalService.start(runtime)).getQueue();

    const enqueued = await queue.enqueue(messageInput());
    await queue.reject(enqueued.id, {
      resolvedBy: "owner-123",
      resolutionReason: "no",
    });
    expect(notifier.markReadByGroupKey).toHaveBeenCalledWith(
      `approval:${enqueued.id}`,
    );
  });

  it("resolve does not throw when the notifier predates markReadByGroupKey", async () => {
    // An older NotificationService exposes notify but not markReadByGroupKey.
    const legacy = { notify: vi.fn(async () => ({})) };
    const runtime = createApprovalTableRuntime(
      "agent-legacy",
      legacy as unknown as NotifierSpy,
    );
    const queue = (await ApprovalService.start(runtime)).getQueue();
    const enqueued = await queue.enqueue(messageInput());
    // Must resolve cleanly even though markReadByGroupKey is absent.
    const approved = await queue.approve(enqueued.id, {
      resolvedBy: "owner-123",
      resolutionReason: "ok",
    });
    expect(approved.state).toBe("approved");
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
    const notifier = createNotifierSpy();
    const runtime = createApprovalTableRuntime("agent-1", notifier);
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
    expect(notifier.markReadByGroupKey).toHaveBeenCalledWith(
      `approval:${enqueued.id}`,
    );
  });

  it("a lapsed pending request is refused and expired at the transition boundary (#11092)", async () => {
    // No purge runs: the lazy guard alone must keep an expired approval from
    // ever executing — nothing calls purgeExpired periodically in production.
    const notifier = createNotifierSpy();
    const runtime = createApprovalTableRuntime("agent-1", notifier);
    const queue = (await ApprovalService.start(runtime)).getQueue();
    const enqueued = await queue.enqueue(
      messageInput({
        subjectUserId: "owner-lapsed",
        expiresAt: new Date(Date.now() - 5 * 60 * 1000),
      }),
    );
    expect(enqueued.state).toBe("pending");

    await expect(
      queue.approve(enqueued.id, {
        resolvedBy: "owner-lapsed",
        resolutionReason: "approving after expiry",
      }),
    ).rejects.toBeInstanceOf(ApprovalStateTransitionError);

    const after = await queue.byId(enqueued.id);
    expect(after?.state).toBe("expired");
    expect(after?.resolvedBy).toBeNull();
    expect(notifier.markReadByGroupKey).toHaveBeenCalledWith(
      `approval:${enqueued.id}`,
    );
  });

  it("a fresh pending request still approves normally under the expiry guard (#11092)", async () => {
    const runtime = createApprovalTableRuntime("agent-1");
    const queue = (await ApprovalService.start(runtime)).getQueue();
    const enqueued = await queue.enqueue(
      messageInput({
        subjectUserId: "owner-fresh",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      }),
    );
    const approved = await queue.approve(enqueued.id, {
      resolvedBy: "owner-fresh",
      resolutionReason: "in time",
    });
    expect(approved.state).toBe("approved");
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

describe("PgApprovalQueue transition CAS (TOCTOU)", () => {
  /**
   * Race: approve() reads `pending` and validates pending → approved, but a
   * concurrent purgeExpired flips the row to `expired` BEFORE the approve
   * UPDATE commits. Without the `AND state = <observed>` guard the UPDATE
   * overwrote the concurrent transition and resurrected an expired request
   * into `approved` — an expired spend/send could then execute. The guard
   * must make the late writer lose with ApprovalStateTransitionError and
   * leave the row `expired`.
   */
  it("a transition validated against a stale read loses the race instead of resurrecting the row", async () => {
    const runtime = createApprovalTableRuntime("agent-race");
    const queue = (await ApprovalService.start(runtime)).getQueue();
    const enqueued = await queue.enqueue(
      messageInput({
        subjectUserId: "owner-race",
        // Future expiresAt: the lazy expiry guard (#11092) must not preempt
        // the interleave — this test exercises the CAS window itself.
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      }),
    );

    // Interleave deterministically: the first UPDATE that tries to write
    // state='approved' for this row first has the "concurrent" purge land.
    const db = (
      runtime as unknown as {
        adapter: {
          db: { execute: (c: { __sql?: string }) => Promise<unknown> };
        };
      }
    ).adapter.db;
    const rawExecute = db.execute.bind(db);
    let interleaved = false;
    db.execute = async (chunks: { __sql?: string }) => {
      const sqlText = chunks.__sql ?? "";
      if (
        !interleaved &&
        /UPDATE\s+approval_requests/i.test(sqlText) &&
        sqlText.includes("'approved'") &&
        sqlText.includes(`'${enqueued.id}'`)
      ) {
        interleaved = true;
        await rawExecute({
          __sql: `UPDATE approval_requests
      SET state = 'expired', updated_at = '2026-07-01T00:00:00.000Z'
      WHERE id = '${enqueued.id}' AND agent_id = 'agent-race' AND state = 'pending'
      RETURNING id`,
        });
      }
      return rawExecute(chunks);
    };

    await expect(
      queue.approve(enqueued.id, {
        resolvedBy: "owner-race",
        resolutionReason: "too late",
      }),
    ).rejects.toBeInstanceOf(ApprovalStateTransitionError);

    const after = await queue.byId(enqueued.id);
    expect(after?.state).toBe("expired");
    expect(after?.resolvedBy).toBeNull();
  });

  it("markExecuting lost to a concurrent reject stays rejected", async () => {
    const runtime = createApprovalTableRuntime("agent-race2");
    const queue = (await ApprovalService.start(runtime)).getQueue();
    const enqueued = await queue.enqueue(
      messageInput({ subjectUserId: "owner-race2" }),
    );
    await queue.approve(enqueued.id, {
      resolvedBy: "owner-race2",
      resolutionReason: "ok",
    });

    const db = (
      runtime as unknown as {
        adapter: {
          db: { execute: (c: { __sql?: string }) => Promise<unknown> };
        };
      }
    ).adapter.db;
    const rawExecute = db.execute.bind(db);
    let interleaved = false;
    db.execute = async (chunks: { __sql?: string }) => {
      const sqlText = chunks.__sql ?? "";
      if (
        !interleaved &&
        /UPDATE\s+approval_requests/i.test(sqlText) &&
        sqlText.includes("'executing'") &&
        sqlText.includes(`'${enqueued.id}'`)
      ) {
        interleaved = true;
        await rawExecute({
          __sql: `UPDATE approval_requests
      SET state = 'rejected', updated_at = '2026-07-01T00:00:00.000Z'
      WHERE id = '${enqueued.id}' AND agent_id = 'agent-race2' AND state = 'approved'
      RETURNING id`,
        });
      }
      return rawExecute(chunks);
    };

    await expect(queue.markExecuting(enqueued.id)).rejects.toBeInstanceOf(
      ApprovalStateTransitionError,
    );
    const after = await queue.byId(enqueued.id);
    expect(after?.state).toBe("rejected");
  });
});
