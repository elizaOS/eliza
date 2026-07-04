/**
 * Playwright UI-smoke spec for the Chat View Memory Stability app flow using
 * the real renderer fixture.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import { CHAT_PREFILL_EVENT } from "../../../ui/src/events";
import {
  expectNoPageDiagnostics,
  expectNoRenderTelemetryErrors,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  openAppPath,
  seedAppStorage,
} from "./helpers";

type RuntimeMetrics = {
  jsHeapUsedSize: number;
  jsHeapTotalSize: number;
  nodes: number;
  documents: number;
  jsEventListeners: number;
};

const MI_B = 1024 * 1024;
const ROUTE_SETTLE_MS = 120;
const DEFAULT_ROUTE_CYCLES = 8;
const MAX_ROUTE_CYCLES = 60;

function parseRouteCycleCount(): number {
  const raw = process.env.ELIZA_UI_SMOKE_MEMORY_CYCLES?.trim();
  if (!raw) return DEFAULT_ROUTE_CYCLES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_ROUTE_CYCLES;
  return Math.min(parsed, MAX_ROUTE_CYCLES);
}

function metricMap(
  metrics: Array<{ name: string; value: number }>,
): Map<string, number> {
  return new Map(metrics.map((metric) => [metric.name, metric.value]));
}

async function collectRuntimeMetrics(page: Page): Promise<RuntimeMetrics> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Performance.enable");
    await session.send("HeapProfiler.enable").catch(() => {});
    await session.send("HeapProfiler.collectGarbage").catch(() => {});
    await page.waitForTimeout(150);
    const { metrics } = await session.send("Performance.getMetrics");
    const byName = metricMap(metrics);
    return {
      jsHeapUsedSize: byName.get("JSHeapUsedSize") ?? 0,
      jsHeapTotalSize: byName.get("JSHeapTotalSize") ?? 0,
      nodes: byName.get("Nodes") ?? 0,
      documents: byName.get("Documents") ?? 0,
      jsEventListeners: byName.get("JSEventListeners") ?? 0,
    };
  } finally {
    await session.detach().catch(() => {});
  }
}

function growth(before: number, after: number): number {
  return Math.max(0, after - before);
}

function expectBoundedRuntimeGrowth(
  before: RuntimeMetrics,
  after: RuntimeMetrics,
): void {
  const heapGrowth = growth(before.jsHeapUsedSize, after.jsHeapUsedSize);
  const nodeGrowth = growth(before.nodes, after.nodes);
  const listenerGrowth = growth(
    before.jsEventListeners,
    after.jsEventListeners,
  );
  const documentGrowth = growth(before.documents, after.documents);
  const summary = JSON.stringify({ before, after }, null, 2);

  expect(
    heapGrowth,
    `expected retained JS heap growth to stay bounded after repeated chat/view switching; metrics=${summary}`,
  ).toBeLessThanOrEqual(96 * MI_B);
  expect(
    after.jsHeapUsedSize,
    `expected final JS heap to stay near the warmed baseline; metrics=${summary}`,
  ).toBeLessThanOrEqual(
    Math.max(before.jsHeapUsedSize * 2.75, before.jsHeapUsedSize + 128 * MI_B),
  );
  expect(
    nodeGrowth,
    `expected DOM node growth to stay bounded after route cycles; metrics=${summary}`,
  ).toBeLessThanOrEqual(8_000);
  expect(
    after.nodes,
    `expected final DOM node count to stay near the warmed baseline; metrics=${summary}`,
  ).toBeLessThanOrEqual(Math.max(before.nodes * 2.5, before.nodes + 12_000));
  expect(
    listenerGrowth,
    `expected event-listener growth to stay bounded after route cycles; metrics=${summary}`,
  ).toBeLessThanOrEqual(2_000);
  expect(
    documentGrowth,
    `expected document count not to grow repeatedly across SPA route changes; metrics=${summary}`,
  ).toBeLessThanOrEqual(8);
}

async function navigateInPlace(page: Page, targetPath: string): Promise<void> {
  await page.evaluate((path) => {
    window.history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, targetPath);
  await expect(page).toHaveURL(
    new RegExp(
      `${targetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[?#].*)?$`,
    ),
  );
}

async function waitForRoute(
  page: Page,
  targetPath: string,
  marker: Locator,
): Promise<void> {
  await navigateInPlace(page, targetPath);
  await expect(marker).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(ROUTE_SETTLE_MS);
}

async function prefillChat(page: Page, text: string): Promise<void> {
  await page.evaluate(
    ({ eventName, value }) => {
      window.dispatchEvent(
        new CustomEvent(eventName, {
          detail: { text: value, select: true },
        }),
      );
    },
    { eventName: CHAT_PREFILL_EVENT, value: text },
  );
  await expect(page.getByTestId("chat-composer-textarea")).toHaveValue(text);
}

test.beforeEach(async ({ page }) => {
  installPageDiagnosticsGuard(page);
  await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
  await installDefaultAppRoutes(page);
});

test.afterEach(async ({ page }, testInfo) => {
  await expectNoPageDiagnostics(page, testInfo.title);
  await expectNoRenderTelemetryErrors(page, testInfo.title);
});

test("chat and routed views keep heap, DOM, and listeners bounded", async ({
  browserName,
  page,
}) => {
  const routeCycles = parseRouteCycleCount();
  test.setTimeout(Math.max(180_000, 45_000 + routeCycles * 8_000));
  test.skip(
    browserName !== "chromium",
    "CDP runtime metrics are Chromium-only.",
  );

  const composer = page.getByTestId("chat-composer-textarea");
  const calendar = page.getByTestId("calendar-view").first();
  const documents = page.getByTestId("documents-view").first();
  const taskCoordinator = page.getByTestId("task-coordinator-panel").first();

  await openAppPath(page, "/chat");
  await expect(composer).toBeVisible({ timeout: 20_000 });

  // Warm each route once so the baseline includes normal lazy imports, cached
  // plugin bundles, and first-render allocations. The measured cycles below
  // then catch retained growth, not expected startup work.
  await waitForRoute(page, "/calendar", calendar);
  await waitForRoute(page, "/character/documents", documents);
  await waitForRoute(page, "/task-coordinator", taskCoordinator);
  await waitForRoute(page, "/chat", composer);
  await prefillChat(page, "show my calendar");

  const before = await collectRuntimeMetrics(page);

  const prompts = [
    "show my documents",
    "what's on my calendar",
    "I want to add a new feature to my app",
  ];
  for (let index = 0; index < routeCycles; index += 1) {
    await waitForRoute(page, "/calendar", calendar);
    await waitForRoute(page, "/character/documents", documents);
    await waitForRoute(page, "/task-coordinator", taskCoordinator);
    await waitForRoute(page, "/chat", composer);
    await prefillChat(page, prompts[index % prompts.length]);
  }

  const after = await collectRuntimeMetrics(page);
  expectBoundedRuntimeGrowth(before, after);
});
