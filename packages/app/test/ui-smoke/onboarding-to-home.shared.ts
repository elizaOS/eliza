import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { installDefaultAppRoutes } from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

// Shared onboarding → home → springboard fixtures, route mocks, and assertions
// for the desktop-Chromium (onboarding-to-home.spec.ts) and mobile-viewport
// (onboarding-to-home-mobile.spec.ts) lanes. Both drive the SAME keyless flow —
// fresh device → real Local/on-device onboarding → completeFirstRun("chat") →
// home with seeded widgets → swipe-left → springboard — so the fixtures and the
// route layer live here once and the two specs differ only in browser context
// (desktop vs Pixel-class touch viewport) and screenshot output directory.

export const SMOKE_GENERATED_AT = "2026-01-01T00:00:00.000Z";

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
export async function injectFullCapabilityHost(page: Page): Promise<void> {
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

export async function installHomeRoutes(page: Page): Promise<void> {
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

export async function settleHomeEntrance(page: Page): Promise<void> {
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

export function makeScreenshotter(
  dir: string,
): (page: Page, name: string) => Promise<void> {
  return async (page, name) => {
    await mkdir(dir, { recursive: true });
    await captureScreenshotWithQualityRetry(page, name, {
      path: path.join(dir, `${name}.png`),
      fullPage: false,
      attempts: 4,
    });
  };
}

// The WidgetSection testIds each widget renders (read from source).
export const FINANCES_TESTID = "chat-widget-finances-alerts";
export const GOALS_TESTID = "widget-goals-attention";
export const NOTIFICATIONS_TESTID = "widget-notifications";

/**
 * Drive the REAL onboarding to completion via Local → on-device inference, then
 * assert the post-onboarding HOME: the continuous chat overlay is present and
 * the home widget host renders its seeded per-plugin cards. This is the simplest
 * path that calls completeFirstRun("chat", { launchCompanionOverlay: true })
 * without a cloud sign-in (all-local does not need a cloud connect). `click`
 * lets the mobile lane drive the onboarding cards with touch taps while the
 * desktop lane uses ordinary clicks.
 */
export async function completeOnboardingToHome(
  page: Page,
  click: (locator: Locator) => Promise<void>,
): Promise<{ onboarding: Locator; surface: Locator }> {
  // 1) Onboarding surface renders.
  const onboarding = page.getByTestId("onboarding-toast");
  await expect(onboarding).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("How should Eliza run?")).toBeVisible({
    timeout: 15_000,
  });

  // 2) Local → on-device inference.
  const local = page.getByTestId("onboarding-option-local");
  await expect(local).toBeVisible({ timeout: 15_000 });
  await expect(local).toBeEnabled({ timeout: 15_000 });
  await click(local);

  const inferenceLocal = page.getByTestId("onboarding-inference-local");
  await expect(inferenceLocal).toBeVisible({ timeout: 15_000 });
  await click(inferenceLocal);

  // 3) Landing is the HOME: the floating chat overlay is present AND the home
  // widget host renders its seeded per-plugin cards.
  const chatOverlay = page.getByTestId("continuous-chat-overlay");
  await expect(chatOverlay).toBeVisible({ timeout: 60_000 });

  const host = page.getByTestId("widget-host-home");
  await expect(host).toBeVisible({ timeout: 30_000 });

  for (const testId of [FINANCES_TESTID, GOALS_TESTID, NOTIFICATIONS_TESTID]) {
    await expect(
      host.getByTestId(testId),
      `home widget ${testId} should render with seeded attention data`,
    ).toBeVisible({ timeout: 30_000 });
  }
  await expect(host.getByTestId(FINANCES_TESTID)).toContainText("Overdrawn");
  await expect(host.getByTestId(GOALS_TESTID)).toContainText("Ship the release");
  await expect(host.getByTestId(NOTIFICATIONS_TESTID)).toContainText(
    "Payment failed",
  );

  // The onboarding surface is gone now that we are on the home.
  await expect(onboarding).toHaveCount(0, { timeout: 15_000 });

  const surface = page.getByTestId("home-springboard-surface");
  await expect(surface).toHaveAttribute("data-page", "home");
  return { onboarding, surface };
}

/**
 * Swipe-left on the home page → the rail pans to the springboard, then assert a
 * real launcher tile. Uses a real left-flick that moves past the 72px
 * RAIL_FLICK_THRESHOLD. Touch-capable mobile contexts drive the gesture through
 * Chromium's touch-input path; desktop contexts use a mouse pointer drag.
 */
export async function swipeLeftToSpringboard(
  page: Page,
  surface: Locator,
): Promise<void> {
  const homePage = page.getByTestId("home-springboard-home-page");
  await expect(homePage).toBeVisible();
  const box = await homePage.boundingBox();
  if (!box) throw new Error("home-springboard-home-page has no bounding box");
  const startX = box.x + box.width * 0.72;
  const midY = box.y + box.height * 0.5;
  const touchCapable = await page.evaluate(
    () =>
      navigator.maxTouchPoints > 0 ||
      window.matchMedia("(pointer: coarse)").matches,
  );

  if (touchCapable) {
    const client = await page.context().newCDPSession(page);
    try {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: startX, y: midY, id: 1, radiusX: 4, radiusY: 4 }],
      });
      for (let i = 1; i <= 6; i++) {
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [
            { x: startX - i * 40, y: midY, id: 1, radiusX: 4, radiusY: 4 },
          ],
        });
      }
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    } finally {
      await client.detach().catch(() => undefined);
    }
  } else {
    await page.mouse.move(startX, midY);
    await page.mouse.down();
    // Several steps so pointermove fires with a clearly-horizontal, > -72px dx.
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(startX - i * 40, midY);
    }
    await page.mouse.up();
  }

  await expect(surface).toHaveAttribute("data-page", "springboard", {
    timeout: 10_000,
  });
  const springboardPage = page.getByTestId("home-springboard-springboard-page");
  await expect(springboardPage).toBeVisible();
  // A real launcher tile is visible on the springboard.
  await expect(
    springboardPage.getByTestId("springboard-tile-settings"),
  ).toBeVisible({ timeout: 15_000 });

  // The rail slides over 300ms; wait until nothing in the rail subtree is still
  // animating so a shot shows the settled launcher.
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
}
