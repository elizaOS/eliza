/**
 * Storybook states for the Health Sleep chat widget across populated, empty,
 * and interaction-focused render states.
 */
import type { Meta, StoryObj } from "@storybook/react";
import {
  assert,
  waitForTestId,
  withSeededHomeWidget,
} from "../../../storybook/home-widget-decorator";
import { HealthSleepWidget } from "./health-sleep";

// The icon-first home Sleep widget (#9304): last night's duration + an
// "Irregular" status badge when the rhythm is off; self-hides when healthy.

const meta = {
  title: "Shell/Home Widgets/Sleep",
  component: HealthSleepWidget,
  parameters: { layout: "centered" },
  decorators: [withSeededHomeWidget],
  args: { pluginId: "health", slot: "home" },
} satisfies Meta<typeof HealthSleepWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NeedsAttention: Story = {
  play: async ({ canvasElement }) => {
    const card = await waitForTestId(canvasElement, "widget-health-sleep");
    assert(card instanceof HTMLButtonElement, "the whole card is a button");
    assert(
      card.textContent?.includes("Irregular"),
      "shows the off-rhythm sleep status",
    );
  },
};
