/**
 * POST /api/v1/reports/bug
 * Receives structured bug reports from clients (Agent) and forwards them
 * via the existing email service.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { emailService } from "@/lib/services/email";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const bugReportSchema = z.object({
  source: z.string().max(120).default("unknown-client"),
  submittedAt: z.string().optional(),
  category: z.enum(["general", "startup-failure"]).default("general"),
  description: z.string().min(1).max(500),
  stepsToReproduce: z.string().min(1).max(10000),
  expectedBehavior: z.string().max(10000).optional(),
  actualBehavior: z.string().max(10000).optional(),
  environment: z.string().max(200).optional(),
  nodeVersion: z.string().max(200).optional(),
  modelProvider: z.string().max(200).optional(),
  appVersion: z.string().max(200).optional(),
  releaseChannel: z.string().max(200).optional(),
  logs: z.string().max(50000).optional(),
  startup: z
    .object({
      reason: z.string().max(120).optional(),
      phase: z.string().max(120).optional(),
      message: z.string().max(1000).optional(),
      detail: z.string().max(10000).optional(),
      status: z.number().int().optional(),
      path: z.string().max(500).optional(),
    })
    .optional(),
});

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function section(title: string, content?: string) {
  if (!content) return "";
  return `
    <div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px; margin: 12px 0;">
      <h3 style="color: #FF5800; margin: 0 0 10px 0; font-size: 15px;">${escapeHtml(title)}</h3>
      <pre style="white-space: pre-wrap; margin: 0; color: #fff; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5;">${escapeHtml(content)}</pre>
    </div>`;
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

app.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const validated = bugReportSchema.parse(body);

    const reportId = `rpt_${crypto.randomUUID()}`;
    const receivedAt = new Date().toISOString();
    const env = c.env as { BUG_REPORT_EMAIL_TO?: string; SUPPORT_EMAIL?: string };
    const recipient = env.BUG_REPORT_EMAIL_TO ?? env.SUPPORT_EMAIL ?? "developer@elizalabs.ai";

    const startupSummary = validated.startup
      ? JSON.stringify(validated.startup, null, 2)
      : undefined;

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>New Structured Bug Report</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 760px; margin: 0 auto; padding: 20px; background-color: #0a0a0a; color: #ffffff;">
  <div style="background: linear-gradient(135deg, rgba(255, 88, 0, 0.1) 0%, rgba(0, 0, 0, 0.85) 100%); padding: 28px; border-radius: 12px; border: 1px solid rgba(255, 88, 0, 0.2);">
    <h2 style="color: #FF5800; margin-top: 0; font-size: 24px;">Structured Bug Report</h2>
    <div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px; margin: 16px 0;">
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <tr><td style="padding: 6px 0; color: #888;"><strong>Report ID</strong></td><td style="padding: 6px 0;">${escapeHtml(reportId)}</td></tr>
        <tr><td style="padding: 6px 0; color: #888;"><strong>Source</strong></td><td style="padding: 6px 0;">${escapeHtml(validated.source)}</td></tr>
        <tr><td style="padding: 6px 0; color: #888;"><strong>Category</strong></td><td style="padding: 6px 0;">${escapeHtml(validated.category)}</td></tr>
        <tr><td style="padding: 6px 0; color: #888;"><strong>Received</strong></td><td style="padding: 6px 0;">${escapeHtml(receivedAt)}</td></tr>
        <tr><td style="padding: 6px 0; color: #888;"><strong>App Version</strong></td><td style="padding: 6px 0;">${escapeHtml(validated.appVersion || "unknown")}</td></tr>
        <tr><td style="padding: 6px 0; color: #888;"><strong>Release Channel</strong></td><td style="padding: 6px 0;">${escapeHtml(validated.releaseChannel || "unknown")}</td></tr>
        <tr><td style="padding: 6px 0; color: #888;"><strong>Environment</strong></td><td style="padding: 6px 0;">${escapeHtml(validated.environment || "unknown")}</td></tr>
      </table>
    </div>
    ${section("Description", validated.description)}
    ${section("Steps to Reproduce", validated.stepsToReproduce)}
    ${section("Expected Behavior", validated.expectedBehavior)}
    ${section("Actual Behavior", validated.actualBehavior)}
    ${section("Startup Context", startupSummary)}
    ${section("Logs", validated.logs)}
  </div>
</body>
</html>`;

    const text = [
      "Structured Bug Report",
      `Report ID: ${reportId}`,
      `Source: ${validated.source}`,
      `Category: ${validated.category}`,
      `Received: ${receivedAt}`,
      `App Version: ${validated.appVersion ?? "unknown"}`,
      `Release Channel: ${validated.releaseChannel ?? "unknown"}`,
      `Environment: ${validated.environment ?? "unknown"}`,
      "",
      "Description:",
      validated.description,
      "",
      "Steps to Reproduce:",
      validated.stepsToReproduce,
      validated.expectedBehavior ? `\nExpected Behavior:\n${validated.expectedBehavior}` : "",
      validated.actualBehavior ? `\nActual Behavior:\n${validated.actualBehavior}` : "",
      startupSummary ? `\nStartup Context:\n${startupSummary}` : "",
      validated.logs ? `\nLogs:\n${validated.logs}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const sent = await emailService.send({
      to: recipient,
      subject: `[Bug Report] ${validated.source} - ${validated.description.slice(0, 100)}`,
      html,
      text,
    });

    if (!sent) {
      logger.error("[BugReport] Failed to send bug report email", {
        reportId,
        source: validated.source,
        category: validated.category,
      });
      return c.json({ accepted: false, error: "Email service unavailable" }, 503);
    }

    logger.info("[BugReport] Structured bug report accepted", {
      reportId,
      source: validated.source,
      category: validated.category,
    });

    return c.json({ accepted: true, id: reportId });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
