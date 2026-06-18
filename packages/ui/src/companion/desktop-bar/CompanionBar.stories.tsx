import type { Meta, StoryObj } from "@storybook/react";
import { CompanionBar } from "./CompanionBar";
import type { TrayMessage } from "./types";

const sampleMessages: TrayMessage[] = [
  {
    id: "m1",
    role: "user",
    text: "What's on my calendar this afternoon?",
    createdAt: Date.now() - 60_000,
  },
  {
    id: "m2",
    role: "agent",
    text: "You have a sync at 2pm and you're free after 3:30.",
    createdAt: Date.now() - 30_000,
  },
  {
    id: "m3",
    role: "user",
    text: "Block 4-5pm for focus time.",
    createdAt: Date.now() - 10_000,
  },
];

const meta = {
  title: "Companion/DesktopBar/CompanionBar",
  component: CompanionBar,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  argTypes: {
    mode: { control: "select", options: [undefined, "collapsed", "expanded"] },
    defaultMode: { control: "select", options: ["collapsed", "expanded"] },
    micState: {
      control: "select",
      options: [undefined, "off", "listening", "always-on"],
    },
    defaultMicState: {
      control: "select",
      options: ["off", "listening", "always-on"],
    },
    placeholder: { control: "text" },
  },
  args: {
    hooks: {
      onSend: () => {},
      onMicStateChange: () => {},
      onPushToTalkDown: () => {},
      onPushToTalkUp: () => {},
      onExpandChange: () => {},
    },
  },
} satisfies Meta<typeof CompanionBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Collapsed: Story = {
  args: {
    defaultMode: "collapsed",
  },
};

export const Expanded: Story = {
  args: {
    mode: "expanded",
    messages: sampleMessages,
  },
};

export const EmptyExpanded: Story = {
  args: {
    mode: "expanded",
    messages: [],
    placeholder: "Ask eliza anything…",
  },
};

export const MicAlwaysOn: Story = {
  args: {
    mode: "collapsed",
    micState: "always-on",
  },
};

export const ExpandedMicOn: Story = {
  args: {
    mode: "expanded",
    micState: "always-on",
    messages: sampleMessages,
  },
};
