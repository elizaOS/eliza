/**
 * Storybook states for the local Telegram and BlueBubbles group-readiness
 * contracts, with no runtime, provider, or credential dependencies.
 */

import type { Meta, StoryObj } from "@storybook/react";
import { GroupChatReadinessGuide } from "./GroupChatReadinessGuide";

const meta = {
  title: "Connectors/GroupChatReadinessGuide",
  component: GroupChatReadinessGuide,
  tags: ["autodocs"],
  args: {
    connector: "telegram",
  },
  argTypes: {
    connector: {
      control: "select",
      options: ["telegram", "bluebubbles"],
    },
  },
} satisfies Meta<typeof GroupChatReadinessGuide>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Telegram: Story = {};

export const BlueBubbles: Story = {
  args: {
    connector: "bluebubbles",
  },
};
