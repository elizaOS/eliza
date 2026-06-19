import type { Meta, StoryObj } from "@storybook/react";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import {
  ContactsPageView,
  MessagesPageView,
  PhonePageView,
} from "./ElizaOsAppsView";

/**
 * The ElizaOS Apps views (Phone, Messages, Contacts) are Android-native
 * workspaces. They fetch their data from the native plugin bridge on mount.
 * In Storybook there is no native bridge, so the plugin calls reject and the
 * views render their empty / error states — which is exactly the useful,
 * story-able surface here.
 */
const meta = {
  title: "Pages/ElizaOsAppsView",
  component: PhonePageView,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    withMockApp,
    (Story) => (
      <div className="h-screen w-full bg-bg text-txt">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PhonePageView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The Phone workspace, defaulting to the Dialer panel. */
export const Phone: Story = {};

/** The Messages workspace: compose panel plus the SMS list (empty state). */
export const Messages: Story = {
  render: () => <MessagesPageView />,
};

/** The Contacts workspace: create form plus the contact list (empty state). */
export const Contacts: Story = {
  render: () => <ContactsPageView />,
};
