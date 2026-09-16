/**
 * Approval workflow routes — tenant-level approval management.
 *
 * Mount: app.route("/approvals", approvalRoutes)
 */

import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { containsAsciiControl } from "../../../shared/src/text-boundaries";
import {
  withTenantAuditedTransaction,
  writeAuditEvent,
} from "../services/audit";
import {
  type ApiResponse,
  type AppVariables,
  agents,
  approvalQueue,
  autoApprovalRules,
  db,
  pendingProxyRequests,
  requireTenantLevel,
  safeJsonParse,
  setNoStoreHeaders,
  transactions,
} from "../services/context";
import { isRecentMfaTimestamp } from "../services/recent-mfa";
import { dispatchWebhook } from "../services/webhook-dispatch";

/**
 * Internal sentinel used to roll back an in-progress audited transaction when
 * the target transaction was resolved concurrently (guarded-update loser).
 * Throwing it rolls back the whole unit; the route maps it to a 409.
 */
class ApprovalAlreadyResolvedError extends Error {
  constructor() {
    super("Approval transaction already resolved");
    this.name = "ApprovalAlreadyResolvedError";
  }
}

export const approvalRoutes = new Hono<{ Variables: AppVariables }>();

approvalRoutes.use("*", async (c, next) => {
  setNoStoreHeaders(c);
  await next();
});

type ApprovalStatusFilter = "pending" | "approved" | "rejected" | "all";

const APPROVAL_STATUS_FILTERS = new Set<ApprovalStatusFilter>([
  "pending",
  "approved",
  "rejected",
  "all",
]);
const MAX_APPROVAL_LIST_LIMIT = 200;
const MAX_APPROVAL_LIST_OFFSET = 10_000;
const MAX_APPROVAL_TEXT_LENGTH = 1_000;
const MAX_APPROVAL_AGENT_ID_LENGTH = 64;
const MAX_APPROVAL_CURSOR_ID_LENGTH = 64;

const approvalTransactionMatchesQueue = sql`${transactions.agentId} = ${approvalQueue.agentId}`;
// JSON/JavaScript Date values retain milliseconds while PostgreSQL timestamps
// may retain microseconds. Use the serialized precision for both ordering and
// cursor comparisons, with id as the deterministic tie-breaker, so sub-ms rows
// cannot fall into a gap between pages.
const approvalRequestedAtMs = sql<Date>`date_trunc('milliseconds', ${approvalQueue.requestedAt})`;

function approvalActor(c: Context<{ Variables: AppVariables }>): string {
  return (
    c.get("userId") ?? `${c.get("authType") ?? "tenant"}:${c.get("tenantId")}`
  );
}

function approvalPrincipal(c: Context<{ Variables: AppVariables }>): {
  type: "user" | "tenant";
  id: string;
} {
  const userId = c.get("userId");
  if (typeof userId === "string" && userId.length > 0) {
    return { type: "user", id: userId };
  }
  return { type: "tenant", id: c.get("tenantId") };
}

function requireHumanApprover(
  c: Context<{ Variables: AppVariables }>,
): boolean {
  const authType = c.get("authType");
  const role = c.get("tenantRole");
  return (
    (authType === "session-jwt" || authType === "dashboard-jwt") &&
    Boolean(c.get("userId")) &&
    (role === "owner" || role === "admin")
  );
}

function hasRecentSessionMfa(
  c: Context<{ Variables: AppVariables }>,
  maxAgeMs = 5 * 60_000,
) {
  return isRecentMfaTimestamp(c.get("sessionMfaVerifiedAt"), maxAgeMs);
}

function approvalIntentActionType(
  actionType: string | null | undefined,
): string {
  if (actionType === "transfer") return "wallet_action.transfer";
  if (actionType === "send_calls") return "wallet_action.send_calls";
  if (actionType === "user_operation") return "user_operation";
  if (actionType === "authorization") return "eip7702_authorization";
  return "transaction";
}

function dispatchApprovalIntentWebhook(
  tenantId: string,
  agentId: string,
  type: "intent.authorized" | "intent.rejected",
  payload: {
    txId: string;
    actionType?: string | null;
    status: "authorized" | "rejected";
    approvalId: string;
    reason?: string;
  },
): void {
  dispatchWebhook(tenantId, agentId, type, {
    intent_id: payload.txId,
    txId: payload.txId,
    transaction_id: payload.txId,
    wallet_id: agentId,
    action_type: approvalIntentActionType(payload.actionType),
    status: payload.status,
    approval_id: payload.approvalId,
    ...(payload.reason ? { reason: payload.reason } : {}),
  });
}

function isNonNegativeIntegerString(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return false;
  try {
    return BigInt(value) >= 0n;
  } catch {
    return false;
  }
}

function parseNonNegativeIntegerParam(
  value: string | undefined,
  fallback: number,
): number | null {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseApprovalListParams(c: Context<{ Variables: AppVariables }>) {
  const rawStatus = c.req.query("status") ?? "pending";
  if (!APPROVAL_STATUS_FILTERS.has(rawStatus as ApprovalStatusFilter)) {
    return {
      ok: false as const,
      error: "status must be pending, approved, rejected, or all",
    };
  }

  const rawLimit = parseNonNegativeIntegerParam(c.req.query("limit"), 50);
  if (rawLimit === null || rawLimit < 1 || rawLimit > MAX_APPROVAL_LIST_LIMIT) {
    return {
      ok: false as const,
      error: `limit must be an integer from 1 to ${MAX_APPROVAL_LIST_LIMIT}`,
    };
  }

  const rawOffset = parseNonNegativeIntegerParam(c.req.query("offset"), 0);
  if (rawOffset === null || rawOffset > MAX_APPROVAL_LIST_OFFSET) {
    return {
      ok: false as const,
      error: `offset must be an integer from 0 to ${MAX_APPROVAL_LIST_OFFSET}`,
    };
  }

  const rawAgentId = c.req.query("agentId");
  const agentId = rawAgentId?.trim();
  if (
    rawAgentId !== undefined &&
    (!agentId ||
      agentId.length > MAX_APPROVAL_AGENT_ID_LENGTH ||
      agentId !== rawAgentId ||
      containsAsciiControl(agentId))
  ) {
    return {
      ok: false as const,
      error: `agentId must be a non-empty string of at most ${MAX_APPROVAL_AGENT_ID_LENGTH} characters`,
    };
  }

  const rawCursorRequestedAt = c.req.query("cursorRequestedAt");
  const rawCursorId = c.req.query("cursorId");
  if ((rawCursorRequestedAt === undefined) !== (rawCursorId === undefined)) {
    return {
      ok: false as const,
      error: "cursorRequestedAt and cursorId must be supplied together",
    };
  }
  if (
    rawCursorRequestedAt !== undefined &&
    c.req.query("offset") !== undefined
  ) {
    return {
      ok: false as const,
      error: "cursor pagination cannot be combined with offset",
    };
  }

  let cursorRequestedAt: string | undefined;
  if (rawCursorRequestedAt !== undefined && rawCursorId !== undefined) {
    const parsedCursorRequestedAt = new Date(rawCursorRequestedAt);
    if (
      Number.isNaN(parsedCursorRequestedAt.getTime()) ||
      parsedCursorRequestedAt.toISOString() !== rawCursorRequestedAt ||
      !/^(?!0000-)\d{4}-/.test(rawCursorRequestedAt)
    ) {
      return {
        ok: false as const,
        error: "cursorRequestedAt must be an ISO 8601 timestamp",
      };
    }
    // Keep the canonical wire representation. Passing a Date as a parameter to
    // a raw SQL expression is driver-dependent and postgres.js expects a string.
    cursorRequestedAt = rawCursorRequestedAt;
    if (
      rawCursorId.length === 0 ||
      rawCursorId.length > MAX_APPROVAL_CURSOR_ID_LENGTH ||
      rawCursorId.trim() !== rawCursorId ||
      containsAsciiControl(rawCursorId)
    ) {
      return {
        ok: false as const,
        error: `cursorId must be a non-empty string of at most ${MAX_APPROVAL_CURSOR_ID_LENGTH} characters`,
      };
    }
  }

  return {
    ok: true as const,
    status: rawStatus as ApprovalStatusFilter,
    limit: rawLimit,
    offset: rawOffset,
    agentId,
    cursorRequestedAt,
    cursorId: rawCursorId,
  };
}

function parseBoundedText(value: unknown, required = false): string | null {
  if (typeof value !== "string") return required ? null : "";
  const trimmed = value.trim();
  if (required && trimmed.length === 0) return null;
  if (trimmed.length > MAX_APPROVAL_TEXT_LENGTH) return null;
  return trimmed;
}

type ApprovalAuditEvent = {
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, unknown>;
};

/**
 * Build the audit-event input for an approval-control-plane mutation from the
 * request context. Kept separate from the writer so the exact same event can be
 * appended either standalone (`writeApprovalAudit`) or atomically inside a
 * caller's transaction (`appendRequiredAudit` from `withTenantAuditedTransaction`).
 */
function approvalAuditEvent(
  c: Context<{ Variables: AppVariables }>,
  event: ApprovalAuditEvent,
) {
  return {
    tenantId: c.get("tenantId"),
    actorType: "user" as const,
    actorId: approvalActor(c),
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    metadata: event.metadata,
    ipAddress: c.req.header("x-forwarded-for") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
    requestId: c.get("requestId") ?? null,
  };
}

async function writeApprovalAudit(
  c: Context<{ Variables: AppVariables }>,
  event: ApprovalAuditEvent,
): Promise<void> {
  await writeAuditEvent(approvalAuditEvent(c, event));
}

// ─── List pending approvals for a tenant ──────────────────────────────────────

approvalRoutes.get("/", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Tenant-level auth required" },
      403,
    );
  }
  if (!requireHumanApprover(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Approval queue requires an owner or admin user session",
      },
      403,
    );
  }
  if (!hasRecentSessionMfa(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Approval queue access requires recent MFA verification",
      },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const params = parseApprovalListParams(c);
  if (!params.ok) {
    return c.json<ApiResponse>({ ok: false, error: params.error }, 400);
  }
  const {
    status: statusFilter,
    limit,
    offset,
    agentId,
    cursorRequestedAt,
    cursorId,
  } = params;
  const cursorRequestedAtSql = cursorRequestedAt
    ? sql<Date>`${cursorRequestedAt}::timestamptz`
    : undefined;

  // Join approval_queue with agents to filter by tenant
  const results = await db
    .select({
      id: approvalQueue.id,
      txId: approvalQueue.txId,
      agentId: approvalQueue.agentId,
      agentName: agents.name,
      status: approvalQueue.status,
      requestedAt: approvalQueue.requestedAt,
      resolvedAt: approvalQueue.resolvedAt,
      resolvedBy: approvalQueue.resolvedBy,
      requestedByType: approvalQueue.requestedByType,
      requestedById: approvalQueue.requestedById,
      resolvedByType: approvalQueue.resolvedByType,
      resolvedById: approvalQueue.resolvedById,
      // Transaction details
      toAddress: transactions.toAddress,
      value: transactions.value,
      chainId: transactions.chainId,
      txStatus: transactions.status,
    })
    .from(approvalQueue)
    .innerJoin(agents, eq(approvalQueue.agentId, agents.id))
    .innerJoin(transactions, eq(approvalQueue.txId, transactions.id))
    .where(
      and(
        eq(agents.tenantId, tenantId),
        approvalTransactionMatchesQueue,
        agentId ? eq(approvalQueue.agentId, agentId) : undefined,
        statusFilter !== "all"
          ? eq(approvalQueue.status, statusFilter)
          : undefined,
        cursorRequestedAtSql && cursorId
          ? or(
              lt(approvalRequestedAtMs, cursorRequestedAtSql),
              and(
                eq(approvalRequestedAtMs, cursorRequestedAtSql),
                lt(approvalQueue.id, cursorId),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(approvalRequestedAtMs), desc(approvalQueue.id))
    .limit(limit)
    .offset(offset);

  return c.json<ApiResponse>({ ok: true, data: results });
});

// ─── Approval stats ───────────────────────────────────────────────────────────

approvalRoutes.get("/stats", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Tenant-level auth required" },
      403,
    );
  }
  if (!requireHumanApprover(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Manual approval requires an owner or admin user session",
      },
      403,
    );
  }
  if (!hasRecentSessionMfa(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Approval stats access requires recent MFA verification",
      },
      403,
    );
  }

  const tenantId = c.get("tenantId");

  const [stats] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${approvalQueue.status} = 'pending')`,
      approved: sql<number>`count(*) filter (where ${approvalQueue.status} = 'approved')`,
      rejected: sql<number>`count(*) filter (where ${approvalQueue.status} = 'rejected')`,
      total: sql<number>`count(*)`,
      avgWaitSeconds: sql<number>`
        coalesce(
          avg(
            extract(epoch from (${approvalQueue.resolvedAt} - ${approvalQueue.requestedAt}))
          ) filter (where ${approvalQueue.resolvedAt} is not null),
          0
        )::integer
      `,
    })
    .from(approvalQueue)
    .innerJoin(agents, eq(approvalQueue.agentId, agents.id))
    .where(eq(agents.tenantId, tenantId));

  return c.json<ApiResponse>({
    ok: true,
    data: {
      pending: Number(stats?.pending ?? 0),
      approved: Number(stats?.approved ?? 0),
      rejected: Number(stats?.rejected ?? 0),
      total: Number(stats?.total ?? 0),
      avgWaitSeconds: Number(stats?.avgWaitSeconds ?? 0),
    },
  });
});

// ─── Approval-gated proxy requests ───────────────────────────────────────────

async function requireProxyOperator(
  c: Context<{ Variables: AppVariables }>,
): Promise<Response | null> {
  if (!requireTenantLevel(c) || !requireHumanApprover(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Proxy approvals require an owner or admin user session",
      },
      403,
    );
  }
  if (!hasRecentSessionMfa(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Proxy approvals require recent MFA verification" },
      403,
    );
  }
  return null;
}

async function expireProxyApprovals(tenantId: string): Promise<void> {
  // Atomicity: the expiry state transition for every row and its
  // `proxy.approval.expired` audit event commit in ONE transaction. Previously
  // the bulk UPDATE committed first and the per-row audits were written after in
  // separate transactions, so a crash mid-loop left expired rows with no audit
  // record (spec section 11 item #10). Now a crash before commit leaves nothing
  // expired and the next sweep/API call retries the whole batch idempotently
  // (the `status IN ('pending','approved')` guard means already-expired rows are
  // not re-selected and cannot be double-audited).
  await withTenantAuditedTransaction(
    tenantId,
    async (tx, appendRequiredAudit) => {
      const dbTx = tx as typeof db;
      const expired = await dbTx
        .update(pendingProxyRequests)
        .set({ status: "expired", updatedAt: new Date() })
        .where(
          and(
            eq(pendingProxyRequests.tenantId, tenantId),
            inArray(pendingProxyRequests.status, ["pending", "approved"]),
            sql`${pendingProxyRequests.expiresAt} <= now()`,
          ),
        )
        .returning();
      for (const row of expired) {
        await appendRequiredAudit({
          tenantId,
          actorType: "system",
          actorId: "proxy-approval-expirer",
          action: "proxy.approval.expired",
          resourceType: "pending_proxy_request",
          resourceId: row.id,
          metadata: { agentId: row.agentId, routeId: row.routeId },
        });
      }
    },
  );
}

approvalRoutes.get("/proxy", async (c) => {
  const denied = await requireProxyOperator(c);
  if (denied) return denied;
  const tenantId = c.get("tenantId");
  await expireProxyApprovals(tenantId);
  const status = c.req.query("status");
  const valid = [
    "pending",
    "approved",
    "denied",
    "executing",
    "executed",
    "expired",
    "failed",
  ] as const;
  if (status && !valid.includes(status as (typeof valid)[number]))
    return c.json<ApiResponse>({ ok: false, error: "Invalid status" }, 400);
  const rows = await db
    .select({
      id: pendingProxyRequests.id,
      agentId: pendingProxyRequests.agentId,
      routeId: pendingProxyRequests.routeId,
      method: pendingProxyRequests.method,
      targetHost: pendingProxyRequests.targetHost,
      targetPath: pendingProxyRequests.targetPath,
      preview: pendingProxyRequests.preview,
      status: pendingProxyRequests.status,
      expiresAt: pendingProxyRequests.expiresAt,
      createdAt: pendingProxyRequests.createdAt,
      executionStatusCode: pendingProxyRequests.executionStatusCode,
    })
    .from(pendingProxyRequests)
    .where(
      and(
        eq(pendingProxyRequests.tenantId, tenantId),
        status
          ? eq(pendingProxyRequests.status, status as (typeof valid)[number])
          : undefined,
      ),
    )
    .orderBy(desc(pendingProxyRequests.createdAt))
    .limit(200);
  return c.json<ApiResponse>({ ok: true, data: rows });
});

approvalRoutes.get("/proxy/:id", async (c) => {
  const denied = await requireProxyOperator(c);
  if (denied) return denied;
  const tenantId = c.get("tenantId");
  await expireProxyApprovals(tenantId);
  const [row] = await db
    .select({
      id: pendingProxyRequests.id,
      agentId: pendingProxyRequests.agentId,
      routeId: pendingProxyRequests.routeId,
      method: pendingProxyRequests.method,
      targetHost: pendingProxyRequests.targetHost,
      targetPath: pendingProxyRequests.targetPath,
      preview: pendingProxyRequests.preview,
      status: pendingProxyRequests.status,
      expiresAt: pendingProxyRequests.expiresAt,
      executionStatusCode: pendingProxyRequests.executionStatusCode,
      executionError: pendingProxyRequests.executionError,
    })
    .from(pendingProxyRequests)
    .where(
      and(
        eq(pendingProxyRequests.id, c.req.param("id")),
        eq(pendingProxyRequests.tenantId, tenantId),
      ),
    )
    .limit(1);
  if (!row)
    return c.json<ApiResponse>(
      { ok: false, error: "Pending proxy request not found" },
      404,
    );
  return c.json<ApiResponse>({ ok: true, data: row });
});

approvalRoutes.post("/proxy/:id/approve", async (c) => {
  const denied = await requireProxyOperator(c);
  if (denied) return denied;
  const tenantId = c.get("tenantId");
  await expireProxyApprovals(tenantId);
  const actor = approvalActor(c);
  // Atomicity: the pending -> approved transition and its
  // `proxy.approval.approved` audit event commit in ONE transaction. Previously
  // the UPDATE committed first and the audit was written in a separate
  // transaction, so an audit failure or crash between them could leave an
  // approved request with no audit record (spec section 11 item #10, invariant
  // I14). The guarded `status = 'pending'` predicate keeps a retry after a crash
  // idempotent: only one transaction can flip the row, and a replayed approve of
  // an already-approved row returns 409 without a second transition or audit.
  const row = await withTenantAuditedTransaction(
    tenantId,
    async (tx, appendRequiredAudit) => {
      const dbTx = tx as typeof db;
      // Agent deletion takes the tenant fence before the parent agent and pending
      // request rows. Approval is an authority reactivation, so acquire the same
      // fence before UPDATE takes the pending-request row lock. Relying only on
      // the row trigger would acquire the advisory lock after PostgreSQL has
      // already locked the row, which can deadlock with deletion.
      await dbTx.execute(
        sql`SELECT public.steward_lock_tenant_deletion(${tenantId})`,
      );
      const [updated] = await dbTx
        .update(pendingProxyRequests)
        .set({
          status: "approved",
          approvedAt: new Date(),
          approvedBy: actor,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(pendingProxyRequests.id, c.req.param("id")),
            eq(pendingProxyRequests.tenantId, tenantId),
            eq(pendingProxyRequests.status, "pending"),
            sql`${pendingProxyRequests.expiresAt} > now()`,
          ),
        )
        .returning();
      if (!updated) return null;
      await appendRequiredAudit(
        approvalAuditEvent(c, {
          action: "proxy.approval.approved",
          resourceType: "pending_proxy_request",
          resourceId: updated.id,
          metadata: {
            agentId: updated.agentId,
            routeId: updated.routeId,
            requestDigest: updated.requestDigest,
          },
        }),
      );
      return updated;
    },
  );
  if (!row)
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Pending proxy request was not found, already resolved, or expired",
      },
      409,
    );
  return c.json<ApiResponse>({
    ok: true,
    data: { id: row.id, status: row.status },
  });
});

approvalRoutes.post("/proxy/:id/deny", async (c) => {
  const denied = await requireProxyOperator(c);
  if (denied) return denied;
  const tenantId = c.get("tenantId");
  const body = await safeJsonParse<{ reason?: string }>(c);
  const reason = parseBoundedText(body?.reason);
  if (reason === null)
    return c.json<ApiResponse>(
      {
        ok: false,
        error: `reason must be at most ${MAX_APPROVAL_TEXT_LENGTH} characters`,
      },
      400,
    );
  const actor = approvalActor(c);
  // Atomicity + race determinism: the deny/revoke transition and its audit event
  // commit in ONE transaction (spec section 11 item #10, invariant I14).
  //
  // Denying an ALREADY-APPROVED-but-unconsumed request is a deliberate,
  // load-bearing admin action: it revokes an approval before the agent's release
  // poll can claim+execute it (release.ts executes ONLY `status === 'approved'`;
  // the deny-of-approved semantic was introduced and behaviorally tested in
  // #181 / af1b330). It is therefore a DISTINCT transition from denying a
  // still-pending request, and it emits a DISTINCT audit event
  // (`proxy.approval.revoked` vs `proxy.approval.denied`).
  //
  // Splitting the guard into two exclusive CAS predicates (pending-only, then
  // approved-only) makes a concurrent approve/deny race resolve deterministically
  // against the single row: the approve's `WHERE status = 'pending'` and this
  // deny's `WHERE status = 'pending'` cannot BOTH match (one flips the row; the
  // loser matches 0 rows). If approve committed first, the pending-CAS here
  // matches 0 and we fall through to the approved-CAS, recording a deliberate
  // REVOKE with its own audit event — never a second conflicting `denied`
  // decision on an approved row. A replayed deny of an already-terminal row
  // matches neither CAS and returns 409 with no transition and no audit.
  const outcome = await withTenantAuditedTransaction(
    tenantId,
    async (tx, appendRequiredAudit) => {
      const dbTx = tx as typeof db;

      // 1. Deny a still-pending request -> `proxy.approval.denied`.
      const [denied] = await dbTx
        .update(pendingProxyRequests)
        .set({
          status: "denied",
          deniedAt: new Date(),
          deniedBy: actor,
          denialReason: reason || null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(pendingProxyRequests.id, c.req.param("id")),
            eq(pendingProxyRequests.tenantId, tenantId),
            eq(pendingProxyRequests.status, "pending"),
            sql`${pendingProxyRequests.expiresAt} > now()`,
          ),
        )
        .returning();
      if (denied) {
        await appendRequiredAudit(
          approvalAuditEvent(c, {
            action: "proxy.approval.denied",
            resourceType: "pending_proxy_request",
            resourceId: denied.id,
            metadata: {
              agentId: denied.agentId,
              routeId: denied.routeId,
              reason: reason || undefined,
            },
          }),
        );
        return denied;
      }

      // 2. Revoke an already-approved-but-unconsumed request -> distinct
      //    `proxy.approval.revoked` event. Row still lands in `denied` (terminal,
      //    unchanged response shape) but the audit trail records that this was a
      //    revoke of a live approval, not a first-time denial.
      const [revoked] = await dbTx
        .update(pendingProxyRequests)
        .set({
          status: "denied",
          deniedAt: new Date(),
          deniedBy: actor,
          denialReason: reason || null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(pendingProxyRequests.id, c.req.param("id")),
            eq(pendingProxyRequests.tenantId, tenantId),
            eq(pendingProxyRequests.status, "approved"),
            sql`${pendingProxyRequests.expiresAt} > now()`,
          ),
        )
        .returning();
      if (revoked) {
        await appendRequiredAudit(
          approvalAuditEvent(c, {
            action: "proxy.approval.revoked",
            resourceType: "pending_proxy_request",
            resourceId: revoked.id,
            metadata: {
              agentId: revoked.agentId,
              routeId: revoked.routeId,
              reason: reason || undefined,
              revokedFrom: "approved",
            },
          }),
        );
        return revoked;
      }

      return null;
    },
  );
  if (!outcome)
    return c.json<ApiResponse>(
      {
        ok: false,
        error:
          "Pending proxy request was not found, already resolved, or expired",
      },
      409,
    );
  return c.json<ApiResponse>({
    ok: true,
    data: { id: outcome.id, status: outcome.status },
  });
});

// ─── Approve transaction ──────────────────────────────────────────────────────

approvalRoutes.post("/:txId/approve", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Tenant-level auth required" },
      403,
    );
  }
  if (!requireHumanApprover(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Manual approval requires an owner or admin user session",
      },
      403,
    );
  }
  if (!hasRecentSessionMfa(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Manual approval requires recent MFA verification" },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const txId = c.req.param("txId");

  const body = await safeJsonParse<{ comment?: string; approvedBy?: string }>(
    c,
  );
  const comment = parseBoundedText(body?.comment);
  if (comment === null) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: `comment must be at most ${MAX_APPROVAL_TEXT_LENGTH} characters`,
      },
      400,
    );
  }

  // Find approval entry, verify it belongs to this tenant
  const [entry] = await db
    .select({
      id: approvalQueue.id,
      txId: approvalQueue.txId,
      agentId: approvalQueue.agentId,
      status: approvalQueue.status,
      requestedByType: approvalQueue.requestedByType,
      requestedById: approvalQueue.requestedById,
      tenantId: agents.tenantId,
      actionType: transactions.actionType,
      transactionStatus: transactions.status,
    })
    .from(approvalQueue)
    .innerJoin(agents, eq(approvalQueue.agentId, agents.id))
    .innerJoin(transactions, eq(approvalQueue.txId, transactions.id))
    .where(
      and(
        eq(approvalQueue.txId, txId),
        eq(agents.tenantId, tenantId),
        approvalTransactionMatchesQueue,
      ),
    );

  if (!entry) {
    return c.json<ApiResponse>({ ok: false, error: "Approval not found" }, 404);
  }

  if (entry.status !== "pending") {
    return c.json<ApiResponse>(
      { ok: false, error: `Approval already ${entry.status}` },
      400,
    );
  }
  if (entry.transactionStatus !== "pending") {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: `Approval transaction already ${entry.transactionStatus}`,
      },
      409,
    );
  }
  // Vault transaction approvals must be executed through the vault route, which
  // re-evaluates current policy, enforces separation of duties, and performs the
  // actual signing/broadcast. This generic endpoint intentionally does not flip
  // approval status on its own.
  return c.json<ApiResponse>(
    {
      ok: false,
      error:
        "Vault transaction approvals must be executed through POST /vault/:agentId/approve/:txId",
      data: { agentId: entry.agentId, txId },
    },
    409,
  );
});

// ─── Deny transaction ─────────────────────────────────────────────────────────

approvalRoutes.post("/:txId/deny", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Tenant-level auth required" },
      403,
    );
  }
  if (!requireHumanApprover(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Manual denial requires an owner or admin user session",
      },
      403,
    );
  }
  if (!hasRecentSessionMfa(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Manual denial requires recent MFA verification" },
      403,
    );
  }

  const tenantId = c.get("tenantId");
  const txId = c.req.param("txId");

  const body = await safeJsonParse<{ reason: string; deniedBy?: string }>(c);

  const reason = parseBoundedText(body?.reason, true);
  if (reason === null) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: `reason is required and must be at most ${MAX_APPROVAL_TEXT_LENGTH} characters`,
      },
      400,
    );
  }

  // Find approval entry, verify it belongs to this tenant
  const [entry] = await db
    .select({
      id: approvalQueue.id,
      txId: approvalQueue.txId,
      agentId: approvalQueue.agentId,
      status: approvalQueue.status,
      tenantId: agents.tenantId,
      actionType: transactions.actionType,
      transactionStatus: transactions.status,
    })
    .from(approvalQueue)
    .innerJoin(agents, eq(approvalQueue.agentId, agents.id))
    .innerJoin(transactions, eq(approvalQueue.txId, transactions.id))
    .where(
      and(
        eq(approvalQueue.txId, txId),
        eq(agents.tenantId, tenantId),
        approvalTransactionMatchesQueue,
      ),
    );

  if (!entry) {
    return c.json<ApiResponse>({ ok: false, error: "Approval not found" }, 404);
  }

  if (entry.status !== "pending") {
    return c.json<ApiResponse>(
      { ok: false, error: `Approval already ${entry.status}` },
      400,
    );
  }
  if (entry.transactionStatus !== "pending") {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: `Approval transaction already ${entry.transactionStatus}`,
      },
      409,
    );
  }

  const resolvedBy = approvalActor(c);
  const principal = approvalPrincipal(c);

  await writeApprovalAudit(c, {
    action: "approval.deny.authorized",
    resourceType: "transaction",
    resourceId: txId,
    metadata: {
      approvalId: entry.id,
      agentId: entry.agentId,
      previousStatus: entry.status,
      previousTransactionStatus: entry.transactionStatus,
      reason,
    },
  });

  // Atomicity: the queue+transaction rejection AND its completion
  // `approval.deny` audit event commit in ONE transaction (invariant I14).
  // Previously the state change committed in its own transaction and the
  // completion audit was written afterwards, guarded only by a best-effort
  // compensating rollback — a crash between the state commit and either the
  // audit or the compensation left a rejected transaction with no completion
  // audit and no rollback. Folding the audit into the same transaction removes
  // that window entirely; the pre-mutation `approval.deny.authorized` intent log
  // above is still written first as a durable record that the decision was
  // attempted. The guarded `status = 'pending'` predicates keep a retry after a
  // crash idempotent (already-rejected rows are not re-selected).
  const updated = await withTenantAuditedTransaction(
    tenantId,
    async (tx, appendRequiredAudit) => {
      const dbTx = tx as typeof db;
      const updatedRows = await dbTx
        .update(approvalQueue)
        .set({
          status: "rejected",
          resolvedAt: new Date(),
          resolvedBy: `${resolvedBy}: ${reason}`,
          resolvedByType: principal.type,
          resolvedById: principal.id,
        })
        .where(
          and(
            eq(approvalQueue.id, entry.id),
            eq(approvalQueue.status, "pending"),
          ),
        )
        .returning();
      if (!updatedRows[0]) return null;
      const transactionRows = await dbTx
        .update(transactions)
        .set({ status: "rejected" })
        .where(
          and(
            eq(transactions.id, txId),
            eq(transactions.agentId, entry.agentId),
            eq(transactions.status, "pending"),
          ),
        )
        .returning({ id: transactions.id });
      // Transaction already resolved out from under us: roll back the WHOLE unit
      // (the queue rejection just applied above included) by throwing. Nothing —
      // not the queue update, not the audit — commits.
      if (!transactionRows[0]) throw new ApprovalAlreadyResolvedError();
      await appendRequiredAudit(
        approvalAuditEvent(c, {
          action: "approval.deny",
          resourceType: "transaction",
          resourceId: txId,
          metadata: { approvalId: entry.id, agentId: entry.agentId, reason },
        }),
      );
      return updatedRows[0];
    },
  ).catch((error: unknown) => {
    if (error instanceof ApprovalAlreadyResolvedError) return null;
    throw error;
  });
  if (!updated) {
    return c.json<ApiResponse>(
      { ok: false, error: "Approval already resolved" },
      409,
    );
  }

  dispatchWebhook(tenantId, entry.agentId, "tx.denied", {
    txId,
    approvalId: entry.id,
    reason,
  });
  dispatchApprovalIntentWebhook(tenantId, entry.agentId, "intent.rejected", {
    txId,
    actionType: entry.actionType,
    status: "rejected",
    approvalId: entry.id,
    reason,
  });

  return c.json<ApiResponse>({
    ok: true,
    data: {
      ...updated,
      reason,
    },
  });
});

// ─── Auto-approval rules ─────────────────────────────────────────────────────

approvalRoutes.get("/rules", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Tenant-level auth required" },
      403,
    );
  }
  if (!requireHumanApprover(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Approval rule access requires an owner or admin user session",
      },
      403,
    );
  }
  if (!hasRecentSessionMfa(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Approval rule access requires recent MFA verification",
      },
      403,
    );
  }

  const tenantId = c.get("tenantId");

  const [rule] = await db
    .select()
    .from(autoApprovalRules)
    .where(eq(autoApprovalRules.tenantId, tenantId));

  return c.json<ApiResponse>({ ok: true, data: rule || null });
});

approvalRoutes.put("/rules", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>(
      { ok: false, error: "Tenant-level auth required" },
      403,
    );
  }
  if (!requireHumanApprover(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Approval rule changes require an owner or admin user session",
      },
      403,
    );
  }
  if (!hasRecentSessionMfa(c)) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "Approval rule changes require recent MFA verification",
      },
      403,
    );
  }

  const tenantId = c.get("tenantId");

  const body = await safeJsonParse<{
    maxAmountWei?: string;
    autoDenyAfterHours?: number | null;
    escalateAboveWei?: string | null;
    enabled?: boolean;
  }>(c);

  if (!body) {
    return c.json<ApiResponse>(
      { ok: false, error: "Invalid JSON in request body" },
      400,
    );
  }

  if (
    body.maxAmountWei !== undefined &&
    !isNonNegativeIntegerString(body.maxAmountWei)
  ) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "maxAmountWei must be a non-negative integer string",
      },
      400,
    );
  }

  if (
    body.escalateAboveWei !== undefined &&
    body.escalateAboveWei !== null &&
    !isNonNegativeIntegerString(body.escalateAboveWei)
  ) {
    return c.json<ApiResponse>(
      {
        ok: false,
        error: "escalateAboveWei must be a non-negative integer string or null",
      },
      400,
    );
  }

  if (
    body.autoDenyAfterHours !== undefined &&
    body.autoDenyAfterHours !== null
  ) {
    if (
      typeof body.autoDenyAfterHours !== "number" ||
      body.autoDenyAfterHours <= 0
    ) {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "autoDenyAfterHours must be a positive number or null",
        },
        400,
      );
    }
  }

  // Upsert
  const [existing] = await db
    .select()
    .from(autoApprovalRules)
    .where(eq(autoApprovalRules.tenantId, tenantId));

  if (existing) {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.maxAmountWei !== undefined)
      updates.maxAmountWei = body.maxAmountWei;
    if (body.autoDenyAfterHours !== undefined)
      updates.autoDenyAfterHours = body.autoDenyAfterHours;
    if (body.escalateAboveWei !== undefined)
      updates.escalateAboveWei = body.escalateAboveWei;
    if (body.enabled !== undefined) updates.enabled = body.enabled;

    await writeApprovalAudit(c, {
      action: "approval_rule.update.authorized",
      resourceType: "approval_rule",
      resourceId: existing.id,
      metadata: { before: existing, updates },
    });

    const [updated] = await db
      .update(autoApprovalRules)
      .set(updates)
      .where(eq(autoApprovalRules.tenantId, tenantId))
      .returning();
    try {
      await writeApprovalAudit(c, {
        action: "approval_rule.update",
        resourceType: "approval_rule",
        resourceId: updated.id,
        metadata: { before: existing, after: updated },
      });
    } catch (err) {
      await db
        .update(autoApprovalRules)
        .set({
          maxAmountWei: existing.maxAmountWei,
          autoDenyAfterHours: existing.autoDenyAfterHours,
          escalateAboveWei: existing.escalateAboveWei,
          enabled: existing.enabled,
          updatedAt: existing.updatedAt,
        })
        .where(eq(autoApprovalRules.id, existing.id));
      throw err;
    }

    return c.json<ApiResponse>({ ok: true, data: updated });
  }

  await writeApprovalAudit(c, {
    action: "approval_rule.create.authorized",
    resourceType: "approval_rule",
    resourceId: tenantId,
    metadata: { requested: body },
  });

  const [created] = await db
    .insert(autoApprovalRules)
    .values({
      tenantId,
      maxAmountWei: body.maxAmountWei || "0",
      autoDenyAfterHours: body.autoDenyAfterHours ?? null,
      escalateAboveWei: body.escalateAboveWei ?? null,
      enabled: body.enabled ?? true,
    })
    .returning();
  try {
    await writeApprovalAudit(c, {
      action: "approval_rule.create",
      resourceType: "approval_rule",
      resourceId: created.id,
      metadata: { after: created },
    });
  } catch (err) {
    await db
      .delete(autoApprovalRules)
      .where(eq(autoApprovalRules.id, created.id));
    throw err;
  }

  return c.json<ApiResponse>({ ok: true, data: created }, 201);
});
