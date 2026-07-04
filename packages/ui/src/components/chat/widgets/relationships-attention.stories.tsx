/**
 * Storybook states for the Relationships Attention chat widget across
 * populated, empty, and interaction-focused render states.
 */
import type { Meta, StoryObj } from "@storybook/react";
import {
  assert,
  waitForTestId,
  withSeededHomeWidget,
} from "../../../storybook/home-widget-decorator";
import { RelationshipsAttentionWidget } from "./relationships-attention";

// The icon-first home Relationships widget (#9304): surfaces a pending
// identity-merge / person needing attention; self-hides when nothing is pending.

const meta = {
  title: "Shell/Home Widgets/Relationships",
  component: RelationshipsAttentionWidget,
  parameters: { layout: "centered" },
  decorators: [withSeededHomeWidget],
  args: { pluginId: "personal-assistant", slot: "home" },
} satisfies Meta<typeof RelationshipsAttentionWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NeedsAttention: Story = {
  play: async ({ canvasElement }) => {
    const card = await waitForTestId(
      canvasElement,
      "chat-widget-relationships",
    );
    assert(card instanceof HTMLButtonElement, "the whole card is a button");
  },
};
