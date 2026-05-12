import { and, eq, gte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { dbRead } from "@/db/helpers";
import { usageRecords } from "@/db/schemas/usage-records";
import { requireAdminWithResponse } from "@/lib/auth/admin";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * Month-to-date cost breakdown for a single user: rawCost (input+output
 * provider cost), markup (platform markup already captured in
 * `usage_records.markup`), and billedCost (rawCost + markup), grouped by
 * type/provider. Read-only endpoint for admin support / billing audits.
 */

const ParamsSchema = z.object({
  userId: z.string().uuid(),
});

interface BreakdownRow {
  type: string;
  provider: string;
  rawCost: number;
  markup: number;
  billedCost: number;
  recordCount: number;
}

function firstOfCurrentMonthUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function __hono_GET(
  request: Request,
  context: { params: Promise<{ userId: string }> },
): Promise<Response> {
  const authResult = await requireAdminWithResponse(
    request,
    "[Admin] Billing breakdown auth error",
  );
  if (authResult instanceof Response) {
    return authResult;
  }

  const rawParams = await context.params;
  const parsed = ParamsSchema.safeParse(rawParams);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid userId", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { userId } = parsed.data;

  const periodStart = firstOfCurrentMonthUtc();

  const rows = await dbRead
    .select({
      type: usageRecords.type,
      provider: usageRecords.provider,
      inputCost: sql<string>`COALESCE(SUM(${usageRecords.input_cost}), 0)`,
      outputCost: sql<string>`COALESCE(SUM(${usageRecords.output_cost}), 0)`,
      markup: sql<string>`COALESCE(SUM(${usageRecords.markup}), 0)`,
      recordCount: sql<number>`COUNT(*)::int`,
    })
    .from(usageRecords)
    .where(and(eq(usageRecords.user_id, userId), gte(usageRecords.created_at, periodStart)))
    .groupBy(usageRecords.type, usageRecords.provider)
    .orderBy(usageRecords.type, usageRecords.provider);

  const breakdown: BreakdownRow[] = rows.map((row) => {
    const rawCost = Number(row.inputCost) + Number(row.outputCost);
    const markup = Number(row.markup);
    return {
      type: row.type,
      provider: row.provider,
      rawCost,
      markup,
      billedCost: rawCost + markup,
      recordCount: row.recordCount,
    };
  });

  const totals = breakdown.reduce(
    (acc, row) => ({
      rawCost: acc.rawCost + row.rawCost,
      markup: acc.markup + row.markup,
      billedCost: acc.billedCost + row.billedCost,
      recordCount: acc.recordCount + row.recordCount,
    }),
    { rawCost: 0, markup: 0, billedCost: 0, recordCount: 0 },
  );

  logger.info("[Admin] Billing breakdown queried", {
    userId,
    periodStart: periodStart.toISOString(),
    totalRecords: totals.recordCount,
  });

  return Response.json({
    userId,
    periodStart: periodStart.toISOString(),
    periodEnd: new Date().toISOString(),
    breakdown,
    totals,
  });
}

const __hono_app = new Hono<AppEnv>();
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, { params: Promise.resolve({ userId: c.req.param("userId")! }) }),
);
export default __hono_app;
