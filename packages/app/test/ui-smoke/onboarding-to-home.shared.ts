/**
 * Shared onboarding-to-home flow helpers used by desktop and mobile UI-smoke
 * specs.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, type Route } from "@playwright/test";
import { installDefaultAppRoutes } from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

// Shared onboarding → home → launcher fixtures, route mocks, and assertions
// for the desktop-Chromium (onboarding-to-home.spec.ts) and mobile-viewport
// (onboarding-to-home-mobile.spec.ts) lanes. Both drive the SAME keyless flow —
// fresh device → real Local/on-device onboarding → completeFirstRun("chat") →
// home with seeded widgets → swipe-left → launcher — so the fixtures and the
// route layer live here once and the two specs differ only in browser context
// (desktop vs Pixel-class touch viewport) and screenshot output directory.

export const SMOKE_GENERATED_AT = "2026-01-01T00:00:00.000Z";

// A valid (tiny, silent) mp3 so a mocked TTS POST returns decodable audio bytes
// instead of a 501, keeping the page-diagnostics guard clean when the tutorial
// narrator speaks. Same fixture the assistant-home-flow voice lane uses.
const TINY_MP3 = Buffer.from(
  "SUQzAwAAAAAAFlRTU0UAAAAMAAADTGF2ZjU4LjI5LjEwMAAA//tQAAAAAAAA",
  "base64",
);

// Launcher views so the launcher is non-empty (the home WidgetHost only
// renders when the catalog has visible views) AND so a known launcher tile
// (`launcher-tile-settings`) is assertable. `settings` is a system entry id.
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
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "content-type": "application/json",
    },
    body: requestAllowsBody(route) ? JSON.stringify(body) : "",
  });
}

function requestAllowsBody(route: Route): boolean {
  return route.request().method() !== "HEAD";
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
// resolveFirstRunLocalAgentApiBase() → getElizaApiBase() (which reads the
// boot-config apiBase, NOT __ELIZA_APP_API_BASE__). Seed the boot-config mirror
// (and the branded __ELIZAOS_API_BASE__) with the page origin so
// client.setBaseUrl() in finishLocal keeps every request on the live preview
// origin (and the route mocks) instead of falling back to
// DEFAULT_LOCAL_AGENT_API_BASE (http://127.0.0.1:31337), which has no server →
// ERR_CONNECTION_REFUSED on the chat/home surface.
export async function injectFullCapabilityHost(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const origin = window.location.origin;
    const win = window as unknown as Record<string, unknown>;
    win.__ELIZA_APP_API_BASE__ = origin;
    win.__ELIZAOS_APP_BOOT_CONFIG__ = { apiBase: origin };
    win.__ELIZAOS_API_BASE__ = origin;
    win.__electrobunWindowId = 1;
  });
}

// Mutable, page-scoped record of the writes the in-chat onboarding performs, so
// a spec can assert "POST /api/first-run fired exactly once" against the live
// network boundary (the single `persistFirstRun` funnel in first-run-finish.ts).
export interface OnboardingRouteState {
  firstRunPosts: unknown[];
}

async function routeFirstRunIncomplete(
  page: Page,
  state: OnboardingRouteState,
): Promise<void> {
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
  // Onboarding boots with first-run NOT complete so the in-chat conductor seeds
  // the greeting + runtime choice into the live floating chat. submitFirstRun
  // (POST /api/first-run) is the single write the finish use case performs
  // before completeFirstRun; we record every POST so the spec can prove the
  // exactly-once contract.
  await page.route("**/api/first-run/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      complete: state.firstRunPosts.length > 0,
      cloudProvisioned: false,
    });
  });
  await page.route("**/api/first-run", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    try {
      state.firstRunPosts.push(route.request().postDataJSON());
    } catch {
      state.firstRunPosts.push({});
    }
    await fulfillJson(route, { ok: true });
  });
}

export async function installHomeRoutes(
  page: Page,
): Promise<OnboardingRouteState> {
  const state: OnboardingRouteState = { firstRunPosts: [] };
  await installDefaultAppRoutes(page);
  await routeFirstRunIncomplete(page, state);

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

  await page.route("**/api/coding-agents", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillJson(route, {});
      return;
    }
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, []);
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
  // (installDefaultAppRoutes registers an empty default; this override wins.)
  await page.route("**/api/notifications**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, notificationsPayload());
  });

  // Benign TTS so the interactive tutorial's narrator (the "Take the tutorial"
  // branch speaks its first voice line through the REAL voice pipeline) does not
  // 501 against the stub and trip the page-diagnostics guard. A valid tiny mp3.
  await page.route("**/api/tts/**", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "audio/mpeg" },
      body: TINY_MP3,
    });
  });

  return state;
}

// ── Cloud-runtime onboarding routes ──────────────────────────────────────────
//
// The in-chat Cloud path (pick Cloud → OAuth card → cloud-agent choice → bind)
// is driven entirely by the conductor; the user never types a key. We mock the
// cloud login success at the network boundary the SAME way the existing cloud
// specs do: `/api/cloud/status` reports connected, a global auth token is
// injected (see `injectCloudAuthToken`), and `/api/cloud/compat/agents` lists
// one already-running agent whose bridge is this very page origin. Because that
// bound base owns the app-shell routes (`supportsFullAppShellRoutes` → true),
// the cloud finish persists first-run exactly once — same `persistFirstRun`
// funnel as Local — so the POST-once contract holds across runtimes.
export const CLOUD_AUTH_TOKEN = "ui-smoke-onboarding-cloud-token";
export const CLOUD_AGENT_ID = "ui-smoke-cloud-agent-1";
export const CLOUD_AGENT_NAME = "Smoke Cloud Agent";

/** Inject the cloud session token before React boots (getCloudAuthToken reads
 *  the canonical steward-session store first). */
export async function injectCloudAuthToken(page: Page): Promise<void> {
  await page.addInitScript((token) => {
    // STEWARD_TOKEN_KEY from @elizaos/shared/steward-session-client.
    window.localStorage.setItem("steward_session_token", token);
  }, CLOUD_AUTH_TOKEN);
}

export async function installCloudRoutes(page: Page): Promise<void> {
  await page.unroute("**/api/cloud/status").catch(() => {});
  await page.route("**/api/cloud/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      connected: true,
      enabled: true,
      cloudVoiceProxyAvailable: true,
      hasApiKey: true,
      userId: "ui-smoke-onboarding-user",
    });
  });

  await page.unroute("**/api/cloud/credits").catch(() => {});
  await page.route("**/api/cloud/credits", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      balance: 100,
      low: false,
      critical: false,
      authRejected: false,
    });
  });

  await page.route("**/api/cloud/login", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      ok: true,
      sessionId: "ui-smoke-onboarding-cloud-session",
      browserUrl:
        "https://www.elizacloud.ai/device/ui-smoke-onboarding-cloud-session",
    });
  });
  await page.route("**/api/cloud/login/status**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      status: "authenticated",
      token: CLOUD_AUTH_TOKEN,
      organizationId: "ui-smoke-onboarding-org",
      userId: "ui-smoke-onboarding-user",
    });
  });

  // The browser cloud path lists agents through the LOCAL proxy
  // (`/api/cloud/compat/agents`), not the direct cloud origin — see
  // getCloudCompatAgents (client-cloud.ts). One running agent whose bridge is
  // the page origin makes the bound base an app-shell base → first-run persists.
  await page.route("**/api/cloud/compat/agents", async (route) => {
    const request = route.request();
    const origin = new URL(request.url()).origin;
    if (request.method() === "GET") {
      await fulfillJson(route, {
        success: true,
        data: [
          {
            agent_id: CLOUD_AGENT_ID,
            agent_name: CLOUD_AGENT_NAME,
            status: "running",
            bridge_url: origin,
            web_ui_url: origin,
            containerUrl: origin,
            webUiUrl: origin,
            database_status: "ready",
            error_message: null,
            agent_config: {},
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
            last_heartbeat_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
      return;
    }
    if (request.method() === "POST") {
      await fulfillJson(route, {
        success: true,
        data: {
          agentId: CLOUD_AGENT_ID,
          agentName: CLOUD_AGENT_NAME,
          jobId: "",
          status: "running",
          nodeId: null,
          message: "Agent created",
        },
      });
      return;
    }
    await route.fallback();
  });

  await page.route("**/api/cloud/compat/agents/**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const origin = new URL(route.request().url()).origin;
    await fulfillJson(route, {
      success: true,
      data: {
        agent_id: CLOUD_AGENT_ID,
        agent_name: CLOUD_AGENT_NAME,
        status: "running",
        bridge_url: origin,
        web_ui_url: origin,
        containerUrl: origin,
        webUiUrl: origin,
        database_status: "ready",
        error_message: null,
        agent_config: {},
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        last_heartbeat_at: "2026-01-01T00:00:00.000Z",
      },
    });
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

// First-run runtime/provider buttons live in the real chat transcript. The
// headless conductor seeds the ChoiceWidgets and the chat action channel routes
// their sentinel values before they hit the server.
export const RUNTIME_CHOICE = (id: "cloud" | "local" | "remote"): string =>
  `choice-__first_run__:runtime:${id}`;
export const PROVIDER_CHOICE = (
  id: "on-device" | "elizacloud" | "other",
): string => `choice-__first_run__:provider:${id}`;
export const TUTORIAL_CHOICE = (id: "start" | "skip"): string =>
  `choice-__first_run__:tutorial:${id}`;
const CLOUD_AGENT_CHOICE = (id: string): string =>
  `choice-__first_run__:cloud-agent:${id}`;

// The removed full-screen onboarding surface used these testIds. Asserting they
// never appear proves the new flow is genuinely chat-first (no startup gate, no
// FirstRunChat surface) — onboarding paints the home + the real chat overlay.
const REMOVED_ONBOARDING_TESTIDS = [
  "first-run-chat",
  "first-run-greeting",
  "startup-first-run-background",
];

/**
 * Assert the FIRST painted surface of a fresh profile is the real app shell plus
 * the real chat overlay with in-transcript first-run choices — and that NONE of
 * the removed full-screen onboarding testIds exist.
 */
export async function expectChatFirstOnboarding(page: Page): Promise<Locator> {
  const chatOverlay = page.getByTestId("continuous-chat-overlay");
  await expect(chatOverlay).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText("First, where should your agent run?", { exact: false }),
  ).toBeVisible({ timeout: 20_000 });
  // The removed full-screen onboarding gate must be absent.
  for (const testId of REMOVED_ONBOARDING_TESTIDS) {
    await expect(
      page.getByTestId(testId),
      `removed onboarding surface ${testId} must not render (flow is chat-first)`,
    ).toHaveCount(0);
  }
  await expect(page.getByTestId(RUNTIME_CHOICE("cloud"))).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId(RUNTIME_CHOICE("local"))).toBeVisible();
  await expect(page.getByTestId(RUNTIME_CHOICE("remote"))).toBeVisible();
  await expect(page.getByTestId("first-run-runtime-chooser")).toHaveCount(0);

  // Onboarding surface (#12178): the composer is UNLOCKED (typed text is
  // answered by the in-chat conductor, never the server) with an inviting
  // placeholder, the backdrop is OPAQUE so the launcher/home is hidden, and the
  // pinned-open sheet is still non-dismissable — Escape must NOT collapse it.
  const composer = page.getByTestId("chat-composer-textarea");
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveAttribute(
    "placeholder",
    "Ask me anything — or pick an option",
  );
  await expect(page.getByTestId("chat-first-run-backdrop")).toHaveAttribute(
    "data-first-run-opaque",
    "true",
  );
  await expect(chatOverlay).toHaveAttribute("data-open", "true");
  await page.keyboard.press("Escape");
  // A gated Escape flips nothing; give a real collapse ample time to (not)
  // land so this negative assertion cannot false-pass on timing.
  await page.waitForTimeout(300);
  await expect(chatOverlay).toHaveAttribute("data-open", "true");
  await expect(page.getByTestId("chat-sheet")).toHaveAttribute(
    "data-detent",
    "full",
  );
  return chatOverlay;
}

/**
 * Assert the overlay AUTO-COLLAPSED on the completion edge: the moment
 * firstRunComplete flips, the sheet drops from the pinned FULL detent to the
 * composer-only resting state (revealing the home), and the composer unlocks.
 */
export async function expectOnboardingAutoCollapse(page: Page): Promise<void> {
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).not.toHaveAttribute("data-open", "true", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("chat-composer-textarea")).toBeEnabled({
    timeout: 15_000,
  });
}

/** Assert the seeded per-plugin home widgets render with their attention data. */
async function expectPopulatedHome(page: Page): Promise<Locator> {
  const host = page.getByTestId("widget-host-home");
  await expect(host).toBeVisible({ timeout: 30_000 });
  for (const testId of [FINANCES_TESTID, GOALS_TESTID, NOTIFICATIONS_TESTID]) {
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
  const surface = page.getByTestId("home-launcher-surface");
  await expect(surface).toHaveAttribute("data-page", "home");
  return surface;
}

/**
 * Drive the tutorial-or-skip CHOICE — the SINGLE real completion gate. The
 * conductor defers the store's `completeFirstRun` until this pick, so it is
 * reachable after EVERY runtime path. Picking either option flips
 * firstRunComplete and lands on "chat" (the home). `start` additionally launches
 * the interactive tutorial spotlight; `skip` lands straight on the home.
 */
async function pickTutorial(
  page: Page,
  click: (locator: Locator) => Promise<void>,
  choice: "start" | "skip",
): Promise<void> {
  const start = page.getByTestId(TUTORIAL_CHOICE("start"));
  const skip = page.getByTestId(TUTORIAL_CHOICE("skip"));
  await expect(start).toBeVisible({ timeout: 30_000 });
  await expect(skip).toBeVisible();
  await click(choice === "start" ? start : skip);
}

/**
 * Drive first-run to completion via Local → on-device inference →
 * tutorial-or-skip, then assert the post-onboarding HOME inside the same shell
 * and floating chat overlay we use everywhere else. This is the keyless path
 * that calls completeFirstRun("chat") without a cloud sign-in.
 */
export async function completeOnboardingToHome(
  page: Page,
  click: (locator: Locator) => Promise<void>,
  opts: { state: OnboardingRouteState; tutorial?: "start" | "skip" } = {
    state: { firstRunPosts: [] },
  },
): Promise<{ surface: Locator }> {
  const { state, tutorial = "skip" } = opts;

  // 1) The chat transcript owns runtime/provider setup; no removed full-screen gate exists.
  await expectChatFirstOnboarding(page);

  // 2) Local runtime → on-device ("all-local") provider.
  const local = page.getByTestId(RUNTIME_CHOICE("local"));
  await expect(local).toBeEnabled({ timeout: 15_000 });
  await click(local);

  const onDevice = page.getByTestId(PROVIDER_CHOICE("on-device"));
  await expect(onDevice).toBeVisible({ timeout: 15_000 });
  await click(onDevice);

  // 3) Provisioning posts first-run, then the conductor offers the tutorial.
  await pickTutorial(page, click, tutorial);

  // 4) Landing is the HOME: the sheet auto-collapses on the completion edge
  // (revealing the home) and the floating chat overlay stays present with a
  // now-unlocked composer; the home widget host renders its seeded cards.
  const chatOverlay = page.getByTestId("continuous-chat-overlay");
  await expect(chatOverlay).toBeVisible({ timeout: 60_000 });
  await expectOnboardingAutoCollapse(page);
  await expect(page.getByTestId("chat-composer-textarea")).toBeVisible({
    timeout: 30_000,
  });

  const surface = await expectPopulatedHome(page);

  // 5) The local finish persisted first-run exactly once (the single
  // persistFirstRun funnel), even though the tutorial step ran afterwards.
  expect(
    state.firstRunPosts.length,
    "POST /api/first-run must fire exactly once for the local path",
  ).toBe(1);

  return { surface };
}

/**
 * Drive first-run to completion via the CLOUD runtime: pick Cloud → the OAuth
 * card appears while the conductor connects Eliza Cloud (mocked at the network
 * boundary, no popup needed) → the cloud-agent CHOICE → bind →
 * tutorial-or-skip → home. The bound agent base is this page origin (an
 * app-shell base), so the cloud finish persists first-run exactly once — same
 * contract as Local. Requires `installCloudRoutes` + `injectCloudAuthToken`.
 */
export async function completeCloudOnboardingToHome(
  page: Page,
  click: (locator: Locator) => Promise<void>,
  opts: { state: OnboardingRouteState; tutorial?: "start" | "skip" },
): Promise<{ surface: Locator }> {
  const { state, tutorial = "skip" } = opts;

  await expectChatFirstOnboarding(page);

  // 1) Pick the Cloud runtime.
  const cloud = page.getByTestId(RUNTIME_CHOICE("cloud"));
  await expect(cloud).toBeEnabled({ timeout: 15_000 });
  await click(cloud);

  // 2) The conductor seeds the Eliza Cloud OAuth card (a `secretRequest` block)
  // while it connects + lists the account's cloud agents at the network boundary.
  await expect(page.getByTestId("sensitive-request").first()).toBeVisible({
    timeout: 20_000,
  });

  // 3) ≥1 cloud agent → the conductor seeds a cloud-agent CHOICE. Pick it.
  const agentChoice = page.getByTestId(CLOUD_AGENT_CHOICE(CLOUD_AGENT_ID));
  await expect(agentChoice).toBeVisible({ timeout: 30_000 });
  await click(agentChoice);

  // 4) Binding done → tutorial offered → land on the home (sheet auto-collapses).
  await pickTutorial(page, click, tutorial);

  const chatOverlay = page.getByTestId("continuous-chat-overlay");
  await expect(chatOverlay).toBeVisible({ timeout: 60_000 });
  await expectOnboardingAutoCollapse(page);
  await expect(page.getByTestId("chat-composer-textarea")).toBeVisible({
    timeout: 30_000,
  });

  const surface = await expectPopulatedHome(page);

  expect(
    state.firstRunPosts.length,
    "POST /api/first-run must fire exactly once for the cloud path",
  ).toBe(1);

  return { surface };
}

export async function completeCloudInferenceOnboardingToHome(
  page: Page,
  click: (locator: Locator) => Promise<void>,
  opts: { state: OnboardingRouteState; tutorial?: "start" | "skip" },
): Promise<{ surface: Locator }> {
  const { state, tutorial = "skip" } = opts;

  await expectChatFirstOnboarding(page);

  const local = page.getByTestId(RUNTIME_CHOICE("local"));
  await expect(local).toBeEnabled({ timeout: 15_000 });
  await click(local);

  const cloudInference = page.getByTestId(PROVIDER_CHOICE("elizacloud"));
  await expect(cloudInference).toBeVisible({ timeout: 15_000 });
  await click(cloudInference);

  await pickTutorial(page, click, tutorial);

  const chatOverlay = page.getByTestId("continuous-chat-overlay");
  await expect(chatOverlay).toBeVisible({ timeout: 60_000 });
  await expectOnboardingAutoCollapse(page);
  await expect(page.getByTestId("chat-composer-textarea")).toBeVisible({
    timeout: 30_000,
  });

  const surface = await expectPopulatedHome(page);

  expect(
    state.firstRunPosts.length,
    "POST /api/first-run must fire exactly once for the cloud-inference local path",
  ).toBe(1);

  return { surface };
}

export async function completeOtherProviderSettingsHandoff(
  page: Page,
  click: (locator: Locator) => Promise<void>,
  opts: { state: OnboardingRouteState; tutorial?: "start" | "skip" },
): Promise<{ surface: Locator }> {
  const { state, tutorial = "skip" } = opts;

  await expectChatFirstOnboarding(page);

  // "Other / configure in Settings" is a PROVIDER sub-choice under the LOCAL
  // runtime (the old top-level runtime:other was renamed/removed when the
  // chooser became cloud/local/remote), so reach it via local → provider:other.
  const localRuntime = page.getByTestId(RUNTIME_CHOICE("local"));
  await expect(localRuntime).toBeVisible({ timeout: 15_000 });
  await click(localRuntime);

  const otherProvider = page.getByTestId(PROVIDER_CHOICE("other"));
  await expect(otherProvider).toBeVisible({ timeout: 15_000 });
  await click(otherProvider);

  await pickTutorial(page, click, tutorial);

  await expect(
    page.getByText("Choose a model provider in Settings before sending", {
      exact: false,
    }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Open Settings" })).toBeVisible(
    { timeout: 15_000 },
  );

  const chatOverlay = page.getByTestId("continuous-chat-overlay");
  await expect(chatOverlay).toBeVisible({ timeout: 60_000 });
  await expectOnboardingAutoCollapse(page);
  await expect(page.getByTestId("chat-composer-textarea")).toBeVisible({
    timeout: 30_000,
  });

  const surface = await expectPopulatedHome(page);

  expect(
    state.firstRunPosts.length,
    "POST /api/first-run must fire exactly once for the Other/settings handoff path",
  ).toBe(1);

  return { surface };
}

export async function connectRemoteFirstRunToHome(
  page: Page,
  opts: { state: OnboardingRouteState; apiBase?: string },
): Promise<{ surface: Locator; activeServer: string | null }> {
  const { state } = opts;

  await expectChatFirstOnboarding(page);

  const apiBase =
    opts.apiBase ??
    (await page.evaluate(() => window.location.origin.toString()));

  await page.evaluate((gatewayUrl) => {
    document.dispatchEvent(
      new CustomEvent("eliza:connect", {
        detail: {
          gatewayUrl,
          completeFirstRun: true,
          skipConfirm: true,
        },
      }),
    );
  }, apiBase);

  const surface = page.getByTestId("home-launcher-surface");
  await expect(surface).toBeVisible({ timeout: 60_000 });
  await expect(surface).toHaveAttribute("data-page", "home");
  // Remote adoption flips firstRunComplete too — same auto-collapse edge.
  await expectOnboardingAutoCollapse(page);
  await expect(page.getByTestId("chat-composer-textarea")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("first-run-runtime-chooser")).toBeHidden({
    timeout: 15_000,
  });

  const firstRunComplete = await page.evaluate(() =>
    localStorage.getItem("eliza:first-run-complete"),
  );
  expect(
    firstRunComplete,
    "remote adoption must persist local completion",
  ).toBe("1");

  expect(
    state.firstRunPosts.length <= 1,
    "remote first-run adoption must not double-submit first-run setup",
  ).toBe(true);

  const activeServer = await page.evaluate(() =>
    localStorage.getItem("elizaos:active-server"),
  );
  expect(activeServer, "remote active-server persisted").toBeTruthy();
  expect(activeServer).toContain('"kind":"remote"');

  return { surface, activeServer };
}

/**
 * Collapse the floating ContinuousChatOverlay back to its composer-only resting
 * state if it happens to be open. The overlay AUTO-COLLAPSES on the onboarding
 * completion edge, so post-onboarding this is normally a no-op guard (the
 * early-return below); it still handles a sheet a test deliberately opened.
 * Escape is the overlay's own keydown contract ONLY once onboarding is
 * complete — during onboarding Escape is gated (see expectChatFirstOnboarding's
 * negative assertion), so never call this mid-onboarding.
 */
export async function collapseChatOverlay(page: Page): Promise<void> {
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 15_000 });
  if ((await overlay.getAttribute("data-open")) !== "true") return;
  await page.keyboard.press("Escape");
  await expect(overlay).not.toHaveAttribute("data-open", "true", {
    timeout: 10_000,
  });
}

/**
 * Swipe-left on the home page → the rail pans to the launcher, then assert a
 * real launcher tile. Uses a real left-flick that moves past the 72px
 * RAIL_FLICK_THRESHOLD. Mobile callers use Chromium CDP touch input and fail if
 * the real touch stream does not move the rail; desktop callers use mouse drag.
 */
export async function swipeLeftToLauncher(
  page: Page,
  surface: Locator,
  options: { input?: "mouse" | "touch" | "auto" } = {},
): Promise<void> {
  // Post-onboarding the overlay already auto-collapsed; this guard only closes
  // a sheet a previous step deliberately opened, so the swipe lands on the
  // home rail rather than the chat scrim.
  await collapseChatOverlay(page);
  const homePage = page.getByTestId("home-launcher-home-page");
  await expect(homePage).toBeVisible();
  const box = await homePage.boundingBox();
  if (!box) throw new Error("home-launcher-home-page has no bounding box");
  const startX = box.x + box.width * 0.72;
  const midY = box.y + box.height * 0.5;
  const touchCapable = await page.evaluate(
    () =>
      navigator.maxTouchPoints > 0 ||
      window.matchMedia("(pointer: coarse)").matches,
  );
  const input = options.input ?? "auto";
  if (input === "touch" && !touchCapable) {
    throw new Error(
      "swipeLeftToLauncher requested touch input in a non-touch context",
    );
  }

  if (input === "touch" || (input === "auto" && touchCapable)) {
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
    await page.waitForTimeout(250);
    if ((await surface.getAttribute("data-page")) !== "launcher") {
      throw new Error(
        "CDP touch swipe did not open the launcher; refusing synthetic pointer fallback",
      );
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

  await expect(surface).toHaveAttribute("data-page", "launcher", {
    timeout: 10_000,
  });
  const launcherPage = page.getByTestId("home-launcher-launcher-page");
  await expect(launcherPage).toBeVisible();
  // A real launcher tile is visible on the launcher.
  await expect(launcherPage.getByTestId("launcher-tile-settings")).toBeVisible({
    timeout: 15_000,
  });

  // The rail slides over 300ms; wait until nothing in the rail subtree is still
  // animating so a shot shows the settled launcher.
  await page.waitForFunction(
    () => {
      const rail = document.querySelector('[data-testid="home-launcher-rail"]');
      if (!rail) return false;
      return !(rail as HTMLElement)
        .getAnimations({ subtree: true })
        .some((a) => a.playState === "running");
    },
    undefined,
    { timeout: 5_000 },
  );
}
