/**
 * GET /api/analytics/export
 * Exports analytics data in various formats (CSV, JSON, Excel).
 * Supports time series, user, provider, and model breakdown exports.
 *
 * NOTE: Excel generation depends on `exceljs`, which uses Node `Buffer`.
 * That import is fine on Workers if exceljs's bundle uses the polyfilled
 * Buffer; verify after wrangler dev. CSV / JSON paths are pure JS.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  createBinaryDownloadResponse,
  createDownloadResponse,
  type ExportColumn,
  type ExportOptions,
  formatCurrency,
  formatDate,
  formatNumber,
  formatPercentage,
  generateCSV,
  generateExcel,
  generateJSON,
} from "@/lib/export/analytics";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  getModelBreakdown,
  getProviderBreakdown,
  getUsageByUser,
  getUsageTimeSeries,
  type TimeGranularity,
  validateGranularity,
} from "@/lib/services/analytics";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const EXPORT_LIMITS = {
  MAX_TIME_RANGE_DAYS: 365,
  MAX_ROWS: 100_000,
  MAX_ROWS_WARNING: 50_000,
} as const;
const SUPPORTED_FORMATS = new Set(["csv", "json", "excel", "xlsx"]);

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const format = c.req.query("format") || "csv";
    if (!SUPPORTED_FORMATS.has(format)) {
      return c.json(
        {
          error: `Unsupported export format: ${format}. Supported formats: csv, json, excel, xlsx`,
        },
        400,
      );
    }
    const startDateRaw = c.req.query("startDate");
    const endDateRaw = c.req.query("endDate");
    const startDate = startDateRaw
      ? new Date(startDateRaw)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = endDateRaw ? new Date(endDateRaw) : new Date();

    const timeRangeDays = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
    if (timeRangeDays > EXPORT_LIMITS.MAX_TIME_RANGE_DAYS) {
      return c.json(
        {
          error: `Time range too large. Maximum: ${EXPORT_LIMITS.MAX_TIME_RANGE_DAYS} days, requested: ${Math.ceil(timeRangeDays)} days`,
          maxDays: EXPORT_LIMITS.MAX_TIME_RANGE_DAYS,
        },
        400,
      );
    }
    if (startDate >= endDate) {
      return c.json({ error: "startDate must be before endDate" }, 400);
    }

    const granularityParam = c.req.query("granularity") || "day";
    if (!validateGranularity(granularityParam)) {
      return c.json(
        {
          error: `Invalid granularity: ${granularityParam}. Must be one of: hour, day, week, month`,
        },
        400,
      );
    }
    const granularity = granularityParam as TimeGranularity;
    const dataType = c.req.query("type") || "timeseries";
    const includeMetadata = c.req.query("includeMetadata") === "true";

    const exportOptions: ExportOptions = { includeTimestamp: true, includeMetadata };

    let data: Array<Record<string, unknown>>;
    let columns: ExportColumn[];
    let filename: string;

    if (dataType === "users") {
      const userBreakdown = await getUsageByUser(user.organization_id, {
        startDate,
        endDate,
        limit: EXPORT_LIMITS.MAX_ROWS,
      });
      data = userBreakdown.map((u) => ({
        email: u.userEmail,
        name: u.userName || "Unknown",
        requests: u.totalRequests,
        cost: u.totalCost,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        lastActive: u.lastActive?.toISOString() || "",
      }));
      columns = [
        { key: "email", label: "Email" },
        { key: "name", label: "Name" },
        { key: "requests", label: "Total Requests", format: formatNumber },
        { key: "cost", label: "Total Cost (Credits)", format: formatCurrency },
        { key: "inputTokens", label: "Input Tokens", format: formatNumber },
        { key: "outputTokens", label: "Output Tokens", format: formatNumber },
        { key: "lastActive", label: "Last Active", format: formatDate },
      ];
      filename = `user-analytics-${startDate.toISOString().split("T")[0]}-to-${endDate.toISOString().split("T")[0]}`;
    } else if (dataType === "providers") {
      const providerBreakdown = await getProviderBreakdown(user.organization_id, {
        startDate,
        endDate,
      });
      data = providerBreakdown.map((p) => ({
        provider: p.provider,
        requests: p.totalRequests,
        cost: p.totalCost,
        tokens: p.totalTokens,
        successRate: p.successRate,
        percentage: p.percentage,
      }));
      columns = [
        { key: "provider", label: "Provider" },
        { key: "requests", label: "Total Requests", format: formatNumber },
        { key: "cost", label: "Total Cost (Credits)", format: formatCurrency },
        { key: "tokens", label: "Total Tokens", format: formatNumber },
        { key: "successRate", label: "Success Rate", format: formatPercentage },
        { key: "percentage", label: "Usage %", format: (v) => `${Number(v).toFixed(1)}%` },
      ];
      filename = `provider-analytics-${startDate.toISOString().split("T")[0]}-to-${endDate.toISOString().split("T")[0]}`;
    } else if (dataType === "models") {
      const modelBreakdown = await getModelBreakdown(user.organization_id, {
        startDate,
        endDate,
        limit: EXPORT_LIMITS.MAX_ROWS,
      });
      data = modelBreakdown.map((m) => ({
        model: m.model,
        provider: m.provider,
        requests: m.totalRequests,
        cost: m.totalCost,
        tokens: m.totalTokens,
        avgCostPerToken: m.avgCostPerToken,
        successRate: m.successRate,
      }));
      columns = [
        { key: "model", label: "Model" },
        { key: "provider", label: "Provider" },
        { key: "requests", label: "Total Requests", format: formatNumber },
        { key: "cost", label: "Total Cost (Credits)", format: formatCurrency },
        { key: "tokens", label: "Total Tokens", format: formatNumber },
        { key: "avgCostPerToken", label: "Avg Cost/Token", format: (v) => Number(v).toFixed(6) },
        { key: "successRate", label: "Success Rate", format: formatPercentage },
      ];
      filename = `model-analytics-${startDate.toISOString().split("T")[0]}-to-${endDate.toISOString().split("T")[0]}`;
    } else {
      const timeSeriesData = await getUsageTimeSeries(user.organization_id, {
        startDate,
        endDate,
        granularity,
      });
      data = timeSeriesData.map((point) => ({
        timestamp: point.timestamp.toISOString(),
        requests: point.totalRequests,
        cost: point.totalCost,
        inputTokens: point.inputTokens,
        outputTokens: point.outputTokens,
        successRate: point.successRate,
      }));
      columns = [
        { key: "timestamp", label: "Timestamp", format: formatDate },
        { key: "requests", label: "Total Requests", format: formatNumber },
        { key: "cost", label: "Total Cost (Credits)", format: formatCurrency },
        { key: "inputTokens", label: "Input Tokens", format: formatNumber },
        { key: "outputTokens", label: "Output Tokens", format: formatNumber },
        { key: "successRate", label: "Success Rate", format: formatPercentage },
      ];
      filename = `usage-analytics-${granularity}-${startDate.toISOString().split("T")[0]}-to-${endDate.toISOString().split("T")[0]}`;
    }

    if (data.length > EXPORT_LIMITS.MAX_ROWS) {
      return c.json(
        {
          error: `Result set too large. Maximum: ${EXPORT_LIMITS.MAX_ROWS} rows, found: ${data.length} rows. Please narrow your date range or filters.`,
          limit: EXPORT_LIMITS.MAX_ROWS,
          actualRows: data.length,
          suggestion: "Use smaller date range or add filters",
        },
        413,
      );
    }

    const responseHeaders: Record<string, string> = {};
    if (data.length > EXPORT_LIMITS.MAX_ROWS_WARNING) {
      responseHeaders["X-Large-Export-Warning"] = "true";
      responseHeaders["X-Row-Count"] = data.length.toString();
    }

    if (format === "json") {
      const response = createDownloadResponse(
        generateJSON(data, exportOptions),
        `${filename}.json`,
        "application/json",
      );
      for (const [k, v] of Object.entries(responseHeaders)) response.headers.set(k, v);
      return response;
    }

    if (format === "excel" || format === "xlsx") {
      const excelBuffer = await generateExcel(data, columns, exportOptions);
      const response = createBinaryDownloadResponse(
        excelBuffer,
        `${filename}.xlsx`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      for (const [k, v] of Object.entries(responseHeaders)) response.headers.set(k, v);
      return response;
    }

    const response = createDownloadResponse(
      generateCSV(data, columns, exportOptions),
      `${filename}.csv`,
      "text/csv",
    );
    for (const [k, v] of Object.entries(responseHeaders)) response.headers.set(k, v);
    return response;
  } catch (error) {
    logger.error("[Analytics Export] Error:", error);
    return failureResponse(c, error);
  }
});

export default app;
