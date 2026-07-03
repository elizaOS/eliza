/**
 * GET  /api/v1/advertising/campaigns/[id]/report — export campaign report.
 * POST /api/v1/advertising/campaigns/[id]/report — mint public report token.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { advertisingService } from "@/lib/services/advertising";
import type { AppEnv } from "@/types/cloud-worker-env";

const MAX_DATE_RANGE_MS = 365 * 24 * 60 * 60 * 1000;

const ReportQuerySchema = z
  .object({
    format: z.enum(["json", "csv"]).default("json"),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
  })
  .refine(
    (data) => {
      if (data.startDate && data.endDate) {
        return new Date(data.startDate) <= new Date(data.endDate);
      }
      return true;
    },
    { message: "startDate must be before or equal to endDate" },
  )
  .refine(
    (data) => {
      if (data.startDate && data.endDate) {
        return (
          new Date(data.endDate).getTime() -
            new Date(data.startDate).getTime() <=
          MAX_DATE_RANGE_MS
        );
      }
      return true;
    },
    { message: "Date range cannot exceed 1 year" },
  );

const TokenBodySchema = z.object({
  expiresInSeconds: z
    .number()
    .int()
    .positive()
    .max(90 * 24 * 60 * 60)
    .optional(),
});

function parseReportQuery(c: Context<AppEnv>) {
  const parsed = ReportQuerySchema.safeParse({
    format: c.req.query("format") ?? "json",
    startDate: c.req.query("startDate") || undefined,
    endDate: c.req.query("endDate") || undefined,
  });
  if (!parsed.success) {
    return {
      ok: false as const,
      response: c.json(
        {
          error: "Invalid report parameters",
          details: parsed.error.issues.map((issue) => issue.message),
        },
        400,
      ),
    };
  }

  return {
    ok: true as const,
    data: {
      format: parsed.data.format,
      dateRange:
        parsed.data.startDate || parsed.data.endDate
          ? {
              start: parsed.data.startDate
                ? new Date(parsed.data.startDate)
                : undefined,
              end: parsed.data.endDate
                ? new Date(parsed.data.endDate)
                : undefined,
            }
          : undefined,
    },
  };
}

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;
    const query = parseReportQuery(c);
    if (!query.ok) return query.response;

    const report = await advertisingService.generateCampaignReport(
      id,
      user.organization_id,
      query.data.dateRange,
    );

    if (query.data.format === "csv") {
      const csv = advertisingService.formatCampaignReportCsv(report);
      return new Response(csv, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="campaign-${id}-performance-report.csv"`,
        },
      });
    }

    return c.json({ report });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id")!;
    const rawBody = await c.req.text();
    const body = rawBody ? JSON.parse(rawBody) : {};
    const parsed = TokenBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        400,
      );
    }

    const token = await advertisingService.mintCampaignReportToken(
      id,
      user.organization_id,
      {
        ttlSeconds: parsed.data.expiresInSeconds,
      },
    );

    return c.json({
      token: token.token,
      tokenId: token.tokenId,
      expiresAt: token.expiresAt,
      publicReportUrl: `/api/v1/advertising/campaigns/${id}/public-report?token=${encodeURIComponent(
        token.token,
      )}`,
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
