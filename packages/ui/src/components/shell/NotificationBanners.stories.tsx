/**
 * NotificationBanners stories — the top-of-screen glass banner queue, rendered
 * over a wallpaper-like field so the glass reads. Each story seeds the banner
 * store on mount so the portal has something to paint.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { useEffect } from "react";
import {
  __resetNotificationBannersForTests,
  pushNotificationBanner,
} from "../../state/notifications/notification-banner-store";
import { NotificationBanners } from "./NotificationBanners";

const BASE = 1_720_000_000_000;

function Seed({
  banners,
}: {
  banners: Array<Parameters<typeof pushNotificationBanner>[0]>;
}): null {
  useEffect(() => {
    __resetNotificationBannersForTests();
    for (const b of [...banners].reverse()) pushNotificationBanner(b);
    return () => __resetNotificationBannersForTests();
  }, [banners]);
  return null;
}

const meta: Meta<typeof NotificationBanners> = {
  title: "Shell/NotificationBanners",
  component: NotificationBanners,
  decorators: [
    (Story) => (
      <div
        style={{
          position: "relative",
          minHeight: "60vh",
          background:
            "linear-gradient(160deg,#f7b58a 0%,#e8896b 45%,#c9607e 100%)",
        }}
      >
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof NotificationBanners>;

export const Stack: Story = {
  render: () => (
    <>
      <Seed
        banners={[
          {
            id: "n-urgent",
            title: "Payment failed",
            body: "Your card ending 4242 was declined.",
            category: "system",
            priority: "urgent",
            source: "billing",
            createdAt: BASE,
            readAt: null,
          },
          {
            id: "n-msg",
            title: "New message from Alice",
            body: "“Did you get a chance to look at the design doc?”",
            category: "message",
            priority: "normal",
            source: "messages",
            createdAt: BASE - 60_000,
            readAt: null,
          },
          {
            id: "n-reminder",
            title: "Reminder: stand-up in 10 minutes",
            category: "reminder",
            priority: "high",
            source: "calendar",
            createdAt: BASE - 120_000,
            readAt: null,
          },
        ]}
      />
      <NotificationBanners />
    </>
  ),
};

export const Single: Story = {
  render: () => (
    <>
      <Seed
        banners={[
          {
            id: "n-1",
            title: "Deploy pipeline update",
            body: "Step 5/5: released to staging.",
            category: "workflow",
            priority: "normal",
            source: "ci",
            createdAt: BASE,
            readAt: null,
          },
        ]}
      />
      <NotificationBanners />
    </>
  ),
};
