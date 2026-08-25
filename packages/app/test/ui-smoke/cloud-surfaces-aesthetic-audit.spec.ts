/**
 * Playwright UI-smoke spec for the Cloud Surfaces Aesthetic Audit app flow
 * using the real renderer fixture.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  type AestheticVerdictDebt,
  evaluateStrictGate,
  readReadableCharsWithNavigationRetry,
} from "./aesthetic-audit-rules";
import { openAppPath } from "./helpers";
import {
  collectBlueColors,
  collectHoverViolations,
} from "./helpers/brand-color-scans";
import {
  BILLING_AUDIT_RESOURCE_EXPECTATIONS,
  installCloudApiStubs,
  seedStewardToken,
} from "./helpers/cloud-audit-fixtures";
import {
  analyzeScreenshot,
  type ScreenshotQuality,
  screenshotQualityIssues,
} from "./helpers/screenshot-quality";

/**
 * Cloud-surface aesthetic audit (#10725 / #11342) — the audit:app equivalent
 * for the app-hosted Eliza Cloud surfaces. `audit:app` walks the tab/view app
 * (builtin tabs + plugin views) but never enters the CloudRouterShell route
 * space, so the cloud surfaces registered in
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
 *    the flag, normal Steward-gated routes authenticate from the persisted
 *    token this spec seeds, and app-auth/authorize uses its local test-auth
 *    adapter to render the signed-in consent state without the live Steward
 *    SDK provider.
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

// Strict gate (#13624), mirroring the app audit (#9304/#10710). Without this the
// cloud audit was a pure reporter — a `broken`/`needs-work` cloud page failed
// nothing, and a turbo-cached renderer built WITHOUT the test-auth shell made
// the whole suite skip green with ZERO pages walked. Under strict the audit is a
// GATE: an undebted `broken` view fails; with the opt-in needs-work extension an
// undebted `needs-work` fails too; a missing auth-shell or an empty walk is a
// HARD FAILURE, not a skip.
const AUDIT_CLOUD_STRICT = process.env.ELIZA_AUDIT_CLOUD_STRICT === "1";
const AUDIT_CLOUD_STRICT_NEEDS_WORK =
  process.env.ELIZA_AUDIT_CLOUD_STRICT_NEEDS_WORK === "1";
// When true, the audit must not silently no-op: a dist without the baked
// test-auth shell, or a run that walks zero pages, reddens instead of skipping.
// Auto-on under CI so no lane can go green with nothing.
const REQUIRE_CLOUD_EVIDENCE =
  AUDIT_CLOUD_STRICT || process.env.CI === "true" || process.env.CI === "1";
// The (currently empty) allowlist for tolerated cloud aesthetic debt: a
// `slug-viewport` key set to `broken`/`needs-work` exempts that view. Shrink it
// over time; a NEW regression on an undebted view fails the run.
const CLOUD_AESTHETIC_VERDICT_DEBT: AestheticVerdictDebt = {};

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
  /** Seed the persisted Steward token before boot (authed cloud pages). */
  auth: boolean;
  /** Capture the complete scroll surface when this route has reviewable content below the fold. */
  fullPageEvidence?: boolean;
  /**
   * Routes that always redirect on localhost (role-gated, environment-bound)
   * cannot be visually inspected in this harness. Instead of recording a
   * misleading screenshot of the redirect destination as if it were the
   * source surface, assert the final URL matches this pattern — proving the
   * redirect fired to the designed end state, not that a different surface
   * rendered its content.
   */
  expectedFinalPath?: RegExp;
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
  // home/
  {
    slug: "cloud",
    path: "/cloud",
    route: "cloud",
    auth: AUTH,
  },
  // instances/
  {
    slug: "cloud-agents",
    path: "/cloud/agents",
    route: "cloud/agents",
    auth: AUTH,
  },
  {
    slug: "cloud-agents-detail",
    path: "/cloud/agents/agent-smoke-1",
    route: "cloud/agents/:id",
    auth: AUTH,
  },
  {
    slug: "cloud-my-agents",
    path: "/cloud/my-agents",
    route: "cloud/my-agents",
    auth: AUTH,
  },
  // analytics/
  {
    slug: "cloud-analytics",
    path: "/cloud/analytics",
    route: "cloud/analytics",
    auth: AUTH,
  },
  // billing/
  {
    slug: "cloud-billing",
    path: "/cloud/billing",
    route: "cloud/billing",
    auth: AUTH,
  },
  {
    slug: "cloud-billing-success",
    path: "/cloud/billing/success",
    route: "cloud/billing/success",
    auth: AUTH,
  },
  {
    slug: "cloud-invoice-detail",
    path: "/cloud/invoices/invoice-smoke-1",
    route: "cloud/invoices/:id",
    auth: AUTH,
  },
  // organization/
  {
    slug: "cloud-organization",
    path: "/cloud/organization",
    route: "cloud/organization",
    auth: AUTH,
  },
  // account-security/
  {
    slug: "cloud-account",
    path: "/cloud/account",
    route: "cloud/account",
    auth: AUTH,
  },
  {
    slug: "cloud-security",
    path: "/cloud/security",
    route: "cloud/security",
    auth: AUTH,
  },
  {
    slug: "cloud-security-permissions",
    path: "/cloud/security/permissions",
    route: "cloud/security/permissions",
    auth: AUTH,
  },
  // join/ — signed-out /join redirects to /login (audited separately), so
  // audit the signed-in flow; agent provisioning POSTs fall through to the
  // stub backend's 501, landing on the designed "couldn't connect" error card.
  { slug: "join", path: "/join", route: "join", auth: AUTH },
  // get-started/ — a continuation token is required to exercise the real
  // messaging handoff page instead of its missing-token redirect.
  {
    slug: "get-started-confirm",
    path: "/get-started?onboardingSession=audit-continuation-token",
    route: "get-started",
    auth: AUTH,
  },
  {
    slug: "get-started-success",
    path: "/get-started?onboardingSession=audit-continuation-token",
    route: "get-started",
    auth: AUTH,
  },
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
    // PaymentSuccessPage renders a brief "Payment Received" confirmation then
    // redirects to /cloud/settings?tab=billing&payment=success. A
    // LegacySettingsTabRedirect in CloudRouterShell then rewrites that to
    // /cloud/billing (the standalone billing page). Both redirects fire
    // before the audit's settle delay + screenshot, so without expectedFinalPath
    // the probe suite screenshots the billing page and mislabels its measurements
    // as payment-success coverage. Treat this as a redirect-only reachability
    // check (same pattern as auth-bridge): assert the terminal redirect path,
    // then skip aesthetic collection.
    auth: AUTH,
    expectedFinalPath: /^\/cloud\/billing$/,
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
    // Public route without a backend-confirmed connection — captures the
    // explicit unverified recovery state (#18054).
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
  // auth/bridge — the SSO handshake route is hostname-role-gated. On localhost
  // (the Playwright harness) ssoBridgeRoleForHostname returns "none", so
  // SsoBridgeRoute renders <Navigate to="/" replace> immediately. This case
  // does NOT visually inspect the bridge surface — that requires a deployed
  // bridge hostname or test-only hostname injection. Instead it asserts the
  // designed localhost redirect fired, proving the route is reachable and
  // wired (not 404/blank). The mint/exchange failure states are covered by
  // focused component tests (SsoBridgeRoute.test.tsx), not this visual walk.
  {
    slug: "auth-bridge",
    path: "/auth/bridge",
    route: "auth/bridge",
    auth: PUBLIC,
    expectedFinalPath: /^\/?$/,
  },
  // oidc/continue — the OIDC sign-in bounce target. Without a `rid` param
  // buildOidcResumeTarget returns "invalid_request_id" on any host; the page
  // renders a readable "sign-in request is no longer valid" message without
  // redirecting.
  {
    slug: "oidc-continue",
    path: "/oidc/continue",
    route: "oidc/continue",
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
  {
    slug: "account-deletion",
    path: "/account-deletion?requested=untrusted-audit-receipt",
    route: "account-deletion",
    auth: AUTH,
    fullPageEvidence: true,
  },
  { slug: "bsc", path: "/bsc", route: "bsc", auth: PUBLIC },
  // api-explorer/
  {
    slug: "cloud-api-explorer",
    path: "/cloud/api-explorer",
    route: "cloud/api-explorer",
    auth: AUTH,
  },
  // api-keys/
  {
    slug: "cloud-api-keys",
    path: "/cloud/api-keys",
    route: "cloud/api-keys",
    auth: AUTH,
  },
  // monetization/
  {
    slug: "cloud-monetization",
    path: "/cloud/monetization",
    route: "cloud/monetization",
    auth: AUTH,
  },
  // connectors/
  {
    slug: "cloud-connectors",
    path: "/cloud/connectors",
    route: "cloud/connectors",
    auth: AUTH,
  },
  // applications/
  {
    slug: "cloud-apps",
    path: "/cloud/apps",
    route: "cloud/apps",
    auth: AUTH,
  },
  {
    // ApplicationDetailPage redirects unless :id is a valid UUID.
    slug: "cloud-apps-detail",
    path: "/cloud/apps/6f9619ff-8b86-4d01-b42d-00c04fc964ff",
    route: "cloud/apps/:id",
    auth: AUTH,
  },
  {
    slug: "cloud-applications-legacy",
    path: "/cloud/applications",
    route: "cloud/applications",
    auth: AUTH,
  },
  {
    slug: "cloud-applications-detail-legacy",
    path: "/cloud/applications/6f9619ff-8b86-4d01-b42d-00c04fc964ff",
    route: "cloud/applications/:id",
    auth: AUTH,
  },
  // approvals/
  {
    slug: "cloud-approvals",
    path: "/cloud/approvals",
    route: "cloud/approvals",
    auth: AUTH,
  },
  // admin/
  {
    slug: "cloud-admin",
    path: "/cloud/admin",
    route: "cloud/admin",
    auth: AUTH,
  },
  {
    slug: "cloud-admin-redemptions",
    path: "/cloud/admin/redemptions",
    route: "cloud/admin/redemptions",
    auth: AUTH,
  },
  {
    slug: "cloud-admin-rpc-status",
    path: "/cloud/admin/rpc-status",
    route: "cloud/admin/rpc-status",
    auth: AUTH,
  },
  // mcps/
  {
    slug: "cloud-mcps",
    path: "/cloud/mcps",
    route: "cloud/mcps",
    auth: AUTH,
  },
];

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
  if (first.slug === "cloud-billing") {
    lines.push(
      "## Paired hover evidence",
      "",
      "- The Active compute card is read-only, so its rest/hover screenshots are a paired stability proof: hovering a resource must not change or hide server-owned billing values.",
      "- The page-wide orange-button hover scan still runs independently before this component-focused pair is captured.",
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
  // Hard gate (#13624): under strict/CI the running renderer bundle MUST contain
  // the test-auth shell. A stale turbo-cached `build:web` (built without
  // VITE_PLAYWRIGHT_TEST_AUTH) leaves the runtime env set but the shell absent —
  // every authed route bounces to /login and the audit used to skip green. This
  // test seeds a Steward token, visits an authed route, and reddens if we were
  // bounced to the login wall (dist lacks the shell) or the runtime flag is off.
  test("renderer dist was built with the test-auth shell", async ({ page }) => {
    test.skip(
      !REQUIRE_CLOUD_EVIDENCE,
      "auth-shell hard gate only enforced under ELIZA_AUDIT_CLOUD_STRICT / CI",
    );
    expect(
      TEST_AUTH_ENABLED,
      "audit:cloud (strict/CI) requires VITE_PLAYWRIGHT_TEST_AUTH=true baked into the renderer build",
    ).toBe(true);
    await seedStewardToken(page);
    await installCloudApiStubs(page);
    await page.goto("/cloud/agents", { waitUntil: "domcontentloaded" });
    // Give StewardProvider a beat to resolve the seeded session (or bounce).
    await page.waitForTimeout(1_500);
    expect(
      page.url(),
      "authed route bounced to /login — the renderer dist lacks the test-auth " +
        "shell (stale turbo cache built without VITE_PLAYWRIGHT_TEST_AUTH). " +
        "Force a clean `build:web` with the flag set.",
    ).not.toMatch(/\/login(\?|#|$)/);
  });

  const outputDir =
    process.env.ELIZA_AUDIT_CLOUD_DIR ??
    path.join(process.cwd(), "aesthetic-audit-output-cloud");

  test.beforeAll(() => {
    expect(
      TEST_AUTH_ENABLED,
      "audit:cloud requires VITE_PLAYWRIGHT_TEST_AUTH=true baked into the renderer build so StewardProvider renders the local test-auth shell",
    ).toBe(true);
  });

  // Coverage guard: every registered cloud route must appear in the audit
  // table, so a newly-registered surface fails the audit until it is walked.
  // The registry is read from the RUNNING production bundle (the same
  // Symbol.for-keyed global store cloud-route-registry.ts uses) — importing
  // the domain tree under node breaks on extensionless ESM subpath imports
  // (react-syntax-highlighter prism styles).
  test("coverage matches the registered cloud routes", async ({ page }) => {
    await seedStewardToken(page);
    await installCloudApiStubs(page);
    await page.goto("/cloud/agents", { waitUntil: "domcontentloaded" });
    const readRegistryPaths = async () => {
      try {
        return await page.evaluate(() => {
          const store = (globalThis as unknown as Record<symbol, unknown>)[
            Symbol.for("elizaos.ui.cloud-route-registry")
          ] as { entries: Map<string, unknown> } | undefined;
          return store ? [...store.entries.keys()] : [];
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("Execution context was destroyed")
        ) {
          return [];
        }
        throw error;
      }
    };
    let registeredPaths = await readRegistryPaths();
    const auditedRoutes = CLOUD_AUDIT_CASES.map((auditCase) => auditCase.route);
    await expect
      .poll(
        async () => {
          registeredPaths = await readRegistryPaths();
          return auditedRoutes.every((route) =>
            registeredPaths.includes(route),
          );
        },
        {
          message:
            "complete cloud-route registry populated by the running shell",
          // Match the audit's cold-start budget: the production renderer can
          // still be compiling/loading its private route chunks after DOMContentLoaded.
          timeout: 120_000,
        },
      )
      .toBe(true);
    const registered = new Set(registeredPaths);
    const audited = new Set(auditedRoutes);
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
        if (auditCase.slug.startsWith("get-started-")) {
          await page.route(
            "**/api/eliza-app/onboarding/chat**",
            async (route) => {
              const request = route.request();
              if (request.method() === "GET") {
                await route.fulfill({
                  status: 200,
                  contentType: "application/json",
                  body: JSON.stringify({
                    success: true,
                    data: {
                      platform: "blooio",
                      platformUserId: "+14155550123",
                      platformDisplayName: "+14155550123",
                      returnUrl: "sms:+18087881821",
                    },
                  }),
                });
                return;
              }
              await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                  success: true,
                  data: {
                    sessionId: "audit-continuation-token",
                    requiresLogin: false,
                  },
                }),
              });
            },
          );
        }
        if (auditCase.slug === "join") {
          await page.route("**/api/cloud/compat/agents**", async (route) => {
            await route.fulfill({
              status: 402,
              contentType: "application/json",
              body: JSON.stringify({
                success: false,
                code: "insufficient_credits",
                error:
                  "Welcome credit unavailable because this network reached the daily free-credit limit. Add funds to start an agent.",
                requiredBalance: 0.1,
                currentBalance: 0,
                welcomeBonusWithheld: true,
                welcomeBonusWithheldReason: "ip_daily_cap",
              }),
            });
          });
        }
        // The static preboot and StartupScreen copy are not route readiness.
        // Reuse the shared bounded startup contract so a cold "Booting up..."
        // splash cannot satisfy the readable-character gate and pass green.
        await openAppPath(page, auditCase.path);

        const billingEvidenceTarget =
          auditCase.slug === "cloud-billing"
            ? page
                .getByRole("heading", { name: "Active compute", exact: true })
                .locator(
                  "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' bg-bg-elevated ')][1]",
                )
            : null;

        if (auditCase.slug === "cloud-agents") {
          // The loading skeleton has readable column labels, so the generic
          // paint gate cannot prove the canonical list DTO was accepted.
          await expect(
            page.getByRole("link", { name: "Smoke Agent" }).filter({
              visible: true,
            }),
          ).toBeVisible({ timeout: 10_000 });
        }

        if (auditCase.slug === "cloud-billing") {
          // The generic readable-text gate also accepts BillingTab's error
          // state. Prove every counterfactual resource value reached its own
          // card and stayed paired with the correct server-owned field. A
          // resourceType -> interval inference or next/estimated cursor swap
          // therefore fails this gate even when all strings exist globally.
          if (!billingEvidenceTarget) {
            throw new Error("Active compute audit target was not initialized");
          }
          for (const resource of BILLING_AUDIT_RESOURCE_EXPECTATIONS) {
            const resourceCard = billingEvidenceTarget.locator("li").filter({
              has: page.getByText(resource.name, { exact: true }),
            });
            await expect(resourceCard).toHaveCount(1);
            await expect(resourceCard).toBeVisible({ timeout: 10_000 });
            await expect(
              resourceCard.getByText(resource.identity, { exact: true }),
            ).toBeVisible();

            for (const field of resource.fields) {
              const term = resourceCard.getByText(field.label, { exact: true });
              await expect(term).toHaveCount(1);
              await expect(
                term.locator("xpath=following-sibling::dd[1]"),
              ).toHaveText(field.value);
            }
          }
        }

        if (auditCase.slug === "get-started-success") {
          await page
            .getByRole("button", { name: "Connect this iMessage account" })
            .click();
          await expect(
            page.getByRole("link", { name: "Back to iMessage" }),
          ).toHaveAttribute("href", "sms:+18087881821");
        }

        // Routes with expectedFinalPath always redirect on localhost (the
        // harness hostname is 127.0.0.1). Assert the final URL matches the
        // designed end state so the audit proves reachability without claiming
        // visual coverage of a surface it cannot render here.
        //
        // Redirect-only reachability: once the redirect is proven, skip the
        // full aesthetic probe suite (readable-text, screenshot, color-buckets,
        // hover) and do NOT publish a CloudPageFinding under this route's slug.
        // The coverage gate keys off case existence in CLOUD_AUDIT_CASES
        // (verified in the registry-sync test above), not off a findings
        // entry, so reachability is proven and the route is counted as audited
        // without falsely attributing the redirect destination's homepage
        // aesthetics to this route's slug. Surface-specific coverage for the
        // bridge is provided by focused component tests (SsoBridgeRoute.test.tsx).
        if (auditCase.expectedFinalPath) {
          await expect
            .poll(async () => new URL(page.url()).pathname, {
              message: `${auditCase.slug} redirected to its designed end state`,
              timeout: 10_000,
            })
            .toMatch(auditCase.expectedFinalPath);
          return;
        }

        // Wait for the page to actually paint text (lazy route chunk +
        // react-query settle). Non-fatal: a page that never paints is recorded
        // as a `broken` finding, not a walk abort.
        const readPaint = async (): Promise<number> =>
          page.evaluate(
            () => document.body.innerText.trim().replace(/\s+/g, " ").length,
          );
        const readPaintAfterNavigation = (minimumReadableChars = 0) =>
          readReadableCharsWithNavigationRetry(
            readPaint,
            (delayMs) => page.waitForTimeout(delayMs),
            { minimumReadableChars },
          );
        let readableChars = await readPaintAfterNavigation();
        for (
          let attempt = 0;
          attempt < 15 && readableChars < 10;
          attempt += 1
        ) {
          await page.waitForTimeout(1000);
          readableChars = await readPaintAfterNavigation();
        }
        // Let late skeleton → content transitions settle before sampling.
        await page.waitForTimeout(750);
        readableChars = await readPaintAfterNavigation(10);

        const restPath = path.join(shotDir, `${auditCase.slug}.png`);
        const fullPage = auditCase.fullPageEvidence ?? false;
        if (fullPage) {
          const scrollRegion = page
            .locator("[data-scroll-cert-scroller]")
            .first();
          await expect(scrollRegion).toHaveCount(1);
          const scrollMetrics = await scrollRegion.evaluate((element) => ({
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
          }));
          if (scrollMetrics.scrollHeight > scrollMetrics.clientHeight) {
            await scrollRegion.evaluate((element) => {
              element.scrollTop = element.scrollHeight;
            });
            expect(
              await scrollRegion.evaluate((element) => element.scrollTop),
              `${auditCase.slug} owns a working vertical scroll region`,
            ).toBeGreaterThan(0);
            await scrollRegion.evaluate((element) => {
              element.scrollTop = 0;
            });
          }
          await page.setViewportSize({
            width: vp.width,
            height: Math.ceil(scrollMetrics.scrollHeight),
          });
          await page.waitForTimeout(100);
        }
        // Billing's server-authoritative resource fields sit below the initial
        // viewport inside an app-owned scroll container. Capture the complete
        // Active Compute card in both states instead of green-lighting a frame
        // that only shows the unrelated credit form above it.
        if (billingEvidenceTarget) {
          const box = await billingEvidenceTarget.boundingBox();
          if (box && box.height + 240 > vp.height) {
            await page.setViewportSize({
              width: vp.width,
              height: Math.ceil(box.height) + 240,
            });
            await billingEvidenceTarget.evaluate((element) =>
              element.scrollIntoView({ block: "start", inline: "nearest" }),
            );
          }
        }
        const captureEvidence = (targetPath: string) =>
          billingEvidenceTarget
            ? billingEvidenceTarget.screenshot({ path: targetPath })
            : page.screenshot({ path: targetPath, fullPage });
        let buffer = await captureEvidence(restPath);
        let quality = await analyzeScreenshot(buffer).catch(() => null);
        for (
          let attempt = 0;
          attempt < 3 && quality && quality.colorBuckets <= 1;
          attempt += 1
        ) {
          await page.waitForTimeout(800);
          buffer = await captureEvidence(restPath);
          quality = await analyzeScreenshot(buffer).catch(() => null);
        }
        const qualityIssues = quality
          ? screenshotQualityIssues(`${auditCase.slug} ${vp.name}`, quality)
          : [];

        const blueColors = await collectBlueColors(page).catch(() => []);
        // This global scan remains the interactive hover gate for every
        // visible orange action on the full page. Billing's component-focused
        // screenshot pair below is additive; it does not replace this scan.
        const { violations: hoverViolations, hoverFailures } =
          await collectHoverViolations(page).catch((error: unknown) => ({
            violations: [],
            hoverFailures: [
              `hover scan failed: ${(error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 120)}`,
            ],
          }));

        // Primary-button hover screenshot (the #10725 hover-rule artifact).
        // The read-only compute card has no action, so hover its first resource
        // and capture the same complete card. Its rest/hover pair proves that
        // pointer presence cannot mutate, hide, or reflow authoritative values;
        // it is explicitly a stability artifact, not an interaction claim.
        const hoverTarget = billingEvidenceTarget
          ? billingEvidenceTarget.locator("li").first()
          : page.locator("button:visible, a[role='button']:visible").first();
        if (await hoverTarget.isVisible().catch(() => false)) {
          const hovered = await hoverTarget
            .hover({ timeout: 2000 })
            .then(() => true)
            .catch(() => false);
          if (hovered) {
            await captureEvidence(
              path.join(shotDir, `${auditCase.slug}--hover.png`),
            );
          }
        }

        const base = {
          slug: auditCase.slug,
          viewport: vp.name,
          path: auditCase.path,
          route: auditCase.route,
          // Uncaught page errors are the hardest crash signal — surface them
          // in the finding alongside console errors.
          consoleErrors: [
            ...pageErrors.map((message) => `pageerror: ${message}`),
            ...consoleErrors,
          ],
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
    if (findings.length === 0) {
      // Green-with-nothing guard (#13624): under strict/CI a walk that produced
      // zero findings means the audit no-opped (skipped auth shell, cached dist,
      // etc.) — that must redden, not pass silently.
      if (REQUIRE_CLOUD_EVIDENCE) {
        throw new Error(
          "[cloud-aesthetic-audit] STRICT/CI run walked ZERO cloud pages — the " +
            "audit produced no findings. This is the green-with-nothing hole: the " +
            "renderer likely lacks the test-auth shell (stale turbo-cached " +
            "build:web without VITE_PLAYWRIGHT_TEST_AUTH). Rebuild the renderer " +
            "with the flag set and re-run.",
        );
      }
      return;
    }
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
    // Strict gate (#13624): fail on any undebted `broken` (a real crash / blank
    // render / console error) and, with the opt-in needs-work extension, any
    // undebted `needs-work` (blue / orange-hover design regression). The pure
    // evaluateStrictGate is unit-tested; here we just thread the flags + throw.
    const gate = evaluateStrictGate(findings, CLOUD_AESTHETIC_VERDICT_DEBT, {
      strict: AUDIT_CLOUD_STRICT,
      needsWorkStrict: AUDIT_CLOUD_STRICT_NEEDS_WORK,
    });
    console.log(
      `[cloud-aesthetic-audit] ${findings.length} findings — ` +
        `broken=${broken.length} needs-work=${needsWork.length} ` +
        `needs-eyeball=${findings.filter((f) => f.verdict === "needs-eyeball").length} ` +
        `good=${findings.filter((f) => f.verdict === "good").length} ` +
        `(strict=${AUDIT_CLOUD_STRICT}, needs-work-strict=${AUDIT_CLOUD_STRICT_NEEDS_WORK}, ` +
        `undebted-broken=${gate.undebtedBroken.length}, ` +
        `undebted-needs-work=${gate.undebtedNeedsWork.length})`,
    );
    if (gate.failed) {
      throw new Error(gate.message);
    }
  });
});
