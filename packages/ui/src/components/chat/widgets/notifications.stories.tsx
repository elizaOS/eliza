/**
 * Storybook states for the Notifications chat widget across populated, empty,
 * and interaction-focused render states.
 */
import type { AgentNotification } from "@elizaos/core";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import {
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
} from "../../../state/notifications/notification-store";
import { NotificationsWidget } from "./notifications";

/**
 * The frontpage Notifications widget (#9143) reads the shared notification
 * store via `useNotifications()` — not props — so every story seeds that store
 * through a decorator that resets it and ingests a fixed set of notifications.
 * The widget renders nothing until there is real activity (#9226), so there is
 * no blank/empty story; the meaningful renders are populated, the unread-badge
 * variant, long bodies, and unicode content.
 */
function seedNotifications(notifications: AgentNotification[]): Decorator {
  return (Story) => {
    __resetNotificationStoreForTests();
    // Ingest oldest-first so the store's newest-first ordering matches input.
    for (let i = notifications.length - 1; i >= 0; i--) {
      __ingestNotificationForTests(notifications[i]);
    }
    return <Story />;
  };
}

function notification(
  over: Partial<AgentNotification> & {
    id: AgentNotification["id"];
    title: string;
  },
): AgentNotification {
  return {
    category: "general",
    priority: "normal",
    source: "system",
    createdAt: 1_704_700_000_000,
    readAt: null,
    ...over,
  };
}

const meta = {
  title: "Chat/Widgets/NotificationsWidget",
  component: NotificationsWidget,
  tags: ["autodocs"],
  args: { pluginId: "notifications" },
} satisfies Meta<typeof NotificationsWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A mix of categories and priorities, all unread (badge shows the count). */
export const Populated: Story = {
  decorators: [
    seedNotifications([
      notification({
        id: "11111111-1111-4111-8111-111111111111",
        title: "Workflow finished",
        body: "Daily digest generated and emailed.",
        category: "workflow",
        priority: "normal",
        source: "workflow",
      }),
      notification({
        id: "22222222-2222-4222-8222-222222222222",
        title: "Approval needed",
        body: "Approve the container deploy to production.",
        category: "approval",
        priority: "high",
        source: "orchestrator",
      }),
      notification({
        id: "33333333-3333-4333-8333-333333333333",
        title: "Reminder: standup at 10am",
        category: "reminder",
        priority: "normal",
        source: "lifeops",
      }),
    ]),
  ],
};

/** A single urgent notification — the unread badge reads "1". */
export const SingleUnread: Story = {
  decorators: [
    seedNotifications([
      notification({
        id: "44444444-4444-4444-8444-444444444444",
        title: "Sleep threshold crossed",
        body: "You slept under 6h three nights running.",
        category: "health",
        priority: "urgent",
        source: "health",
      }),
    ]),
  ],
};

/** All read — the title still renders but no unread badge appears. */
export const AllRead: Story = {
  decorators: [
    seedNotifications([
      notification({
        id: "55555555-5555-4555-8555-555555555555",
        title: "Backup completed",
        body: "Nightly incremental backup succeeded.",
        category: "system",
        priority: "low",
        source: "system",
        readAt: 1_704_700_500_000,
      }),
    ]),
  ],
};

/** Long bodies must truncate to a single line per row. */
export const LongBodies: Story = {
  decorators: [
    seedNotifications([
      notification({
        id: "66666666-6666-4666-8666-666666666666",
        title:
          "Coding agent finished the parser refactor and opened a pull request",
        body: "Touched 14 files across the runtime and added a regression test; review the diff and re-run the live trajectory before merging to develop.",
        category: "agent",
        priority: "normal",
        source: "orchestrator",
      }),
    ]),
  ],
};

/** Non-ASCII titles and bodies must render without mojibake. */
export const UnicodeContent: Story = {
  decorators: [
    seedNotifications([
      notification({
        id: "77777777-7777-4777-8777-777777777777",
        title: "新しいメッセージ 📨",
        body: "田中さんから返信が届きました。",
        category: "message",
        priority: "normal",
        source: "telegram",
      }),
      notification({
        id: "88888888-8888-4888-8888-888888888888",
        title: "تذكير بالموعد ⏰",
        body: "اجتماع الساعة العاشرة صباحاً.",
        category: "reminder",
        priority: "high",
        source: "lifeops",
      }),
    ]),
  ],
};
