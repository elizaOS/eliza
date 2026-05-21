// Blue is banned from the Eliza Cloud palette.
//
// This spec enforces the rule at two layers:
//   1. Source: grep `packages/cloud-frontend/src/` for any Tailwind
//      `*-blue-*` class. Zero hits required.
//   2. Runtime: load every key page in the audit route list and assert
//      no visible element resolves to a "blueish" computed color.
//
// "Blueish" is bucketed via HSL hue (200deg <= h <= 260deg) with
// non-trivial saturation/lightness so dark navy backgrounds and pure
// black don't false-positive.
//
// Skipped in live-prod mode; pair with `aesthetic-audit.spec.ts` which
// already records palette violations into `report.json`.

import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { loginWithInjectedEthereum } from "./_helpers/siwe-session";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "Blue-ban runtime check uses local mocks; skipped in live-prod mode.",
);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../../src");

test("source: no `*-blue-*` Tailwind classes in src/", () => {
  // grep returns exit 1 when no match — that's what we want.
  let output = "";
  try {
    output = execSync(
      `grep -rnE "(^|[^a-z-])(bg|text|border|ring|from|via|to|hover:bg|hover:text|hover:border|focus:ring|focus:border)-blue-[0-9]" "${SRC}" --include="*.tsx" --include="*.ts" --include="*.css" || true`,
      { encoding: "utf8" },
    );
  } catch (err) {
    // Non-zero from grep is expected when there are no matches.
    output = err instanceof Error ? "" : String(err);
  }
  // Trim and ignore empty lines.
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  expect(
    lines,
    `Blue Tailwind classes found in src/ — see HOVER_SYSTEM.md. Offenders:\n${lines.join("\n")}`,
  ).toEqual([]);
});

const RUNTIME_PAGES: { path: string; auth: boolean }[] = [
  { path: "/", auth: false },
  { path: "/login", auth: false },
  { path: "/bsc", auth: false },
  { path: "/dashboard", auth: true },
  { path: "/dashboard/api-explorer", auth: true },
  { path: "/dashboard/agents", auth: true },
  { path: "/dashboard/billing", auth: true },
  { path: "/dashboard/settings", auth: true },
];

for (const { path: route, auth } of RUNTIME_PAGES) {
  test(`runtime: no blue pixels rendered on ${route}`, async ({
    page,
    context,
  }) => {
    if (auth) {
      await loginWithInjectedEthereum(page, context);
    }
    await page.goto(route);
    await page
      .waitForLoadState("networkidle", { timeout: 6_000 })
      .catch(() => {});
    await page.waitForTimeout(400);

    const blueElements = await page.evaluate(() => {
      const isBlueish = (color: string): boolean => {
        const m =
          color.match(/^rgba?\(([^)]+)\)/i) ||
          color.match(/^oklab\([^)]+\)/i) ||
          null;
        if (!m) return false;
        const parts = m[1]?.split(/[,\s/]+/).map((p) => parseFloat(p)) ?? [];
        if (parts.length < 3) return false;
        const [r, g, b, a = 1] = parts;
        if (a < 0.05) return false;
        // RGB → HSL hue.
        const rn = r / 255;
        const gn = g / 255;
        const bn = b / 255;
        const max = Math.max(rn, gn, bn);
        const min = Math.min(rn, gn, bn);
        const l = (max + min) / 2;
        const d = max - min;
        if (d < 0.08) return false; // near-grey
        if (l < 0.05 || l > 0.95) return false; // near-black/white
        let h = 0;
        if (max === rn) h = ((gn - bn) / d) % 6;
        else if (max === gn) h = (bn - rn) / d + 2;
        else h = (rn - gn) / d + 4;
        h = h * 60;
        if (h < 0) h += 360;
        return h >= 200 && h <= 260;
      };
      const hits: { selector: string; color: string; prop: string }[] = [];
      const tagPath = (el: Element): string => {
        const parts: string[] = [];
        let cur: Element | null = el;
        let depth = 0;
        while (cur && depth < 4) {
          const id = cur.id ? `#${cur.id}` : "";
          const cls =
            cur.className && typeof cur.className === "string"
              ? `.${cur.className.split(/\s+/).slice(0, 2).join(".")}`
              : "";
          parts.unshift(`${cur.tagName.toLowerCase()}${id}${cls}`);
          cur = cur.parentElement;
          depth++;
        }
        return parts.join(" > ");
      };
      const all = document.querySelectorAll<HTMLElement>("*");
      for (const el of Array.from(all)) {
        if (!(el instanceof HTMLElement)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const cs = window.getComputedStyle(el);
        for (const prop of [
          "color",
          "backgroundColor",
          "borderTopColor",
          "borderRightColor",
          "borderBottomColor",
          "borderLeftColor",
        ] as const) {
          const val = cs[prop];
          if (val && isBlueish(val)) {
            hits.push({ selector: tagPath(el), color: val, prop });
            if (hits.length >= 20) return hits;
          }
        }
      }
      return hits;
    });

    expect(
      blueElements,
      `Blue pixels rendered on ${route}:\n${blueElements
        .map((h) => `  ${h.selector}  ${h.prop}=${h.color}`)
        .join("\n")}`,
    ).toEqual([]);
  });
}
