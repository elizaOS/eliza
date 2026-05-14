import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  generateProjectionAlerts,
  generateProjections,
} from "../../packages/lib/analytics/projections";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const DEFAULT_EVIDENCE_DIR = resolve(REPO_ROOT, "reports/eliza1-release-gates");

interface Args {
  organizationId: string;
  periods: number;
  dashboardUrl?: string;
  evidenceDir: string;
}

interface TimeSeriesRow {
  timestamp: Date;
  totalRequests: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  successRate: number;
}

interface AlertEventRow {
  id: string;
  severity: string;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {
    periods: 7,
    dashboardUrl: process.env.ELIZA1_DASHBOARD_URL,
    evidenceDir: process.env.ELIZA1_EVIDENCE_DIR || DEFAULT_EVIDENCE_DIR,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--organization-id") args.organizationId = next();
    else if (arg === "--periods") args.periods = Number(next());
    else if (arg === "--dashboard-url") args.dashboardUrl = next();
    else if (arg === "--evidence-dir") args.evidenceDir = resolve(next());
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: bun cloud/scripts/eliza1/dashboard-alerts.ts --organization-id ORG [--dashboard-url URL]",
          "",
          "Evaluates projection alert policies, persists alert events, and optionally verifies rendered red/yellow dashboard states via Playwright.",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!args.organizationId) throw new Error("--organization-id is required");
  if (!Number.isFinite(args.periods) || args.periods! < 1) {
    throw new Error("--periods must be a positive number");
  }
  return args as Args;
}

function timestampForFile(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function writeEvidence(evidenceDir: string, evidence: Record<string, unknown>) {
  mkdirSync(evidenceDir, { recursive: true });
  const file = resolve(evidenceDir, `dashboard_alerts-${timestampForFile()}.json`);
  writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[eliza1:dashboard-alerts] wrote ${relative(REPO_ROOT, file)} (${evidence.status})`);
}

function databaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL or TEST_DATABASE_URL is required");
  return url;
}

async function loadDashboardInputs(
  organizationId: string,
  startDate: Date,
  endDate: Date,
): Promise<{ historicalData: TimeSeriesRow[]; creditBalance: number | null }> {
  const pool = new Pool({ connectionString: databaseUrl() });
  try {
    const [usage, org] = await Promise.all([
      pool.query<{
        timestamp: Date;
        total_requests: number | string;
        total_cost: number | string;
        input_tokens: number | string;
        output_tokens: number | string;
        success_rate: number | string;
      }>(
        `
          SELECT
            date_trunc('day', created_at) AS timestamp,
            count(*)::int AS total_requests,
            coalesce(sum(input_cost + output_cost), 0)::numeric AS total_cost,
            coalesce(sum(input_tokens), 0)::int AS input_tokens,
            coalesce(sum(output_tokens), 0)::int AS output_tokens,
            coalesce(
              count(*) FILTER (WHERE is_successful = true)::float /
              nullif(count(*)::float, 0),
              1.0
            ) AS success_rate
          FROM usage_records
          WHERE organization_id = $1
            AND created_at >= $2
            AND created_at <= $3
          GROUP BY 1
          ORDER BY 1
        `,
        [organizationId, startDate, endDate],
      ),
      pool.query<{ credit_balance: string | number }>(
        "SELECT credit_balance FROM organizations WHERE id = $1",
        [organizationId],
      ),
    ]);

    return {
      historicalData: usage.rows.map((row) => ({
        timestamp: new Date(row.timestamp),
        totalRequests: Number(row.total_requests),
        totalCost: Number(row.total_cost),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        successRate: Number(row.success_rate),
      })),
      creditBalance:
        org.rows[0]?.credit_balance === undefined ? null : Number(org.rows[0].credit_balance),
    };
  } finally {
    await pool.end();
  }
}

function alertPolicyId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function alertSeverity(type: "warning" | "danger" | "info"): "warning" | "critical" | "info" {
  return type === "danger" ? "critical" : type;
}

async function persistAlertEvents(input: {
  organizationId: string;
  alerts: ReturnType<typeof generateProjectionAlerts>;
  historicalCount: number;
  projectedCount: number;
  creditBalance: number;
  evaluatedAt: Date;
}): Promise<AlertEventRow[]> {
  if (input.alerts.length === 0) return [];

  const pool = new Pool({ connectionString: databaseUrl() });
  try {
    const rows: AlertEventRow[] = [];
    for (const alert of input.alerts) {
      const policyId = alertPolicyId(alert.title);
      const dedupeKey = `analytics.projections:${policyId}:${input.evaluatedAt
        .toISOString()
        .slice(0, 10)}`;
      const result = await pool.query<AlertEventRow>(
        `
          INSERT INTO analytics_alert_events (
            organization_id,
            policy_id,
            severity,
            status,
            source,
            title,
            message,
            evidence,
            dedupe_key,
            evaluated_at
          )
          VALUES ($1, $2, $3, 'open', 'analytics.projections', $4, $5, $6::jsonb, $7, $8)
          ON CONFLICT (organization_id, dedupe_key)
          DO UPDATE SET evaluated_at = excluded.evaluated_at
          RETURNING id, severity
        `,
        [
          input.organizationId,
          policyId,
          alertSeverity(alert.type),
          alert.title,
          alert.message,
          JSON.stringify({
            projectedValue: alert.projectedValue ?? null,
            projectedDate: alert.projectedDate?.toISOString?.() ?? null,
            historicalPoints: input.historicalCount,
            projectedPoints: input.projectedCount,
            creditBalance: input.creditBalance,
          }),
          dedupeKey,
          input.evaluatedAt,
        ],
      );
      if (result.rows[0]) rows.push(result.rows[0]);
    }
    return rows;
  } finally {
    await pool.end();
  }
}

async function verifyDashboardRender(dashboardUrl?: string) {
  if (!dashboardUrl) {
    return {
      attempted: false,
      redStateRendered: false,
      yellowStateRendered: false,
      reason: "missing --dashboard-url",
    };
  }

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const authCookies = createDashboardTestAuthCookies(dashboardUrl);
    if (authCookies.length > 0) {
      await context.addCookies(authCookies);
    }
    const page = await context.newPage();
    await page.goto(dashboardUrl, { waitUntil: "networkidle", timeout: 60_000 });
    await page
      .locator('button[value="projections"], [role="tab"]:has-text("Projections")')
      .first()
      .click({ timeout: 30_000 })
      .catch(() => {});
    await page.locator('[data-alert-severity="critical"]').first().waitFor({ timeout: 30_000 }).catch(() => {});
    await page.locator('[data-alert-severity="warning"]').first().waitFor({ timeout: 30_000 }).catch(() => {});
    const redStateRendered = (await page.locator('[data-alert-severity="critical"]').count()) > 0;
    const yellowStateRendered = (await page.locator('[data-alert-severity="warning"]').count()) > 0;
    return {
      attempted: true,
      redStateRendered,
      yellowStateRendered,
      reason: redStateRendered && yellowStateRendered ? null : "alert severity selectors not found",
    };
  } finally {
    await browser.close();
  }
}

function createDashboardTestAuthCookies(dashboardUrl: string) {
  if (process.env.ELIZA1_DASHBOARD_TEST_AUTH !== "true") return [];
  const userId = process.env.ELIZA1_DASHBOARD_TEST_USER_ID?.trim();
  const organizationId = process.env.ELIZA1_DASHBOARD_TEST_ORGANIZATION_ID?.trim();
  const secret = process.env.PLAYWRIGHT_TEST_AUTH_SECRET?.trim();
  if (!userId || !organizationId || !secret || secret.length < 16) return [];

  const claims = {
    userId,
    organizationId,
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const url = new URL(dashboardUrl);
  const secure = url.protocol === "https:";
  const domain = url.hostname;
  return [
    {
      name: "eliza-test-auth",
      value: "1",
      domain,
      path: "/",
      secure,
      httpOnly: false,
      sameSite: "Lax" as const,
    },
    {
      name: "steward-authed",
      value: "1",
      domain,
      path: "/",
      secure,
      httpOnly: false,
      sameSite: "Lax" as const,
    },
    {
      name: "eliza-test-session",
      value: `${payload}.${signature}`,
      domain,
      path: "/",
      secure,
      httpOnly: true,
      sameSite: "Lax" as const,
    },
  ];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  let historicalData: TimeSeriesRow[];
  let creditBalance: number | null;
  try {
    const inputs = await loadDashboardInputs(args.organizationId, startDate, now);
    historicalData = inputs.historicalData;
    creditBalance = inputs.creditBalance;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    writeEvidence(args.evidenceDir, {
      gate: "dashboard_alerts",
      status: "fail",
      completedAt: new Date().toISOString(),
      organizationId: args.organizationId,
      policiesEvaluated: 0,
      redStateRendered: false,
      yellowStateRendered: false,
      alertEventsPersisted: 0,
      error: reason,
      summary: `DB-backed dashboard alert evaluation could not run: ${reason}`,
    });
    process.exitCode = 1;
    return;
  }

  if (creditBalance === null) {
    writeEvidence(args.evidenceDir, {
      gate: "dashboard_alerts",
      status: "fail",
      completedAt: new Date().toISOString(),
      organizationId: args.organizationId,
      policiesEvaluated: 0,
      redStateRendered: false,
      yellowStateRendered: false,
      alertEventsPersisted: 0,
      error: `organization ${args.organizationId} not found`,
      summary: `DB-backed dashboard alert evaluation could not run: organization ${args.organizationId} not found`,
    });
    process.exitCode = 1;
    return;
  }

  const projections = generateProjections(historicalData, args.periods);
  const alerts = generateProjectionAlerts(historicalData, projections, creditBalance);
  let events: AlertEventRow[];
  try {
    events = await persistAlertEvents({
      organizationId: args.organizationId,
      alerts,
      historicalCount: historicalData.length,
      projectedCount: projections.filter((point) => point.isProjected).length,
      creditBalance,
      evaluatedAt: now,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    writeEvidence(args.evidenceDir, {
      gate: "dashboard_alerts",
      status: "fail",
      completedAt: new Date().toISOString(),
      organizationId: args.organizationId,
      policiesEvaluated: 2,
      projectionAlertsGenerated: alerts.length,
      redStateRendered: false,
      yellowStateRendered: false,
      alertEventsPersisted: 0,
      error: reason,
      summary: `dashboard alert events could not be persisted: ${reason}`,
    });
    process.exitCode = 1;
    return;
  }
  const render = await verifyDashboardRender(args.dashboardUrl);
  const criticalPersisted = events.some((event) => event.severity === "critical");
  const warningPersisted = events.some((event) => event.severity === "warning");
  const status =
    alerts.length > 0 &&
    events.length >= alerts.length &&
    criticalPersisted &&
    warningPersisted &&
    render.redStateRendered &&
    render.yellowStateRendered;

  writeEvidence(args.evidenceDir, {
    gate: "dashboard_alerts",
    status: status ? "pass" : "fail",
    completedAt: new Date().toISOString(),
    organizationId: args.organizationId,
    policiesEvaluated: 2,
    projectionAlertsGenerated: alerts.length,
    redStateRendered: render.redStateRendered,
    yellowStateRendered: render.yellowStateRendered,
    alertEventsPersisted: events.length,
    alertEventIds: events.map((event) => event.id),
    renderVerification: render,
    summary: `generated ${alerts.length} projection alerts; persisted ${events.length}; red rendered ${render.redStateRendered}; yellow rendered ${render.yellowStateRendered}`,
  });

  if (!status) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[eliza1:dashboard-alerts] ${error.message}`);
  process.exit(1);
});
