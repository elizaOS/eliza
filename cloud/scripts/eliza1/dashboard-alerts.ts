import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateProjectionAlerts,
  generateProjections,
} from "../../packages/lib/analytics/projections";
import { analyticsService } from "../../packages/lib/services/analytics";
import { analyticsAlertsService } from "../../packages/lib/services/analytics-alerts";
import { organizationsService } from "../../packages/lib/services/organizations";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const DEFAULT_EVIDENCE_DIR = resolve(REPO_ROOT, "reports/eliza1-release-gates");

interface Args {
  organizationId: string;
  periods: number;
  dashboardUrl?: string;
  evidenceDir: string;
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
    const page = await browser.newPage();
    await page.goto(dashboardUrl, { waitUntil: "networkidle", timeout: 60_000 });
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [historicalData, organization] = await Promise.all([
    analyticsService.getUsageTimeSeries(args.organizationId, {
      startDate,
      endDate: now,
      granularity: "day",
    }),
    organizationsService.getById(args.organizationId),
  ]);

  if (!organization) throw new Error(`organization ${args.organizationId} not found`);

  const creditBalance = Number(organization.credit_balance ?? 0);
  const projections = generateProjections(historicalData, args.periods);
  const alerts = generateProjectionAlerts(historicalData, projections, creditBalance);
  const events = await analyticsAlertsService.persistProjectionAlerts({
    organizationId: args.organizationId,
    alerts,
    historicalData,
    projectedData: projections,
    creditBalance,
    evaluatedAt: now,
  });
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
