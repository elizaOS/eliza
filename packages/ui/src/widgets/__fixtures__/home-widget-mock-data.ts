/**
 * Browser-safe mock data + installers for the home-slot WidgetHost (#9143).
 *
 * One source of truth for "the home dashboard, populated with attention-worthy
 * data" — shared between the home-screen e2e fixture and the Storybook story so
 * both render the REAL per-plugin home widgets (calendar / goals / finances /
 * health / relationships / inbox) plus notifications, fed by injected DATA only
 * (no stubbing of WidgetHost or the widget components).
 *
 * NO node imports — this is bundled into a browser IIFE (e2e) and into the
 * Storybook renderer (vite). Times are RELATIVE to `Date.now()` so the calendar
 * card lands inside its 2h urgent window and the bills land within a week,
 * matching the live ranking the home surface performs.
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
// Plugin snapshot — the per-plugin home widgets resolve only when the matching
// plugin id is enabled+active in the app-store plugins snapshot
// (registry.ts `isWidgetEnabled`). Notifications + messages are always-visible
// core surfaces; agent-orchestrator is in the built-in fallback set. Mirrors the
// ui-smoke spec's `pluginInfo()`.
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
  pluginInfo("finances", "Finances"),
  pluginInfo("health", "Health"),
  pluginInfo("relationships", "Relationships"),
  // Inbox: the cross-channel unread card (inbox-unread.tsx, pluginId "inbox").
  pluginInfo("inbox", "Inbox"),
  pluginInfo("agent-orchestrator", "Agent Orchestrator"),
];

// ---------------------------------------------------------------------------
// Relative time helpers — keep the seeded data inside each widget's live
// attention window so the cards render AND float up.
// ---------------------------------------------------------------------------

const NOW = () => Date.now();
const minutesFromNow = (m: number) =>
  new Date(Date.now() + m * 60_000).toISOString();
const hoursFromNow = (h: number) =>
  new Date(Date.now() + h * 3_600_000).toISOString();
const daysFromNow = (d: number) =>
  new Date(Date.now() + d * 24 * 3_600_000).toISOString();

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

/** FinancesAlertsWidget reads /api/lifeops/money/{dashboard,recurring,sources};
 *  netUsd < 0 (overdrawn) floats up at escalation weight. A connected source is
 *  required for the card to render. */
function moneyDashboard() {
  return {
    spending: { netUsd: -125.5 },
    generatedAt: new Date(NOW()).toISOString(),
  };
}
function moneySources() {
  return { sources: [{ id: "src-1", status: "active", label: "Checking" }] };
}
function moneyRecurring() {
  return {
    charges: [
      {
        merchantNormalized: "netflix",
        merchantDisplay: "Netflix",
        cadence: "monthly",
        averageAmountUsd: 15.99,
        nextExpectedAt: daysFromNow(3),
        category: "entertainment",
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

/** RelationshipsAttentionWidget reads client.getRelationshipsPeople() ->
 *  GET /api/relationships/people ({ data, stats }) and
 *  client.getRelationshipsCandidates() -> GET /api/relationships/candidates
 *  ({ data }). A pending merge candidate floats up at approval weight. */
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
        lastInteractionAt: daysFromNow(-60),
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
        proposedAt: new Date(NOW()).toISOString(),
      },
    ],
  };
}

/** InboxUnreadWidget reads /api/lifeops/inbox; the wire shape is
 *  { messages: [{ id, sender: { displayName }, subject, snippet, unread }] }
 *  (see inbox-unread.tsx parseUnread). Only `unread === true` rows are kept. */
function inboxPayload() {
  return {
    messages: [
      {
        id: "msg-1",
        channel: "imessage",
        sender: { displayName: "Alex Rivera" },
        subject: "Deck for the 5pm",
        snippet: "see you at 5, bring the deck",
        unread: true,
        receivedAt: minutesFromNow(-3),
      },
      {
        id: "msg-2",
        channel: "email",
        sender: { displayName: "Acme Billing" },
        subject: "Invoice past due",
        snippet: "Your March invoice is overdue",
        unread: true,
        receivedAt: minutesFromNow(-90),
      },
    ],
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
  source: "finances",
  createdAt: Date.now(),
  readAt: null,
};

function notificationsPayload() {
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

// ---------------------------------------------------------------------------
// Direct accessors for the relationships widget, which fetches via the typed
// `client.getRelationshipsPeople()` / `client.getRelationshipsCandidates()`
// methods rather than raw `window.fetch`. The e2e api-stub `client` delegates
// to these; the Storybook story relies on the fetch mock below (the real client
// fetches `/api/relationships/*` through `window.fetch`).
// ---------------------------------------------------------------------------

export function homeWidgetRelationshipsPeople(): {
  people: ReturnType<typeof relationshipsPeople>["data"];
  stats: ReturnType<typeof relationshipsPeople>["stats"];
} {
  const payload = relationshipsPeople();
  return { people: payload.data, stats: payload.stats };
}

export function homeWidgetRelationshipsCandidates(): ReturnType<
  typeof relationshipsCandidates
>["data"] {
  return relationshipsCandidates().data;
}

export function homeWidgetNotificationsResponse() {
  return notificationsPayload();
}

// ---------------------------------------------------------------------------
// Fetch mock — the widgets fetch on mount, so install this BEFORE first render.
// Matches the URL substrings each widget requests (any base) and returns a
// 200 JSON envelope. Unmatched routes resolve to an empty 200 body so the
// widgets degrade to null rather than throwing.
// ---------------------------------------------------------------------------

type RouteMatch = { test: (url: string) => boolean; body: () => unknown };

function routeTable(): RouteMatch[] {
  const has = (needle: string) => (url: string) => url.includes(needle);
  return [
    { test: has("/api/lifeops/calendar/feed"), body: calendarFeed },
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
    { test: has("/api/lifeops/goals"), body: goalsPayload },
    { test: has("/api/lifeops/money/dashboard"), body: moneyDashboard },
    { test: has("/api/lifeops/money/recurring"), body: moneyRecurring },
    { test: has("/api/lifeops/money/sources"), body: moneySources },
    { test: has("/api/lifeops/sleep/history"), body: sleepHistory },
    { test: has("/api/lifeops/sleep/regularity"), body: sleepRegularity },
    { test: has("/api/lifeops/inbox"), body: inboxPayload },
    { test: has("/api/relationships/people"), body: relationshipsPeople },
    {
      test: has("/api/relationships/candidates"),
      body: relationshipsCandidates,
    },
    { test: has("/api/notifications"), body: notificationsPayload },
    { test: has("/api/approvals"), body: approvalsPayload },
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
// App-store + notification seeding — the WidgetHost reads the plugins snapshot
// from the app store (resolveWidgetsForSlot), and HomeScreen's pinned
// NotificationsHomeCenter reads the notification store. Seed both BEFORE first
// render.
// ---------------------------------------------------------------------------

const noop = () => {};

/**
 * A minimal {@link AppContextValue} carrying just the slices the home widgets
 * read (`plugins`, `conversations`, `t`) — everything else resolves to a no-op
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
  __ingestNotificationForTests(HOME_WIDGET_MOCK_NOTIFICATION, 1);
}
