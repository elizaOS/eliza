import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, expect, test } from "@playwright/test";

// This spec lives at packages/app/test/hmr/, so the repo root is four levels up.
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

// One representative, always-in-the-module-graph source file per dependency
// depth. The point of the suite is to prove an edit made at each depth — the
// app itself, a directly-imported workspace UI package, and a transitively
// depended-on shared package — actually propagates to the running dev client
// over Vite's HMR channel. That exercises the dev architecture's reliance on
// `src/` (not `dist/`) resolution plus workspace-source watching.
const LEVELS = [
  { name: "app (packages/app)", file: "packages/app/src/main.tsx" },
  { name: "@elizaos/ui", file: "packages/ui/src/browser.ts" },
  { name: "@elizaos/shared", file: "packages/shared/src/brand/index.ts" },
] as const;

// Vite's client logs these to the page console when it processes a change.
const VITE_UPDATE = /\[vite\].*(hot updated|hmr update|page reload|invalidate)/i;

function collectViteEvents(page: Page): string[] {
  const events: string[] = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (VITE_UPDATE.test(text)) events.push(text);
  });
  return events;
}

async function waitForViteClient(page: Page): Promise<void> {
  // The Vite client connects its HMR socket shortly after load; give it room.
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2000);
}

test.describe("HMR propagation across package dependency levels", () => {
  for (const level of LEVELS) {
    test(`edit at ${level.name} reaches the running dev client`, async ({
      page,
    }) => {
      const abs = path.join(repoRoot, level.file);
      expect(
        fs.existsSync(abs),
        `target source file missing: ${level.file}`,
      ).toBe(true);
      const original = fs.readFileSync(abs, "utf8");
      const marker = `HMR_PROBE_${level.name.replace(/[^a-z0-9]/gi, "_")}_${Date.now()}`;

      const events = collectViteEvents(page);
      await page.goto("/");
      await waitForViteClient(page);

      // Sentinel survives an HMR module swap but is wiped by a full reload —
      // recorded for diagnostics, not asserted (barrels legitimately reload).
      await page.evaluate((m) => {
        (window as unknown as Record<string, unknown>).__hmrSentinel = m;
      }, marker);

      events.length = 0;
      try {
        // Appending a comment is always syntactically valid and still forces
        // Vite to re-process the module and push an update to the client.
        fs.writeFileSync(abs, `${original}\n// ${marker}\n`);
        await expect
          .poll(() => events.length, {
            timeout: 30_000,
            message: `Expected a Vite HMR/reload event in the browser after editing ${level.file}. Captured: ${JSON.stringify(events)}`,
          })
          .toBeGreaterThan(0);
      } finally {
        fs.writeFileSync(abs, original);
      }
    });
  }
});
