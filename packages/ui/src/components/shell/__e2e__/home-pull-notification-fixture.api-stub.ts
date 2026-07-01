// API stub for the pull-down notification-center e2e (#10706).
//
// Reuses the shared home-screen api-stub (so the REAL home widgets still get
// their injected data) but overrides `listNotifications` so the notification
// store hydrates from a mixed-attention set — three unread items whose priority
// order and createdAt order are deliberately different, so the panel's
// priority↔time sort toggle produces two visibly distinct orderings.

import { client as sharedClient } from "./home-screen-fixture.api-stub";

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const min = (n: number): number => T0 + n * 60_000;

export const PULL_NOTIFICATIONS = [
  {
    id: "urgent-old",
    title: "Urgent but old",
    category: "system",
    priority: "urgent",
    source: "test",
    createdAt: min(0),
    readAt: null,
  },
  {
    id: "normal-mid",
    title: "Normal middle",
    category: "message",
    priority: "normal",
    source: "test",
    createdAt: min(10),
    readAt: null,
  },
  {
    id: "high-recent",
    title: "High and recent",
    category: "approval",
    priority: "high",
    source: "test",
    createdAt: min(20),
    readAt: null,
  },
];

export const client = {
  ...sharedClient,
  listNotifications: async () => ({
    notifications: PULL_NOTIFICATIONS,
    unreadCount: PULL_NOTIFICATIONS.filter((n) => !n.readAt).length,
  }),
};
