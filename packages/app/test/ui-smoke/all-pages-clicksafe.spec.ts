import { readFileSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { DIRECT_ROUTE_CASES, escapeRegExp } from "./apps-session-route-cases";
import {
  assertReadyChecks,
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";

type ReadyCheck =
  | { selector: string; text?: never }
  | { selector?: never; text: string };

type RouteProbe = {
  name: string;
  path: string;
  readyChecks: readonly ReadyCheck[];
  mode?: "any" | "all";
  timeoutMs?: number;
};

type ViewportProbe = {
  name: string;
  size: { width: number; height: number };
  routes: readonly RouteProbe[];
};

type PermissionId =
  | "screen-recording"
  | "accessibility"
  | "reminders"
  | "calendar"
  | "health"
  | "screentime"
  | "contacts"
  | "notes"
  | "microphone"
  | "camera"
  | "location"
  | "shell"
  | "website-blocking"
  | "notifications"
  | "full-disk"
  | "automation";

type PermissionStateFixture = {
  id: PermissionId;
  status: "not-applicable";
  lastChecked: number;
  canRequest: boolean;
  platform: "linux";
};

type AllPermissionsStateFixture = Record<PermissionId, PermissionStateFixture>;

const PERMISSION_IDS: readonly PermissionId[] = [
  "screen-recording",
  "accessibility",
  "reminders",
  "calendar",
  "health",
  "screentime",
  "contacts",
  "notes",
  "microphone",
  "camera",
  "location",
  "shell",
  "website-blocking",
  "notifications",
  "full-disk",
  "automation",
];

const CORE_ROUTE_PROBES: readonly RouteProbe[] = [
  {
    name: "chat",
    path: "/chat",
    readyChecks: [
      { selector: '[data-testid="conversations-sidebar"]' },
      { selector: '[data-testid="chat-composer-textarea"]' },
      { selector: '[data-testid="chat-widgets-bar"]' },
    ],
    mode: "all",
  },
  {
    name: "connectors",
    path: "/connectors",
    readyChecks: [{ selector: "#root" }],
  },
  {
    name: "apps catalog",
    path: "/apps",
    readyChecks: [{ selector: '[data-testid="apps-catalog-grid"]' }],
    timeoutMs: 60_000,
  },
  {
    name: "automations",
    path: "/automations",
    readyChecks: [{ selector: '[data-testid="automations-shell"]' }],
    timeoutMs: 60_000,
  },
  {
    name: "browser",
    path: "/browser",
    readyChecks: [
      { selector: '[data-testid="browser-workspace-address-input"]' },
      { selector: '[data-testid="browser-workspace-open-home"]' },
    ],
    timeoutMs: 60_000,
  },
  {
    name: "character",
    path: "/character",
    readyChecks: [{ selector: '[data-testid="character-editor-view"]' }],
    timeoutMs: 60_000,
  },
  {
    name: "character knowledge",
    path: "/character/documents",
    readyChecks: [
      { selector: '[data-testid="character-editor-view"]' },
      { selector: '[data-testid="documents-view"]' },
      { text: "Knowledge" },
    ],
    timeoutMs: 60_000,
  },
  {
    name: "wallet",
    path: "/wallet",
    readyChecks: [{ selector: '[data-testid="wallet-shell"]' }],
    timeoutMs: 60_000,
  },
  {
    name: "settings",
    path: "/settings",
    readyChecks: [{ selector: '[data-testid="settings-shell"]' }],
    timeoutMs: 60_000,
  },
];

const APP_TOOL_ROUTE_PROBES: readonly RouteProbe[] = DIRECT_ROUTE_CASES.map(
  (routeCase) => ({
    name: `app tool ${routeCase.name}`,
    path: routeCase.path,
    readyChecks:
      "readyChecks" in routeCase
        ? routeCase.readyChecks
        : [{ selector: routeCase.selector }],
    timeoutMs: "timeoutMs" in routeCase ? routeCase.timeoutMs : 60_000,
  }),
);

const DESKTOP_PROBE: ViewportProbe = {
  name: "desktop",
  size: { width: 1440, height: 1000 },
  routes: [...CORE_ROUTE_PROBES, ...APP_TOOL_ROUTE_PROBES],
};

const MOBILE_CHAT_ROUTE_PROBE: RouteProbe = {
  ...CORE_ROUTE_PROBES[0],
  readyChecks: [{ selector: '[data-testid="chat-composer-textarea"]' }],
  mode: "all",
};

const MOBILE_PROBE: ViewportProbe = {
  name: "mobile",
  size: { width: 390, height: 844 },
  routes: [
    MOBILE_CHAT_ROUTE_PROBE,
    CORE_ROUTE_PROBES[1],
    CORE_ROUTE_PROBES[2],
    CORE_ROUTE_PROBES[3],
    CORE_ROUTE_PROBES[7],
    CORE_ROUTE_PROBES[8],
    ...APP_TOOL_ROUTE_PROBES.filter((route) =>
      new Set([
        "/apps/lifeops",
        "/apps/plugins",
        "/apps/skills",
        "/apps/runtime",
        "/apps/logs",
      ]).has(route.path),
    ),
  ],
};

const SAFE_APP_TILES = [
  {
    testId: "app-card--elizaos-app-plugin-viewer",
    name: "plugin viewer tile",
    expectedPath: /\/apps\/plugins$/,
    readyChecks: [{ text: "Other Features" }] satisfies readonly ReadyCheck[],
  },
  {
    testId: "app-card--elizaos-app-skills-viewer",
    name: "skills viewer tile",
    expectedPath: /\/apps\/skills$/,
    readyChecks: [
      { selector: '[data-testid="skills-shell"]' },
    ] satisfies readonly ReadyCheck[],
  },
  {
    testId: "app-card--elizaos-app-memory-viewer",
    name: "memory viewer tile",
    expectedPath: /\/apps\/memories$/,
    readyChecks: [
      { selector: '[data-testid="memory-viewer-view"]' },
    ] satisfies readonly ReadyCheck[],
  },
] as const;

const SETTING_SECTIONS_TO_CLICK = [/^Capabilities\b/, /^Permissions\b/];
const SMOKE_GENERATED_AT = "2026-01-01T00:00:00.000Z";
const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const SMOKE_VRM = readFileSync(
  new URL("../../../../plugins/app-companion/public_src/vrms/milady-1.vrm", import.meta.url),
);
const EMPTY_PERMISSIONS = Object.fromEntries(
  PERMISSION_IDS.map((id: PermissionId) => [
    id,
    {
      id,
      status: "not-applicable",
      lastChecked: 0,
      canRequest: false,
      platform: "linux",
    },
  ]),
) as AllPermissionsStateFixture;
const EMPTY_LIFEOPS_OVERVIEW_SUMMARY = {
  activeOccurrenceCount: 0,
  overdueOccurrenceCount: 0,
  snoozedOccurrenceCount: 0,
  activeReminderCount: 0,
  activeGoalCount: 0,
};
const EMPTY_LIFEOPS_CHANNEL_COUNTS = {
  gmail: { total: 0, unread: 0 },
  discord: { total: 0, unread: 0 },
  telegram: { total: 0, unread: 0 },
  signal: { total: 0, unread: 0 },
  imessage: { total: 0, unread: 0 },
  whatsapp: { total: 0, unread: 0 },
  sms: { total: 0, unread: 0 },
  x_dm: { total: 0, unread: 0 },
};

function formatPageIssue(kind: string, value: unknown): string {
  if (value instanceof Error) {
    return `${kind}: ${value.message}\n${value.stack ?? ""}`.trim();
  }
  return `${kind}: ${String(value)}`;
}

function installPageIssueGuards(page: Page): string[] {
  const issues: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location();
    issues.push(
      `console.error: ${message.text()}${
        location.url ? ` (${location.url}:${location.lineNumber})` : ""
      }`,
    );
  });
  page.on("pageerror", (error) => {
    issues.push(formatPageIssue("pageerror", error));
  });
  return issues;
}

async function installDesktopPermissionsBridge(page: Page): Promise<void> {
  await page.addInitScript((permissions) => {
    const existing = window.__ELIZA_ELECTROBUN_RPC__;
    window.__ELIZA_ELECTROBUN_RPC__ = {
      request: {
        ...(existing?.request ?? {}),
        permissionsGetAll: async () => permissions,
        permissionsIsShellEnabled: async () => false,
        permissionsGetPlatform: async () => "linux",
      },
      onMessage: existing?.onMessage ?? (() => {}),
      offMessage: existing?.offMessage ?? (() => {}),
    };
  }, EMPTY_PERMISSIONS);
}

function emptyLifeOpsOverview() {
  const section = {
    occurrences: [],
    goals: [],
    reminders: [],
    summary: EMPTY_LIFEOPS_OVERVIEW_SUMMARY,
  };
  return {
    occurrences: [],
    goals: [],
    reminders: [],
    summary: EMPTY_LIFEOPS_OVERVIEW_SUMMARY,
    owner: section,
    agentOps: section,
    schedule: null,
  };
}

function emptyLifeOpsSocialSummary(url: URL) {
  return {
    since: url.searchParams.get("since") ?? SMOKE_GENERATED_AT,
    until: url.searchParams.get("until") ?? SMOKE_GENERATED_AT,
    totalSeconds: 0,
    services: [],
    devices: [],
    surfaces: [],
    browsers: [],
    sessions: [],
    messages: {
      channels: [],
      inbound: 0,
      outbound: 0,
      opened: 0,
      replied: 0,
    },
    dataSources: [],
    fetchedAt: SMOKE_GENERATED_AT,
  };
}

async function installSupplementalSafeRoutes(page: Page): Promise<void> {
  await page.route(/\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i, async (route) => {
    const pathname = new URL(route.request().url()).pathname.toLowerCase();
    if (pathname.endsWith(".svg")) {
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="#111"/></svg>',
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"),
    });
  });

  await page.route("**/api/avatar/background**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"),
    });
  });

  await page.route("**/api/avatar/vrm**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      body: SMOKE_VRM,
    });
  });

  await page.route("**/api/apps/overlay-presence", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route("**/api/catalog/apps", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route("**/api/coding-agents/preflight", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ installed: [], available: false }),
    });
  });

  await page.route("**/api/coding-agents/coordinator/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        supervisionLevel: "manual",
        taskCount: 0,
        tasks: [],
        pendingConfirmations: 0,
        taskThreadCount: 0,
        taskThreads: [],
        frameworks: [],
      }),
    });
  });

  await page.route("**/api/character/experiences**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [], total: 0 }),
    });
  });

  await page.route("**/api/browser-workspace", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ mode: "web", tabs: [] }),
    });
  });

  await page.route("**/api/browser-bridge/settings", async (route) => {
    const method = route.request().method();
    if (method !== "GET" && method !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        settings: {
          enabled: false,
          trackingMode: "off",
          allowBrowserControl: false,
          requireConfirmationForAccountAffecting: true,
          incognitoEnabled: false,
          siteAccessMode: "current_site_only",
          grantedOrigins: [],
          blockedOrigins: [],
          maxRememberedTabs: 50,
          pauseUntil: null,
          metadata: {},
          updatedAt: SMOKE_GENERATED_AT,
        },
      }),
    });
  });

  await page.route("**/api/browser-bridge/companions", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ companions: [] }),
    });
  });

  await page.route("**/api/browser-bridge/packages", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: {
          extensionPath: null,
          chromeBuildPath: null,
          chromePackagePath: null,
          safariWebExtensionPath: null,
          safariAppPath: null,
          safariPackagePath: null,
          releaseManifest: null,
        },
      }),
    });
  });

  await page.route("**/api/vincent/status**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connected: false,
        connectedAt: null,
        tradingVenues: [],
      }),
    });
  });

  await page.route("**/api/vincent/strategy**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ connected: false, strategy: null }),
    });
  });

  await page.route("**/api/vincent/trading-profile**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ connected: false, profile: null }),
    });
  });

  await page.route("**/api/shopify/status**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connected: false,
        shop: null,
      }),
    });
  });

  await page.route("**/api/shopify/products**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ products: [], total: 0, page: 1, pageSize: 25 }),
    });
  });

  await page.route("**/api/shopify/orders**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ orders: [], total: 0 }),
    });
  });

  await page.route("**/api/shopify/inventory**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], locations: [] }),
    });
  });

  await page.route("**/api/shopify/customers**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ customers: [], total: 0 }),
    });
  });

  await page.route("**/api/drop/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        dropEnabled: false,
        publicMintOpen: false,
        whitelistMintOpen: false,
        mintedOut: false,
        currentSupply: 0,
        maxSupply: 2138,
        shinyPrice: "0.1",
        userHasMinted: false,
      }),
    });
  });

  await page.route("**/api/training/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runningJobs: 0,
        queuedJobs: 0,
        completedJobs: 0,
        failedJobs: 0,
        modelCount: 0,
        datasetCount: 0,
        runtimeAvailable: false,
      }),
    });
  });

  await page.route("**/api/training/trajectories**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        available: false,
        reason: "ui-smoke",
        total: 0,
        trajectories: [],
      }),
    });
  });

  await page.route("**/api/training/datasets", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ datasets: [] }),
    });
  });

  await page.route("**/api/training/backends**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        backends: { mlx: false, cuda: false, cpu: true },
      }),
    });
  });

  await page.route("**/api/training/jobs", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobs: [] }),
    });
  });

  await page.route("**/api/training/models", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ models: [] }),
    });
  });

  await page.route("**/api/trajectories**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    const url = new URL(request.url());
    if (url.pathname === "/api/trajectories/stats") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          totalTrajectories: 0,
          totalLlmCalls: 0,
          totalProviderAccesses: 0,
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          averageDurationMs: 0,
          bySource: {},
          byModel: {},
        }),
      });
      return;
    }
    if (url.pathname === "/api/trajectories/config") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ enabled: false }),
      });
      return;
    }
    if (url.pathname === "/api/trajectories") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          trajectories: [],
          total: 0,
          offset: Number(url.searchParams.get("offset") ?? 0),
          limit: Number(url.searchParams.get("limit") ?? 50),
        }),
      });
      return;
    }
    await route.fallback();
  });

  await page.route(
    "**/api/lifeops/connectors/google/status**",
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          connected: false,
          available: false,
          authUrl: null,
          lastSyncedAt: null,
        }),
      });
    },
  );

  await page.route("**/api/lifeops/connectors/x/status**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        provider: "x",
        side: "owner",
        mode: "local",
        defaultMode: "local",
        availableModes: ["local"],
        configured: false,
        connected: false,
        reason: "disconnected",
        preferredByAgent: false,
        cloudConnectionId: null,
        grantedCapabilities: [],
        grantedScopes: [],
        identity: null,
        hasCredentials: false,
        feedRead: false,
        feedWrite: false,
        dmRead: false,
        dmWrite: false,
        dmInbound: false,
        grant: null,
      }),
    });
  });

  await page.route("**/api/lifeops/capabilities", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: SMOKE_GENERATED_AT,
        appEnabled: true,
        relativeTime: null,
        capabilities: [],
        summary: {
          totalCount: 0,
          workingCount: 0,
          degradedCount: 0,
          blockedCount: 0,
          notConfiguredCount: 0,
        },
      }),
    });
  });

  await page.route("**/api/lifeops/overview", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(emptyLifeOpsOverview()),
    });
  });

  await page.route("**/api/lifeops/calendar/feed**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    const url = new URL(request.url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        calendarId: "primary",
        events: [],
        source: "cache",
        timeMin: url.searchParams.get("timeMin") ?? SMOKE_GENERATED_AT,
        timeMax: url.searchParams.get("timeMax") ?? SMOKE_GENERATED_AT,
        syncedAt: null,
      }),
    });
  });

  await page.route("**/api/lifeops/inbox**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        messages: [],
        channelCounts: EMPTY_LIFEOPS_CHANNEL_COUNTS,
        threadGroups: [],
        fetchedAt: SMOKE_GENERATED_AT,
      }),
    });
  });

  await page.route("**/api/lifeops/screen-time/summary**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], totalSeconds: 0 }),
    });
  });

  await page.route("**/api/lifeops/screen-time/breakdown**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [],
        totalSeconds: 0,
        bySource: [],
        byCategory: [],
        byDevice: [],
        byService: [],
        byBrowser: [],
        fetchedAt: SMOKE_GENERATED_AT,
      }),
    });
  });

  await page.route("**/api/lifeops/social/summary**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(emptyLifeOpsSocialSummary(new URL(request.url()))),
    });
  });

  await page.route("**/api/lifeops/activity-signals**", async (route) => {
    const method = route.request().method();
    if (method !== "GET" && method !== "POST" && method !== "PUT") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: method === "POST" ? 201 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        method === "POST" ? { signal: null } : { signals: [] },
      ),
    });
  });

  await page.route("**/api/computer-use/approvals/stream**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
      body: `data: ${JSON.stringify({
        type: "snapshot",
        snapshot: {
          mode: "full_control",
          pendingCount: 0,
          pendingApprovals: [],
        },
      })}\n\n`,
    });
  });

  await page.route("**/api/computer-use/approvals", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        mode: "full_control",
        pendingCount: 0,
        pendingApprovals: [],
      }),
    });
  });

  await page.route("**/api/automations", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        automations: [],
        summary: { total: 0, enabled: 0, disabled: 0 },
        workflowStatus: {
          mode: "local",
          host: "http://127.0.0.1:5678",
          status: "ready",
          cloudConnected: false,
          localEnabled: true,
          platform: "desktop",
          cloudHealth: "unknown",
        },
        workflowFetchError: null,
      }),
    });
  });

  await page.route("**/api/automations/nodes", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        nodes: [],
        summary: { total: 0, enabled: 0, disabled: 0 },
      }),
    });
  });

  await page.route("**/api/wallet/steward-status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        configured: false,
        available: false,
        connected: false,
        error: null,
        walletAddresses: { evm: null, solana: null },
        vaultHealth: "ok",
      }),
    });
  });

  await page.route("**/api/wallet/nfts**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ evm: [], solana: null }),
    });
  });

  await page.route("**/api/documents**", async (route) => {
    const method = route.request().method();
    if (method !== "GET" && method !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        method === "POST"
          ? { document: null, fragments: [] }
          : { documents: [], total: 0 },
      ),
    });
  });

  await page.route("**/api/secrets/manager/backends", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        backends: [
          {
            id: "in-house",
            label: "Local (encrypted)",
            available: true,
            signedIn: true,
          },
        ],
      }),
    });
  });

  await page.route("**/api/secrets/manager/preferences", async (route) => {
    const method = route.request().method();
    if (method !== "GET" && method !== "PUT") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ preferences: { enabled: ["in-house"] } }),
    });
  });

  await page.route("**/api/secrets/inventory**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ entries: [] }),
    });
  });

  await page.route("**/api/secrets/routing", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ config: { rules: [] } }),
    });
  });

  await page.route("**/api/local-inference/providers", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ providers: [] }),
    });
  });

  await page.route("**/api/local-inference/routing", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        registrations: [],
        preferences: {
          preferredProvider: {},
          policy: {},
        },
      }),
    });
  });

  await page.route("**/api/training/auto/config", async (route) => {
    const method = route.request().method();
    if (method !== "GET" && method !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        config: {
          autoTrain: false,
          triggerThreshold: 20,
          triggerCooldownHours: 24,
          backends: [],
        },
      }),
    });
  });

  await page.route("**/api/training/auto/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ serviceRegistered: false }),
    });
  });

  await page.route("**/api/website-blocker", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ enabled: false, rules: [], activeBlocks: [] }),
    });
  });

  await page.route("**/api/permissions**", async (route) => {
    const method = route.request().method();
    if (method !== "GET" && method !== "POST") {
      await route.fallback();
      return;
    }
    const pathname = new URL(route.request().url()).pathname;
    const body =
      pathname === "/api/permissions/shell"
        ? { enabled: false }
        : EMPTY_PERMISSIONS;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

async function expectNoPageIssues(
  issues: readonly string[],
  label: string,
): Promise<void> {
  expect(issues, `[all-pages-clicksafe] ${label}`).toEqual([]);
}

async function expectMainShell(page: Page, route: RouteProbe): Promise<void> {
  await expect(page.locator("#root")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/404|not found/i);
  if (route.path === "/apps/companion") {
    await expect(page.getByTestId("companion-root")).toBeVisible({
      timeout: route.timeoutMs,
    });
    return;
  }
  const shellSettings = page
    .getByTestId("header-settings-button")
    .or(
      page
        .getByRole("navigation", { name: "Navigation menu" })
        .getByRole("button", { name: "Settings" }),
    );
  await expect(shellSettings).toBeVisible({ timeout: route.timeoutMs });
}

async function probeRoute(page: Page, route: RouteProbe): Promise<void> {
  await openAppPath(page, route.path);
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(route.path)}$`), {
    timeout: route.timeoutMs,
  });
  await expectMainShell(page, route);
  await assertReadyChecks(
    page,
    route.name,
    route.readyChecks,
    route.mode ?? "any",
    route.timeoutMs,
  );
}

async function clickIfVisible(locator: Locator): Promise<boolean> {
  if ((await locator.count()) === 0) return false;
  const target = locator.first();
  if (!(await target.isVisible().catch(() => false))) return false;
  if (!(await target.isEnabled().catch(() => false))) return false;
  await target.click();
  return true;
}

async function clickSafeAllowlist(
  page: Page,
  issues: readonly string[],
): Promise<void> {
  await probeRoute(page, CORE_ROUTE_PROBES[0]);
  await clickIfVisible(page.getByTestId("header-tasks-events-toggle"));
  await page.waitForTimeout(250);
  await expectNoPageIssues(issues, "chat safe toggle");

  await probeRoute(page, CORE_ROUTE_PROBES[2]);
  await clickIfVisible(page.getByRole("button", { name: "Add to favorites" }));
  await page.waitForTimeout(250);
  await expectNoPageIssues(issues, "apps favorite toggle");

  await probeRoute(page, CORE_ROUTE_PROBES[8]);
  for (const section of SETTING_SECTIONS_TO_CLICK) {
    await openSettingsSection(page, section);
    await page.waitForTimeout(150);
    await expectNoPageIssues(issues, `settings section ${String(section)}`);
  }
}

test.beforeEach(async ({ page }) => {
  await installDesktopPermissionsBridge(page);
  await seedAppStorage(page);
  await installSupplementalSafeRoutes(page);
  await installDefaultAppRoutes(page);
});

for (const viewport of [DESKTOP_PROBE, MOBILE_PROBE]) {
  for (const route of viewport.routes) {
    test(`route renders without console failures: ${viewport.name} ${route.name}`, async ({
      page,
    }) => {
      const issues = installPageIssueGuards(page);
      await page.setViewportSize(viewport.size);
      await probeRoute(page, route);
      await expectNoPageIssues(issues, `${viewport.name}: ${route.name}`);
    });
  }
}

test("visible safe app tiles and allowlisted buttons are click-safe", async ({
  page,
}) => {
  const issues = installPageIssueGuards(page);
  await page.setViewportSize(DESKTOP_PROBE.size);

  for (const tile of SAFE_APP_TILES) {
    await test.step(tile.name, async () => {
      await probeRoute(page, CORE_ROUTE_PROBES[2]);
      const card = page.getByTestId(tile.testId);
      await expect(card).toBeVisible({ timeout: 60_000 });
      await card.click();
      await expect(page).toHaveURL(tile.expectedPath, { timeout: 60_000 });
      await assertReadyChecks(page, tile.name, tile.readyChecks, "any", 90_000);
      await expectNoPageIssues(issues, tile.name);
    });
  }

  await clickSafeAllowlist(page, issues);
});
