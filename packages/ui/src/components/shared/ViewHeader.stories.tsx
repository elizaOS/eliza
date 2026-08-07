/** Standard title, back-navigation, and trailing-action header compositions. */
import type { Meta, StoryObj } from "@storybook/react";
import { assert } from "../../storybook/home-widget-decorator";
import { Button } from "../ui/button";
import { ViewHeader } from "./ViewHeader";

let backCount = 0;

const meta = {
  title: "Shared/ViewHeader",
  component: ViewHeader,
  parameters: { layout: "fullscreen" },
  args: {
    title: "Automations",
    onBack: () => {
      backCount += 1;
    },
  },
} satisfies Meta<typeof ViewHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    backCount = 0;
    const back = canvasElement.querySelector(
      'button[aria-label="Back to launcher"]',
    );
    assert(back instanceof HTMLButtonElement, "back control renders");
    back.click();
    assert(backCount === 1, "back callback fires");
  },
};

export const WithTrailingAction: Story = {
  args: { right: <Button size="sm">New task</Button> },
};

export const RootView: Story = { args: { showBack: false, title: "Home" } };
