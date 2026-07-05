/**
 * Focused contrast proof for the Applications dropdown/select popovers (#14232).
 *
 * The broad cloud aesthetic audit (cloud-surfaces-aesthetic-audit.spec.ts)
 * walks every registered cloud route at desktop + mobile but only captures the
 * rest + primary-button-hover states — it never OPENS the touched
 * `SelectContent` popovers, so the flagged dropdown surface was never actually
 * rendered as proof.
 *
 * IMPORTANT theme note: the Applications/MCPs page bodies render inside
 * `CloudRouterShell`'s `theme-cloud` surface (dark cloud console). The Radix
 * SelectContent, however, PORTALS to document.body — outside that wrapper — so
 * the opened popover resolves its `bg-card`/`text-txt` tokens against the ROOT
 * app theme (`eliza:ui-theme-mode`). The real correctness invariant is
 * therefore: the opened popover must be OPAQUE (not the transparent
 * `bg-popover`/undefined-`--popover` regression) AND its background must
 * CONTRAST with its own text so the menu items are readable — in whichever
 * root theme is active. This spec opens the select in both app theme modes and
 * checks opacity + a real bg/text contrast delta, not a fixed light/dark value.
 *
 * This surfaced a real regression: #14236 retokenized the popovers
 * `bg-neutral-800` -> `bg-popover`, but `--popover` is UNDEFINED in the entire
 * UI token set (grep the built CSS: no `--popover:` anywhere), so `bg-popover`
 * resolves to `background: var(--popover)` == transparent `rgba(0,0,0,0)`. The
 * fix retokenizes to `bg-card` (defined `= brand-black` under theme-cloud),
 * matching the SelectTrigger and every sibling working cloud dropdown
 * (EarningsPageClient, create-eliza-agent-dialog, eliza-agents-table...).
 *
 * It reuses the SAME auth seeding + API stub surface as the cloud audit
 * (helpers/cloud-audit-fixtures) so ApplicationDetailPage reaches its real
 * analytics/earnings tab instead of the session-not-ready loading spinner.
 *
 * Output: aesthetic-audit-output-cloud/applications-dropdown/<mode>/<slug>.png
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  installCloudApiStubs,
  SMOKE_APP_UUID,
  seedStewardToken,
} from "./helpers/cloud-audit-fixtures";

// The app resolves light/dark from `eliza:ui-theme-mode` (values light | dark |
// system) and applies it as CSS variables on documentElement.style via
// applyThemeToDocument (NOT a `light`/`dark` class). See
// packages/ui/src/state/persistence.ts + themes/apply-theme.ts.
const THEME_MODE_STORAGE_KEY = "eliza:ui-theme-mode";

const OUTPUT_ROOT = path.join(
  process.env.ELIZA_AUDIT_CLOUD_DIR ??
    path.join(process.cwd(), "aesthetic-audit-output-cloud"),
  "applications-dropdown",
);

type Theme = "light" | "dark";
const THEMES: Theme[] = ["light", "dark"];

// The two touched Applications surfaces, keyed by deep-link tab param. Each
// renders a shadcn Select whose SelectContent popover was the flagged hard-dark
// `bg-neutral-800` surface (now semantic `bg-popover`).
const SELECT_SURFACES = [
  {
    slug: "app-analytics-range-select",
    tab: "analytics",
    label: "analytics time-range select",
  },
  {
    slug: "app-earnings-range-select",
    tab: "earnings",
    label: "earnings range select",
  },
] as const;

// App-detail analytics/earnings endpoints are app-specific and not part of the
// shared cloud-audit stub set (the audit only visits the app-detail OVERVIEW
// tab). Register them BEFORE the shared catch-all so the analytics/earnings tabs
// leave their loading/error state and render the range Select. Shapes traced
// from app-analytics.tsx / app-earnings-dashboard.tsx response types.
async function installAppDetailTabStubs(page: Page): Promise<void> {
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  await page.route(`**/api/v1/apps/${SMOKE_APP_UUID}/analytics**`, (route) =>
    route.fulfill(
      json({
        success: true,
        data: {
          totals: { requests: 0, users: 0, errors: 0 },
          series: [],
          requests: [],
          stats: {},
          visitors: [],
          sessions: [],
          logs: [],
        },
      }),
    ),
  );
  const breakdownPeriod = (period: string) => ({
    period,
    inferenceEarnings: 0,
    purchaseEarnings: 0,
    total: 0,
  });
  await page.route(`**/api/v1/apps/${SMOKE_APP_UUID}/earnings**`, (route) =>
    route.fulfill(
      // Shape traced from EarningsResponse in app-earnings-dashboard.tsx: a
      // wrong shape sends the component into its early-return error state and
      // the range Select never renders.
      json({
        success: true,
        testData: false,
        monetization: { enabled: true },
        earnings: {
          summary: {
            totalLifetimeEarnings: 0,
            totalInferenceEarnings: 0,
            totalPurchaseEarnings: 0,
            pendingBalance: 0,
            withdrawableBalance: 0,
            totalWithdrawn: 0,
            payoutThreshold: 50,
          },
          breakdown: {
            today: breakdownPeriod("today"),
            thisWeek: breakdownPeriod("thisWeek"),
            thisMonth: breakdownPeriod("thisMonth"),
            allTime: breakdownPeriod("allTime"),
          },
          chartData: [],
          recentTransactions: [],
        },
      }),
    ),
  );
}

async function seedTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, value);
    },
    { key: THEME_MODE_STORAGE_KEY, value: theme },
  );
  // Belt-and-suspenders: pin the OS preference so any `system` fallback resolves
  // to the same theme as the explicit storage value.
  await page.emulateMedia({ colorScheme: theme });
}

function parseRgbLuminance(value: string): number | null {
  const m = value.match(/rgba?\(([^)]+)\)/);
  let r: number;
  let g: number;
  let b: number;
  if (m) {
    [r, g, b] = m[1]
      .split(",")
      .slice(0, 3)
      .map((v) => Number(v.trim()));
  } else if (value.startsWith("#")) {
    const hex = value.slice(1);
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((c) => c + c)
            .join("")
        : hex;
    r = parseInt(full.slice(0, 2), 16);
    g = parseInt(full.slice(2, 4), 16);
    b = parseInt(full.slice(4, 6), 16);
  } else {
    return null;
  }
  if ([r, g, b].some((n) => Number.isNaN(n))) return null;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

async function waitForPaint(page: Page): Promise<void> {
  const readPaint = async (): Promise<number> =>
    page
      .evaluate(
        () => document.body.innerText.trim().replace(/\s+/g, " ").length,
      )
      .catch(() => 0);
  let readable = await readPaint();
  for (let attempt = 0; attempt < 15 && readable < 10; attempt += 1) {
    await page.waitForTimeout(1000);
    readable = await readPaint();
  }
  await page.waitForTimeout(750);
}

for (const theme of THEMES) {
  for (const surface of SELECT_SURFACES) {
    test(`applications dropdown contrast: ${surface.slug} (${theme})`, async ({
      page,
    }) => {
      const shotDir = path.join(OUTPUT_ROOT, theme);
      await mkdir(shotDir, { recursive: true });

      await seedTheme(page, theme);
      await seedStewardToken(page);
      // Order matters: the app-detail tab stubs must register before the shared
      // catch-all `**/api/**` route so they win for the analytics/earnings
      // endpoints (Playwright matches later-registered routes first).
      await installCloudApiStubs(page);
      await installAppDetailTabStubs(page);

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/dashboard/apps/${SMOKE_APP_UUID}?tab=${surface.tab}`, {
        waitUntil: "domcontentloaded",
      });
      await waitForPaint(page);

      // Wait for the app-detail route to leave its session-not-ready /
      // isLoading spinner and paint the real tab (a `role=tab` or the Select
      // trigger). Non-fatal: a page that never paints is still screenshotted.
      await page
        .locator("[role='tab'], [role='combobox']")
        .first()
        .waitFor({ state: "visible", timeout: 15000 })
        .catch(() => {});

      // Rest state (popover closed) — the tab surface in this app theme mode.
      // (The cloud console surface itself stays theme-cloud dark regardless.)
      await page.screenshot({
        path: path.join(shotDir, `${surface.slug}--rest.png`),
        fullPage: false,
      });

      // Open the Select popover (the touched `bg-popover` surface). shadcn
      // Select triggers are `role=combobox`; the popover content is
      // `role=listbox`.
      const trigger = page.locator("[role='combobox']").first();
      const triggerVisible = await trigger.isVisible().catch(() => false);
      expect(
        triggerVisible,
        `expected the ${surface.label} (role=combobox) to render on the ${surface.tab} tab`,
      ).toBe(true);

      await trigger.click();
      const listbox = page.locator("[role='listbox']").first();
      await listbox.waitFor({ state: "visible", timeout: 4000 });
      await page.waitForTimeout(300);
      await page.screenshot({
        path: path.join(shotDir, `${surface.slug}--open.png`),
        fullPage: false,
      });

      // Assert the OPEN popover is an OPAQUE surface (not the transparent
      // `bg-popover`/undefined-`--popover` regression from #14236) AND that its
      // background contrasts with its own menu-item text so items are readable.
      const { bg: listboxBg, fg: listboxFg } = await listbox
        .evaluate((el) => {
          const s = getComputedStyle(el);
          // Prefer a real menu item's text color; fall back to the content's.
          const item = el.querySelector(
            "[role='option']",
          ) as HTMLElement | null;
          const fg = item ? getComputedStyle(item).color : s.color;
          return { bg: s.backgroundColor, fg };
        })
        .catch(() => ({ bg: "", fg: "" }));

      const alphaMatch = listboxBg.match(/rgba\([^)]*,\s*([\d.]+)\s*\)/);
      const alpha = alphaMatch ? Number(alphaMatch[1]) : 1;
      expect(
        alpha,
        `${surface.label} popover must be opaque, got "${listboxBg}" (alpha=${alpha}) — a transparent bg-popover (undefined --popover token) regression`,
      ).toBeGreaterThan(0.9);

      const bgLum = parseRgbLuminance(listboxBg);
      const fgLum = parseRgbLuminance(listboxFg);
      if (bgLum !== null && fgLum !== null) {
        const delta = Math.abs(bgLum - fgLum);
        expect(
          delta,
          `${surface.label} popover text must contrast its background (readable menu items), bg="${listboxBg}" (lum ${bgLum.toFixed(0)}) fg="${listboxFg}" (lum ${fgLum.toFixed(0)}) delta=${delta.toFixed(0)}`,
        ).toBeGreaterThan(90);
      }
    });
  }
}
