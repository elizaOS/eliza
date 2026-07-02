import type { Page } from "@playwright/test";
import { bucket } from "../aesthetic-audit-rules";

/**
 * Brand-color DOM scans shared by the aesthetic audits (#8796, #10725): the
 * all-views walk (`all-views-aesthetic-audit.spec.ts`) and the cloud-surface
 * walk (`cloud-surfaces-aesthetic-audit.spec.ts`) enforce the same rules —
 * no blue anywhere, and orange-resting buttons must never hover to
 * black/white/transparent.
 */

/** Scan the rendered DOM for any blue text/background/border color (banned). */
export async function collectBlueColors(page: Page): Promise<string[]> {
  const colors = await page.evaluate(() => {
    const out = new Set<string>();
    const nodes = Array.from(document.querySelectorAll("*")).slice(0, 4000);
    for (const node of nodes) {
      const cs = getComputedStyle(node as Element);
      out.add(cs.color);
      out.add(cs.backgroundColor);
      out.add(cs.borderTopColor);
    }
    return Array.from(out);
  });
  return colors.filter((c) => bucket(c) === "blue");
}

export interface HoverScanResult {
  violations: string[];
  /** Orange-resting buttons the probe could not actually hover — recorded as
   * findings so a hover failure never silently passes as "no violation". */
  hoverFailures: string[];
}

/** Tag primary buttons, read rest+hover backgrounds, flag brand violations. */
export async function collectHoverViolations(
  page: Page,
): Promise<HoverScanResult> {
  const buttons = page.locator("button, a[role='button'], [data-audit-btn]");
  const count = Math.min(await buttons.count(), 24);
  const violations: string[] = [];
  const hoverFailures: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const btn = buttons.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;
    const rest = await btn
      .evaluate((el) => getComputedStyle(el).backgroundColor)
      .catch(() => "");
    if (bucket(rest) !== "orange") continue; // only orange-resting buttons matter
    let hoverError: string | null = null;
    try {
      await btn.hover({ timeout: 1000 });
    } catch (error) {
      hoverError = (error instanceof Error ? error.message : String(error))
        .split("\n")[0]
        .slice(0, 120);
    }
    if (hoverError !== null) {
      // The hover never applied, so reading the "hover" background would just
      // re-read the rest color and vacuously pass. Surface the probe failure.
      const label = (await btn.innerText().catch(() => "")).slice(0, 24);
      hoverFailures.push(`"${label}" hover probe failed: ${hoverError}`);
      continue;
    }
    const hover = await btn
      .evaluate((el) => getComputedStyle(el).backgroundColor)
      .catch(() => "");
    const dest = bucket(hover);
    if (dest === "black" || dest === "white" || dest === "transparent") {
      const label = (await btn.innerText().catch(() => "")).slice(0, 24);
      violations.push(`"${label}" orange→${dest} (${rest} -> ${hover})`);
    }
  }
  return { violations, hoverFailures };
}
