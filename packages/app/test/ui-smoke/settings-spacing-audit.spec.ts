// Settings SPACING + SAFE-AREA audit. Unlike settings-audit-capture (which just
// screenshots), this spec *measures* layout: it injects a simulated device
// safe-area inset (so the browser behaves like a notched phone), then for every
// settings section records the gap between the status-bar safe area and the
// first content, the page's horizontal insets, and the vertical rhythm between
// groups/rows. Each section gets a programmatic verdict (ok / too-tight /
// too-loose / violates-safe-area / inconsistent) written to a JSON report, plus
// a screenshot taken WITH the simulated notch so the safe-area behavior is
// visible. Developer mode is seeded on so dev-only sections render too.
//
// Run on demand:  ELIZA_SETTINGS_SPACING=1 node scripts/run-ui-playwright.mjs \
//   --config playwright.ui-smoke.config.ts test/ui-smoke/settings-spacing-audit.spec.ts

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, test } from "@playwright/test";
import {
  SETTINGS_SECTIONS,
  VIEWPORT_SIZES,
} from "../../../../scripts/ai-qa/route-catalog.ts";
import {
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const OUT_DIR = resolve(REPO_ROOT, "reports", "settings-spacing");

// Simulated device insets (iPhone 15-ish): Dynamic Island top, home-indicator
// bottom. The settings shell reserves the top via `var(--safe-area-top)`.
const SAFE_TOP = 47;
const SAFE_BOTTOM = 34;

// Verdict thresholds (px), measured from the bottom of the safe-area band to the
// top of the first real content element.
const TOP_GAP_MIN = 0; // below this → content intrudes into the safe area
const TOP_GAP_TIGHT = 6; // [0,6) → uncomfortably close to the notch
const TOP_GAP_LOOSE = 40; // > this → wasted top margin
// Horizontal inset (px) per side that we consider "wasted" on mobile.
const H_INSET_LOOSE_MOBILE = 28;

const VIEWPORTS = [
  { name: "desktop", size: VIEWPORT_SIZES.desktop },
  { name: "mobile", size: VIEWPORT_SIZES.mobile },
] as const;

interface SectionSpacing {
  id: string;
  /** y of the bottom of the safe-area band (== SAFE_TOP when respected). */
  safeBandBottom: number;
  /** y (viewport px) of the first rendered content element in the shell. */
  firstContentTop: number;
  /** firstContentTop - SAFE_TOP. Negative = intrudes into the safe area. */
  topGap: number;
  /** y of the page <h1> title (section header), if present. */
  headerTop: number | null;
  /** Left / right horizontal inset of the content column (px). */
  leftInset: number;
  rightInset: number;
  /** Gaps between consecutive SettingsGroup sections (px). */
  groupGaps: number[];
  /** Proof the simulated safe area took effect + offset the content. */
  diag: {
    resolvedVar: string;
    safePadColPadTop: number;
    safePadColTop: number;
  };
  /** Verdicts (zero or more). Empty array == clean. */
  verdicts: string[];
}

async function settleTheme(page: Page): Promise<void> {
  await page.addInitScript(
    ({ safeTop, safeBottom }) => {
      try {
        localStorage.setItem("eliza:theme-mode", "light");
        localStorage.setItem("eliza-theme", "light");
        // Seed developer mode so dev-only sections (remote-plugins) render and
        // get measured/captured like everything else.
        localStorage.setItem("eliza:developerMode", "1");
      } catch {}
      // Inject the simulated safe-area inset as soon as the document exists, so
      // the shell's `var(--safe-area-top)` resolves to a real notch height.
      const install = () => {
        if (document.getElementById("ui-smoke-safe-area")) return;
        const style = document.createElement("style");
        style.id = "ui-smoke-safe-area";
        style.textContent = `:root{--safe-area-top:${safeTop}px;--safe-area-bottom:${safeBottom}px;}`;
        (document.head ?? document.documentElement).appendChild(style);
      };
      if (document.head || document.documentElement) install();
      else
        document.addEventListener("DOMContentLoaded", install, { once: true });
    },
    { safeTop: SAFE_TOP, safeBottom: SAFE_BOTTOM },
  );
  await page.emulateMedia({ colorScheme: "light" });
}

/**
 * Measure the active settings section's spacing in-page. Returns raw numbers;
 * verdicts are derived host-side so thresholds live in one place.
 */
async function measure(
  page: Page,
  id: string,
  safeTop: number,
): Promise<Omit<SectionSpacing, "verdicts">> {
  // Force the simulated safe-area inset with inline `!important` so it beats the
  // inline value the app sets on <html> at boot (env(safe-area-inset-top) → 0px
  // on web). Set it on html + body + the shell-column ancestors in case the
  // custom property is registered `inherits: false`. Then scroll to top.
  await page.evaluate((safeTop) => {
    const setOn = (el: HTMLElement | null) => {
      if (!el) return;
      el.style.setProperty("--safe-area-top", `${safeTop}px`, "important");
      el.style.setProperty(
        "--safe-area-bottom",
        `${Math.round(safeTop * 0.72)}px`,
        "important",
      );
    };
    setOn(document.documentElement);
    setOn(document.body);
    const shell = document.querySelector(
      '[data-testid="settings-shell"]',
    ) as HTMLElement | null;
    let node: HTMLElement | null = shell;
    while (node && node !== document.body) {
      setOn(node);
      node = node.parentElement;
    }
    node = shell;
    while (node) {
      if (node.scrollHeight > node.clientHeight) node.scrollTop = 0;
      node = node.parentElement;
    }
    window.scrollTo(0, 0);
  }, SAFE_TOP);

  return page.evaluate(
    ({ id, safeTop }) => {
      const shell = document.querySelector(
        '[data-testid="settings-shell"]',
      ) as HTMLElement | null;
      const rect = (el: Element | null) =>
        el ? el.getBoundingClientRect() : null;

      // DIAGNOSTICS: prove whether the simulated safe area actually offsets the
      // content. Resolve the custom property and find the shell column that
      // consumes it (App.tsx applies `paddingTop: var(--safe-area-top)`).
      const resolvedVar = getComputedStyle(document.documentElement)
        .getPropertyValue("--safe-area-top")
        .trim();
      let safePadColPadTop = -1;
      let safePadColTop = -1;
      {
        // The column sits between <body> and the shell; find the nearest
        // ancestor whose computed padding-top matches the safe-area band.
        let node: HTMLElement | null = shell;
        while (node && node !== document.body) {
          const pt = Number.parseFloat(getComputedStyle(node).paddingTop) || 0;
          if (pt >= safeTop - 2) {
            safePadColPadTop = Math.round(pt);
            safePadColTop = Math.round(node.getBoundingClientRect().top);
            break;
          }
          node = node.parentElement;
        }
      }

      // First IN-FLOW content element inside the shell: skip fixed/absolute/
      // sticky (agent-surface overlays, teleported nodes) which pollute the
      // top/gap math. Measure only elements with their own ink or a control.
      let firstTop = Number.POSITIVE_INFINITY;
      let leftInset = Number.POSITIVE_INFINITY;
      let rightInset = Number.POSITIVE_INFINITY;
      const vw = window.innerWidth;
      const shellRect = shell?.getBoundingClientRect() ?? null;
      if (shell) {
        const all = shell.querySelectorAll<HTMLElement>("*");
        for (const el of all) {
          const cs = getComputedStyle(el);
          if (cs.visibility === "hidden" || cs.display === "none") continue;
          if (cs.position === "fixed" || cs.position === "absolute") continue;
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          // Ignore elements above the shell's own top (off-flow / teleported).
          if (shellRect && r.top < shellRect.top - 2) continue;
          const hasInk =
            el.childNodes.length > 0 &&
            Array.from(el.childNodes).some(
              (n) =>
                n.nodeType === Node.TEXT_NODE &&
                (n.textContent ?? "").trim().length > 0,
            );
          const isControl = /^(BUTTON|INPUT|SELECT|TEXTAREA|svg|IMG)$/i.test(
            el.tagName,
          );
          if (!hasInk && !isControl) continue;
          if (r.top < firstTop) firstTop = r.top;
          leftInset = Math.min(leftInset, r.left);
          rightInset = Math.min(rightInset, vw - r.right);
        }
      }
      const h1 = rect(shell?.querySelector("h1") ?? null);

      // Vertical rhythm between in-flow SettingsGroup <section> blocks.
      const groups = shell
        ? Array.from(shell.querySelectorAll<HTMLElement>("section"))
        : [];
      const visibleGroups = groups
        .filter((g) => {
          const cs = getComputedStyle(g);
          return cs.position !== "fixed" && cs.position !== "absolute";
        })
        .map((g) => g.getBoundingClientRect())
        .filter(
          (r) => r.height > 4 && (!shellRect || r.top >= shellRect.top - 2),
        )
        .sort((a, b) => a.top - b.top);
      const groupGaps: number[] = [];
      for (let i = 1; i < visibleGroups.length; i++) {
        groupGaps.push(
          Math.round(visibleGroups[i].top - visibleGroups[i - 1].bottom),
        );
      }

      const firstContentTop = Number.isFinite(firstTop)
        ? Math.round(firstTop)
        : safeTop;
      return {
        id,
        safeBandBottom: safeTop,
        firstContentTop,
        topGap: Math.round(firstContentTop - safeTop),
        headerTop: h1 ? Math.round(h1.top) : null,
        leftInset: Number.isFinite(leftInset) ? Math.round(leftInset) : 0,
        rightInset: Number.isFinite(rightInset) ? Math.round(rightInset) : 0,
        groupGaps,
        diag: { resolvedVar, safePadColPadTop, safePadColTop },
      };
    },
    { id, safeTop },
  );
}

function verdictsFor(
  m: Omit<SectionSpacing, "verdicts">,
  viewport: string,
): string[] {
  const v: string[] = [];
  if (m.topGap < TOP_GAP_MIN) v.push(`violates-safe-area(${m.topGap}px)`);
  else if (m.topGap < TOP_GAP_TIGHT) v.push(`too-tight(${m.topGap}px)`);
  else if (m.topGap > TOP_GAP_LOOSE) v.push(`too-loose(${m.topGap}px)`);
  // Negative inset == content runs past the viewport edge (horizontal overflow):
  // a real clipping/scroll bug on any viewport.
  if (m.leftInset < -2) v.push(`overflow-left(${m.leftInset}px)`);
  if (m.rightInset < -2) v.push(`overflow-right(${m.rightInset}px)`);
  if (viewport === "mobile") {
    if (m.leftInset > H_INSET_LOOSE_MOBILE)
      v.push(`wide-left-inset(${m.leftInset}px)`);
    if (m.rightInset > H_INSET_LOOSE_MOBILE)
      v.push(`wide-right-inset(${m.rightInset}px)`);
  }
  // Inconsistent vertical rhythm: groups should breathe by a uniform amount.
  const gaps = m.groupGaps.filter((g) => g >= 0);
  if (gaps.length >= 2) {
    const min = Math.min(...gaps);
    const max = Math.max(...gaps);
    if (max - min > 24) v.push(`uneven-group-gaps(${min}-${max}px)`);
  }
  return v;
}

test.describe("settings spacing + safe-area audit", () => {
  test.describe.configure({ mode: "default" });
  test.skip(
    process.env.ELIZA_SETTINGS_SPACING !== "1",
    "settings spacing audit is opt-in (set ELIZA_SETTINGS_SPACING=1)",
  );

  for (const viewport of VIEWPORTS) {
    test(`measure all sections @ ${viewport.name}`, async ({ browser }) => {
      test.setTimeout(600_000);
      const outDir = join(OUT_DIR, viewport.name);
      await mkdir(outDir, { recursive: true });

      const context = await browser.newContext({
        viewport: viewport.size,
        colorScheme: "light",
      });
      const page = await context.newPage();
      await settleTheme(page);
      await seedAppStorage(page, { "eliza:developerMode": "1" });
      await installDefaultAppRoutes(page);

      await openAppPath(page, "/settings");
      await page
        .getByTestId("settings-shell")
        .first()
        .waitFor({ state: "visible", timeout: 90_000 });

      const results: SectionSpacing[] = [];

      // Hub first.
      await page.waitForTimeout(400);
      {
        const raw = await measure(page, "_hub", SAFE_TOP);
        results.push({ ...raw, verdicts: verdictsFor(raw, viewport.name) });
        await captureScreenshotWithQualityRetry(page, `hub ${viewport.name}`, {
          attempts: 4,
          fullPage: true,
          type: "png",
          path: join(outDir, "_hub.png"),
        });
      }

      const missing: string[] = [];
      for (const section of SETTINGS_SECTIONS) {
        try {
          await openSettingsSection(page, section.match);
        } catch (error) {
          missing.push(`${section.id}: ${(error as Error).message}`);
          continue;
        }
        await page.waitForTimeout(500);
        const raw = await measure(page, section.id, SAFE_TOP);
        results.push({ ...raw, verdicts: verdictsFor(raw, viewport.name) });
        await captureScreenshotWithQualityRetry(
          page,
          `${section.id} ${viewport.name}`,
          {
            attempts: 4,
            fullPage: true,
            type: "png",
            path: join(outDir, `${section.id}.png`),
          },
        );
      }

      const flagged = results.filter((r) => r.verdicts.length > 0);
      const report = {
        viewport: viewport.name,
        simulatedSafeArea: { top: SAFE_TOP, bottom: SAFE_BOTTOM },
        thresholds: {
          TOP_GAP_MIN,
          TOP_GAP_TIGHT,
          TOP_GAP_LOOSE,
          H_INSET_LOOSE_MOBILE,
        },
        summary: {
          total: results.length,
          clean: results.length - flagged.length,
          flagged: flagged.length,
        },
        flagged: flagged.map((r) => ({ id: r.id, verdicts: r.verdicts })),
        sections: results,
        missing,
      };
      await writeFile(
        join(outDir, "_spacing.json"),
        JSON.stringify(report, null, 2),
      );
      // Console table for quick scan in the test log.
      console.log(`\n=== spacing verdicts @ ${viewport.name} ===`);
      const d0 = results[0]?.diag;
      console.log(
        `  [diag] --safe-area-top resolved="${d0?.resolvedVar}" ` +
          `safePadColumn.paddingTop=${d0?.safePadColPadTop}px top=${d0?.safePadColTop}px ` +
          `(expected paddingTop=${SAFE_TOP}px if the inset offsets content)`,
      );
      for (const r of results) {
        const tag = r.verdicts.length ? r.verdicts.join(", ") : "ok";
        console.log(
          `  ${r.id.padEnd(16)} topGap=${String(r.topGap).padStart(4)}px  ` +
            `L=${String(r.leftInset).padStart(3)} R=${String(r.rightInset).padStart(3)}  ` +
            `gaps=[${r.groupGaps.join(",")}]  → ${tag}`,
        );
      }
      await context.close();
    });
  }
});
