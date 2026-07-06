/**
 * Browser-safe mock data + installers for the home-slot WidgetHost (#9143).
 *
 * One source of truth for "the home dashboard, populated with attention-worthy
 * data" - shared between the home-screen e2e fixture and the Storybook story so
 * both render the REAL kept home widgets (calendar / Today-todos, with the
 * at-risk goal folded into the Today card per spec §E item 5) plus
 * notifications/approvals, fed by injected DATA only (no stubbing of WidgetHost
 * or the widget components). The goals payload now feeds the Today card's
 * flagged row rather than a standalone goals resident; the sleep payload is
 * retained for the routed health surface but no longer renders on home.
 *
 * NO node imports - this is bundled into a browser IIFE (e2e) and into the
 * Storybook renderer (vite). Times are RELATIVE to `Date.now()` so the calendar
 * card lands inside its 2h urgent window, matching the live ranking the home
 * surface performs.
 *
 * The payload shapes mirror packages/app/test/ui-smoke/home-widget-priority.spec.ts
 * and were verified field-by-field against each widget's parser.
 */

import type { AgentNotification } from "@elizaos/core";
import type { PluginInfo } from "../../api/client-types-config";
import { publishAppValue, seedAppValue } from "../../state/app-store";
import {
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
} from "../../state/notifications/notification-store";
import type { AppContextValue } from "../../state/types";

// ---------------------------------------------------------------------------
// Plugin snapshot - plugin-gated home widgets resolve only when the matching
// plugin id is enabled+active in the app-store plugins snapshot
// (registry.ts `isWidgetEnabled`). Notifications are pinned outside WidgetHost.
// Mirrors the ui-smoke spec's `pluginInfo()`.
// ---------------------------------------------------------------------------

function pluginInfo(id: string, name: string): PluginInfo {
  return {
    id,
    name,
    description: `${name} (home-widget fixture)`,
    enabled: true,
    isActive: true,
    configured: true,
    envKey: null,
    category: "feature",
    source: "bundled",
    parameters: [],
    validationErrors: [],
    validationWarnings: [],
  };
}

export const HOME_WIDGET_MOCK_PLUGINS: PluginInfo[] = [
  pluginInfo("calendar", "Calendar"),
  pluginInfo("goals", "Goals"),
  pluginInfo("health", "Health"),
  pluginInfo("todo", "Todos"),
];

// ---------------------------------------------------------------------------
// Relative time helpers - keep the seeded data inside each widget's live
// attention window so the cards render AND float up.
// ---------------------------------------------------------------------------

const minutesFromNow = (m: number) =>
  new Date(Date.now() + m * 60_000).toISOString();
const hoursFromNow = (h: number) =>
  new Date(Date.now() + h * 3_600_000).toISOString();

export type HomeWidgetMockMode = "attention" | "quiet";

export function homeWidgetMockMode(): HomeWidgetMockMode {
  if (typeof window === "undefined") return "attention";
  const params = new URLSearchParams(window.location.search);
  return params.get("homeData") === "quiet" ? "quiet" : "attention";
}

// ---------------------------------------------------------------------------
// Per-widget payloads (verified against each widget's parser).
// ---------------------------------------------------------------------------

/** CalendarUpcomingWidget reads /api/lifeops/calendar/feed; a timed event within
 *  the next 2h floats up at reminder weight. */
function calendarFeed() {
  return {
    events: [
      {
        id: "evt-soon",
        title: "Design review",
        startAt: minutesFromNow(45),
        endAt: minutesFromNow(105),
        isAllDay: false,
        location: "Zoom",
      },
    ],
  };
}

/** GoalsAttentionWidget reads /api/lifeops/goals; an at_risk goal floats up at
 *  escalation weight and renders an urgent row. */
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

/** HealthSleepWidget reads /api/lifeops/sleep/{history,regularity}; an
 *  "irregular" classification floats up at check-in weight. A latest episode is
 *  required for the card to render. */
function sleepHistory() {
  return {
    episodes: [
      {
        startedAt: hoursFromNow(-8),
        endedAt: hoursFromNow(-2),
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

/** The pinned dashboard notification center (NotificationsHomeCenter, mounted
 *  by HomeScreen) reads the notification store (hydrated from
 *  GET /api/notifications). An urgent unread notification ranks at the top. */
export const HOME_WIDGET_MOCK_NOTIFICATION: AgentNotification = {
  id: "notif-urgent",
  title: "Payment failed",
  body: "Your card was declined for the Acme invoice.",
  category: "system",
  priority: "urgent",
  source: "system",
  createdAt: Date.now(),
  readAt: null,
};

function notificationsPayload() {
  if (homeWidgetMockMode() === "quiet") {
    return {
      notifications: [],
      unreadCount: 0,
    };
  }
  return {
    notifications: [HOME_WIDGET_MOCK_NOTIFICATION],
    unreadCount: 1,
  };
}

/** NeedsAttentionWidget reads GET /api/approvals; the wire shape is
 *  { pending: PendingUserAction[] } (see needs-attention.tsx / approval-routes).
 *  Two pending decisions; the older one is the single datum the card shows. */
function approvalsPayload() {
  return {
    pending: [
      {
        id: "approval-1",
        kind: "approval",
        title: "Send the signed contract to Acme",
        createdAt: Date.now() - 45 * 60_000,
        roomId: "11111111-1111-1111-1111-111111111111",
        options: [
          { name: "approve", description: "Approve and send" },
          { name: "deny", description: "Don't send", isCancel: true },
        ],
      },
      {
        id: "approval-2",
        kind: "approval",
        title: "Confirm the production deploy",
        createdAt: Date.now() - 5 * 60_000,
        roomId: "11111111-1111-1111-1111-111111111111",
      },
    ],
  };
}

export function homeWidgetNotificationsResponse() {
  return notificationsPayload();
}

export function homeWidgetTodosResponse() {
  if (homeWidgetMockMode() === "quiet") {
    return { todos: [] };
  }
  return {
    todos: [
      {
        id: "todo-groceries",
        name: "Buy groceries",
        description: "",
        type: "task",
        isCompleted: false,
        isUrgent: false,
        priority: 2,
      },
    ],
  };
}

export function homeWidgetApprovalsResponse() {
  return homeWidgetMockMode() === "attention"
    ? approvalsPayload()
    : { pending: [] };
}

// ---------------------------------------------------------------------------
// Fetch mock - the widgets fetch on mount, so install this BEFORE first render.
// Matches the URL substrings each widget requests (any base) and returns a
// 200 JSON envelope. Unmatched routes resolve to an empty 200 body so the
// widgets degrade to null rather than throwing.
// ---------------------------------------------------------------------------

type RouteMatch = { test: (url: string) => boolean; body: () => unknown };

function routeTable(): RouteMatch[] {
  const has = (needle: string) => (url: string) => url.includes(needle);
  const whenAttention = (body: () => unknown, quietBody: unknown) => () =>
    homeWidgetMockMode() === "attention" ? body() : quietBody;
  return [
    {
      test: has("/api/lifeops/calendar/feed"),
      body: whenAttention(calendarFeed, { events: [] }),
    },
    {
      test: has("/api/connectors/google/accounts"),
      body: () => ({
        accounts: [
          {
            id: "google-owner",
            provider: "google",
            status: "connected",
          },
        ],
      }),
    },
    {
      test: has("/api/lifeops/goals"),
      body: whenAttention(goalsPayload, { goals: [] }),
    },
    {
      test: has("/api/lifeops/sleep/history"),
      body: whenAttention(sleepHistory, {
        episodes: [],
        summary: {
          cycleCount: 0,
          averageDurationMin: 0,
          overnightCount: 0,
          napCount: 0,
          openCount: 0,
        },
        windowDays: 14,
        includeNaps: true,
      }),
    },
    {
      test: has("/api/lifeops/sleep/regularity"),
      body: whenAttention(sleepRegularity, {
        classification: "regular",
        sri: 92,
        sampleSize: 0,
        windowDays: 14,
      }),
    },
    { test: has("/api/notifications"), body: notificationsPayload },
    {
      test: has("/api/approvals"),
      body: whenAttention(approvalsPayload, { pending: [] }),
    },
  ];
}

function jsonResponse(body: unknown): Response {
  // A real Response (not a hand-rolled object) so it satisfies BOTH the widgets'
  // raw `window.fetch(...).ok / .json()` and the typed `client.fetch` path
  // (which also reads `.headers`, `.text()`, `.clone()`).
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Override `window.fetch` to answer the home widgets' data requests with the
 * mock payloads above. Returns a restore function that puts the original
 * `window.fetch` back.
 */
export function installHomeWidgetFetchMock(): () => void {
  if (typeof window === "undefined") return () => {};
  const original = window.fetch;
  const routes = routeTable();
  window.fetch = (async (
    input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const route = routes.find((r) => r.test(url));
    return jsonResponse(route ? route.body() : {});
  }) as typeof window.fetch;
  return () => {
    window.fetch = original;
  };
}

// ---------------------------------------------------------------------------
// App-store + notification seeding - the WidgetHost reads the plugins snapshot
// from the app store (resolveWidgetsForSlot), and HomeScreen's pinned
// NotificationsHomeCenter reads the notification store. Seed both BEFORE first
// render.
// ---------------------------------------------------------------------------

const noop = () => {};

/**
 * A minimal {@link AppContextValue} carrying just the slices the home widgets
 * read (`plugins`, `conversations`, `t`) - everything else resolves to a no-op
 * via the Proxy, mirroring the inert proxy `useApp()` returns in tests. Built
 * inline (no mock-providers import) to keep this module dependency-light and
 * browser-safe for the esbuild e2e bundle.
 */
function homeWidgetAppValue(): AppContextValue {
  const base: Partial<AppContextValue> = {
    plugins: HOME_WIDGET_MOCK_PLUGINS,
    conversations: [],
    t: ((key: string, values?: { defaultValue?: unknown }) =>
      values?.defaultValue?.toString() ?? key) as AppContextValue["t"],
    uiLanguage: "en",
  };
  return new Proxy(base as AppContextValue, {
    get(target, prop: keyof AppContextValue) {
      if (prop in target) return target[prop];
      return noop;
    },
  }) as AppContextValue;
}

/** Seed the app-store plugins snapshot so the per-plugin home widgets resolve. */
export function seedHomeWidgetAppStore(): void {
  const value = homeWidgetAppValue();
  seedAppValue(value);
  publishAppValue(value);
}

/** Reset + ingest the urgent notification into the notification store. */
export function seedHomeWidgetNotifications(): void {
  __resetNotificationStoreForTests();
  const { notifications, unreadCount } = notificationsPayload();
  for (const notification of notifications) {
    __ingestNotificationForTests(notification, unreadCount);
  }
}
