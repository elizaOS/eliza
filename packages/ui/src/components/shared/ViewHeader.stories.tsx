/** Demonstrates actionable view controls and the intentionally empty no-action state. */
import type { Meta, StoryObj } from "@storybook/react";
import { assert } from "../../storybook/home-widget-decorator";
import { Button } from "../ui/button";
import { ViewHeader } from "./ViewHeader";

let actionCount = 0;

const meta = {
  title: "Shared/ViewHeader",
  component: ViewHeader,
  parameters: { layout: "fullscreen" },
  args: {
    title: "Automations",
  },
} satisfies Meta<typeof ViewHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    right: (
      <Button
        size="sm"
        onClick={() => {
          actionCount += 1;
        }}
      >
        New task
      </Button>
    ),
  },
  play: async ({ canvasElement }) => {
    actionCount = 0;
    const action = canvasElement.querySelector("button");
    assert(action instanceof HTMLButtonElement, "view action renders");
    action.click();
    assert(actionCount === 1, "view action callback fires");
  },
};

export const WithTrailingAction: Story = {
  args: { right: <Button size="sm">New task</Button> },
};

export const SubviewReturn: Story = {
  args: {
    title: "Run details",
    backLabel: "Back to activity",
    onBack: () => {
      actionCount += 1;
    },
  },
  play: async ({ canvasElement }) => {
    actionCount = 0;
    const back = canvasElement.querySelector('[aria-label="Back to activity"]');
    assert(back instanceof HTMLButtonElement, "subview return control renders");
    back.click();
    assert(actionCount === 1, "subview return callback fires");
  },
};

export const RootView: Story = {
  tags: ["story-gate-expect-blank"],
  args: { showBack: false, title: "Home" },
};
