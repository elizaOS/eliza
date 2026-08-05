/** Composer chrome and cancel interaction states for reply targets. */
import type { Meta, StoryObj } from "@storybook/react";
import { assert } from "../../../storybook/home-widget-decorator";
import { ChatReplyPill } from "./chat-reply-pill";

let cancelCount = 0;

const meta = {
  title: "Composites/ChatReplyPill",
  component: ChatReplyPill,
  parameters: { layout: "centered" },
  args: {
    target: {
      messageId: "message-1",
      senderName: "Eliza",
      snippet: "I can move the planning session to Friday afternoon.",
    },
    onCancel: () => {
      cancelCount += 1;
    },
  },
  decorators: [
    (Story) => (
      <div className="w-[420px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ChatReplyPill>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Panel: Story = {
  play: async ({ canvasElement }) => {
    cancelCount = 0;
    const cancel = canvasElement.querySelector(
      '[data-testid="chat-reply-pill-cancel"]',
    );
    assert(cancel instanceof HTMLButtonElement, "cancel button renders");
    cancel.click();
    assert(cancelCount === 1, "cancel callback fires once");
  },
};

export const Glass: Story = {
  args: { appearance: "glass" },
  decorators: [
    (Story) => (
      <div className="rounded-3xl bg-scrim p-4">
        <Story />
      </div>
    ),
  ],
};
