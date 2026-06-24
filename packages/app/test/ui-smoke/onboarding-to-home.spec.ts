import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  expectNoPageDiagnostics,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  seedAppStorage,
} from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

// CRITICAL FLOW — completing onboarding lands on the HOME screen (the floating
// chat overlay over the home widgets), and a swipe-left flips to the
// springboard launcher.
//
// This boots a fresh device (no first-run-complete), drives the REAL onboarding
// UI to completion via the simplest non-cloud path — Local runtime →
// on-device ("all-local") inference — which calls
// completeFirstRun("chat", { launchCompanionOverlay: true }). That sets the tab
// to "chat" → ChatRouteShellContent → HomeScreenMount(initialPage="home") →
// HomeSpringboardSurface(home=HomeScreen[<WidgetHost slot="home">],
// springboard=SpringboardSurface). So the post-onboarding landing is the home:
// the ContinuousChatOverlay composer is present AND the home widget host renders
// its seeded per-plugin cards. A real left-flick on the home page then pans the
// rail to the springboard (data-page="springboard") and reveals a launcher tile.
//
// To reach the home with populated widgets, the same lifeops/health/relationship
// + notification data the home-widget-priority spec seeds is provided here, plus
// a non-empty views catalog (the home WidgetHost only mounts when the catalog
// has visible views).

const SCREENSHOT_DIR = path.join(
  process.cwd(),
  "aesthetic-audit-output",
  "onboarding-to-home",
);

const SMOKE_GENERATED_AT = "2026-01-01T00:00:00.000Z";

// Launcher views so the springboard is non-empty (the home WidgetHost only
// renders when the catalog has visible views) AND so a known springboard tile
// (`springboard-tile-settings`) is assertable. `settings` is a system entry id.
const VIEW_FIXTURES = [
  {
    id: "views-manager",
    label: "Views",
    description: "Browse and launch every available view",
    path: "/views",
    available: true,
    pluginName: "core",
    builtin: true,
    tags: ["launcher"],
    desktopTabEnabled: true,
  },
  {
    id: "settings",
    label: "Settings",
    description: "Settings view",
    path: "/settings",
    available: true,
    pluginName: "core",
    builtin: true,
    tags: ["system"],
    desktopTabEnabled: true,
  },
  {
    id: "calendar",
    label: "Calendar",
    description: "Calendar view",
    path: "/calendar",
    available: true,
    pluginName: "calendar",
    tags: ["calendar"],
    desktopTabEnabled: true,
  },
  {
    id: "goals",
    label: "Goals",
    description: "Goals view",
    path: "/goals",
    available: true,
    pluginName: "goals",
    tags: ["goals"],
    desktopTabEnabled: true,
  },
  {
    id: "finances",
    label: "Finances",
    description: "Finances view",
    path: "/finances",
    available: true,
    pluginName: "finances",
    tags: ["finances"],
    desktopTabEnabled: true,
  },
];

// The home widgets resolve only when the matching plugin id is enabled+active in
// the runtime snapshot (registry.ts `isWidgetEnabled`).
function pluginInfo(id: string, name: string) {
  return {
    id,
    name,
    description: `${name} (ui-smoke)`,
    enabled: true,
    isActive: true,
    configured: true,
    envKey: null,
    category: "feature" as const,
    source: "bundled" as const,
    parameters: [],
    validationErrors: [],
    validationWarnings: [],
  };
}

const PLUGIN_SNAPSHOT = [
  pluginInfo("calendar", "Calendar"),
  pluginInfo("goals", "Goals"),
  pluginInfo("finances", "Finances"),
  pluginInfo("health", "Health"),
  pluginInfo("relationships", "Relationships"),
  pluginInfo("agent-orchestrator", "Agent Orchestrator"),
];

async function fulfillJson(
  route: Route,
  body: Record<string, unknown> | unknown[],
  status = 200,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

// -- Seeded attention payloads (mirror home-widget-priority.spec) -------------

function moneyDashboard() {
  return {
    spending: { netUsd: -125.5 },
    generatedAt: SMOKE_GENERATED_AT,
  };
}
function moneySources() {
  return { sources: [{ id: "src-1", status: "active", label: "Checking" }] };
}
function moneyRecurring() {
  const inDays = (n: number) =>
    new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
  return {
    charges: [
      {
        merchantNormalized: "netflix",
        merchantDisplay: "Netflix",
        cadence: "monthly",
        averageAmountUsd: 15.99,
        nextExpectedAt: inDays(3),
        category: "entertainment",
      },
    ],
  };
}
function goalsPayload() {
  return {
    goals: [
      {
        goal: {
          id: "goal-at-risk",
          title: "Ship the release",
          status: "active",
          reviewState: "at_risk",
        },
        links: [],
      },
    ],
  };
}
function calendarFeed() {
  const startAt = new Date(Date.now() + 45 * 60 * 1000).toISOString();
  const endAt = new Date(Date.now() + 105 * 60 * 1000).toISOString();
  return {
    events: [
      {
        id: "evt-soon",
        title: "Design review",
        startAt,
        endAt,
        isAllDay: false,
        location: "Zoom",
      },
    ],
  };
}
function sleepHistory() {
  return {
    episodes: [
      {
        startedAt: "2026-01-01T23:30:00.000Z",
        endedAt: "2026-01-02T05:15:00.000Z",
        durationMin: 345,
      },
    ],
    summary: {
      cycleCount: 6,
      averageDurationMin: 360,
      overnightCount: 6,
      napCount: 0,
      openCount: 0,
    },
    windowDays: 14,
    includeNaps: true,
  };
}
function sleepRegularity() {
  return {
    classification: "irregular",
    sri: 41.2,
    sampleSize: 6,
    windowDays: 14,
  };
}
function relationshipsPeople() {
  return {
    data: [
      {
        groupId: "grp-pat",
        primaryEntityId: "ent-pat",
        memberEntityIds: ["ent-pat"],
        displayName: "Pat Doe",
        aliases: [],
        platforms: ["discord"],
        identities: [],
        emails: [],
        phones: [],
        websites: [],
        preferredCommunicationChannel: null,
        categories: [],
        tags: [],
        factCount: 0,
        relationshipCount: 1,
        isOwner: false,
        profiles: [],
        lastInteractionAt: "2026-04-01T00:00:00.000Z",
      },
    ],
    stats: { totalPeople: 1, totalRelationships: 1, totalIdentities: 1 },
  };
}
function relationshipsCandidates() {
  return {
    data: [
      {
        id: "cand-1",
        entityA: "ent-pat",
        entityB: "ent-patrick",
        confidence: 0.88,
        evidence: { platform: "discord", handle: "pat#1" },
        status: "pending",
        proposedAt: SMOKE_GENERATED_AT,
      },
    ],
  };
}
function notificationsPayload() {
  return {
    notifications: [
      {
        id: "notif-urgent",
        title: "Payment failed",
        body: "Your card was declined for the Acme invoice.",
        category: "system",
        priority: "urgent",
        source: "finances",
        createdAt: Date.now(),
        readAt: null,
      },
    ],
    unreadCount: 1,
  };
}

// A full-capability host (real API base + an Electrobun window id) so the
// onboarding offers — and ENABLES — the Local runtime card. `__electrobunWindowId`
// makes isElectrobunRuntime()→isDesktopPlatform() true, which is what
// canSelectLocalRuntime() keys off (without it the Local card is rendered but
// disabled on a cloud-only host).
//
// The local first-run path resolves the on-device agent base via
// resolveFirstRunLocalAgentApiBase() → getElizaApiBase() (which reads
// __ELIZA_API_BASE__ / __ELIZAOS_API_BASE__, NOT __ELIZA_APP_API_BASE__). Pin
// all three to the page origin so client.setBaseUrl() in finishLocal keeps every
// request on the live preview origin (and the route mocks) instead of falling
// back to DEFAULT_LOCAL_AGENT_API_BASE (http://127.0.0.1:31337), which has no
// server → ERR_CONNECTION_REFUSED on the chat/home surface.
async function injectFullCapabilityHost(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const origin = window.location.origin;
    const win = window as unknown as Record<string, unknown>;
    win.__ELIZA_APP_API_BASE__ = origin;
    win.__ELIZA_API_BASE__ = origin;
    win.__ELIZAOS_API_BASE__ = origin;
    win.__electrobunWindowId = 1;
  });
}

async function routeFirstRunIncomplete(page: Page): Promise<void> {
  await page.route("**/api/auth/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      required: false,
      authenticated: true,
      loginRequired: false,
      localAccess: true,
      passwordConfigured: false,
      pairingEnabled: false,
      expiresAt: null,
    });
  });
  // Onboarding boots with first-run NOT complete so the onboarding surface
  // renders. submitFirstRun (POST /api/first-run) is the write the local finish
  // performs before completeFirstRun.
  await page.route("**/api/first-run/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, { complete: false, cloudProvisioned: false });
  });
  await page.route("**/api/first-run", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, { ok: true });
  });
}

async function installHomeRoutes(page: Page): Promise<void> {
  await installDefaultAppRoutes(page);
  await routeFirstRunIncomplete(page);

  await page.route("**/api/config", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      cloud: { enabled: false },
      media: {},
      plugins: { entries: {} },
      ui: { avatarIndex: 1 },
      wallet: {},
    });
  });

  await page.route("**/api/stream/settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, { settings: { avatarIndex: 1 } });
  });
  await page.route("**/api/agent/events**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      events: [],
      latestEventId: null,
      totalBuffered: 0,
      replayed: true,
    });
  });

  // Local-inference shell-level GETs — a fresh agent has no local model, so an
  // idle/unsupported snapshot matches real zero-state (and the local first-run
  // path's background auto-download probe lands on this empty hub).
  await page.route("**/api/local-inference/hub", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const emptyDownload = {
      state: "idle",
      percent: null,
      etaMs: null,
      bytesDownloaded: 0,
      bytesTotal: 0,
      error: null,
    };
    const slot = (name: string) => ({
      slot: name,
      assigned: false,
      assignedModelId: null,
      displayName: null,
      primaryDownloaded: false,
      downloaded: false,
      active: false,
      ready: false,
      state: "unassigned",
      requiredModelIds: [],
      missingModelIds: [],
      installedBytes: 0,
      expectedBytes: 0,
      download: emptyDownload,
      errors: [],
    });
    await fulfillJson(route, {
      catalog: [],
      installed: [],
      active: {
        modelId: null,
        loaded: false,
        status: "idle",
        error: null,
        updatedAt: new Date(0).toISOString(),
      },
      downloads: [],
      hardware: { status: "unsupported" },
      assignments: {},
      textReadiness: {
        updatedAt: new Date(0).toISOString(),
        slots: {
          TEXT_SMALL: slot("TEXT_SMALL"),
          TEXT_LARGE: slot("TEXT_LARGE"),
        },
      },
    });
  });
  await page.route(
    "**/api/local-inference/downloads/stream**",
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: "",
      });
    },
  );

  // The plugin snapshot drives which per-plugin home widgets resolve.
  await page.route("**/api/plugins", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, { plugins: PLUGIN_SNAPSHOT });
  });

  // Views catalog — populate the springboard so the home WidgetHost mounts.
  await page.route("**/api/views**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/views/search") {
      await fulfillJson(route, { results: VIEW_FIXTURES });
      return;
    }
    await fulfillJson(route, { views: VIEW_FIXTURES });
  });

  // Seeded attention data for every per-plugin home widget.
  await page.route("**/api/lifeops/money/dashboard**", async (route) => {
    await fulfillJson(route, moneyDashboard());
  });
  await page.route("**/api/lifeops/money/recurring**", async (route) => {
    await fulfillJson(route, moneyRecurring());
  });
  await page.route("**/api/lifeops/money/sources**", async (route) => {
    await fulfillJson(route, moneySources());
  });
  await page.route("**/api/lifeops/goals**", async (route) => {
    await fulfillJson(route, goalsPayload());
  });
  await page.route("**/api/lifeops/calendar/feed**", async (route) => {
    await fulfillJson(route, calendarFeed());
  });
  await page.route("**/api/lifeops/sleep/history**", async (route) => {
    await fulfillJson(route, sleepHistory());
  });
  await page.route("**/api/lifeops/sleep/regularity**", async (route) => {
    await fulfillJson(route, sleepRegularity());
  });
  await page.route("**/api/relationships/people**", async (route) => {
    await fulfillJson(route, relationshipsPeople());
  });
  await page.route("**/api/relationships/candidates**", async (route) => {
    await fulfillJson(route, relationshipsCandidates());
  });

  // Notification inbox hydrate — the notifications widget + the urgent signal.
  // (installDefaultAppRoutes registers an empty default; this override wins.)
  await page.route("**/api/notifications**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, notificationsPayload());
  });
}

async function settleHomeEntrance(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const home = document.querySelector('[data-testid="home-screen"]');
      if (!home) return false;
      const animating = (home as HTMLElement)
        .getAnimations({ subtree: true })
        .some(
          (a) =>
            (a as CSSAnimation).animationName === "home-enter" &&
            a.playState !== "finished",
        );
      return !animating;
    },
    undefined,
    { timeout: 5_000 },
  );
}

async function screenshot(page: Page, name: string): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await captureScreenshotWithQualityRetry(page, name, {
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
    fullPage: false,
    attempts: 4,
  });
}

// The WidgetSection testIds each widget renders (read from source).
const FINANCES_TESTID = "chat-widget-finances-alerts";
const GOALS_TESTID = "widget-goals-attention";
const NOTIFICATIONS_TESTID = "widget-notifications";

test.describe("onboarding → home → springboard", () => {
  test.beforeEach(({ page }) => {
    installPageDiagnosticsGuard(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await expectNoPageDiagnostics(page, testInfo.title);
  });

  test("completing onboarding lands on the home and swipe-left opens the springboard", async ({
    page,
  }) => {
    await rm(SCREENSHOT_DIR, { force: true, recursive: true });
    // No Electrobun RPC bridge is injected (matching first-run-startup.spec): the
    // local first-run path's bridge calls (getDesktopRuntimeMode → null,
    // agentStart → null) are non-throwing no-ops, and waitForAgentApi falls back
    // to the HTTP GET /api/auth/status mocked below, which resolves on the first
    // poll. Injecting a partial bridge could change which startup gate fires.
    await injectFullCapabilityHost(page);
    await installHomeRoutes(page);
    // Fresh device: no persisted first-run completion (mobile-runtime-mode left
    // unset so the local desktop path is taken).
    await seedAppStorage(page, { "eliza:first-run-complete": "" });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    // 1) Onboarding surface renders.
    const onboarding = page.getByTestId("onboarding-toast");
    await expect(onboarding).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("How should Eliza run?")).toBeVisible({
      timeout: 15_000,
    });

    // 2) Drive the REAL onboarding to completion via Local → on-device
    // inference. This is the simplest path that calls
    // completeFirstRun("chat", { launchCompanionOverlay: true }) without a cloud
    // sign-in (all-local does not need a cloud connect).
    const local = page.getByTestId("onboarding-option-local");
    await expect(local).toBeVisible({ timeout: 15_000 });
    await expect(local).toBeEnabled({ timeout: 15_000 });
    await local.click();

    const inferenceLocal = page.getByTestId("onboarding-inference-local");
    await expect(inferenceLocal).toBeVisible({ timeout: 15_000 });
    await inferenceLocal.click();

    // 3) Landing is the HOME: the floating chat overlay is present AND the home
    // widget host renders its seeded per-plugin cards.
    const chatOverlay = page.getByTestId("continuous-chat-overlay");
    await expect(chatOverlay).toBeVisible({ timeout: 60_000 });

    const host = page.getByTestId("widget-host-home");
    await expect(host).toBeVisible({ timeout: 30_000 });

    for (const testId of [
      FINANCES_TESTID,
      GOALS_TESTID,
      NOTIFICATIONS_TESTID,
    ]) {
      await expect(
        host.getByTestId(testId),
        `home widget ${testId} should render with seeded attention data`,
      ).toBeVisible({ timeout: 30_000 });
    }
    await expect(host.getByTestId(FINANCES_TESTID)).toContainText("Overdrawn");
    await expect(host.getByTestId(GOALS_TESTID)).toContainText(
      "Ship the release",
    );
    await expect(host.getByTestId(NOTIFICATIONS_TESTID)).toContainText(
      "Payment failed",
    );

    // The onboarding surface is gone now that we are on the home.
    await expect(onboarding).toHaveCount(0, { timeout: 15_000 });

    const surface = page.getByTestId("home-springboard-surface");
    await expect(surface).toHaveAttribute("data-page", "home");

    // Capture the populated home.
    await settleHomeEntrance(page);
    await screenshot(page, "home");

    // 4) Swipe-left on the home page → the rail pans to the springboard. Use a
    // real left-flick (pointer drag) over the home page, exactly the gesture
    // HomeSpringboardSurface's pointer handlers consume (threshold 72px, mostly
    // horizontal), proving the in-app swipe — not just the navigation event.
    const homePage = page.getByTestId("home-springboard-home-page");
    await expect(homePage).toBeVisible();
    const box = await homePage.boundingBox();
    if (!box) throw new Error("home-springboard-home-page has no bounding box");
    const startX = box.x + box.width * 0.72;
    const midY = box.y + box.height * 0.5;
    await page.mouse.move(startX, midY);
    await page.mouse.down();
    // Several steps so pointermove fires with a clearly-horizontal, > -72px dx.
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(startX - i * 40, midY);
    }
    await page.mouse.up();

    await expect(surface).toHaveAttribute("data-page", "springboard", {
      timeout: 10_000,
    });
    const springboardPage = page.getByTestId(
      "home-springboard-springboard-page",
    );
    await expect(springboardPage).toBeVisible();
    // A real launcher tile is visible on the springboard.
    await expect(
      springboardPage.getByTestId("springboard-tile-settings"),
    ).toBeVisible({ timeout: 15_000 });

    // The rail slides over 300ms; wait until nothing in the rail subtree is
    // still animating so the shot shows the settled launcher.
    await page.waitForFunction(
      () => {
        const rail = document.querySelector(
          '[data-testid="home-springboard-rail"]',
        );
        if (!rail) return false;
        return !(rail as HTMLElement)
          .getAnimations({ subtree: true })
          .some((a) => a.playState === "running");
      },
      undefined,
      { timeout: 5_000 },
    );
    await screenshot(page, "springboard");
  });
});
