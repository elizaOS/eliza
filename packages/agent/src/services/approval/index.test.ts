/**
 * Approval barrel contract test — the `services/approval/index.ts` public
 * surface (`ApprovalService`, `resolveApprovalService`, `createApprovalQueue`,
 * `PgApprovalQueue`, the execution constants, and the typed errors).
 *
 * Drives the real service and store through the barrel against an in-memory
 * fake of the `approval_requests` table (the public-schema table owned by
 * `@elizaos/plugin-sql`). Covers the wiring the service-level suite does not:
 * the default-`runtime.agentId` partition, the positive
 * `resolveApprovalService` path, the `getExecutionCapability` protocol gate,
 * and the `ApprovalIdempotencyConflictError` branch. Deterministic: no
 * network, no database, no wall-clock assertions.
 */

import { randomUUID } from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/core/testing";
import { describe, expect, it, vi } from "vitest";
import {
  APPROVAL_EXECUTION_CAPABILITY,
  APPROVAL_EXECUTION_PROTOCOL_VERSION,
  APPROVAL_SERVICE,
  ApprovalIdempotencyConflictError,
  ApprovalNotFoundError,
  ApprovalService,
  ApprovalStateTransitionError,
  createApprovalQueue,
  PgApprovalQueue,
  resolveApprovalService,
} from "./index.ts";

vi.mock("drizzle-orm", () => ({
  sql: {
    raw: (text: string) => ({ __sql: text, queryChunks: [text] }),
  },
}));

const SUBJECT = "owner-barrel";

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
  [column: string]: string | undefined;
}

function parseWhere(whereSql: string): WhereClause {
  const clause: WhereClause = {};
  for (const cond of whereSql.split(/\bAND\b/i).map((s) => s.trim())) {
    const eq = cond.match(/^(\w+)\s*=\s*('(?:[^']|'')*')$/);
    if (eq) {
      const [, column, value] = eq;
      const unquoted = unquote(value);
      if (unquoted !== null) clause[column] = unquoted;
    }
  }
  return clause;
}

function matches(row: Record<string, unknown>, clause: WhereClause): boolean {
  for (const [column, value] of Object.entries(clause)) {
    if (value !== undefined && row[column] !== value) return false;
  }
  return true;
}

/**
 * In-memory stand-in for the `approval_requests` table. Interprets exactly the
 * INSERT … RETURNING and SELECT … ORDER BY … LIMIT shapes the store emits; we
 * model query shapes, not a general SQL engine.
 */
function createApprovalTableRuntime(agentId: string): IAgentRuntime {
  const rows = new Map<string, Record<string, unknown>>();

  function projectSelect(
    row: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const column of SELECT_COLUMNS) out[column] = row[column] ?? null;
    return out;
  }

  const execute = (
    sqlText: string,
  ): { rows: Array<Record<string, unknown>> } => {
    const trimmed = sqlText.trim();

    if (/^INSERT\s+INTO\s+approval_requests/i.test(trimmed)) {
      const colsMatch = trimmed.match(/\(([\s\S]+?)\)\s*VALUES/i);
      const valsMatch = trimmed.match(
        /VALUES\s*\(([\s\S]+?)\)\s*(?:ON\s+CONFLICT[\s\S]+?)?RETURNING/i,
      );
      if (!colsMatch || !valsMatch) throw new Error("bad INSERT in mock");
      const columns = colsMatch[1].split(",").map((s) => s.trim());
      const values = splitValues(valsMatch[1]);
      const row: Record<string, unknown> = {};
      columns.forEach((column, index) => {
        row[column] = unquote(values[index] ?? "NULL");
      });
      if (
        /\bON\s+CONFLICT\b/i.test(trimmed) &&
        Array.from(rows.values()).some(
          (existing) =>
            existing.agent_id === row.agent_id &&
            existing.idempotency_key === row.idempotency_key,
        )
      ) {
        return { rows: [] };
      }
      rows.set(String(row.id), row);
      return { rows: [projectSelect(row)] };
    }

    if (/^SELECT\s+/i.test(trimmed)) {
      const whereMatch = trimmed.match(
        /WHERE\s+([\s\S]+?)(?:\s+ORDER\s+BY|\s+LIMIT|$)/i,
      );
      const clause = whereMatch ? parseWhere(whereMatch[1]) : {};
      let result = Array.from(rows.values()).filter((row) =>
        matches(row, clause),
      );
      result = result.sort((a, b) =>
        String(b.created_at).localeCompare(String(a.created_at)),
      );
      const limitMatch = trimmed.match(/LIMIT\s+(\d+)/i);
      if (limitMatch) result = result.slice(0, Number(limitMatch[1]));
      return { rows: result.map(projectSelect) };
    }

    throw new Error(
      `unsupported SQL in approval mock: ${trimmed.slice(0, 40)}`,
    );
  };

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
  overrides: Partial<
    Parameters<ReturnType<typeof createApprovalQueue>["enqueue"]>[0]
  > = {},
) {
  return {
    requestedBy: "agent:barrel-test",
    subjectUserId: SUBJECT,
    action: "send_message" as const,
    payload: {
      action: "send_message" as const,
      recipient: "+15555551212",
      body: "Hello!",
      replyToMessageId: null,
    },
    channel: "sms" as const,
    reason: "agent wants owner confirmation",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  };
}

describe("approval barrel surface", () => {
  it("pins the service key and execution protocol constants consumers bind to", () => {
    expect(APPROVAL_SERVICE).toBe("eliza_approval");
    expect(APPROVAL_EXECUTION_CAPABILITY).toBe("eliza.approval-execution");
    expect(APPROVAL_EXECUTION_PROTOCOL_VERSION).toBe(2);
  });

  it("exposes one queue implementation stamped with the capability and protocol", () => {
    const runtime = createApprovalTableRuntime("agent-barrel-shape");
    const queue = createApprovalQueue(runtime, {
      agentId: "agent-barrel-shape",
    });
    expect(queue).toBeInstanceOf(PgApprovalQueue);
    expect(queue.capability).toBe(APPROVAL_EXECUTION_CAPABILITY);
    expect(queue.protocolVersion).toBe(APPROVAL_EXECUTION_PROTOCOL_VERSION);
  });
});

describe("resolveApprovalService", () => {
  it("returns null when the runtime has no registered approval service", () => {
    const runtime = createMockRuntime({ getService: () => null });
    expect(resolveApprovalService(runtime)).toBeNull();
  });

  it("returns the exact instance registered under the approval service key", async () => {
    const registered = await ApprovalService.start(
      createApprovalTableRuntime("agent-resolve"),
    );
    const requestedTypes: string[] = [];
    const runtime = createMockRuntime({
      getService: ((type: string) => {
        requestedTypes.push(type);
        return type === APPROVAL_SERVICE ? registered : null;
      }) as IAgentRuntime["getService"],
    });
    expect(resolveApprovalService(runtime)).toBe(registered);
    expect(requestedTypes).toContain(APPROVAL_SERVICE);
  });
});

describe("ApprovalService", () => {
  it("start binds the supplied runtime and stop resolves without work", async () => {
    const service = await ApprovalService.start(
      createApprovalTableRuntime("agent-lifecycle"),
    );
    expect(service).toBeInstanceOf(ApprovalService);
    expect(service.capabilityDescription.length).toBeGreaterThan(0);
    await expect(service.stop()).resolves.toBeUndefined();
  });

  it("getQueue() defaults the partition to runtime.agentId", async () => {
    const service = await ApprovalService.start(
      createApprovalTableRuntime("agent-default-partition"),
    );
    const enqueued = await service.getQueue().enqueue(messageInput());

    const stranger = service.getQueue("agent-stranger");
    expect(await stranger.byId(enqueued.id, SUBJECT)).toBeNull();

    // The default queue reads its own partition back.
    const own = await service.getQueue().byId(enqueued.id, SUBJECT);
    expect(own?.id).toBe(enqueued.id);
  });

  it("getExecutionCapability serves the current protocol for an explicit agent partition", async () => {
    const service = await ApprovalService.start(
      createApprovalTableRuntime("agent-capability"),
    );
    const queue = service.getExecutionCapability(
      APPROVAL_EXECUTION_PROTOCOL_VERSION,
      "agent-explicit",
    );
    expect(queue.capability).toBe(APPROVAL_EXECUTION_CAPABILITY);

    const enqueued = await queue.enqueue(messageInput());
    expect(await service.getQueue().byId(enqueued.id, SUBJECT)).toBeNull();
    const explicit = await service
      .getQueue("agent-explicit")
      .byId(enqueued.id, SUBJECT);
    expect(explicit?.id).toBe(enqueued.id);
  });

  it("refuses unsupported protocol versions by message", async () => {
    const service = await ApprovalService.start(
      createApprovalTableRuntime("agent-version-gate"),
    );
    const attempt = (version: number) =>
      (service.getExecutionCapability as unknown as (v: number) => unknown)(
        version,
      );
    for (const version of [1, 3]) {
      expect(() => attempt(version)).toThrow(
        `unsupported approval execution protocol version: ${version}`,
      );
    }
  });
});

describe("PgApprovalQueue through the barrel", () => {
  it("enqueues a pending request and decodes it back through byId", async () => {
    const queue = createApprovalQueue(
      createApprovalTableRuntime("agent-roundtrip"),
      { agentId: "agent-roundtrip" },
    );
    const input = messageInput({ idempotencyKey: "barrel-roundtrip-1" });

    const inserted = await queue.enqueueWithResult(input);
    expect(inserted.reused).toBe(false);
    expect(inserted.request.state).toBe("pending");
    expect(inserted.request.idempotencyKey).toBe("barrel-roundtrip-1");

    const fetched = await queue.byId(inserted.request.id, SUBJECT);
    expect(fetched?.action).toBe("send_message");
    expect(fetched?.channel).toBe("sms");
    expect(fetched?.payload).toEqual(input.payload);
    expect(fetched?.createdAt).toBeInstanceOf(Date);
    expect(fetched?.expiresAt).toBeInstanceOf(Date);
    expect(fetched?.execution).toBeNull();
  });

  it("replays the same immutable approval under one idempotency key", async () => {
    const queue = createApprovalQueue(
      createApprovalTableRuntime("agent-replay"),
      { agentId: "agent-replay" },
    );
    const input = messageInput({ idempotencyKey: "barrel-replay-1" });

    const first = await queue.enqueueWithResult(input);
    const replay = await queue.enqueueWithResult({ ...input });
    expect(first.reused).toBe(false);
    expect(replay.reused).toBe(true);
    expect(replay.request.id).toBe(first.request.id);
  });

  it("rejects a reused idempotency key describing a different approval", async () => {
    const queue = createApprovalQueue(
      createApprovalTableRuntime("agent-conflict"),
      { agentId: "agent-conflict" },
    );
    const input = messageInput({ idempotencyKey: "barrel-conflict-1" });
    const original = await queue.enqueue(input);

    const conflict = await queue
      .enqueue({ ...input, reason: "changed intent" })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(conflict).toBeInstanceOf(ApprovalIdempotencyConflictError);
    expect((conflict as ApprovalIdempotencyConflictError).idempotencyKey).toBe(
      "barrel-conflict-1",
    );

    // The stored row still carries the original approval.
    const after = await queue.byId(original.id, SUBJECT);
    expect(after?.reason).toBe("agent wants owner confirmation");
  });

  it("treats a whitespace idempotency key as no key at all", async () => {
    const queue = createApprovalQueue(
      createApprovalTableRuntime("agent-blank-key"),
      { agentId: "agent-blank-key" },
    );

    const first = await queue.enqueueWithResult(
      messageInput({ idempotencyKey: "   ", reason: "first" }),
    );
    const second = await queue.enqueueWithResult(
      messageInput({ idempotencyKey: "   ", reason: "second" }),
    );

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(false);
    expect(second.request.id).not.toBe(first.request.id);
    expect(second.request.idempotencyKey).toBeNull();
  });
});

describe("exported approval errors", () => {
  it("ApprovalIdempotencyConflictError names the conflicting key", () => {
    const error = new ApprovalIdempotencyConflictError("key-x");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ApprovalIdempotencyConflictError");
    expect(error.idempotencyKey).toBe("key-x");
    expect(error.message).toContain("key-x");
  });

  it("ApprovalStateTransitionError reports the request and both states", () => {
    const error = new ApprovalStateTransitionError("req-1", "pending", "done");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ApprovalStateTransitionError");
    expect(error.requestId).toBe("req-1");
    expect(error.from).toBe("pending");
    expect(error.to).toBe("done");
    expect(error.message).toContain("pending -> done");
  });

  it("ApprovalNotFoundError reports the missing request id", () => {
    const error = new ApprovalNotFoundError(`missing-${randomUUID()}`);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ApprovalNotFoundError");
    expect(error.requestId).toBe(error.message.split("request not found: ")[1]);
    expect(error.message).toContain("[ApprovalQueue]");
  });
});
