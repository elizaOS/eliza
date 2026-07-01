// Stub for `../../api` (and `../../api/client`) in the home-screen e2e.
//
// The REAL WidgetHost + home widgets bundle and render; only their data sources
// are stubbed. Widgets that fetch lifeops routes call `client.getBaseUrl()` then
// raw `window.fetch` (mocked in the fixture); the relationships widget and the
// notification store call typed `client.*` methods, delegated here to the shared
// home-widget mock data so the cards render with injected data.

import {
  homeWidgetNotificationsResponse,
  homeWidgetRelationshipsCandidates,
  homeWidgetRelationshipsPeople,
} from "../../../widgets/__fixtures__/home-widget-mock-data";

export const client = {
  // Empty base → widgets fetch `/api/lifeops/...` which the window.fetch mock
  // (installed in the fixture) intercepts.
  getBaseUrl: () => "",
  getRelationshipsPeople: async () => homeWidgetRelationshipsPeople(),
  getRelationshipsCandidates: async () => homeWidgetRelationshipsCandidates(),
  // Notification store hydrate + live subscription.
  listNotifications: async () => homeWidgetNotificationsResponse(),
  onWsEvent: () => {},
  markNotificationRead: async () => ({ ok: true }),
  markAllNotificationsRead: async () => ({ changed: 0 }),
  removeNotification: async () => ({ ok: true }),
  clearNotifications: async () => ({ ok: true }),
  // The inbox-chats client method the previous fixture exposed (unused by the
  // home widgets, kept harmless for any incidental caller).
  getInboxChats: async () => ({ chats: [], count: 0 }),
  // Agent-orchestrator home cards (Apps / Activity). No live runs/accounts in
  // the fixture → empty results so those cards self-hide cleanly rather than
  // surfacing a "not a function" error-boundary fallback.
  listAppRuns: async () => [],
  getOrchestratorAccounts: async () => ({ accounts: [] }),
  getOrchestratorRooms: async () => ({ rooms: [] }),
  listAccounts: async () => ({ accounts: [] }),
  // Unified-tasks home widget (useUnifiedTasks) — empty so it self-hides. These
  // prototype methods are bare side-effect patches in production, dropped from
  // this esbuild bundle, so stub them here explicitly.
  listAutomations: async () => ({ automations: [] }),
  listScheduledTasks: async () => ({ tasks: [] }),
  // CalendarUpcomingWidget probes Google connectivity through the typed client
  // before showing events; report a connected account so it renders the seeded
  // feed instead of the "Connect calendar" affordance.
  listConnectorAccounts: async () => ({
    accounts: [{ id: "google-owner", provider: "google", status: "connected" }],
  }),
  // Conversation stubs kept for any home surface that reads the conversation
  // list; the standalone Messages tile was removed (#10697), so nothing renders
  // a conversation list on the home grid now.
  listConversations: async () => ({ conversations: [] }),
  getConversationMessages: async () => ({ messages: [] }),
};
