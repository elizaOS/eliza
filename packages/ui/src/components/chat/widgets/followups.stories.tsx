import type { Meta, StoryObj } from "@storybook/react";
import type { FollowupOption } from "./followups";
import { FollowupsWidget } from "./followups";

const mixedOptions: FollowupOption[] = [
  { kind: "reply", payload: "Yes, schedule it", label: "Yes, schedule it" },
  { kind: "reply", payload: "Not right now", label: "Not right now" },
  { kind: "navigate", payload: "/calendar", label: "Open calendar" },
  {
    kind: "prompt",
    payload: "Draft a follow-up email about ",
    label: "Draft email",
  },
];

const meta = {
  title: "Chat/Widgets/Followups",
  component: FollowupsWidget,
  tags: ["autodocs"],
  argTypes: {
    id: { control: "text" },
    onChoose: { action: "choose" },
    onNavigate: { action: "navigate" },
    onPrompt: { action: "prompt" },
  },
  args: {
    id: "fu-default",
    options: mixedOptions,
    onChoose: (value: string) => console.log("choose", value),
    onNavigate: (payload: string) => console.log("navigate", payload),
    onPrompt: (payload: string) => console.log("prompt", payload),
  },
} satisfies Meta<typeof FollowupsWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const RepliesOnly: Story = {
  args: {
    id: "fu-replies",
    options: [
      { kind: "reply", payload: "Sounds good", label: "Sounds good" },
      { kind: "reply", payload: "Maybe later", label: "Maybe later" },
      { kind: "reply", payload: "Tell me more", label: "Tell me more" },
    ],
  },
};

export const NavigateSuggestions: Story = {
  args: {
    id: "fu-navigate",
    options: [
      { kind: "navigate", payload: "/settings", label: "Open settings" },
      { kind: "navigate", payload: "/inbox", label: "Go to inbox" },
    ],
  },
};

export const PromptPrefill: Story = {
  args: {
    id: "fu-prompt",
    options: [
      {
        kind: "prompt",
        payload: "Summarize the last meeting about ",
        label: "Summarize meeting",
      },
      {
        kind: "prompt",
        payload: "Write a status update for ",
        label: "Status update",
      },
    ],
  },
};

export const Empty: Story = {
  args: {
    id: "fu-empty",
    options: [],
  },
};
