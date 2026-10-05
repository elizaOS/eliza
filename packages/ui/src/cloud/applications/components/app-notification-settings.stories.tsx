/** Shows signed callback setup with a synthetic SDK transport and no real signing material. */
import type { Meta, StoryObj } from "@storybook/react";
import { notificationFixture } from "./app-notification-fixture";
import { AppNotificationSettings } from "./app-notification-settings";

const fixture = notificationFixture();
const meta = {
  title: "Cloud/Apps/Signed notifications",
  component: AppNotificationSettings,
  args: {
    client: fixture.client,
    appId: "app-a",
    clientRegistrationId: "client-test",
    environment: "test",
  },
} satisfies Meta<typeof AppNotificationSettings>;
export default meta;
export const Setup: StoryObj<typeof meta> = {};
