/**
 * Exercises the real browser hover scanner against named icon-only controls,
 * including an initially offscreen target and a blocked interaction.
 */

import { expect, test } from "@playwright/test";
import { collectHoverViolations } from "./helpers/brand-color-scans";

test("centers and names an offscreen icon-only orange control", async ({
  page,
}) => {
  await page.setContent(`
    <style>
      #scrollport { height: 100px; overflow: auto; }
      #spacer { height: 240px; }
      #target { width: 44px; height: 44px; background: rgb(255, 88, 0); }
      #target:hover { background: rgb(0, 0, 0); }
    </style>
    <div id="scrollport">
      <div id="spacer"></div>
      <button id="target" aria-label="Use orange color">
        <svg aria-hidden="true"></svg>
      </button>
    </div>
  `);

  const finding = await collectHoverViolations(page);

  expect(finding.hoverFailures).toEqual([]);
  expect(finding.violations).toHaveLength(1);
  expect(finding.violations[0]).toContain('"Use orange color" orange→black');
});

test("reports a named icon-only control when hover remains blocked", async ({
  page,
}) => {
  await page.setContent(`
    <button
      aria-label="Blocked orange action"
      style="width:44px;height:44px;background:rgb(255,88,0)"
    >
      <svg aria-hidden="true"></svg>
    </button>
    <div style="position:fixed;inset:0;z-index:2"></div>
  `);

  const finding = await collectHoverViolations(page);

  expect(finding.violations).toEqual([]);
  expect(finding.hoverFailures).toHaveLength(1);
  expect(finding.hoverFailures[0]).toContain('"Blocked orange action"');
});
