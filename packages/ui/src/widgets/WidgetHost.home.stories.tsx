/**
 * Storybook stories for the home WidgetHost, seeding activity/notification state.
 */
import type { AgentNotification } from "@elizaos/core";
import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useState } from "react";
import type { ActivityEvent } from "../hooks/useActivityEvents";
import { __setAppValueForTests } from "../state";
import {
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
} from "../state/notifications/notification-store";
import { WidgetHost } from "./WidgetHost";

/**
 * The home `WidgetHost` (#9143) — exactly what the /chat launch screen mounts
 * (`HomeScreen` → `<WidgetHost slot="home" layout="grid">`). This story seeds the
 * module-level app store + the notification store so the real home cards render
 * the way they do on a populated launch. The per-plugin lifeops cards self-hide
 * here (no backend), which is the intended fresh-launch behavior.
 */

const NOW = Date.UTC(2026, 5, 24, 8, 0, 0);

const NOTIFICATIONS: AgentNotification[] = [
  {
    id: "n1" as AgentNotification["id"],
    title: "PR #9412 ready for review",
    body: "chat-widget matrix + shared parity hook",
    category: "agent",
    priority: "high",
    source: "orchestrator",
    createdAt: NOW - 120_000,
  },
  {
    id: "n2" as AgentNotification["id"],
    title: "Standup at 10:30",
    body: "daily sync — bring the deploy notes",
    category: "reminder",
    priority: "normal",
    source: "lifeops",
    createdAt: NOW - 3_600_000,
  },
];

const CONVERSATIONS = [
  {
    id: "c1",
    title: "Trip planning",
    roomId: "r1",
    createdAt: "x",
    updatedAt: "2026-06-24T08:00:00.000Z",
  },
  {
    id: "c2",
    title: "Budget review",
    roomId: "r2",
    createdAt: "x",
    updatedAt: "2026-06-24T07:30:00.000Z",
  },
  {
    id: "c3",
    title: "Launch checklist",
    roomId: "r3",
    createdAt: "x",
    updatedAt: "2026-06-24T06:00:00.000Z",
  },
];

const EVENTS: ActivityEvent[] = [
  {
    id: "a1",
    timestamp: NOW - 8_000,
    eventType: "task_complete",
    summary: "Shipped the chat-widget matrix",
  } as ActivityEvent,
  {
    id: "a2",
    timestamp: NOW - 95_000,
    eventType: "tool_running",
    summary: "Running the home-widget suite",
  } as ActivityEvent,
];

// Mirror the runtime i18n contract: honor a caller's `defaultValue`, else
// humanize the key's last segment — so the cards read like the shipped app
// instead of showing raw i18n keys.
function t(key: string, opts?: { defaultValue?: string }): string {
  if (opts && typeof opts.defaultValue === "string") return opts.defaultValue;
  const tail = key.split(".").pop() ?? key;
  const spaced = tail.replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function HomeWidgetsHarness() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // Seed the module-level stores the real widgets read.
    __setAppValueForTests({
      plugins: [{ id: "agent-orchestrator", enabled: true, isActive: true }],
      conversations: CONVERSATIONS,
      t,
      // biome-ignore lint/suspicious/noExplicitAny: partial seed — widgets read only the fields above
    } as any);
    __resetNotificationStoreForTests();
    for (const n of NOTIFICATIONS) __ingestNotificationForTests(n);
    // No backend in storybook: the API-polled cards (apps, lifeops) get an empty
    // payload so they self-hide cleanly instead of showing a fetch error.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const body = url.includes("/api/approvals")
        ? JSON.stringify({ pending: [] })
        : "[]";
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    setReady(true);
    return () => {
      globalThis.fetch = realFetch;
      __resetNotificationStoreForTests();
      __setAppValueForTests(null);
    };
  }, []);

  if (!ready) return null;
  return (
    <div className="mx-auto w-full max-w-2xl p-4">
      <WidgetHost
        slot="home"
        layout="grid"
        events={EVENTS}
        clearEvents={() => {}}
      />
    </div>
  );
}

const meta = {
  title: "Widgets/HomeWidgets",
  component: HomeWidgetsHarness,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof HomeWidgetsHarness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};
