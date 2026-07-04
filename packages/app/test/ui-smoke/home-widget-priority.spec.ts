/**
 * Playwright UI-smoke spec for the Home Widget Priority app flow using the
 * real renderer fixture.
 */
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  expectNoPageDiagnostics,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { mousePointerDrag } from "./helpers/gesture-inputs";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

// #9143 — the home launcher mounts <WidgetHost slot="home"> and ranks the
// per-plugin home widgets by importance: a stable base order plus live
// activity/notification signals plus each widget's self-published attention.
// This spec boots the app to the Views launcher with the lifeops/health/
// relationships plugins enabled+active, seeds ATTENTION-worthy data into every
// widget's data source (overdrawn balance, at-risk goal, imminent calendar
// event, irregular sleep, a pending relationships merge, an urgent
// notification), and proves the urgent widgets render AND rank at the top of
// the home host. Desktop + mobile screenshots land under
// aesthetic-audit-output/home-widget-priority/.

const SCREENSHOT_DIR = path.join(
  process.cwd(),
  "aesthetic-audit-output",
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

const SMOKE_GENERATED_AT = "2026-01-01T00:00:00.000Z";

// Plugin snapshot (GET /api/plugins) — the home widgets resolve only when the
// matching plugin id is enabled+active in the runtime snapshot (registry.ts
// `isWidgetEnabled`). The widget declarations key off the normalized plugin id
// (calendar/goals/finances/health/relationships). Notifications + messages are
// always-visible core surfaces; agent-orchestrator is in the fallback set.
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
): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

// -- Seeded attention payloads ------------------------------------------------

// FinancesAlertsWidget reads /api/lifeops/money/{dashboard,recurring,sources}.
// netUsd < 0 -> overdrawn -> escalation self-signal (weight 10). A connected
// source is required for the widget to render at all.
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

// RelationshipsAttentionWidget reads client.getRelationshipsPeople() ->
// GET /api/relationships/people ({ data, stats }) and
// client.getRelationshipsCandidates() -> GET /api/relationships/candidates
// ({ data }). A pending merge candidate -> approval self-signal (weight 9).
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

// NotificationsWidget reads the notification store, hydrated from
// GET /api/notifications ({ notifications, unreadCount }). An urgent unread
// notification -> escalation-weight (10) home signal.
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

async function installHomeWidgetRoutes(page: Page): Promise<void> {
  await installDefaultAppRoutes(page);

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
  // model, so an idle/unsupported snapshot matches real zero-state.
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

  // Views catalog — populate the launcher so the home WidgetHost mounts.
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
  });
}

async function installReadyDesktopStatusBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Bridge = {
      request?: Record<string, (params?: unknown) => Promise<unknown>>;
      onMessage?: (
        messageName: string,
        listener: (payload: unknown) => void,
      ) => void;
      offMessage?: (
        messageName: string,
        listener: (payload: unknown) => void,
      ) => void;
    };
    const win = window as Window & { __ELIZA_ELECTROBUN_RPC__?: Bridge };
    const existing = win.__ELIZA_ELECTROBUN_RPC__;
    const now = Date.now();
    const readyStatus = {
      state: "running",
      agentName: "Playwright Smoke",
      model: "ui-smoke",
      uptime: 60_000,
      startedAt: now - 60_000,
      pendingRestart: false,
      pendingRestartReasons: [],
      startup: { phase: "running", attempt: 0 },
    };
    const readyLaunch = {
      phase: "ready",
      agent: {
        state: "running",
        port: null,
        apiBase: null,
        startedAt: now - 60_000,
        error: null,
      },
      boot: {
        runtimePhase: "running",
        pluginsLoaded: 0,
        pluginsFailed: 0,
        database: "ok",
      },
      auth: { checked: true, required: false },
      firstRun: { checked: true, complete: true, cloudProvisioned: true },
      remotes: { seeded: true, requiredStarted: false, errors: [] },
      localModel: { backgroundDownloadQueued: false, blocking: false },
      diagnostics: { logPath: "", statusPath: "" },
      recovery: {
        canRetry: false,
        canOpenLogs: false,
        canCreateBugReport: false,
      },
      updatedAt: new Date(now).toISOString(),
    };
    const readyBoot = {
      state: "running",
      phase: "running",
      lastError: null,
      pluginsLoaded: 0,
      pluginsFailed: 0,
      database: "ok",
      agentName: "Playwright Smoke",
      port: null,
      startedAt: now - 60_000,
    };
    const withReadyStatus = (bridge?: Bridge): Bridge => ({
      request: {
        ...(bridge?.request ?? {}),
        getAgentStatus: async () => readyStatus,
        launchProgress: async () => readyLaunch,
        bootProgress: async () => readyBoot,
      },
      onMessage: bridge?.onMessage ?? (() => {}),
      offMessage: bridge?.offMessage ?? (() => {}),
    });
    let currentBridge = withReadyStatus(existing);
    Object.defineProperty(win, "__ELIZA_ELECTROBUN_RPC__", {
      configurable: true,
      get() {
        return currentBridge;
      },
      set(nextBridge: Bridge | undefined) {
        currentBridge = withReadyStatus(nextBridge);
      },
    });
    localStorage.setItem(
      "elizaos:active-server",
      JSON.stringify({
        id: "local:playwright-smoke",
        kind: "local",
        label: "Playwright Smoke",
        apiBase: window.location.origin,
      }),
    );
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

// The WidgetSection testIds each widget renders (read from source — not guessed).
const FINANCES_TESTID = "chat-widget-finances-alerts";
const GOALS_TESTID = "widget-goals-attention";
const CALENDAR_TESTID = "chat-widget-calendar-upcoming";
const HEALTH_TESTID = "widget-health-sleep";
const RELATIONSHIPS_TESTID = "chat-widget-relationships";
const NOTIFICATIONS_TESTID = "widget-notifications";

const URGENT_TESTIDS = [FINANCES_TESTID, GOALS_TESTID, NOTIFICATIONS_TESTID];
const SEEDED_TESTIDS = [
  FINANCES_TESTID,
  GOALS_TESTID,
  CALENDAR_TESTID,
  HEALTH_TESTID,
  RELATIONSHIPS_TESTID,
  NOTIFICATIONS_TESTID,
];

/**
 * The rank order of the widgets inside widget-host-home, read from DOM document
 * order. The host renders each ranked widget as a direct child in importance
 * order (WidgetHost.tsx `displayed.map`), each wrapped in an error boundary, so
 * DOM order IS the rank order — robust to the responsive grid that puts two
 * cards on the same visual row (sorting by getBoundingClientRect().top alone
 * would tie row-mates). We collect each seeded widget's testid element and sort
 * by their relative document position.
 */
async function homeWidgetOrder(page: Page): Promise<string[]> {
  return page.evaluate((testIds: string[]) => {
    const host = document.querySelector('[data-testid="widget-host-home"]');
    if (!host) return [];
    const present: Array<{ id: string; el: Element }> = [];
    for (const id of testIds) {
      const el = host.querySelector(`[data-testid="${id}"]`);
      if (el) present.push({ id, el });
    }
    present.sort((a, b) => {
      if (a.el === b.el) return 0;
      const position = a.el.compareDocumentPosition(b.el);
      // DOCUMENT_POSITION_FOLLOWING (4): b comes after a → a first.
      return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    return present.map((entry) => entry.id);
  }, SEEDED_TESTIDS);
}

test.describe("home widget priority (#9143)", () => {
  test.beforeEach(({ page }) => {
    installPageDiagnosticsGuard(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await expectNoPageDiagnostics(page, testInfo.title);
  });

  test("ranks attention-worthy home widgets first on the launcher", async ({
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

    // Sanity-check the seeded urgent content actually rendered.
    await expect(host.getByTestId(FINANCES_TESTID)).toContainText("Overdrawn");
    await expect(host.getByTestId(GOALS_TESTID)).toContainText(
      "Ship the release",
    );
    await expect(host.getByTestId(NOTIFICATIONS_TESTID)).toContainText(
      "Payment failed",
    );

    // The ranking re-settles once useNow installs the real clock in an effect
    // (it returns 0 on the first render for determinism). Poll for the stable
    // post-effect order: the three urgent widgets (finances + goals at
    // escalation weight 10, notifications at escalation-weight 10) must occupy
    // the top of the host, ahead of the non-urgent calendar/health/
    // relationships cards.
    await expect
      .poll(
        async () => {
          const order = await homeWidgetOrder(page);
          const urgentRanks = URGENT_TESTIDS.map((id) => order.indexOf(id));
          if (urgentRanks.some((rank) => rank === -1)) return false;
          const maxUrgentRank = Math.max(...urgentRanks);
          // Every urgent widget sits in the leading block — no non-urgent
          // widget may appear before the last urgent one.
          return maxUrgentRank <= URGENT_TESTIDS.length - 1;
        },
        { timeout: 20_000, message: "urgent home widgets must rank first" },
      )
      .toBe(true);

    const finalOrder = await homeWidgetOrder(page);
    // Record the asserted ordering for the run log.
    console.log("HOME_WIDGET_ORDER>", JSON.stringify(finalOrder));
    expect(
      finalOrder.slice(0, URGENT_TESTIDS.length).sort(),
      `urgent widgets ${JSON.stringify(URGENT_TESTIDS)} should be the leading block; got ${JSON.stringify(finalOrder)}`,
    ).toEqual([...URGENT_TESTIDS].sort());

    // Desktop screenshot (1280x900) of the populated, ranked home host.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(host).toBeVisible();
    await screenshot(page, "desktop");

    // Mobile screenshot (Pixel-7-ish 390px width).
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(host).toBeVisible();
    // Keep the urgent widgets visible at the mobile width too.
    for (const testId of URGENT_TESTIDS) {
      await expect(host.getByTestId(testId)).toBeVisible({ timeout: 15_000 });
    }
    await screenshot(page, "mobile");

    // Launcher capture — the home (widgets) and the launcher (launcher
    // tiles) are the two pages of HomeLauncherSurface, sharing one ambient
    // wallpaper after the Views→Launcher consolidation. Flip to the launcher
    // page with a real leftward drag across the home half (the in-app rail
    // gesture, which calls `goLauncher()` directly) and screenshot the launcher
    // to capture the consolidated home↔launcher pair on the same surface.
    const surface = page.getByTestId("home-launcher-surface");
    const launcherPage = page.getByTestId("home-launcher-launcher-page");
    const homeHalf = page.getByTestId("home-launcher-home-page");
    await expect(homeHalf).toBeVisible({ timeout: 15_000 });
    await mousePointerDrag(page, homeHalf, -220, 4, { steps: 10 });
    await expect(surface).toHaveAttribute("data-page", "launcher", {
      timeout: 10_000,
    });
    await expect(launcherPage).toBeVisible();
    // The rail slides over 300ms (translate3d) and the launcher tiles play
    // their own entrance; wait until nothing in the rail subtree is still
    // animating so the shot shows the settled launcher rather than a mid-slide
    // frame straddling home + launcher.
    await page.waitForFunction(
      () => {
        const rail = document.querySelector(
          '[data-testid="home-launcher-rail"]',
        );
        if (!rail) return false;
        return !(rail as HTMLElement)
          .getAnimations({ subtree: true })
          .some((a) => a.playState === "running");
      },
      undefined,
      { timeout: 5_000 },
    );
    await screenshot(page, "launcher");
  });
});
