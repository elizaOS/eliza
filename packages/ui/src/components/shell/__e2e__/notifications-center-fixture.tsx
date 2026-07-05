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
    body: "New here? A two-minute guided tour shows you chat, the launcher, and your home screen.",
    category: "general",
    priority: "normal",
    deepLink: "/tutorial",
  },
  {
    title: "Get help any time",
    body: "Stuck or curious? The help center answers common questions and can restart the tour.",
    category: "general",
    priority: "low",
    deepLink: "/help",
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
