/**
 * Storybook states for the ChoiceWidget chat widget across populated, empty,
 * and interaction-focused render states.
 */
import type { Meta, StoryObj } from "@storybook/react";
import {
  assert,
  waitForTestId,
} from "../../../storybook/home-widget-decorator";
import { mockApp } from "../../../storybook/mock-providers.helpers";
import { ChoiceWidget } from "./ChoiceWidget";

const meta = {
  title: "Chat/Widgets/ChoiceWidget",
  component: ChoiceWidget,
  tags: ["autodocs"],
  argTypes: {
    id: { control: "text" },
    scope: { control: "text" },
    onChoose: { action: "choose" },
  },
  decorators: [mockApp()],
  args: {
    id: "choice-1",
    scope: "app-create",
    onChoose: () => {},
    options: [
      { value: "calendar", label: "Calendar" },
      { value: "notes", label: "Notes" },
      { value: "cancel", label: "Cancel" },
    ],
  },
} satisfies Meta<typeof ChoiceWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const TwoOptions: Story = {
  args: {
    id: "choice-2",
    scope: "plugin-create",
    options: [
      { value: "confirm", label: "Confirm" },
      { value: "cancel", label: "Cancel" },
    ],
  },
};

export const ManyOptions: Story = {
  args: {
    id: "choice-3",
    scope: "app-pick",
    options: [
      { value: "messages", label: "Messages" },
      { value: "calendar", label: "Calendar" },
      { value: "notes", label: "Notes" },
      { value: "reminders", label: "Reminders" },
      { value: "weather", label: "Weather" },
      { value: "none", label: "None of these" },
    ],
  },
};

export const SelectedCollapsed: Story = {
  args: {
    id: "choice-selected",
    scope: "app-create",
    onChoose: () => {},
    options: [
      { value: "calendar", label: "Calendar" },
      { value: "notes", label: "Notes" },
      { value: "cancel", label: "Cancel" },
    ],
  },
  play: async ({ canvasElement }) => {
    const button = await waitForTestId(canvasElement, "choice-calendar");
    button.click();
    const summary = await waitForTestId(
      canvasElement,
      "choice-shell-choice-selected-summary",
    );
    assert(
      /selected:\s*calendar/i.test(summary.textContent ?? ""),
      "selected choice summary is visible",
    );
  },
};

export const NoCancel: Story = {
  args: {
    id: "choice-4",
    scope: "tone-pick",
    options: [
      { value: "casual", label: "Casual" },
      { value: "formal", label: "Formal" },
      { value: "playful", label: "Playful" },
    ],
  },
};

export const Empty: Story = {
  args: {
    id: "choice-empty",
    scope: "app-create",
    options: [],
  },
};
