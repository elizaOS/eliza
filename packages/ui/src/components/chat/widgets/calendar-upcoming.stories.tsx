/**
 * Storybook states for the Calendar Upcoming chat widget across populated,
 * empty, and interaction-focused render states.
 */
import type { Meta, StoryObj } from "@storybook/react";
import {
  assert,
  waitForTestId,
  withSeededHomeWidget,
} from "../../../storybook/home-widget-decorator";
import { CalendarUpcomingWidget } from "./calendar-upcoming";

// The icon-first home Calendar widget (#9304): the single most imminent event
// with a tight relative-time `meta` ("in 45m"); self-hides when nothing is near.

const meta = {
  title: "Shell/Home Widgets/Calendar",
  component: CalendarUpcomingWidget,
  parameters: { layout: "centered" },
  decorators: [withSeededHomeWidget],
  args: { pluginId: "personal-assistant", slot: "home" },
} satisfies Meta<typeof CalendarUpcomingWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NeedsAttention: Story = {
  play: async ({ canvasElement }) => {
    const card = await waitForTestId(
      canvasElement,
      "chat-widget-calendar-upcoming",
    );
    assert(card instanceof HTMLButtonElement, "the whole card is a button");
    assert(
      card.textContent?.includes("Design review"),
      "shows the imminent event",
    );
  },
};
