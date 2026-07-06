// Walkthrough driver against a LOCAL static HTML fixture served over http, in a
// REAL headless Playwright chromium — no mocks, no stubbed browser. Skipped with
// an explicit reason when @playwright/test or its chromium browser is
// unavailable (after attempting nothing destructive; the runner reports the
// skip). Asserts the driver records a video, per-step screenshots, and an ARIA
// snapshot, executes every step in order, and fails fast on a false assertion.
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runWalkthrough } from "./driver.ts";
import { serveFixture } from "./fixture-server.ts";
import { parseWalkthroughDef } from "./walkthrough-schema.ts";

const dir = mkdtempSync(join(os.tmpdir(), "evidence-driver-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Can we launch a real headless chromium? Gate the browser lane honestly. */
async function chromiumLaunchable(): Promise<boolean> {
  try {
    const { chromium } = (await import("@playwright/test")) as {
      chromium: { launch(o?: unknown): Promise<{ close(): Promise<void> }> };
    };
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    // error-policy:J4 test-capability gate — an absent browser download is a
    // skipped lane with a reason, not a failed test.
    return false;
  }
}

const hasChromium = await chromiumLaunchable();

// A minimal fixture with one button that swaps visible text on click, so the
// driver can exercise goto/waitFor/click/assertText/screenshot/aria on real DOM.
const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title></head>
<body>
  <button data-testid="go" aria-label="Go">Go</button>
  <p data-testid="out">idle</p>
  <script>
    document.querySelector('[data-testid="go"]').addEventListener('click', () => {
      document.querySelector('[data-testid="out"]').textContent = 'done';
    });
  </script>
</body></html>`;

describe.skipIf(!hasChromium)("runWalkthrough (real chromium)", () => {
  it("records a video, screenshots, and an aria snapshot over a fixture", async () => {
    const fixtureDir = mkdtempSync(join(dir, "fixture-"));
    writeFileSync(join(fixtureDir, "index.html"), FIXTURE_HTML);
    const server = await serveFixture(fixtureDir);
    const out = mkdtempSync(join(dir, "out-"));
    try {
      const def = parseWalkthroughDef(
        {
          slug: "driver-fixture",
          granularity: "feature",
          baseUrl: server.baseUrl,
          steps: [
            { action: "goto", value: "/", label: "open" },
            {
              action: "waitFor",
              selector: '[data-testid="go"]',
              label: "await-button",
            },
            {
              action: "assertText",
              selector: '[data-testid="out"]',
              value: "idle",
            },
            {
              action: "click",
              selector: '[data-testid="go"]',
              label: "click",
              ariaAfter: true,
            },
            {
              action: "assertText",
              selector: '[data-testid="out"]',
              value: "done",
              label: "result",
              screenshotAfter: true,
            },
          ],
        },
        "test",
      );
      const result = await runWalkthrough(def, {
        out,
        stepPauseMs: 100,
      });
      expect(result.steps).toHaveLength(5);
      expect(result.steps.map((s) => s.action)).toEqual([
        "goto",
        "waitFor",
        "assertText",
        "click",
        "assertText",
      ]);
      expect(result.screenshots).toHaveLength(1);
      expect(result.ariaSnapshots).toHaveLength(1);
      expect(statSync(result.video).size).toBeGreaterThan(0);
      expect(statSync(result.stepsLog).size).toBeGreaterThan(0);
    } finally {
      await server.stop();
    }
  }, 60_000);

  it("fails fast when an assertText does not hold", async () => {
    const fixtureDir = mkdtempSync(join(dir, "fixture-fail-"));
    writeFileSync(join(fixtureDir, "index.html"), FIXTURE_HTML);
    const server = await serveFixture(fixtureDir);
    const out = mkdtempSync(join(dir, "out-fail-"));
    try {
      const def = parseWalkthroughDef(
        {
          slug: "driver-fail",
          granularity: "feature",
          baseUrl: server.baseUrl,
          steps: [
            { action: "goto", value: "/" },
            {
              action: "assertText",
              selector: '[data-testid="out"]',
              value: "this text is never present",
            },
          ],
        },
        "test",
      );
      await expect(
        runWalkthrough(def, { out, stepPauseMs: 0 }),
      ).rejects.toMatchObject({ code: "WALKTHROUGH_ASSERTION_FAILED" });
    } finally {
      await server.stop();
    }
  }, 60_000);
});

describe("runWalkthrough guards", () => {
  it("refuses a requiresApp definition without a baseUrl", async () => {
    const def = parseWalkthroughDef(
      {
        slug: "needs-app",
        granularity: "walkthrough",
        requiresApp: true,
        steps: [{ action: "goto", value: "/" }],
      },
      "test",
    );
    await expect(
      runWalkthrough(def, { out: join(dir, "never") }),
    ).rejects.toMatchObject({ code: "WALKTHROUGH_REQUIRES_APP" });
  });
});
