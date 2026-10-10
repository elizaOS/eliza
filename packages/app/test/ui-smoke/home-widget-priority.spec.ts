/**
 * Playwright UI-smoke spec for the Home Widget Priority app flow using the
 * real renderer fixture.
 */

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import {
  expectNoPageDiagnostics,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  openAppPath,
  seedAppStorage,
  UI_SMOKE_CPU_ONLY_HARDWARE,
} from "./helpers";
import { installReadyDesktopStatusBridge } from "./helpers/desktop-status-bridge";
import { launcherGrid } from "./helpers/launcher-navigation";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

// Home retains the existing notification center and calendar surface. Populated
// goal/todo source fixtures prove that removed Today cards stay absent without
// deleting owner data. Desktop/mobile captures also retain launcher access.

const SCREENSHOT_DIR = testOutputPath(
  "aesthetic-audit",
  "home-widget-priority",
);

// A handful of launcher views so the launcher is non-empty (the home
// WidgetHost only renders when the catalog has visible views — see
// ViewCatalog.tsx's `totalVisible === 0` empty-state branch).
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
];

// Plugin snapshot (GET /api/plugins) — the home widgets resolve only when the
// matching plugin id is enabled+active in the runtime snapshot (registry.ts
// `isWidgetEnabled`). The kept sparse-home declarations key off calendar/goals/
// health/todo. Notifications are pinned outside WidgetHost.
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
  pluginInfo("health", "Health"),
  pluginInfo("todo", "Todos"),
];

async function fulfillJson(
  route: Route,
  body: Record<string, unknown> | unknown[],
): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

// -- Seeded attention payloads ------------------------------------------------

// GoalsAttentionWidget reads /api/lifeops/goals. A goal whose reviewState is
// at_risk -> escalation self-signal (weight 10) and renders an urgent row.
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
      {
        goal: {
          id: "goal-on-track",
          title: "Learn Spanish",
          status: "active",
          reviewState: "on_track",
        },
        links: [],
      },
    ],
  };
}

// CalendarUpcomingWidget reads /api/lifeops/calendar/feed. A timed event
// starting within the next 2h -> reminder self-signal (weight 6).
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

// HealthSleepWidget reads /api/lifeops/sleep/{history,regularity}. An
// "irregular" classification -> off-rhythm -> check-in self-signal (weight 4)
// and an urgent badge. A latest episode is required for the card to render.
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

// The pinned NotificationsHomeCenter reads the notification store, hydrated
// from GET /api/notifications ({ notifications, unreadCount }). The inbox is
// not a ranked tile — it renders in the pinned center below the time/weather
// base — but an urgent unread notification still emits escalation-weight
// signals to any RANKED widget subscribing via signalKinds
// (homeSignalsFromNotifications).
function notificationsPayload() {
  return {
    notifications: [
      {
        id: "notif-urgent",
        title: "Payment failed",
        body: "Your card was declined for the Acme invoice.",
        category: "system",
        priority: "urgent",
        source: "system",
        createdAt: Date.now(),
        readAt: null,
      },
    ],
    unreadCount: 1,
  };
}

async function installHomeWidgetRoutes(page: Page): Promise<void> {
  await installDefaultAppRoutes(page);

  await page.route("**/build-info.json", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      commit: "ui-smoke",
      shortCommit: "smoke",
      branch: "home-widget-priority",
      builtAt: new Date(0).toISOString(),
    });
  });

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

  await page.route("**/api/cloud/login", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      ok: true,
      sessionId: "home-widget-cloud-login",
      browserUrl:
        "https://www.elizacloud.ai/auth/cli-login?session=home-widget",
    });
  });
  await page.route("**/api/cloud/login/status**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      status: "authenticated",
      token: "home-widget-cloud-token",
      organizationId: "home-widget-org",
      userId: "home-widget-user",
    });
  });
  await page.route("**/api/cloud/login/persist", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, { success: true });
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

  // Local-inference shell-level GETs — the booted zero-key stack answers 501,
  // which the diagnostics guard treats as a failure. A fresh agent has no local
  // model, so an idle snapshot with valid OS-fallback hardware matches the
  // real zero-state.
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
      hardware: UI_SMOKE_CPU_ONLY_HARDWARE,
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

  // CalendarUpcomingWidget self-hides unless the Google connector probe finds
  // a usable connected account. Override the default zero-account smoke route
  // so seeded calendar feed data can render the real calendar card.
  await page.route("**/api/connectors/google/accounts", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      provider: "google",
      connectorId: "google",
      defaultAccountId: "acct-google-owner",
      accounts: [
        {
          id: "acct-google-owner",
          provider: "google",
          connectorId: "google",
          label: "Design Calendar",
          email: "design@example.test",
          status: "connected",
          enabled: true,
          role: "owner",
        },
      ],
    });
  });

  // Views catalog — populate the launcher so the home WidgetHost mounts.
  await page.route("**/api/views**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/views/search") {
      await fulfillJson(route, { results: VIEW_FIXTURES });
      return;
    }
    await fulfillJson(route, { views: VIEW_FIXTURES });
  });

  // Seeded attention data for kept sparse-home widgets.
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
  // Notification inbox hydrate — the pinned center + the urgent signal.
  await page.route("**/api/notifications**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, notificationsPayload());
  });
}

async function seedHomeWidgetStorage(page: Page): Promise<void> {
  await seedAppStorage(page, {
    "eliza:mobile-runtime-mode": "local",
    "eliza:permissions-primed": "1",
  });
}

// The home screen plays a staggered `home-enter` fade-up (opacity 0 -> 1,
// HomeScreen.tsx's HOME_ENTER_CSS) on its content blocks — including the
// WidgetHost wrapper. A `setViewportSize` restarts that animation from
// opacity:0, so a screenshot taken immediately after a resize captures the
// still-invisible cards over the bare ambient field. Wait for every running
// entrance animation in the home subtree to finish before each capture so the
// shot shows the populated, fully-opaque widgets.
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
  await settleHomeEntrance(page);
  await captureScreenshotWithQualityRetry(page, name, {
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
    fullPage: false,
    attempts: 4,
  });
}

const CALENDAR_TESTID = "chat-widget-calendar-upcoming";
const NOTIFICATION_CENTER_TESTID = "home-notification-center";
const SEEDED_TESTIDS = [CALENDAR_TESTID];
const REMOVED_HOME_TESTIDS = [
  "chat-widget-todos",
  "today-todo-row",
  "todo-goal-attention-row",
  "chat-widget-relationships",
  "chat-widget-inbox-unread",
  "chat-widget-automations",
  // Routed goal and sleep components remain available without Home residents.
  "widget-goals-attention",
  "widget-health-sleep",
];

test.describe("home widget priority (#9143)", () => {
  test.beforeEach(({ page }) => {
    installPageDiagnosticsGuard(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await expectNoPageDiagnostics(page, testInfo.title);
  });

  test("keeps notifications and calendar without a separate Today section", async ({
    page,
  }) => {
    await rm(SCREENSHOT_DIR, { force: true, recursive: true });
    await seedHomeWidgetStorage(page);
    await installReadyDesktopStatusBridge(page);
    await installHomeWidgetRoutes(page);

    // The /chat home (HomeScreen) mounts the unified <WidgetHost slot="home">
    // (#9143). Views was consolidated into the Launcher, and the home-widget
    // surface now lives on the home page behind the floating chat overlay.
    await openAppPath(page, "/chat");

    const host = page.getByTestId("widget-host-home");
    await expect(host).toBeVisible({ timeout: 30_000 });

    // Every seeded widget renders its populated card (each self-hides when
    // empty, so visibility proves the data flowed through).
    for (const testId of SEEDED_TESTIDS) {
      await expect(
        host.getByTestId(testId),
        `home widget ${testId} should render with seeded attention data`,
      ).toBeVisible({ timeout: 30_000 });
    }

    await expect(host.getByText("Ship the release")).toHaveCount(0);
    for (const testId of REMOVED_HOME_TESTIDS) {
      await expect(
        host.getByTestId(testId),
        `removed resident card ${testId} must stay out of sparse home`,
      ).toHaveCount(0);
    }

    // The seeded urgent notification renders in the INLINE notification inbox —
    // NOT a ranked WidgetHost tile. The inbox is its own section on the home
    // column, so it must live OUTSIDE the ranked host.
    const notificationCenter = page.getByTestId(NOTIFICATION_CENTER_TESTID);
    await expect(notificationCenter).toBeVisible({ timeout: 30_000 });
    await expect(
      notificationCenter.getByTestId("notification-row"),
    ).toContainText("Payment failed");
    await expect(
      host.getByTestId(NOTIFICATION_CENTER_TESTID),
      "the notification inbox lives outside the ranked WidgetHost",
    ).toHaveCount(0);

    // Desktop screenshot (1280x900) of the retained Home surfaces.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(host).toBeVisible();
    await screenshot(page, "desktop");

    // Mobile screenshot (Pixel-7-ish 390px width).
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(host).toBeVisible();
    // Keep the calendar and existing center visible at the mobile width.
    for (const testId of SEEDED_TESTIDS) {
      await expect(host.getByTestId(testId)).toBeVisible({ timeout: 15_000 });
    }
    await expect(page.getByTestId(NOTIFICATION_CENTER_TESTID)).toBeVisible({
      timeout: 15_000,
    });
    await screenshot(page, "mobile");

    // This spec owns Home composition rather than gesture recognition. Exercise
    // the rail through its real desktop control, then return to the mobile
    // viewport for the launcher capture; dedicated pager specs own swipes.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByTestId("rail-pager-edge-next").click();
    await expect(page.getByTestId("home-launcher-surface")).toHaveAttribute(
      "data-page",
      "launcher",
      { timeout: 10_000 },
    );
    await page.setViewportSize({ width: 390, height: 844 });
    const grid = launcherGrid(page);
    await expect(grid).toBeVisible({
      timeout: 15_000,
    });
    await expect(grid.getByTestId("launcher-tile-settings")).toBeVisible({
      timeout: 15_000,
    });
    await screenshot(page, "launcher");
  });
});
