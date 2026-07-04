/**
 * Storybook states for the ChoiceWidget chat widget across populated, empty,
 * and interaction-focused render states.
 */
import type { Meta, StoryObj } from "@storybook/react";
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
  args: {
    id: "choice-1",
    scope: "app-create",
    onChoose: (value: string) => {
      // no-op for stories
      console.log("chose", value);
    },
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
