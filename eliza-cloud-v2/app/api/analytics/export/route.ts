import { type NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { logger } from "@/lib/utils/logger";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";
import {
  getUsageTimeSeries,
  getUsageByUser,
  getProviderBreakdown,
  getModelBreakdown,
  validateGranularity,
  type TimeGranularity,
} from "@/lib/services/analytics";
import {
  generateCSV,
  generateJSON,
  generateExcel,
  createDownloadResponse,
  createBinaryDownloadResponse,
  formatCurrency,
  formatNumber,
  formatPercentage,
  formatDate,
  type ExportColumn,
  type ExportOptions,
} from "@/lib/export/analytics";

export const maxDuration = 60;

const EXPORT_LIMITS = {
  MAX_TIME_RANGE_DAYS: 365, // Max 1 year of data
  MAX_ROWS: 100000, // Max 100k rows
  MAX_ROWS_WARNING: 50000, // Warning threshold
  STREAMING_THRESHOLD: 10000, // Stream if > 10k rows (future)
} as const;

/**
 * GET /api/analytics/export
 * Exports analytics data in various formats (CSV, JSON, Excel).
 * Supports time series, user breakdown, provider breakdown, and model breakdown exports.
 *
 * @param req - Request with query parameters for format, date range, granularity, and data type.
 * @returns File download response with analytics data in the requested format.
 */
async function handleGET(req: NextRequest) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(req);
    const searchParams = req.nextUrl.searchParams;

    const format = searchParams.get("format") || "csv";
    const startDate = searchParams.get("startDate")
      ? new Date(searchParams.get("startDate")!)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = searchParams.get("endDate")
      ? new Date(searchParams.get("endDate")!)
      : new Date();

    // Validate time range
    const timeRangeDays =
      (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);

    if (timeRangeDays > EXPORT_LIMITS.MAX_TIME_RANGE_DAYS) {
      return NextResponse.json(
        {
          error: `Time range too large. Maximum: ${EXPORT_LIMITS.MAX_TIME_RANGE_DAYS} days, requested: ${Math.ceil(timeRangeDays)} days`,
          maxDays: EXPORT_LIMITS.MAX_TIME_RANGE_DAYS,
        },
        { status: 400 },
      );
    }

    if (startDate >= endDate) {
      return NextResponse.json(
        { error: "startDate must be before endDate" },
        { status: 400 },
      );
    }

    const granularityParam = searchParams.get("granularity") || "day";

    if (!validateGranularity(granularityParam)) {
      return NextResponse.json(
        {
          error: `Invalid granularity: ${granularityParam}. Must be one of: hour, day, week, month`,
        },
        { status: 400 },
      );
    }

    const granularity = granularityParam as TimeGranularity;
    const dataType = searchParams.get("type") || "timeseries";
    const includeMetadata = searchParams.get("includeMetadata") === "true";

    const exportOptions: ExportOptions = {
      includeTimestamp: true,
      includeMetadata,
    };

    let data: Array<Record<string, unknown>>;
    let columns: ExportColumn[];
    let filename: string;

    if (dataType === "users") {
      const userBreakdown = await getUsageByUser(user.organization_id!, {
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
      const providerBreakdown = await getProviderBreakdown(
        user.organization_id!,
        {
          startDate,
          endDate,
        },
      );
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
        {
          key: "successRate",
          label: "Success Rate",
          format: formatPercentage,
        },
        {
          key: "percentage",
          label: "Usage %",
          format: (v) => `${Number(v).toFixed(1)}%`,
        },
      ];
      filename = `provider-analytics-${startDate.toISOString().split("T")[0]}-to-${endDate.toISOString().split("T")[0]}`;
    } else if (dataType === "models") {
      const modelBreakdown = await getModelBreakdown(user.organization_id!, {
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
        {
          key: "avgCostPerToken",
          label: "Avg Cost/Token",
          format: (v) => Number(v).toFixed(6),
        },
        {
          key: "successRate",
          label: "Success Rate",
          format: formatPercentage,
        },
      ];
      filename = `model-analytics-${startDate.toISOString().split("T")[0]}-to-${endDate.toISOString().split("T")[0]}`;
    } else {
      // Time series export with DOS protection
      const timeSeriesData = await getUsageTimeSeries(user.organization_id!, {
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
        {
          key: "successRate",
          label: "Success Rate",
          format: formatPercentage,
        },
      ];
      filename = `usage-analytics-${granularity}-${startDate.toISOString().split("T")[0]}-to-${endDate.toISOString().split("T")[0]}`;
    }

    // Check result size
    if (data.length > EXPORT_LIMITS.MAX_ROWS) {
      return NextResponse.json(
        {
          error: `Result set too large. Maximum: ${EXPORT_LIMITS.MAX_ROWS} rows, found: ${data.length} rows. Please narrow your date range or filters.`,
          limit: EXPORT_LIMITS.MAX_ROWS,
          actualRows: data.length,
          suggestion: "Use smaller date range or add filters",
        },
        { status: 413 }, // Payload Too Large
      );
    }

    // Add warning headers for large exports
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
      Object.entries(responseHeaders).forEach(([key, value]) =>
        response.headers.set(key, value),
      );
      return response;
    }

    if (format === "excel" || format === "xlsx") {
      const excelBuffer = await generateExcel(data, columns, exportOptions);
      const response = createBinaryDownloadResponse(
        excelBuffer,
        `${filename}.xlsx`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      Object.entries(responseHeaders).forEach(([key, value]) =>
        response.headers.set(key, value),
      );
      return response;
    }

    if (format === "pdf") {
      return NextResponse.json(
        {
          error:
            "PDF export requires 'pdfkit' package. Install with: bun add pdfkit @types/pdfkit",
        },
        { status: 501 },
      );
    }

    const response = createDownloadResponse(
      generateCSV(data, columns, exportOptions),
      `${filename}.csv`,
      "text/csv",
    );
    Object.entries(responseHeaders).forEach(([key, value]) =>
      response.headers.set(key, value),
    );
    return response;
  } catch (error) {
    logger.error("[Analytics Export] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to export analytics data",
      },
      { status: 500 },
    );
  }
}

export const GET = withRateLimit(handleGET, RateLimitPresets.STANDARD);
