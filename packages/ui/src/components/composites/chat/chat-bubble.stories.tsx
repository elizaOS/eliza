/**
 * Storybook states for the Chat Bubble chat composite used by shared
 * conversation and composer surfaces.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { Card } from "../../ui/card";
import { ChatBubble } from "./chat-bubble";

const meta = {
  title: "Composites/Chat/ChatBubble",
  component: ChatBubble,
  tags: ["autodocs"],
  argTypes: {
    tone: { control: "select", options: ["assistant", "user"] },
    variant: { control: "select", options: ["panel", "glass"] },
    appearance: {
      control: "select",
      options: ["default", "firstRun", "game", "gameTyping", "suggestion"],
    },
    bare: { control: "boolean" },
    source: {
      control: "select",
      options: [undefined, "imessage", "telegram", "discord", "whatsapp"],
    },
    children: { control: "text" },
  },
  args: {
    tone: "assistant",
    children: "Hey, I pulled up the schedule — you are free after 3pm today.",
  },
} satisfies Meta<typeof ChatBubble>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Assistant: Story = {};

export const User: Story = {
  args: {
    tone: "user",
    children: "Perfect, book the 3:30 slot then.",
  },
};

export const FromTelegram: Story = {
  args: {
    tone: "user",
    source: "telegram",
    children: "Can you forward that to the team channel?",
  },
};

export const FromDiscord: Story = {
  args: {
    tone: "assistant",
    source: "discord",
    children: "Posted it to #general and pinned the summary.",
  },
};

export const BareGlass: Story = {
  args: {
    variant: "glass",
    bare: true,
    children: "Ready when you are.",
  },
};

export const FirstRun: Story = {
  args: {
    appearance: "firstRun",
    variant: "glass",
    children: "Hi, I'm Eliza. What would you like to do first?",
  },
  render: (args) => (
    <div className="flex flex-col gap-6">
      <ChatBubble {...args} data-testid="first-run-bubble" />
      <Card
        variant="panel"
        padding="comfortable"
        radius="xlarge"
        className="w-fit max-w-full"
        data-testid="first-run-reference"
      >
        Canonical panel reference
      </Card>
    </div>
  ),
  decorators: [
    (Story) => (
      <div className="w-[22rem] max-w-full">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const surface = canvasElement.querySelector<HTMLElement>(
      '[data-testid="first-run-bubble"]',
    );
    const reference = canvasElement.querySelector<HTMLElement>(
      '[data-testid="first-run-reference"]',
    );
    if (!surface || !reference)
      throw new Error("The first-run bubble and canonical panel must render.");
    const computed = getComputedStyle(surface);
    const canonical = getComputedStyle(reference);
    for (const property of [
      "backgroundColor",
      "color",
      "borderTopColor",
      "borderTopWidth",
      "borderTopLeftRadius",
      "borderBottomLeftRadius",
      "paddingLeft",
      "paddingTop",
      "backdropFilter",
      "textShadow",
    ] as const) {
      if (computed[property] !== canonical[property]) {
        throw new Error(
          `First-run ${property} must come from its canonical panel.`,
        );
      }
    }
    const box = surface.getBoundingClientRect();
    const column = surface.parentElement?.getBoundingClientRect();
    if (
      box.width <= 0 ||
      !column ||
      box.width > column.width + 0.5 ||
      surface.scrollWidth > surface.clientWidth ||
      Number.parseFloat(computed.paddingLeft) <= 0
    ) {
      throw new Error(
        "First-run bubble must fit its rendered conversation column.",
      );
    }
  },
};

export const Multiline: Story = {
  args: {
    children:
      "Here is the plan:\n\n1. Confirm the venue\n2. Send invites\n3. Lock the menu by Friday",
  },
};
