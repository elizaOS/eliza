/** Loading, error-recovery, and platform-restricted dynamic-view states. */
import type { Meta, StoryObj } from "@storybook/react";
import { assert } from "../../storybook/home-widget-decorator";
import {
  ViewErrorState,
  ViewLoadingSkeleton,
  ViewRestrictedState,
} from "./ViewStatusStates";

let retryCount = 0;

const meta = {
  title: "Views/ViewStatusStates",
  component: ViewErrorState,
  parameters: { layout: "fullscreen" },
  args: {
    viewId: "calendar-planner",
    error: new Error("The view bundle could not be loaded."),
    onRetry: () => {
      retryCount += 1;
    },
    onBack: () => {},
  },
} satisfies Meta<typeof ViewErrorState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RecoverableError: Story = {
  play: async ({ canvasElement }) => {
    retryCount = 0;
    const retry = Array.from(canvasElement.querySelectorAll("button")).find(
      (button) => /retry/i.test(button.textContent ?? ""),
    );
    assert(retry instanceof HTMLButtonElement, "retry action renders");
    retry.click();
    assert(retryCount === 1, "retry callback fires");
  },
};

export const Loading: Story = { render: () => <ViewLoadingSkeleton /> };
export const Restricted: Story = {
  render: () => <ViewRestrictedState viewId="desktop-terminal" />,
};
