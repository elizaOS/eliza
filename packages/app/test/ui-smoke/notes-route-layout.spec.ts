/**
 * Protects the Notes route's shell ownership and adaptive collection geometry
 * in the deterministic app renderer rather than asserting styling literals.
 */

import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { installDesktopBridgeFixture } from "./helpers/desktop-bridge";

async function installCloudSession(page: Page): Promise<void> {
  await page.route("**/api/cloud/login", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        sessionId: "notes-layout-login",
        browserUrl: "https://example.invalid/auth",
      }),
    });
  });
  await page.route("**/api/cloud/login/status**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "authenticated",
        token: "notes-layout-token",
        organizationId: "notes-layout-org",
        userId: "notes-layout-user",
      }),
    });
  });
  await page.route("**/api/cloud/login/persist", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true }),
    });
  });
}

async function openNotes(page: Page): Promise<void> {
  await installCloudSession(page);
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/notes");
  await expect(page.getByTestId("simple-notes-view")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Note / })).toHaveCount(2);
}

function rectanglesOverlap(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
): boolean {
  return !(
    first.x + first.width <= second.x ||
    second.x + second.width <= first.x ||
    first.y + first.height <= second.y ||
    second.y + second.height <= first.y
  );
}

test("Notes retains an in-flight edit and failed draft across app navigation", async ({
  page,
}) => {
  await installDesktopBridgeFixture(page);
  await seedAppStorage(page, {
    "eliza:permissions-primed": "1",
    "elizaos.desktop.pinned-tabs": JSON.stringify([
      { viewId: "notes", label: "Notes", path: "/notes", pinned: true },
    ]),
  });
  let elementReports = 0;
  await page.route("**/api/views", (route) =>
    route.fulfill({
      json: {
        views: [
          {
            id: "notes",
            label: "Notes",
            path: "/notes",
            viewType: "gui",
            pluginName: "@elizaos/plugin-notes",
            available: true,
            installationId: "notes-navigation-fixture",
          },
        ],
      },
    }),
  );
  await page.route("**/api/views/notes/elements", (route) => {
    elementReports++;
    return route.fulfill({ json: { ok: true } });
  });
  await openNotes(page);
  const tabBars = page.getByRole("toolbar", {
    name: "Desktop view tabs",
    includeHidden: true,
  });
  await expect(tabBars).toHaveCount(1);
  await expect.poll(() => elementReports).toBeGreaterThan(0);
  const snapshot = await page.evaluate(
    async () => (await (await fetch("/api/notes/state")).json()).data,
  );
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0,
    fail = false;
  await page.route("**/api/notes/state", (route) =>
    route.fulfill({ json: { success: true, data: snapshot } }),
  );
  await page.route("**/api/views/notes/interact", async (route) => {
    writes++;
    if (writes === 1) await pending;
    if (fail) {
      await route.fulfill({
        status: 503,
        json: { error: "Controlled save failure" },
      });
      return;
    }
    const { params } = route.request().postDataJSON();
    const note = snapshot.notes.find(
      (entry: { id: string }) => entry.id === params.id,
    );
    const split = params.content.indexOf("\n");
    note.title = split < 0 ? params.content : params.content.slice(0, split);
    note.body = split < 0 ? "" : params.content.slice(split);
    snapshot.revision++;
    await route.fulfill({
      json: {
        requestId: `navigation-${writes}`,
        success: true,
        result: {
          success: true,
          text: "Saved",
          state: snapshot,
          data: { note },
        },
      },
    });
  });
  const navigate = (path: string) =>
    page.evaluate((path) => {
      window.dispatchEvent(
        new CustomEvent("eliza:navigate:view", { detail: { viewPath: path } }),
      );
    }, path);
  await page
    .getByRole("button", { name: "Note Launch checklist", exact: true })
    .click();
  const body = page.getByRole("textbox", { name: "Note", exact: true });
  const original = await body.elementHandle();
  await body.fill("First edit in flight");
  await expect.poll(() => writes).toBe(1);
  await body.fill("Later owner input must survive navigation");
  await navigate("/views");
  await expect(page.locator("[data-retained-notes]")).toHaveAttribute(
    "inert",
    "",
  );
  await expect(page.locator("[data-retained-notes]")).toBeHidden();
  await expect(tabBars).toHaveCount(1);
  await expect(
    page.locator('[data-retained-notes] [aria-label="Desktop view tabs"]'),
  ).toHaveCount(0);
  const hiddenReports = elementReports;
  expect(
    await page.evaluate(async () => {
      try {
        await window.__ELIZA_BRIDGE__?.viewInteract?.(
          "notes",
          "gui",
          "get-state",
        );
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
  release();
  await expect
    .poll(() => snapshot.notes[0].body)
    .toBe("\nLater owner input must survive navigation");
  // The reporter debounces for 400 ms. Let that window pass after the hidden
  // save so a retained reporter cannot silently send the edited note text.
  await page.waitForTimeout(650);
  expect(elementReports).toBe(hiddenReports);
  await navigate("/notes");
  await expect(tabBars).toHaveCount(1);
  await expect.poll(() => elementReports).toBeGreaterThan(hiddenReports);
  await expect(body).toHaveValue("Later owner input must survive navigation");
  expect(
    await body.evaluate((element, prior) => element === prior, original),
  ).toBe(true);
  fail = true;
  await body.fill("Keep this failed draft until I review it");
  await expect(
    page.getByRole("button", { name: "Discard draft and reload", exact: true }),
  ).toBeVisible();
  const failedWrites = writes;
  await navigate("/views");
  await navigate("/notes");
  await expect(body).toHaveValue("Keep this failed draft until I review it");
  expect(writes).toBe(failedWrites);
});

test("Notes keeps the desktop collection readable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openNotes(page);

  const cards = page.getByRole("button", { name: /^Note / });
  const first = await cards.nth(0).boundingBox();
  const second = await cards.nth(1).boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  if (!first || !second) return;
  expect(first.width).toBeGreaterThanOrEqual(320);
  expect(second.width).toBeGreaterThanOrEqual(320);
  expect(Math.abs(first.y - second.y)).toBeLessThanOrEqual(2);
  expect(second.x).toBeGreaterThan(first.x + first.width);
});

test("Notes uses the canonical shell gutter on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openNotes(page);

  const geometry = await page.evaluate(() => {
    const pageContent = document.querySelector<HTMLElement>(
      "[data-page-content]",
    );
    const notesRail = document.querySelector<HTMLElement>(
      '[data-testid="simple-notes-view"] [data-slot="page-panel-content-rail"]',
    );
    if (!pageContent || !notesRail) return null;
    const pageRect = pageContent.getBoundingClientRect();
    const railRect = notesRail.getBoundingClientRect();
    const pageStyle = getComputedStyle(pageContent);
    return {
      expectedStart:
        pageRect.left + Number.parseFloat(pageStyle.paddingInlineStart),
      expectedEnd:
        pageRect.right - Number.parseFloat(pageStyle.paddingInlineEnd),
      actualStart: railRect.left,
      actualEnd: railRect.right,
    };
  });

  expect(geometry).not.toBeNull();
  if (!geometry) throw new Error("Expected routed Notes gutter geometry");
  expect(
    Math.abs(geometry.actualStart - geometry.expectedStart),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(geometry.actualEnd - geometry.expectedEnd),
  ).toBeLessThanOrEqual(1);
});

test("Notes keeps readable cards clear of the composer in short landscape", async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await openNotes(page);

  const cards = page.getByRole("button", { name: /^Note / });
  await cards.nth(1).scrollIntoViewIfNeeded();
  const first = await cards.nth(0).boundingBox();
  const second = await cards.nth(1).boundingBox();
  const composerInput = page.getByPlaceholder(/Message/);
  await expect(composerInput).toBeInViewport();
  const composer = await composerInput.boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(composer).not.toBeNull();
  if (!first || !second || !composer) return;
  expect(first.width).toBeGreaterThanOrEqual(300);
  expect(second.width).toBeGreaterThanOrEqual(300);
  expect(Math.abs(first.x - second.x)).toBeLessThanOrEqual(2);
  expect(second.y).toBeGreaterThan(first.y + first.height);
  expect(rectanglesOverlap(first, composer)).toBe(false);
  const visibleSecondBottom = await cards.nth(1).evaluate((card) => {
    let bottom = card.getBoundingClientRect().bottom;
    let ancestor = card.parentElement;
    while (ancestor) {
      const style = getComputedStyle(ancestor);
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        bottom = Math.min(bottom, ancestor.getBoundingClientRect().bottom);
      }
      ancestor = ancestor.parentElement;
    }
    return bottom;
  });
  // The DOM box includes clipped content; compare the actually visible card
  // edge after every scroll/clip ancestor with the shell composer instead.
  expect(visibleSecondBottom).toBeLessThanOrEqual(composer.y);
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  if (!viewport) throw new Error("Expected the configured landscape viewport");
  expect(composer.x).toBeGreaterThanOrEqual(0);
  expect(composer.y).toBeGreaterThanOrEqual(0);
  expect(composer.x + composer.width).toBeLessThanOrEqual(viewport.width);
  expect(composer.y + composer.height).toBeLessThanOrEqual(viewport.height);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
