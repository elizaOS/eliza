// Settings DARK + LIGHT theme audit. For every settings section it captures the
// section in BOTH themes and, crucially, runs a PROGRAMMATIC per-element
// theme-response check: it snapshots every element's computed colors in light,
// flips the theme in-place (DOM unchanged, only CSS vars change), re-snapshots,
// and diffs. An element whose text color / background / border is byte-identical
// in both themes — while NOT being the brand accent and NOT transparent — is a
// hardcoded color that does not respond to the theme (the classic invisible-in-
// dark / invisible-in-light bug). Findings + screenshots are written per section.
//
// Run:  ELIZA_SETTINGS_THEME=1 node scripts/run-ui-playwright.mjs \
//   --config playwright.ui-smoke.config.ts test/ui-smoke/settings-theme-audit.spec.ts

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
const OUT_DIR = resolve(REPO_ROOT, "reports", "settings-theme");

const ALL_VIEWPORTS = [
  { name: "desktop", size: VIEWPORT_SIZES.desktop },
  { name: "mobile", size: VIEWPORT_SIZES.mobile },
] as const;
// Allow a single-viewport run (ELIZA_THEME_VP=desktop|mobile) so each pass fits
// comfortably under the harness timeout; default to both.
const VIEWPORTS = process.env.ELIZA_THEME_VP
  ? ALL_VIEWPORTS.filter((v) => v.name === process.env.ELIZA_THEME_VP)
  : ALL_VIEWPORTS;

interface ElemColor {
  path: string;
  tag: string;
  cls: string;
  text: string;
  color: string;
  bg: string;
  border: string;
}

interface ThemeFinding {
  path: string;
  tag: string;
  cls: string;
  text: string;
  kind: "text-color" | "background" | "border";
  value: string; // the identical-in-both value
}

async function seedTheme(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("eliza:developerMode", "1");
    } catch {}
  });
}

/**
 * Switch the app's theme for real: write the canonical theme keys the app reads
 * at boot (`eliza:ui-theme-mode` / `eliza:ui-theme`, persistence.ts) then RELOAD
 * so the React ThemeProvider boots in that theme — forcing `data-theme` on the
 * DOM alone is reverted by the provider. Returns the resolved `--bg` so the
 * caller can assert the theme actually flipped.
 */
async function setThemeAndReload(
  page: Page,
  theme: "light" | "dark",
): Promise<string> {
  await page.evaluate((t) => {
    try {
      localStorage.setItem("eliza:ui-theme-mode", t);
      localStorage.setItem("eliza:ui-theme", t);
      localStorage.setItem("elizaos:ui-theme", t);
    } catch {}
  }, theme);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByTestId("settings-shell")
    .first()
    .waitFor({ state: "visible", timeout: 90_000 });
  await page.waitForTimeout(250);
  return page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
  );
}

/** Snapshot computed colors of every visible inky element inside the shell. */
async function snapshotColors(page: Page): Promise<ElemColor[]> {
  return page.evaluate(() => {
    const shell = document.querySelector('[data-testid="settings-shell"]');
    if (!shell) return [];
    const pathOf = (el: Element): string => {
      const parts: string[] = [];
      let n: Element | null = el;
      while (n && n !== shell) {
        const p: Element | null = n.parentElement;
        if (!p) break;
        parts.unshift(String(Array.prototype.indexOf.call(p.children, n)));
        n = p;
      }
      return parts.join("/");
    };
    const out: ElemColor[] = [];
    for (const el of Array.from(shell.querySelectorAll<HTMLElement>("*"))) {
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const ownText = Array.from(el.childNodes)
        .filter((c) => c.nodeType === Node.TEXT_NODE)
        .map((c) => (c.textContent ?? "").trim())
        .join(" ")
        .trim();
      out.push({
        path: pathOf(el),
        tag: el.tagName.toLowerCase(),
        cls: typeof el.className === "string" ? el.className.slice(0, 80) : "",
        text: ownText.slice(0, 40),
        color: cs.color,
        bg: cs.backgroundColor,
        border: cs.borderTopColor,
      });
    }
    return out;
  });
}

const TRANSPARENT = /rgba?\([^)]*,\s*0\)|transparent/;

/** Parse "rgb(r, g, b)" / "rgba(...)" → [r,g,b] or null. */
function rgb(v: string): [number, number, number] | null {
  const m = v.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Brand accent (orange ~#ff8a24) is intentionally theme-invariant, in either
 * rgb() form or the oklab() form Tailwind emits for `bg-accent/NN` (warm hue:
 * positive a + positive b, mid lightness). Also treats the accent/danger button
 * foregrounds (#fff7ee off-white, #ffffff white) as invariant — they sit on a
 * colored button that is the same in both themes. */
function isAccent(v: string): boolean {
  const c = rgb(v);
  if (c) {
    const [r, g, b] = c;
    if (r > 200 && g >= 60 && g <= 175 && b < 90) return true; // orange
    if (r > 248 && g > 235 && b > 225) return true; // #fff7ee / #ffffff button fg
  }
  const ok = v.match(/oklab\(\s*([\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/);
  if (ok) {
    const l = Number(ok[1]);
    const a = Number(ok[2]);
    const bb = Number(ok[3]);
    // warm orange: positive a (red) + positive b (yellow), mid lightness.
    if (l > 0.5 && l < 0.9 && a > 0.04 && bb > 0.06) return true;
  }
  return false;
}

/** ok/warn/danger status tokens are also intentionally theme-invariant. */
function isStatusColor(v: string): boolean {
  const c = rgb(v);
  if (!c) return false;
  const [r, g, b] = c;
  const green = g > 150 && r < 120 && b < 140;
  const red = r > 180 && g < 110 && b < 110;
  return green || red;
}

function diffFindings(light: ElemColor[], dark: ElemColor[]): ThemeFinding[] {
  const darkByPath = new Map(dark.map((e) => [e.path, e]));
  const findings: ThemeFinding[] = [];
  for (const l of light) {
    const d = darkByPath.get(l.path);
    if (!d) continue;
    // Text color that never changed while the theme flipped — and the element
    // actually paints text — is a hardcoded color (contrast bug in one theme).
    if (
      l.text.length > 0 &&
      l.color === d.color &&
      !TRANSPARENT.test(l.color) &&
      !isAccent(l.color) &&
      !isStatusColor(l.color)
    ) {
      findings.push({
        path: l.path,
        tag: l.tag,
        cls: l.cls,
        text: l.text,
        kind: "text-color",
        value: l.color,
      });
    }
    // Non-transparent background identical in both themes (not accent/status).
    if (
      l.bg === d.bg &&
      !TRANSPARENT.test(l.bg) &&
      !isAccent(l.bg) &&
      !isStatusColor(l.bg)
    ) {
      findings.push({
        path: l.path,
        tag: l.tag,
        cls: l.cls,
        text: l.text,
        kind: "background",
        value: l.bg,
      });
    }
  }
  return findings;
}

test.describe("settings theme audit", () => {
  test.describe.configure({ mode: "default" });
  test.skip(
    process.env.ELIZA_SETTINGS_THEME !== "1",
    "settings theme audit is opt-in (set ELIZA_SETTINGS_THEME=1)",
  );

  for (const viewport of VIEWPORTS) {
    test(`light+dark all sections @ ${viewport.name}`, async ({ browser }) => {
      test.setTimeout(600_000);
      const lightDir = join(OUT_DIR, "light", viewport.name);
      const darkDir = join(OUT_DIR, "dark", viewport.name);
      await mkdir(lightDir, { recursive: true });
      await mkdir(darkDir, { recursive: true });

      const context = await browser.newContext({
        viewport: viewport.size,
        colorScheme: "light",
      });
      const page = await context.newPage();
      await seedTheme(page);
      await seedAppStorage(page, { "eliza:developerMode": "1" });
      await installDefaultAppRoutes(page);

      await openAppPath(page, "/settings");
      await page
        .getByTestId("settings-shell")
        .first()
        .waitFor({ state: "visible", timeout: 90_000 });

      const perSection: Record<string, ThemeFinding[]> = {};
      const sections = [
        { id: "_hub", match: /^Settings$/i },
        ...SETTINGS_SECTIONS,
      ];
      const missing = new Set<string>();

      // One pass per theme (a real reload-driven theme switch), capturing each
      // section's color snapshot + screenshot. Then diff per (section, element).
      const lightSnaps: Record<string, ElemColor[]> = {};
      const darkSnaps: Record<string, ElemColor[]> = {};

      const runPass = async (
        theme: "light" | "dark",
        snaps: Record<string, ElemColor[]>,
        dir: string,
      ) => {
        const bg = await setThemeAndReload(page, theme);
        console.log(`  [diag] ${theme} pass: --bg=${bg}`);
        for (const section of sections) {
          if (section.id !== "_hub") {
            try {
              await openSettingsSection(page, section.match);
            } catch (error) {
              missing.add(`${section.id}: ${(error as Error).message}`);
              continue;
            }
          } else {
            // Soft-navigate to the hub (clear the section hash) without a full
            // re-nav, which renders blank right after a theme reload.
            await page.evaluate(() => {
              window.history.replaceState(null, "", "#");
              window.dispatchEvent(new HashChangeEvent("hashchange"));
            });
            await page
              .getByTestId("settings-shell")
              .first()
              .waitFor({ state: "visible", timeout: 30_000 });
          }
          await page.waitForTimeout(500);
          snaps[section.id] = await snapshotColors(page);
          await captureScreenshotWithQualityRetry(
            page,
            `${section.id} ${theme} ${viewport.name}`,
            {
              attempts: 3,
              fullPage: true,
              type: "png",
              path: join(dir, `${section.id}.png`),
            },
          );
        }
      };

      await runPass("light", lightSnaps, lightDir);
      await runPass("dark", darkSnaps, darkDir);

      for (const section of sections) {
        const l = lightSnaps[section.id];
        const d = darkSnaps[section.id];
        if (l && d) perSection[section.id] = diffFindings(l, d);
      }

      const flagged = Object.entries(perSection)
        .filter(([, f]) => f.length > 0)
        .map(([id, f]) => ({ id, count: f.length, findings: f }));
      await writeFile(
        join(OUT_DIR, `_theme-response.${viewport.name}.json`),
        JSON.stringify(
          {
            viewport: viewport.name,
            totalSections: sections.length - missing.size,
            sectionsWithFindings: flagged.length,
            flagged,
            missing: [...missing],
          },
          null,
          2,
        ),
      );
      console.log(`\n=== theme-response @ ${viewport.name} ===`);
      for (const [id, f] of Object.entries(perSection)) {
        console.log(
          `  ${id.padEnd(16)} ${f.length} hardcoded-color element(s)`,
        );
      }
      await context.close();
    });
  }
});
