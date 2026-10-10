/**
 * Playwright UI-smoke spec for the Model Download Deferral app flow using the
 * real renderer fixture.
 */
import { recommendForFirstRun } from "@elizaos/plugin-native-inference/model-catalog/recommendation";
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  installRenderTelemetryGuard,
  seedAppStorage,
} from "./helpers";
import { installDesktopBridgeFixture } from "./helpers/desktop-bridge";

const DOWNLOAD_MODEL_ID = "eliza-1-4b";
const DOWNLOAD_MODEL = {
  id: DOWNLOAD_MODEL_ID,
  displayName: "eliza-1-4B",
  hfRepo: "elizaos/eliza-1",
  hfPathPrefix: "bundles/4b",
  ggufFile: "bundles/4b/text/eliza-1-4b-128k.gguf",
  bundleManifestFile: "bundles/4b/eliza-1.manifest.json",
  params: "4B",
  quant: "Eliza-1 optimized local runtime",
  sizeGb: 2.6,
  minRamGb: 8,
  category: "chat",
  bucket: "medium",
  contextLength: 131_072,
  tokenizerFamily: "eliza1",
  publishStatus: "published",
  activationEligible: true,
  blurb: "Smoke-test downloadable local tier.",
};

const DOWNLOAD_HUB_SNAPSHOT: Record<string, unknown> = {
  catalog: [DOWNLOAD_MODEL],
  installed: [],
  active: { modelId: null, loadedAt: null, status: "idle" },
  downloads: [],
  assignments: {},
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
    mobile: {
      platform: "ios",
      isSimulator: true,
      availableRamGb: 5,
      freeStorageGb: 64,
      gpuSupported: true,
      mtpSupported: true,
      source: "native",
    },
  },
  textReadiness: {
    updatedAt: "2026-01-01T00:00:00.000Z",
    slots: {},
  },
};

// Verifies the model-download deferral UX requirement: when a user picks the
// on-device runtime, selecting it must NOT trap them on a download/progress
// screen — onboarding finishes immediately and drops them into the main chat
// view while the model download proceeds in the background.
// Source of the behavior: first-run-finish.ts finishLocal() — it
// `void autoDownloadRecommendedLocalModelInBackground(...)` (fire-and-forget)
// then persists the first-run profile without awaiting the download.

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
  await installDesktopBridgeFixture(page);
  await page.addInitScript(() => {
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
  // Without this the default route reports first-run complete and the app skips
  // onboarding straight to the home view.
  await page.route("**/api/first-run/status", async (route) => {
    await fulfillJson(route, 200, { complete: false, cloudProvisioned: false });
  });
}

// The first-run provider step offers on-device only when the model catalog has
// a published Eliza-1 tier that passes the activation gate. Each test below
// covers one side of that gate.
const ON_DEVICE_MODEL_PUBLISHED = recommendForFirstRun() !== null;

interface LocalFinishObservations {
  firstRunPosted: boolean;
  backgroundDownloadStarted: boolean;
}

/** Drive first-run to the Local provider step and return the on-device choice. */
async function openProviderStep(
  page: Page,
  observed: LocalFinishObservations,
): Promise<ReturnType<Page["getByTestId"]>> {
  await installRenderTelemetryGuard(page);
  await installDefaultAppRoutes(page);
  await routeFirstRunIncomplete(page);
  await injectFullCapabilityHost(page);

  // Accept the first-run profile submission (POST /api/first-run).
  await page.route("**/api/first-run", async (route) => {
    if (route.request().method() === "POST") {
      observed.firstRunPosted = true;
      await fulfillJson(route, 200, { ok: true });
      return;
    }
    await route.fallback();
  });

  // Track the background download: the helper waits for /api/health, fetches
  // the hub, then queues a fit-aware model download. The hub must contain a
  // default-eligible model or the helper legitimately no-ops.
  await page.route("**/api/local-inference/**", async (route) => {
    const url = new URL(route.request().url());
    if (
      route.request().method() === "GET" &&
      url.pathname === "/api/local-inference/hub"
    ) {
      await fulfillJson(route, 200, DOWNLOAD_HUB_SNAPSHOT);
      return;
    }
    if (
      route.request().method() === "POST" &&
      (url.pathname.endsWith("/downloads") || url.pathname.endsWith("/active"))
    ) {
      observed.backgroundDownloadStarted = true;
      await fulfillJson(route, 200, {
        ok: true,
        job: { modelId: DOWNLOAD_MODEL_ID, status: "queued" },
      });
      return;
    }
    await fulfillJson(route, 200, { ok: true, models: [], installed: [] });
  });

  await seedAppStorage(page, {
    "eliza:first-run-complete": "",
    // These specs drive the Local/on-device runtime cards; the chooser is off
    // by default since cloud-only onboarding (#13377/#15532) - opt back in.
    "eliza:enable-runtime-chooser": "1",
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const chatOverlay = page.getByTestId("chat-overlay");
  await expect(chatOverlay).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("first-run-runtime-chooser")).toHaveCount(0);
  const runtimeChoice = page.getByTestId("choice-__first_run__:runtime:local");
  await expect(runtimeChoice).toBeVisible({ timeout: 15_000 });

  // This device → provider step.
  await runtimeChoice.click();
  const onDevice = page.getByTestId("choice-__first_run__:provider:on-device");
  await expect(onDevice).toBeVisible({ timeout: 10_000 });
  return onDevice;
}

test("on-device inference is labeled unavailable and refused while no Eliza-1 tier is published", async ({
  page,
}) => {
  test.skip(
    ON_DEVICE_MODEL_PUBLISHED,
    "the catalog has a published, activation-eligible Eliza-1 tier",
  );
  const observed: LocalFinishObservations = {
    firstRunPosted: false,
    backgroundDownloadStarted: false,
  };
  const onDevice = await openProviderStep(page, observed);
  await expect(onDevice).toContainText("unavailable");
  await expect(onDevice).not.toContainText("recommended");
  await expect(
    page.getByTestId("choice-__first_run__:provider:elizacloud"),
  ).toContainText("recommended");

  await onDevice.click();

  // The tap is refused with the reason and the provider choice is re-offered;
  // no local agent is started and nothing is persisted or downloaded.
  await expect(
    page.getByText("There is no on-device model to download yet", {
      exact: false,
    }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByTestId("choice-__first_run__:tutorial:skip"),
  ).toHaveCount(0);
  expect(observed.firstRunPosted).toBe(false);
  expect(observed.backgroundDownloadStarted).toBe(false);
});

test("selecting on-device inference drops the user into chat while the model downloads in the background", async ({
  page,
}) => {
  test.skip(
    !ON_DEVICE_MODEL_PUBLISHED,
    "no published Eliza-1 tier passes the activation gate, so first-run refuses on-device",
  );
  const observed: LocalFinishObservations = {
    firstRunPosted: false,
    backgroundDownloadStarted: false,
  };
  const onDevice = await openProviderStep(page, observed);
  await onDevice.click();

  // THE requirement: picking on-device does NOT park the user on a blocking
  // download/progress screen. finishLocal() kicks the model download off in the
  // background (fire-and-forget) and immediately advances the conductor to the
  // tutorial-or-skip CHOICE — proof the user is never trapped on a download UI.
  const skipTutorial = page.getByTestId("choice-__first_run__:tutorial:skip");
  await expect(skipTutorial).toBeVisible({ timeout: 25_000 });

  // And the download was deferred to the background (kicked off, not awaited)
  // before the user even reaches the tutorial step.
  await expect
    .poll(() => observed.backgroundDownloadStarted, { timeout: 15_000 })
    .toBe(true);

  // Completing the tutorial step flips first-run complete and drops the user
  // into the main chat view with a usable composer (no blocking download).
  await skipTutorial.click();
  await expect(page.getByTestId("chat-composer-textarea")).toBeVisible({
    timeout: 25_000,
  });
});
