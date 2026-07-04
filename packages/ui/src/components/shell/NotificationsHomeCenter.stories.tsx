/**
 * Stories for the dashboard notification center: the pinned home widget that
 * IS the notification inbox. Seeds the shared notification store directly so
 * the stories render real store-driven states (no network).
 */

import type { AgentNotification } from "@elizaos/core";
import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useState } from "react";
import {
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
} from "../../state/notifications/notification-store";
import { NotificationsHomeCenter } from "./NotificationsHomeCenter";

let seq = 0;
function seed(overrides: Partial<AgentNotification>): void {
  seq += 1;
  const hex = String(seq).padStart(12, "0");
  __ingestNotificationForTests({
    id: `00000000-0000-4000-8000-${hex}` as AgentNotification["id"],
    title: "Notification",
    category: "general",
    priority: "normal",
    source: "story",
    createdAt: Date.now() - seq * 90_000,
    readAt: null,
    ...overrides,
  });
}

/** Seed the store before the first render, reset on unmount. */
function Seeded({
  notifications,
}: {
  notifications: Array<Partial<AgentNotification>>;
}): React.JSX.Element | null {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    __resetNotificationStoreForTests();
    seq = 0;
    for (const n of notifications) seed(n);
    setReady(true);
    return () => __resetNotificationStoreForTests();
  }, [notifications]);
  if (!ready) return null;
  return (
    <div className="max-w-md">
      <NotificationsHomeCenter />
    </div>
  );
}

const meta: Meta<typeof NotificationsHomeCenter> = {
  title: "Shell/NotificationsHomeCenter",
  component: NotificationsHomeCenter,
};
export default meta;

type Story = StoryObj<typeof NotificationsHomeCenter>;

export const MixedPriorities: Story = {
  render: () => (
    <Seeded
      notifications={[
        {
          title: "Disk almost full",
          body: "The agent workspace volume is at 94% capacity.",
          category: "system",
          priority: "urgent",
        },
        {
          title: "Approval needed",
          body: "A workflow wants to send an email on your behalf.",
          category: "approval",
          priority: "high",
        },
        {
          title: "Reminder: stand-up in 10 minutes",
          category: "reminder",
          priority: "normal",
        },
        {
          title: "Nightly backup finished",
          category: "task",
          priority: "low",
          readAt: Date.now() - 30_000,
        },
      ]}
    />
  ),
};

export const ScrollingInbox: Story = {
  render: () => (
    <Seeded
      notifications={Array.from({ length: 14 }, (_, i) => ({
        title: `Update ${i + 1}`,
        body:
          i % 3 === 0
            ? "Something happened that you may care about."
            : undefined,
        category: (["task", "message", "workflow"] as const)[i % 3],
        priority: (["normal", "high", "low"] as const)[i % 3],
      }))}
    />
  ),
};

export const SingleRead: Story = {
  render: () => (
    <Seeded
      notifications={[
        {
          title: "Welcome to your dashboard",
          body: "Notifications will show up here.",
          category: "system",
          readAt: Date.now() - 5_000,
        },
      ]}
    />
  ),
};
