/**
 * Storybook states for the Inbox Unread chat widget across populated, empty,
 * and interaction-focused render states.
 */
import type { Meta, StoryObj } from "@storybook/react";
import {
  assert,
  waitForTestId,
  withSeededHomeWidget,
} from "../../../storybook/home-widget-decorator";
import { InboxUnreadWidget } from "./inbox-unread";

// The icon-first home Inbox widget (#9304): the latest unread thread's sender
// with an unread-count badge; self-hides when the inbox is clear.

const meta = {
  title: "Shell/Home Widgets/Inbox",
  component: InboxUnreadWidget,
  parameters: { layout: "centered" },
  decorators: [withSeededHomeWidget],
  args: { pluginId: "personal-assistant", slot: "home" },
} satisfies Meta<typeof InboxUnreadWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NeedsAttention: Story = {
  play: async ({ canvasElement }) => {
    const card = await waitForTestId(canvasElement, "chat-widget-inbox-unread");
    assert(card instanceof HTMLButtonElement, "the whole card is a button");
    assert(
      card.textContent?.includes("Alex Rivera"),
      "shows the latest unread sender",
    );
  },
};
