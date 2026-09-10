/** Exercises the page action strip and its empty state. */
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
    assert(action instanceof HTMLButtonElement, "page action is available");
    action.click();
    assert(actionCount === 1, "page action callback fires");
  },
};

export const WithTrailingAction: Story = {
  args: { right: <Button size="sm">New task</Button> },
};

export const RootView: Story = {
  tags: ["story-gate-expect-blank"],
  args: { showBack: false, title: "Home" },
  play: async ({ canvasElement }) => {
    assert(
      canvasElement.childElementCount === 0,
      "a view without trailing actions leaves no empty header row",
    );
  },
};
