/**
 * Storybook states for the Goals Attention chat widget across populated,
 * empty, and interaction-focused render states.
 */
import type { Meta, StoryObj } from "@storybook/react";
import {
  assert,
  waitForTestId,
  withSeededHomeWidget,
} from "../../../storybook/home-widget-decorator";
import { GoalsAttentionWidget } from "./goals-attention";

// The icon-first home Goals widget (#9304): surfaces the single most at-risk
// goal (warn tone) and self-hides when every goal is on track.

const meta = {
  title: "Shell/Home Widgets/Goals",
  component: GoalsAttentionWidget,
  parameters: { layout: "centered" },
  decorators: [withSeededHomeWidget],
  args: { pluginId: "personal-assistant", slot: "home" },
} satisfies Meta<typeof GoalsAttentionWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NeedsAttention: Story = {
  play: async ({ canvasElement }) => {
    const card = await waitForTestId(canvasElement, "widget-goals-attention");
    assert(card instanceof HTMLButtonElement, "the whole card is a button");
    assert(
      card.textContent?.includes("Ship the release"),
      "shows the at-risk goal",
    );
  },
};
