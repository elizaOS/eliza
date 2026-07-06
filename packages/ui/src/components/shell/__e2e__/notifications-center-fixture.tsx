/**
 * Fixture for the notification-center capture: seeds the store with the default
 * (onboarding) notification set and renders the integrated home center, so the
 * screenshot shows the default set exactly as a fresh install would.
 */
import type { AgentNotification } from "@elizaos/core";
import { createRoot } from "react-dom/client";
import { NotificationsHomeCenter } from "../NotificationsHomeCenter";
import {
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
  __setHydratedForTests,
} from "../../../state/notifications/notification-store";

const DEFAULT_SET: Array<Partial<AgentNotification>> = [
  {
    title: "Take the tour",
    body: "New here? A one-minute tour runs right in the chat — it walks you through messaging, voice, and navigating by asking.",
    category: "general",
    priority: "normal",
    deepLink: "/chat",
  },
  {
    title: "Get help any time",
    body: "Stuck or curious? Just ask in the chat — your agent answers questions about the app and can restart the tour.",
    category: "general",
    priority: "low",
    deepLink: "/chat",
  },
  {
    title: "Connect your calendar",
    body: "Link a calendar so your agent can brief you on what's next and keep your day on track.",
    category: "general",
    priority: "low",
    deepLink: "/connectors",
  },
];

__resetNotificationStoreForTests();
let seq = 0;
for (const n of DEFAULT_SET) {
  seq += 1;
  __ingestNotificationForTests({
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}` as AgentNotification["id"],
    title: "Notification",
    category: "general",
    priority: "normal",
    source: "system",
    createdAt: Date.now() - seq * 90_000,
    readAt: null,
    ...n,
  });
}
__setHydratedForTests(true);

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <div style={{ maxWidth: 460, margin: "24px auto", padding: "0 16px" }}>
      <NotificationsHomeCenter />
    </div>,
  );
}
