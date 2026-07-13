/**
 * Fixture for the inline notification-inbox browser regression run. The seed
 * covers a multi-row interrupt stack, a solo interrupt row, and enough quiet
 * producer groups to overflow the inbox's bounded native scrollport once the
 * explicit mode toggle reveals them. The stack and inbox modes stay orthogonal:
 * stack-local tap/drag/wheel gestures fan one producer without revealing the
 * quiet digest.
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
  // One producer with three interrupt rows → the rested Z-stack (urgent on
  // top, two glass peeks beneath).
  {
    title: "Build failed on main",
    body: "verify lane: typecheck exited 1 — tap to open the run.",
    category: "task",
    priority: "urgent",
    source: "github",
  },
  {
    title: "PR #42 approved",
    body: "Ready to merge once CI settles.",
    category: "task",
    priority: "high",
    source: "github",
  },
  {
    title: "Deploy queued",
    category: "task",
    priority: "high",
    source: "github",
  },
  // A solo interrupt row in its own group → renders flat next to the stack.
  {
    title: "Disk almost full",
    body: "The agent workspace volume is at 94% capacity.",
    category: "system",
    priority: "high",
  },
  // Sub-interrupt rows: distinct producers keep the full inbox tall enough to
  // exercise the component-owned max height and native vertical scrolling.
  {
    title: "Take the tour",
    body: "New here? A one-minute tour runs right in the chat — it walks you through messaging, voice, and navigating by asking.",
    category: "general",
    priority: "normal",
    source: "onboarding-tour",
    deepLink: "/chat",
  },
  {
    title: "Get help any time",
    body: "Stuck or curious? Just ask in the chat — your agent answers questions about the app and can restart the tour.",
    category: "general",
    priority: "low",
    source: "onboarding-help",
    deepLink: "/chat",
  },
  {
    title: "Connect your calendar",
    body: "Link a calendar so your agent can brief you on what's next and keep your day on track.",
    category: "general",
    priority: "low",
    source: "onboarding-calendar",
    deepLink: "/connectors",
  },
  {
    title: "Workspace indexed",
    body: "Search is ready across the current project.",
    category: "system",
    priority: "normal",
    source: "documents",
  },
  {
    title: "Backup complete",
    body: "Workspace snapshot stored locally.",
    category: "system",
    priority: "low",
    source: "backup",
  },
  {
    title: "Agent digest ready",
    body: "Three background tasks finished while you were away.",
    category: "agent",
    priority: "normal",
    source: "agent",
  },
  {
    title: "New message from Alex",
    body: "The launch notes are ready for review.",
    category: "message",
    priority: "normal",
    source: "messages",
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
    // Deliberately provide NO flex-fill or fixed-height parent. The component
    // itself owns the cap; its section must otherwise remain natural-height so
    // the Apps section that follows it in HomeScreen can stack immediately.
    <div
      data-testid="fixture-home-column"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        maxWidth: 460,
        margin: "24px auto",
        padding: "0 16px",
      }}
    >
      <NotificationsHomeCenter />
      <section
        aria-label="Apps"
        data-testid="fixture-apps-section"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: "0.08em",
            opacity: 0.62,
            textTransform: "uppercase",
          }}
        >
          Apps
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: 10,
          }}
        >
          {["Chat", "Tasks", "Settings"].map((label) => (
            <button
              key={label}
              type="button"
              style={{
                minHeight: 72,
                border: "1px solid rgba(255,255,255,0.16)",
                borderRadius: 16,
                color: "inherit",
                background: "rgba(255,255,255,0.09)",
                boxShadow:
                  "inset 0 1px 0 rgba(255,255,255,0.18), 0 8px 28px rgba(0,0,0,0.16)",
                backdropFilter: "blur(18px)",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </section>
    </div>,
  );
}
