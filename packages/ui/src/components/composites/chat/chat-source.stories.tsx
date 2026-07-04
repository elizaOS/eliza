/**
 * Storybook states for the Chat Source chat composite used by shared
 * conversation and composer surfaces.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ChatSourceIcon } from "./chat-source";

const meta = {
  title: "Composites/Chat/ChatSource",
  component: ChatSourceIcon,
  tags: ["autodocs"],
  argTypes: {
    source: { control: "text" },
    decorative: { control: "boolean" },
    className: { control: "text" },
  },
  args: { source: "discord", decorative: false, className: "h-4 w-4" },
} satisfies Meta<typeof ChatSourceIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Telegram: Story = { args: { source: "telegram" } };

export const Decorative: Story = { args: { decorative: true } };

/** Unknown sources fall back to the default message glyph and title-cased label. */
export const UnknownSource: Story = { args: { source: "custom_connector" } };

/** Several sources side by side at a larger glyph size. */
export const Gallery: Story = {
  render: (args) => (
    <div className="flex items-center gap-4">
      <ChatSourceIcon {...args} source="discord" />
      <ChatSourceIcon {...args} source="telegram" />
      <ChatSourceIcon {...args} source="whatsapp" />
      <ChatSourceIcon {...args} source="imessage" />
    </div>
  ),
  args: { className: "h-6 w-6" },
};
