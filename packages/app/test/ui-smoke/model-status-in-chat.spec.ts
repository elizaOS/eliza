import { expect, type Page, type Route, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  installRenderTelemetryGuard,
  seedAppStorage,
} from "./helpers";

// Verifies WI-4 (#12178 / #12367): while a local text model is still
// downloading, the in-chat model-status conductor seeds ONE live status turn
// (`model:download-status`) into the transcript — progress + the Cancel /
// Switch-to-Eliza-Cloud / Keep-waiting controls — and Cancel drives the real
// DELETE /downloads/:id. Behaviour source: use-model-status-conductor.ts +
// model-status-copy.ts (packages/ui). The download progress is mocked at the
// local-inference hub (a downloading TEXT_LARGE slot), exactly as
// model-download-deferral.spec.ts mocks the hub.

const DOWNLOAD_MODEL_ID = "eliza-1-2b";

function downloadingSlot(): Record<string, unknown> {
  return {
    slot: "TEXT_LARGE",
    assigned: true,
    assignedModelId: DOWNLOAD_MODEL_ID,
    displayName: "eliza-1-2b",
    primaryDownloaded: false,
    downloaded: false,
    active: false,
    ready: false,
    state: "downloading",
    requiredModelIds: [DOWNLOAD_MODEL_ID],
    missingModelIds: [DOWNLOAD_MODEL_ID],
    installedBytes: 700_000_000,
    expectedBytes: 1_600_000_000,
    download: {
      state: "downloading",
      receivedBytes: 700_000_000,
      totalBytes: 1_600_000_000,
      percent: 43,
      bytesPerSec: 5_000_000,
      etaMs: 120_000,
      updatedAt: "2026-01-01T00:00:00.000Z",
      errors: [],
    },
    errors: [],
  };
}

function hubSnapshot(): Record<string, unknown> {
  return {
    catalog: [],
    installed: [],
    active: { modelId: null, loadedAt: null, status: "idle" },
    downloads: [],
    assignments: { TEXT_LARGE: DOWNLOAD_MODEL_ID },
    hardware: {
      platform: "ios",
      arch: "arm64",
      totalRamGb: 8,
      freeRamGb: 5,
      gpu: { backend: "metal", totalVramGb: 0, freeVramGb: 0 },
      cpuCores: 8,
      appleSilicon: true,
      recommendedBucket: "small",
      source: "os-fallback",
    },
    textReadiness: {
      updatedAt: "2026-01-01T00:00:00.000Z",
      slots: { TEXT_LARGE: downloadingSlot() },
    },
  };
}

async function fulfillJson(
  route: Route,
  status: number,
  body: Record<string, unknown>,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function injectFullCapabilityHost(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__ELIZA_APP_API_BASE__ =
      window.location.origin;
    (window as unknown as Record<string, number>).__electrobunWindowId = 1;
  });
}

async function routeFirstRunIncomplete(page: Page): Promise<void> {
  await page.route("**/api/auth/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, 200, {
      required: false,
      authenticated: true,
      loginRequired: false,
      localAccess: true,
    });
  });
  await page.route("**/api/first-run/status", async (route) => {
    await fulfillJson(route, 200, { complete: false, cloudProvisioned: false });
  });
}

test("in-chat model status turn shows progress + cancel while the model downloads", async ({
  page,
}) => {
  await installRenderTelemetryGuard(page);
  await installDefaultAppRoutes(page);
  await routeFirstRunIncomplete(page);
  await injectFullCapabilityHost(page);

  await page.route("**/api/first-run", async (route) => {
    if (route.request().method() === "POST") {
      await fulfillJson(route, 200, { ok: true });
      return;
    }
    await route.fallback();
  });

  // The download SSE stream: hold it open with a single keep-alive comment so
  // the hook's EventSource attaches without erroring (readiness is driven by the
  // hub fetch below, which the stream would only re-trigger).
  await page.route(
    "**/api/local-inference/downloads/stream**",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: ": connected\n\n",
      });
    },
  );

  let cancelHit = false;
  await page.route("**/api/local-inference/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (method === "GET" && url.pathname === "/api/local-inference/hub") {
      await fulfillJson(route, 200, hubSnapshot());
      return;
    }
    if (
      method === "DELETE" &&
      url.pathname.startsWith("/api/local-inference/downloads/")
    ) {
      cancelHit = true;
      await fulfillJson(route, 200, { cancelled: true });
      return;
    }
    if (method === "POST" && url.pathname.endsWith("/downloads")) {
      await fulfillJson(route, 200, {
        ok: true,
        job: { modelId: DOWNLOAD_MODEL_ID, status: "queued" },
      });
      return;
    }
    await fulfillJson(route, 200, { ok: true, models: [], installed: [] });
  });

  await seedAppStorage(page, { "eliza:first-run-complete": "" });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const chatOverlay = page.getByTestId("continuous-chat-overlay");
  await expect(chatOverlay).toBeVisible({ timeout: 20_000 });

  // Drive onboarding to the on-device path (kicks off the real local finish).
  const runtimeChoice = page.getByTestId("choice-__first_run__:runtime:local");
  await expect(runtimeChoice).toBeVisible({ timeout: 15_000 });
  await runtimeChoice.click();
  const onDevice = page.getByTestId("choice-__first_run__:provider:on-device");
  await expect(onDevice).toBeVisible({ timeout: 10_000 });
  await onDevice.click();

  // THE requirement: the in-chat model-status turn appears with live progress
  // and an always-reachable Cancel control (no floating pill).
  const cancelControl = page.getByTestId("choice-__model__:cancel");
  await expect(cancelControl).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("choice-__model__:switch-cloud")).toBeVisible();
  await expect(page.getByText(/43%/)).toBeVisible();

  // Cancel drives the real DELETE /downloads/:id and is not a dead end — the
  // turn flips to re-offer the download.
  await cancelControl.click();
  await expect.poll(() => cancelHit, { timeout: 10_000 }).toBe(true);
  await expect(page.getByTestId("choice-__model__:download")).toBeVisible({
    timeout: 10_000,
  });
});
