/**
 * Approval workflow routes — tenant-level approval management.
 *
 * Mount: app.route("/approvals", approvalRoutes)
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  type ApiResponse,
  type AppVariables,
  agents,
  approvalQueue,
  autoApprovalRules,
  db,
  requireTenantLevel,
  safeJsonParse,
  transactions,
} from "../services/context";

export const approvalRoutes = new Hono<{ Variables: AppVariables }>();

// ─── List pending approvals for a tenant ──────────────────────────────────────

approvalRoutes.get("/", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant-level auth required" }, 403);
  }

  const tenantId = c.get("tenantId");
  const statusFilter = c.req.query("status") || "pending";
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
  const offset = parseInt(c.req.query("offset") || "0", 10);

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
        statusFilter !== "all"
          ? eq(approvalQueue.status, statusFilter as "pending" | "approved" | "rejected")
          : undefined,
      ),
    )
    .orderBy(desc(approvalQueue.requestedAt))
    .limit(limit)
    .offset(offset);

  return c.json<ApiResponse>({ ok: true, data: results });
});

// ─── Approval stats ───────────────────────────────────────────────────────────

approvalRoutes.get("/stats", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant-level auth required" }, 403);
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

// ─── Approve transaction ──────────────────────────────────────────────────────

approvalRoutes.post("/:txId/approve", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant-level auth required" }, 403);
  }

  const tenantId = c.get("tenantId");
  const txId = c.req.param("txId");

  const body = await safeJsonParse<{ comment?: string; approvedBy?: string }>(c);

  // Find approval entry, verify it belongs to this tenant
  const [entry] = await db
    .select({
      id: approvalQueue.id,
      txId: approvalQueue.txId,
      agentId: approvalQueue.agentId,
      status: approvalQueue.status,
      tenantId: agents.tenantId,
    })
    .from(approvalQueue)
    .innerJoin(agents, eq(approvalQueue.agentId, agents.id))
    .where(and(eq(approvalQueue.txId, txId), eq(agents.tenantId, tenantId)));

  if (!entry) {
    return c.json<ApiResponse>({ ok: false, error: "Approval not found" }, 404);
  }

  if (entry.status !== "pending") {
    return c.json<ApiResponse>({ ok: false, error: `Approval already ${entry.status}` }, 400);
  }

  const resolvedBy = body?.approvedBy || "tenant-admin";

  // Update approval queue
  const [updated] = await db
    .update(approvalQueue)
    .set({
      status: "approved",
      resolvedAt: new Date(),
      resolvedBy,
    })
    .where(eq(approvalQueue.id, entry.id))
    .returning();

  // Update transaction status to approved
  await db.update(transactions).set({ status: "approved" }).where(eq(transactions.id, txId));

  return c.json<ApiResponse>({
    ok: true,
    data: {
      ...updated,
      comment: body?.comment || null,
    },
  });
});

// ─── Deny transaction ─────────────────────────────────────────────────────────

approvalRoutes.post("/:txId/deny", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant-level auth required" }, 403);
  }

  const tenantId = c.get("tenantId");
  const txId = c.req.param("txId");

  const body = await safeJsonParse<{ reason: string; deniedBy?: string }>(c);

  if (!body?.reason || typeof body.reason !== "string" || body.reason.trim().length === 0) {
    return c.json<ApiResponse>({ ok: false, error: "reason is required" }, 400);
  }

  // Find approval entry, verify it belongs to this tenant
  const [entry] = await db
    .select({
      id: approvalQueue.id,
      txId: approvalQueue.txId,
      agentId: approvalQueue.agentId,
      status: approvalQueue.status,
      tenantId: agents.tenantId,
    })
    .from(approvalQueue)
    .innerJoin(agents, eq(approvalQueue.agentId, agents.id))
    .where(and(eq(approvalQueue.txId, txId), eq(agents.tenantId, tenantId)));

  if (!entry) {
    return c.json<ApiResponse>({ ok: false, error: "Approval not found" }, 404);
  }

  if (entry.status !== "pending") {
    return c.json<ApiResponse>({ ok: false, error: `Approval already ${entry.status}` }, 400);
  }

  const resolvedBy = body.deniedBy || "tenant-admin";

  // Update approval queue
  const [updated] = await db
    .update(approvalQueue)
    .set({
      status: "rejected",
      resolvedAt: new Date(),
      resolvedBy: `${resolvedBy}: ${body.reason}`,
    })
    .where(eq(approvalQueue.id, entry.id))
    .returning();

  // Update transaction status to rejected
  await db.update(transactions).set({ status: "rejected" }).where(eq(transactions.id, txId));

  return c.json<ApiResponse>({
    ok: true,
    data: {
      ...updated,
      reason: body.reason,
    },
  });
});

// ─── Auto-approval rules ─────────────────────────────────────────────────────

approvalRoutes.get("/rules", async (c) => {
  if (!requireTenantLevel(c)) {
    return c.json<ApiResponse>({ ok: false, error: "Tenant-level auth required" }, 403);
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
    return c.json<ApiResponse>({ ok: false, error: "Tenant-level auth required" }, 403);
  }

  const tenantId = c.get("tenantId");

  const body = await safeJsonParse<{
    maxAmountWei?: string;
    autoDenyAfterHours?: number | null;
    escalateAboveWei?: string | null;
    enabled?: boolean;
  }>(c);

  if (!body) {
    return c.json<ApiResponse>({ ok: false, error: "Invalid JSON in request body" }, 400);
  }

  if (body.maxAmountWei !== undefined) {
    try {
      if (BigInt(body.maxAmountWei) < 0n) throw new Error();
    } catch {
      return c.json<ApiResponse>(
        {
          ok: false,
          error: "maxAmountWei must be a non-negative integer string",
        },
        400,
      );
    }
  }

  if (body.autoDenyAfterHours !== undefined && body.autoDenyAfterHours !== null) {
    if (typeof body.autoDenyAfterHours !== "number" || body.autoDenyAfterHours <= 0) {
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
    if (body.maxAmountWei !== undefined) updates.maxAmountWei = body.maxAmountWei;
    if (body.autoDenyAfterHours !== undefined) updates.autoDenyAfterHours = body.autoDenyAfterHours;
    if (body.escalateAboveWei !== undefined) updates.escalateAboveWei = body.escalateAboveWei;
    if (body.enabled !== undefined) updates.enabled = body.enabled;

    const [updated] = await db
      .update(autoApprovalRules)
      .set(updates)
      .where(eq(autoApprovalRules.tenantId, tenantId))
      .returning();

    return c.json<ApiResponse>({ ok: true, data: updated });
  }

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

  return c.json<ApiResponse>({ ok: true, data: created }, 201);
});
