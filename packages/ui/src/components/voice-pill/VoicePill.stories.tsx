import type { Meta, StoryObj } from "@storybook/react";
import { VoicePill, type VoicePillMessage } from "./VoicePill";

const sampleMessages: VoicePillMessage[] = [
  { id: "1", role: "user", text: "What is on my calendar today?" },
  {
    id: "2",
    role: "agent",
    text: "You have a standup at 10 and a design review at 2.",
  },
  { id: "3", role: "user", text: "Move the design review to tomorrow." },
  { id: "4", role: "agent", text: "Done — rescheduled to 2pm tomorrow." },
];

const meta = {
  title: "VoicePill/VoicePill",
  component: VoicePill,
  tags: ["autodocs"],
  argTypes: {
    open: { control: "boolean" },
    recording: { control: "boolean" },
    placeholder: { control: "text" },
    ariaLabel: { control: "text" },
    className: { control: "text" },
    messages: { control: "object" },
    onOpenChange: { action: "openChange" },
    onRecordingChange: { action: "recordingChange" },
    onSubmit: { action: "submit" },
    onAdd: { action: "add" },
  },
  args: {
    placeholder: "Ask Eliza…",
    ariaLabel: "Eliza",
    onOpenChange: () => {},
    onRecordingChange: () => {},
    onSubmit: () => {},
    onAdd: () => {},
  },
  decorators: [
    (Story) => (
      <div
        style={{
          minHeight: "240px",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "center",
          padding: "32px",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof VoicePill>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Expanded: Story = {
  args: {
    open: true,
  },
};

export const WithConversation: Story = {
  args: {
    open: true,
    messages: sampleMessages,
  },
};

export const Recording: Story = {
  args: {
    open: true,
    recording: true,
    messages: sampleMessages.slice(0, 2),
  },
};

export const CustomPlaceholder: Story = {
  args: {
    open: true,
    placeholder: "Speak or type your request…",
    ariaLabel: "Voice assistant",
  },
};
