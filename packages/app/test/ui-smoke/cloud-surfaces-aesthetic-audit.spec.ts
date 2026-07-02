import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { expect, type Page, test } from "@playwright/test";
import {
  collectBlueColors,
  collectHoverViolations,
} from "./helpers/brand-color-scans";
import {
  analyzeScreenshot,
  type ScreenshotQuality,
  screenshotQualityIssues,
} from "./helpers/screenshot-quality";

/**
 * Cloud-surface aesthetic audit (#10725 / #11342) — the audit:app equivalent
 * for the app-hosted Eliza Cloud surfaces. `audit:app` walks the tab/view app
 * (builtin tabs + plugin views) but never enters the CloudRouterShell route
 * space, so the ~28 cloud surfaces registered in
 * `packages/ui/src/cloud/register-all.ts` shipped with no visual-audit loop.
 *
 * This walk visits EVERY registered cloud route (parametric routes get a
 * representative stubbed id) at desktop (1440×900) + mobile (390×844),
 * captures rest + primary-button-hover screenshots, scans for the #10725
 * brand rules (no blue anywhere; orange-resting buttons must not hover to
 * black/white/transparent), collects console errors, and writes a per-page
 * `manual-review/<slug>.md` verdict stub + `report.json` +
 * `contact-sheet.html` for the hand-review loop.
 *
 * Run via `bun run --cwd packages/app audit:cloud`. Requirements:
 *  - The renderer dist must be built with `VITE_PLAYWRIGHT_TEST_AUTH=true`
 *    (the audit:cloud script exports it so a stale-dist rebuild inlines it;
 *    with ELIZA_UI_SMOKE_SKIP_BUILD=1 you must have built it yourself). With
 *    the flag, StewardAuthProvider renders children directly and the pages
 *    authenticate from the persisted Steward token this spec seeds.
 *  - Cloud APIs are stubbed per domain below so pages render real zero/served
 *    states instead of eternal skeletons; anything unstubbed falls through to
 *    the deterministic 501 stub backend, and the page's rendered failure
 *    state is itself audited.
 *
 * Verdict policy (subset of audit:app's — cloud pages don't mount the
 * floating chat overlay, so overlay checks don't apply): `broken` on console
 * error / blank render, `needs-work` on a blue-color or hover violation,
 * otherwise `needs-eyeball` until the committed manual review upgrades it.
 * Output dir: `aesthetic-audit-output-cloud/` (override: ELIZA_AUDIT_CLOUD_DIR).
 */

const TEST_AUTH_ENABLED =
  process.env.VITE_PLAYWRIGHT_TEST_AUTH === "true" ||
  process.env.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH === "true";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

interface CloudAuditCase {
  slug: string;
  /** Concrete path (parametric segments filled with the stubbed sample ids). */
  path: string;
  /** The registered route pattern this case exercises. */
  route: string;
  /** Seed the persisted Steward token before boot (authed dashboard pages). */
  auth: boolean;
}

const AUTH = true;
const PUBLIC = false;

/**
 * Every route registered by `registerAllCloudSurfaces()` (register-all.test.ts
 * guards the wiring). Parametric routes use the sample ids the stub layer
 * below serves. The `coverage matches the registered cloud routes` test at the
 * bottom fails when this table drifts from the live registry.
 */
const CLOUD_AUDIT_CASES: CloudAuditCase[] = [
  // instances/
  {
    slug: "dashboard-agents",
    path: "/dashboard/agents",
    route: "dashboard/agents",
    auth: AUTH,
  },
  {
    slug: "dashboard-agents-detail",
    path: "/dashboard/agents/agent-smoke-1",
    route: "dashboard/agents/:id",
    auth: AUTH,
  },
  {
    slug: "dashboard-my-agents",
    path: "/dashboard/my-agents",
    route: "dashboard/my-agents",
    auth: AUTH,
  },
  // account-security/
  {
    slug: "dashboard-account",
    path: "/dashboard/account",
    route: "dashboard/account",
    auth: AUTH,
  },
  {
    slug: "dashboard-security",
    path: "/dashboard/security",
    route: "dashboard/security",
    auth: AUTH,
  },
  {
    slug: "dashboard-security-permissions",
    path: "/dashboard/security/permissions",
    route: "dashboard/security/permissions",
    auth: AUTH,
  },
  // analytics/
  {
    slug: "dashboard-analytics",
    path: "/dashboard/analytics",
    route: "dashboard/analytics",
    auth: AUTH,
  },
  // billing/
  {
    slug: "dashboard-billing",
    path: "/dashboard/billing",
    route: "dashboard/billing",
    auth: AUTH,
  },
  {
    slug: "dashboard-billing-success",
    path: "/dashboard/billing/success",
    route: "dashboard/billing/success",
    auth: AUTH,
  },
  {
    slug: "dashboard-invoice-detail",
    path: "/dashboard/invoices/invoice-smoke-1",
    route: "dashboard/invoices/:id",
    auth: AUTH,
  },
  // organization/
  {
    slug: "dashboard-organization",
    path: "/dashboard/organization",
    route: "dashboard/organization",
    auth: AUTH,
  },
  // connectors/
  {
    slug: "dashboard-settings-connections",
    path: "/dashboard/settings/connections",
    route: "dashboard/settings/connections",
    auth: AUTH,
  },
  // join/
  { slug: "join", path: "/join", route: "join", auth: PUBLIC },
  // public-pages/ — payment + approval + governance token pages
  {
    slug: "payment-request",
    path: "/payment/payreq-smoke-1",
    route: "payment/:paymentRequestId",
    auth: PUBLIC,
  },
  {
    slug: "payment-success",
    path: "/payment/success",
    route: "payment/success",
    auth: PUBLIC,
  },
  {
    slug: "payment-app-charge",
    path: "/payment/app-charge/app-smoke-1/charge-smoke-1",
    route: "payment/app-charge/:appId/:chargeId",
    auth: PUBLIC,
  },
  {
    slug: "approve-approval",
    path: "/approve/approval-smoke-1",
    route: "approve/:approvalId",
    auth: PUBLIC,
  },
  {
    slug: "ballot",
    path: "/ballot/ballot-smoke-1",
    route: "ballot/:ballotId",
    auth: PUBLIC,
  },
  {
    slug: "sensitive-request",
    path: "/sensitive-requests/sensitive-smoke-1",
    route: "sensitive-requests/:requestId",
    auth: PUBLIC,
  },
  {
    slug: "public-character-chat",
    path: "/chat/smoke-character",
    route: "chat/:characterRef",
    auth: PUBLIC,
  },
  // public-pages/ — invitations + auth
  {
    slug: "invite-accept",
    path: "/invite/accept?token=invite-smoke-token",
    route: "invite/accept",
    auth: PUBLIC,
  },
  {
    slug: "accept-invitation",
    path: "/accept-invitation?token=invite-smoke-token",
    route: "accept-invitation",
    auth: PUBLIC,
  },
  { slug: "login", path: "/login", route: "login", auth: PUBLIC },
  {
    slug: "auth-success",
    path: "/auth/success",
    route: "auth/success",
    auth: PUBLIC,
  },
  {
    slug: "auth-error",
    path: "/auth/error",
    route: "auth/error",
    auth: PUBLIC,
  },
  {
    slug: "auth-cli-login",
    path: "/auth/cli-login",
    route: "auth/cli-login",
    auth: PUBLIC,
  },
  {
    slug: "auth-callback-email",
    path: "/auth/callback/email?token=email-smoke-token",
    route: "auth/callback/email",
    auth: PUBLIC,
  },
  {
    slug: "app-auth-authorize",
    path: "/app-auth/authorize?app_id=app-smoke-1&redirect_uri=https%3A%2F%2Fexample.com%2Fcb",
    route: "app-auth/authorize",
    auth: AUTH,
  },
  // public-pages/ — legal + bsc
  {
    slug: "terms-of-service",
    path: "/terms-of-service",
    route: "terms-of-service",
    auth: PUBLIC,
  },
  {
    slug: "privacy-policy",
    path: "/privacy-policy",
    route: "privacy-policy",
    auth: PUBLIC,
  },
  { slug: "bsc", path: "/bsc", route: "bsc", auth: PUBLIC },
  // api-explorer/
  {
    slug: "dashboard-api-explorer",
    path: "/dashboard/api-explorer",
    route: "dashboard/api-explorer",
    auth: AUTH,
  },
  // applications/
  {
    slug: "dashboard-apps",
    path: "/dashboard/apps",
    route: "dashboard/apps",
    auth: AUTH,
  },
  {
    slug: "dashboard-apps-detail",
    path: "/dashboard/apps/app-smoke-1",
    route: "dashboard/apps/:id",
    auth: AUTH,
  },
  // approvals/
  {
    slug: "dashboard-approvals",
    path: "/dashboard/approvals",
    route: "dashboard/approvals",
    auth: AUTH,
  },
  // monetization/
  {
    slug: "dashboard-monetization",
    path: "/dashboard/monetization",
    route: "dashboard/monetization",
    auth: AUTH,
  },
  {
    slug: "dashboard-earnings",
    path: "/dashboard/earnings",
    route: "dashboard/earnings",
    auth: AUTH,
  },
  {
    slug: "dashboard-affiliates",
    path: "/dashboard/affiliates",
    route: "dashboard/affiliates",
    auth: AUTH,
  },
  // admin/
  {
    slug: "dashboard-admin",
    path: "/dashboard/admin",
    route: "dashboard/admin",
    auth: AUTH,
  },
  {
    slug: "dashboard-admin-redemptions",
    path: "/dashboard/admin/redemptions",
    route: "dashboard/admin/redemptions",
    auth: AUTH,
  },
  {
    slug: "dashboard-admin-rpc-status",
    path: "/dashboard/admin/rpc-status",
    route: "dashboard/admin/rpc-status",
    auth: AUTH,
  },
  // mcps/
  {
    slug: "dashboard-mcps",
    path: "/dashboard/mcps",
    route: "dashboard/mcps",
    auth: AUTH,
  },
];

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.sig`;
}

async function seedStewardToken(page: Page): Promise<void> {
  const token = makeJwt({
    sub: "cloud-audit-smoke-user",
    email: "cloud-audit-smoke@agent.local",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, value);
    },
    { key: STEWARD_TOKEN_KEY, value: token },
  );
}

// ── Cloud API stubs ──────────────────────────────────────────────────────────
// Installed per page; shapes traced from packages/ui/src/cloud/** data hooks.
// The goal is a real zero/populated render per page, not a mocked component:
// the page code, routing, auth gates, and design system all run for real.

async function installCloudApiStubs(page: Page): Promise<void> {
  await installCloudApiStubTable(page);
}

interface StubRule {
  /** Method to match (default GET). */
  method?: string;
  /** Pathname test, run against `new URL(request.url()).pathname`. */
  match: (pathname: string, search: URLSearchParams) => boolean;
  status?: number;
  body: unknown;
}

// NOTE: table order matters — first match wins.
const STUB_RULES: StubRule[] = [];

async function installCloudApiStubTable(page: Page): Promise<void> {
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const rule = STUB_RULES.find(
      (r) =>
        (r.method ?? "GET") === request.method() &&
        r.match(url.pathname, url.searchParams),
    );
    if (!rule) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: rule.status ?? 200,
      contentType: "application/json",
      body: JSON.stringify(rule.body),
    });
  });
}

// ── Findings ─────────────────────────────────────────────────────────────────

type CloudVerdict = "good" | "needs-work" | "needs-eyeball" | "broken";

interface CloudPageFinding {
  slug: string;
  viewport: string;
  path: string;
  route: string;
  consoleErrors: string[];
  blueColors: string[];
  hoverViolations: string[];
  hoverFailures: string[];
  readableChars: number;
  quality: ScreenshotQuality | null;
  qualityIssues: string[];
  verdict: CloudVerdict;
}

function computeCloudVerdict(
  finding: Omit<CloudPageFinding, "verdict">,
): CloudVerdict {
  if (
    finding.consoleErrors.length > 0 ||
    finding.qualityIssues.length > 0 ||
    finding.readableChars < 10
  ) {
    return "broken";
  }
  if (finding.blueColors.length > 0 || finding.hoverViolations.length > 0) {
    return "needs-work";
  }
  return "needs-eyeball";
}

function renderManualReviewStub(findings: CloudPageFinding[]): string {
  const [first] = findings;
  const lines = [
    `# ${first.slug}`,
    "",
    `- **route:** \`${first.route}\``,
    `- **path:** \`${first.path}\``,
    "",
  ];
  for (const f of findings) {
    lines.push(
      `## ${f.viewport}`,
      "",
      `- **verdict:** ${f.verdict}`,
      `- **console errors:** ${f.consoleErrors.length ? f.consoleErrors.join("; ") : "none"}`,
      `- **blue colors (banned):** ${f.blueColors.length ? f.blueColors.join(", ") : "none"}`,
      `- **orange hover violations:** ${f.hoverViolations.length ? f.hoverViolations.join("; ") : "none"}`,
      `- **hover probe failures:** ${f.hoverFailures.length ? f.hoverFailures.join("; ") : "none"}`,
      `- **readable content chars:** ${f.readableChars}`,
      `- **screenshot quality issues:** ${f.qualityIssues.length ? f.qualityIssues.join("; ") : "none"}`,
      "",
    );
  }
  lines.push(
    "## Hand review",
    "",
    "_Fill in: rendered state, visual issues, layout breaks, color/hover notes._",
    "_Set the per-viewport verdicts above to one of `good` · `needs-work` ·_",
    "_`needs-eyeball` · `broken` after opening the screenshots._",
    "",
  );
  return lines.join("\n");
}

const findings: CloudPageFinding[] = [];
const findingsBySlug = new Map<string, CloudPageFinding[]>();

test.describe("cloud-surfaces aesthetic audit (#10725/#11342)", () => {
  test.skip(
    !TEST_AUTH_ENABLED,
    "set VITE_PLAYWRIGHT_TEST_AUTH=true (bake it into the renderer build) so StewardProvider renders the local test-auth shell",
  );

  const outputDir =
    process.env.ELIZA_AUDIT_CLOUD_DIR ??
    path.join(process.cwd(), "aesthetic-audit-output-cloud");

  // Coverage guard: every registered cloud route must appear in the audit
  // table, so a newly-registered surface fails the audit until it is walked.
  test("coverage matches the registered cloud routes", async () => {
    const { registerAllCloudSurfaces } = await import(
      "../../../ui/src/cloud/register-all"
    );
    const { listCloudRoutes } = await import(
      "../../../ui/src/cloud/shell/cloud-route-registry"
    );
    registerAllCloudSurfaces();
    const registered = new Set(listCloudRoutes().map((r) => r.path));
    const audited = new Set(CLOUD_AUDIT_CASES.map((c) => c.route));
    const unaudited = [...registered].filter((p) => !audited.has(p));
    expect(
      unaudited,
      `registered cloud routes missing from the audit table: ${unaudited.join(", ")}`,
    ).toEqual([]);
    const phantom = [...audited].filter((p) => !registered.has(p));
    expect(
      phantom,
      `audit table routes that are no longer registered: ${phantom.join(", ")}`,
    ).toEqual([]);
  });

  for (const auditCase of CLOUD_AUDIT_CASES) {
    for (const vp of VIEWPORTS) {
      test(`${auditCase.slug} ${vp.name}`, async ({ page }) => {
        const reviewDir = path.join(outputDir, "manual-review");
        const shotDir = path.join(outputDir, vp.name);
        await mkdir(reviewDir, { recursive: true });
        await mkdir(shotDir, { recursive: true });

        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        page.on("pageerror", (e) => pageErrors.push(e.message));
        page.on("console", (msg) => {
          if (msg.type() !== "error") return;
          const text = msg.text();
          // The deterministic stub backend answers unstubbed routes with
          // 501/404; those network console errors are expected in this harness
          // (same policy as all-views-aesthetic-audit) — only real,
          // non-network console errors count.
          if (
            /\b50[124]\b|\b40[134]\b|failed to (load|fetch)|net::err|networkerror|status (of )?(40|50)\d|err_/i.test(
              text,
            )
          ) {
            return;
          }
          consoleErrors.push(text);
        });

        await page.setViewportSize({ width: vp.width, height: vp.height });
        if (auditCase.auth) {
          await seedStewardToken(page);
        }
        await installCloudApiStubs(page);
        await page.goto(auditCase.path, { waitUntil: "domcontentloaded" });

        // Wait for the page to actually paint text (lazy route chunk +
        // react-query settle). Non-fatal: a page that never paints is recorded
        // as a `broken` finding, not a walk abort.
        const readPaint = async (): Promise<number> =>
          page
            .evaluate(
              () => document.body.innerText.trim().replace(/\s+/g, " ").length,
            )
            .catch(() => 0);
        let readableChars = await readPaint();
        for (
          let attempt = 0;
          attempt < 15 && readableChars < 10;
          attempt += 1
        ) {
          await page.waitForTimeout(1000);
          readableChars = await readPaint();
        }
        // Let late skeleton → content transitions settle before sampling.
        await page.waitForTimeout(750);
        readableChars = await readPaint();

        const restPath = path.join(shotDir, `${auditCase.slug}.png`);
        let buffer = await page.screenshot({ path: restPath, fullPage: false });
        let quality = await analyzeScreenshot(buffer).catch(() => null);
        for (
          let attempt = 0;
          attempt < 3 && quality && quality.colorBuckets <= 1;
          attempt += 1
        ) {
          await page.waitForTimeout(800);
          buffer = await page.screenshot({ path: restPath, fullPage: false });
          quality = await analyzeScreenshot(buffer).catch(() => null);
        }
        const qualityIssues = quality
          ? screenshotQualityIssues(`${auditCase.slug} ${vp.name}`, quality)
          : [];

        const blueColors = await collectBlueColors(page).catch(() => []);
        const { violations: hoverViolations, hoverFailures } =
          await collectHoverViolations(page).catch((error: unknown) => ({
            violations: [],
            hoverFailures: [
              `hover scan failed: ${(error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 120)}`,
            ],
          }));

        // Primary-button hover screenshot (the #10725 hover-rule artifact):
        // hover the first visible enabled button and capture the state.
        const hoverTarget = page
          .locator("button:visible, a[role='button']:visible")
          .first();
        if (await hoverTarget.isVisible().catch(() => false)) {
          const hovered = await hoverTarget
            .hover({ timeout: 2000 })
            .then(() => true)
            .catch(() => false);
          if (hovered) {
            await page.screenshot({
              path: path.join(shotDir, `${auditCase.slug}--hover.png`),
              fullPage: false,
            });
          }
        }

        const base = {
          slug: auditCase.slug,
          viewport: vp.name,
          path: auditCase.path,
          route: auditCase.route,
          consoleErrors,
          blueColors,
          hoverViolations,
          hoverFailures,
          readableChars,
          quality,
          qualityIssues,
        };
        const finding: CloudPageFinding = {
          ...base,
          verdict: computeCloudVerdict(base),
        };
        findings.push(finding);
        const perSlug = findingsBySlug.get(auditCase.slug) ?? [];
        perSlug.push(finding);
        findingsBySlug.set(auditCase.slug, perSlug);
        await writeFile(
          path.join(reviewDir, `${auditCase.slug}.md`),
          renderManualReviewStub(perSlug),
          "utf8",
        );

        // Only a real crash fails the walk; design findings live in the report.
        expect(
          pageErrors,
          `${auditCase.slug} ${vp.name} must not throw an uncaught page error`,
        ).toEqual([]);
      });
    }
  }

  test.afterAll(async () => {
    if (findings.length === 0) return;
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      path.join(outputDir, "report.json"),
      JSON.stringify(findings, null, 2),
      "utf8",
    );
    const rows = findings
      .map(
        (f) =>
          `<tr><td>${f.slug}</td><td>${f.viewport}</td><td>${f.verdict}</td>` +
          `<td>${f.consoleErrors.length}</td><td>${f.blueColors.length}</td>` +
          `<td>${f.hoverViolations.length}${f.hoverFailures.length ? ` (+${f.hoverFailures.length} probe-failed)` : ""}</td>` +
          `<td>${f.readableChars}</td>` +
          `<td><a href="${f.viewport}/${f.slug}.png">rest</a> <a href="${f.viewport}/${f.slug}--hover.png">hover</a></td></tr>`,
      )
      .join("\n");
    await writeFile(
      path.join(outputDir, "contact-sheet.html"),
      `<!doctype html><meta charset="utf-8"><title>cloud aesthetic audit</title>` +
        `<table border="1" cellpadding="6"><tr><th>page</th><th>viewport</th>` +
        `<th>verdict</th><th>console</th><th>blue</th><th>hover</th>` +
        `<th>chars</th><th>shots</th></tr>${rows}</table>`,
      "utf8",
    );
    const broken = findings.filter((f) => f.verdict === "broken");
    const needsWork = findings.filter((f) => f.verdict === "needs-work");
    console.log(
      `[cloud-aesthetic-audit] ${findings.length} findings — ` +
        `broken=${broken.length} needs-work=${needsWork.length} ` +
        `needs-eyeball=${findings.filter((f) => f.verdict === "needs-eyeball").length} ` +
        `good=${findings.filter((f) => f.verdict === "good").length}`,
    );
  });
});
