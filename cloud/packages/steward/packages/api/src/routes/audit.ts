/**
 * Audit routes — read-only endpoints for querying transaction history,
 * proxy audit logs, and approval queue data across all agents for a tenant.
 *
 * Mount: app.route("/audit", auditRoutes)
 */

import { proxyAuditLog } from "@stwd/db";
import { and, count, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import {
  type ApiResponse,
  type AppVariables,
  agents,
  approvalQueue,
  db,
  transactions,
} from "../services/context";

export const auditRoutes = new Hono<{ Variables: AppVariables }>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parsePage(raw: string | undefined): number {
  const n = parseInt(raw || "1", 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function parseLimit(raw: string | undefined): number {
  const n = parseInt(raw || "50", 10);
  if (!Number.isFinite(n) || n < 1) return 50;
  return Math.min(n, 200);
}

/** Resolve the set of agentIds belonging to the authenticated tenant. */
async function tenantAgentIds(tenantId: string): Promise<string[]> {
  const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.tenantId, tenantId));
  return rows.map((r) => r.id);
}

// ─── GET /audit/log ───────────────────────────────────────────────────────────

auditRoutes.get("/log", async (c) => {
  const tenantId = c.get("tenantId");
  const page = parsePage(c.req.query("page"));
  const limit = parseLimit(c.req.query("limit"));
  const offset = (page - 1) * limit;

  const filterAgentId = c.req.query("agentId");
  const filterAction = c.req.query("action"); // sign, approve, reject, proxy
  const filterStatus = c.req.query("status");
  const dateFrom = c.req.query("dateFrom");
  const dateTo = c.req.query("dateTo");

  // Get all agent IDs for this tenant (for tenant isolation)
  const agentIds = await tenantAgentIds(tenantId);

  if (agentIds.length === 0) {
    return c.json<ApiResponse>({
      ok: true,
      data: {
        data: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
      },
    });
  }

  // Narrow to a single agent if filter provided
  const relevantAgentIds = filterAgentId
    ? agentIds.includes(filterAgentId)
      ? [filterAgentId]
      : []
    : agentIds;

  if (relevantAgentIds.length === 0) {
    return c.json<ApiResponse>({
      ok: true,
      data: {
        data: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
      },
    });
  }

  type AuditEntry = {
    id: string;
    timestamp: string;
    agentId: string;
    action: string;
    status: string;
    details: Record<string, unknown>;
    policyResults?: unknown;
    value?: string;
    to?: string;
  };

  const entries: AuditEntry[] = [];
  let totalCount = 0;

  const wantTx = !filterAction || ["sign", "approve", "reject"].includes(filterAction);
  const wantProxy = !filterAction || filterAction === "proxy";

  // ── Transactions + approval_queue ────────────────────────────────────────

  if (wantTx) {
    const txConditions = [inArray(transactions.agentId, relevantAgentIds)];

    if (filterStatus) {
      txConditions.push(eq(transactions.status, filterStatus as any));
    }
    if (dateFrom) {
      txConditions.push(gte(transactions.createdAt, new Date(dateFrom)));
    }
    if (dateTo) {
      txConditions.push(lte(transactions.createdAt, new Date(dateTo)));
    }

    const txWhere = and(...txConditions);

    // Count
    const [txCount] = await db.select({ count: count() }).from(transactions).where(txWhere);

    // Fetch with left join to approval_queue
    const txRows = await db
      .select({
        id: transactions.id,
        agentId: transactions.agentId,
        status: transactions.status,
        toAddress: transactions.toAddress,
        value: transactions.value,
        chainId: transactions.chainId,
        txHash: transactions.txHash,
        policyResults: transactions.policyResults,
        createdAt: transactions.createdAt,
        signedAt: transactions.signedAt,
        aqStatus: approvalQueue.status,
        aqRequestedAt: approvalQueue.requestedAt,
        aqResolvedAt: approvalQueue.resolvedAt,
        aqResolvedBy: approvalQueue.resolvedBy,
      })
      .from(transactions)
      .leftJoin(approvalQueue, eq(approvalQueue.txId, transactions.id))
      .where(txWhere)
      .orderBy(desc(transactions.createdAt))
      .limit(wantProxy ? 1000 : limit) // over-fetch if merging with proxy
      .offset(wantProxy ? 0 : offset);

    for (const row of txRows) {
      let action: string;
      if (row.aqStatus === "approved") action = "approve";
      else if (row.aqStatus === "rejected" || row.status === "rejected") action = "reject";
      else if (row.status === "signed" || row.status === "broadcast" || row.status === "confirmed")
        action = "sign";
      else action = "sign"; // pending, failed, etc.

      if (filterAction && action !== filterAction) continue;

      entries.push({
        id: row.id,
        timestamp: (row.createdAt as Date).toISOString(),
        agentId: row.agentId,
        action,
        status: row.status,
        details: {
          chainId: row.chainId,
          txHash: row.txHash ?? undefined,
          approvalStatus: row.aqStatus ?? undefined,
          resolvedBy: row.aqResolvedBy ?? undefined,
          resolvedAt: row.aqResolvedAt ? (row.aqResolvedAt as Date).toISOString() : undefined,
        },
        policyResults: row.policyResults,
        value: row.value,
        to: row.toAddress,
      });
    }

    if (!wantProxy) {
      totalCount = Number(txCount?.count ?? 0);
    } else {
      totalCount += Number(txCount?.count ?? 0);
    }
  }

  // ── Proxy audit log ─────────────────────────────────────────────────────

  if (wantProxy) {
    const proxyConditions = [eq(proxyAuditLog.tenantId, tenantId)];

    if (filterAgentId) {
      proxyConditions.push(eq(proxyAuditLog.agentId, filterAgentId));
    }
    if (dateFrom) {
      proxyConditions.push(gte(proxyAuditLog.createdAt, new Date(dateFrom)));
    }
    if (dateTo) {
      proxyConditions.push(lte(proxyAuditLog.createdAt, new Date(dateTo)));
    }

    const proxyWhere = and(...proxyConditions);

    const [proxyCount] = await db.select({ count: count() }).from(proxyAuditLog).where(proxyWhere);

    const proxyRows = await db
      .select()
      .from(proxyAuditLog)
      .where(proxyWhere)
      .orderBy(desc(proxyAuditLog.createdAt))
      .limit(wantTx ? 1000 : limit)
      .offset(wantTx ? 0 : offset);

    for (const row of proxyRows) {
      if (filterStatus) {
        const statusStr = String(row.statusCode);
        if (statusStr !== filterStatus) continue;
      }

      entries.push({
        id: row.id,
        timestamp: (row.createdAt as Date).toISOString(),
        agentId: row.agentId,
        action: "proxy",
        status: row.statusCode < 400 ? "success" : "error",
        details: {
          targetHost: row.targetHost,
          targetPath: row.targetPath,
          method: row.method,
          statusCode: row.statusCode,
          latencyMs: row.latencyMs,
        },
      });
    }

    totalCount += Number(proxyCount?.count ?? 0);
  }

  // Sort merged entries by timestamp descending, then paginate
  entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const needsClientPagination = wantTx && wantProxy;
  const paginatedEntries = needsClientPagination
    ? entries.slice(offset, offset + limit)
    : entries.slice(0, limit);

  const totalPages = Math.ceil(totalCount / limit);

  return c.json<ApiResponse>({
    ok: true,
    data: {
      data: paginatedEntries,
      pagination: { page, limit, total: totalCount, totalPages },
    },
  });
});

// ─── GET /audit/summary ───────────────────────────────────────────────────────

auditRoutes.get("/summary", async (c) => {
  const tenantId = c.get("tenantId");
  const range = c.req.query("range") || "30d";

  let since: Date | null = null;
  const now = new Date();

  switch (range) {
    case "24h":
      since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      break;
    case "7d":
      since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case "30d":
      since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case "all":
      since = null;
      break;
    default:
      since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }

  const agentIds = await tenantAgentIds(tenantId);

  if (agentIds.length === 0) {
    return c.json<ApiResponse>({
      ok: true,
      data: {
        totalTransactions: 0,
        totalApprovals: 0,
        totalRejections: 0,
        totalProxyRequests: 0,
        policyViolations: 0,
        topAgents: [],
        dailyActivity: [],
      },
    });
  }

  // Transaction stats
  const txConditions = [inArray(transactions.agentId, agentIds)];
  if (since) txConditions.push(gte(transactions.createdAt, since));

  const [txStats] = await db
    .select({
      total: count(),
      approvals: sql<number>`count(*) filter (where ${transactions.status} in ('signed', 'broadcast', 'confirmed'))`,
      rejections: sql<number>`count(*) filter (where ${transactions.status} = 'rejected')`,
      policyViolations: sql<number>`count(*) filter (where ${transactions.status} = 'rejected' and jsonb_array_length(${transactions.policyResults}::jsonb) > 0)`,
    })
    .from(transactions)
    .where(and(...txConditions));

  // Proxy request count
  const proxyConditions: ReturnType<typeof eq>[] = [eq(proxyAuditLog.tenantId, tenantId)];
  if (since) proxyConditions.push(gte(proxyAuditLog.createdAt, since));

  const [proxyStats] = await db
    .select({ total: count() })
    .from(proxyAuditLog)
    .where(and(...proxyConditions));

  // Top agents by tx count
  const topAgentsRows = await db
    .select({
      agentId: transactions.agentId,
      txCount: count(),
    })
    .from(transactions)
    .where(and(...txConditions))
    .groupBy(transactions.agentId)
    .orderBy(desc(count()))
    .limit(10);

  // Look up agent names
  const agentNameMap = new Map<string, string>();
  if (topAgentsRows.length > 0) {
    const agentRows = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(
        inArray(
          agents.id,
          topAgentsRows.map((r) => r.agentId),
        ),
      );
    for (const a of agentRows) agentNameMap.set(a.id, a.name);
  }

  const topAgents = topAgentsRows.map((r) => ({
    agentId: r.agentId,
    name: agentNameMap.get(r.agentId) || r.agentId,
    txCount: Number(r.txCount),
  }));

  // Daily activity (transactions only, last 30 days max)
  const dailyCutoff = since || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const dailyRows = await db
    .select({
      date: sql<string>`date_trunc('day', ${transactions.createdAt})::date::text`,
      txCount: count(),
    })
    .from(transactions)
    .where(and(inArray(transactions.agentId, agentIds), gte(transactions.createdAt, dailyCutoff)))
    .groupBy(sql`date_trunc('day', ${transactions.createdAt})`)
    .orderBy(sql`date_trunc('day', ${transactions.createdAt})`);

  const dailyActivity = dailyRows.map((r) => ({
    date: r.date,
    txCount: Number(r.txCount),
  }));

  return c.json<ApiResponse>({
    ok: true,
    data: {
      totalTransactions: Number(txStats?.total ?? 0),
      totalApprovals: Number(txStats?.approvals ?? 0),
      totalRejections: Number(txStats?.rejections ?? 0),
      totalProxyRequests: Number(proxyStats?.total ?? 0),
      policyViolations: Number(txStats?.policyViolations ?? 0),
      topAgents,
      dailyActivity,
    },
  });
});

// ─── GET /audit/export ────────────────────────────────────────────────────────

auditRoutes.get("/export", async (c) => {
  const tenantId = c.get("tenantId");
  const filterAgentId = c.req.query("agentId");
  const filterAction = c.req.query("action");
  const filterStatus = c.req.query("status");
  const dateFrom = c.req.query("dateFrom");
  const dateTo = c.req.query("dateTo");

  const agentIds = await tenantAgentIds(tenantId);

  if (agentIds.length === 0) {
    c.header("Content-Type", "text/csv");
    c.header("Content-Disposition", 'attachment; filename="audit-export.csv"');
    return c.body("id,timestamp,agentId,action,status,to,value,details\n");
  }

  const relevantAgentIds = filterAgentId
    ? agentIds.includes(filterAgentId)
      ? [filterAgentId]
      : []
    : agentIds;

  const rows: string[] = [];
  rows.push("id,timestamp,agentId,action,status,to,value,details");

  const wantTx = !filterAction || ["sign", "approve", "reject"].includes(filterAction);
  const wantProxy = !filterAction || filterAction === "proxy";

  if (wantTx && relevantAgentIds.length > 0) {
    const txConditions = [inArray(transactions.agentId, relevantAgentIds)];
    if (filterStatus) txConditions.push(eq(transactions.status, filterStatus as any));
    if (dateFrom) txConditions.push(gte(transactions.createdAt, new Date(dateFrom)));
    if (dateTo) txConditions.push(lte(transactions.createdAt, new Date(dateTo)));

    const txRows = await db
      .select()
      .from(transactions)
      .where(and(...txConditions))
      .orderBy(desc(transactions.createdAt))
      .limit(10000);

    for (const row of txRows) {
      let action = "sign";
      if (row.status === "rejected") action = "reject";
      if (filterAction && action !== filterAction) continue;

      rows.push(
        csvRow([
          row.id,
          (row.createdAt as Date).toISOString(),
          row.agentId,
          action,
          row.status,
          row.toAddress,
          row.value,
          `chainId=${row.chainId}${row.txHash ? ` txHash=${row.txHash}` : ""}`,
        ]),
      );
    }
  }

  if (wantProxy) {
    const proxyConditions: ReturnType<typeof eq>[] = [eq(proxyAuditLog.tenantId, tenantId)];
    if (filterAgentId) proxyConditions.push(eq(proxyAuditLog.agentId, filterAgentId));
    if (dateFrom) proxyConditions.push(gte(proxyAuditLog.createdAt, new Date(dateFrom)));
    if (dateTo) proxyConditions.push(lte(proxyAuditLog.createdAt, new Date(dateTo)));

    const proxyRows = await db
      .select()
      .from(proxyAuditLog)
      .where(and(...proxyConditions))
      .orderBy(desc(proxyAuditLog.createdAt))
      .limit(10000);

    for (const row of proxyRows) {
      rows.push(
        csvRow([
          row.id,
          (row.createdAt as Date).toISOString(),
          row.agentId,
          "proxy",
          row.statusCode < 400 ? "success" : "error",
          `${row.targetHost}${row.targetPath}`,
          "",
          `method=${row.method} status=${row.statusCode} latency=${row.latencyMs}ms`,
        ]),
      );
    }
  }

  c.header("Content-Type", "text/csv");
  c.header("Content-Disposition", 'attachment; filename="audit-export.csv"');
  return c.body(`${rows.join("\n")}\n`);
});

function csvRow(fields: string[]): string {
  return fields
    .map((f) => {
      const s = String(f ?? "");
      if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    })
    .join(",");
}
