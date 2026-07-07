/**
 * Fixture for the notification-shade browser regression run: seeds the store
 * with a spread that exercises every shade surface — a multi-row interrupt
 * group (renders as the rested Z-stack), a solo interrupt row, and
 * sub-interrupt rows (hidden at rest behind the pull hint, including the
 * onboarding "Take the tour" row the capture asserts appears after the pull
 * gesture expands the shade).
 */
import type { AgentNotification } from "@elizaos/core";
import { createRoot } from "react-dom/client";
import {
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
  __setHydratedForTests,
} from "../../../state/notifications/notification-store";
import { NotificationsHomeCenter } from "../NotificationsHomeCenter";

const SEED_SET: Array<Partial<AgentNotification>> = [
  // One view-group with three interrupt rows → the rested Z-stack (urgent on
  // top, two glass peeks beneath).
  {
    title: "Build failed on main",
    body: "verify lane: typecheck exited 1 — tap to open the run.",
    category: "task",
    priority: "urgent",
  },
  {
    title: "PR #42 approved",
    body: "Ready to merge once CI settles.",
    category: "task",
    priority: "high",
  },
  {
    title: "Deploy queued",
    category: "task",
    priority: "high",
  },
  // A solo interrupt row in its own group → renders flat next to the stack.
  {
    title: "Disk almost full",
    body: "The agent workspace volume is at 94% capacity.",
    category: "system",
    priority: "high",
  },
  // Sub-interrupt rows: hidden at rest behind the "N more" pull hint.
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
for (const n of SEED_SET) {
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
    // The shade is a min-h-0 flex-1 column child in the app; give it the same
    // bounded flex context here so the internal scroller actually scrolls.
    <div
      style={{
        maxWidth: 460,
        margin: "24px auto",
        padding: "0 16px",
        height: "80vh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <NotificationsHomeCenter />
    </div>,
  );
}
