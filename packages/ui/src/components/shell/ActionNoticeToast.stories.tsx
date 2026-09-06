/** Displays passive shell feedback, including long recovery messages and pending work. */
import type { Meta, StoryObj } from "@storybook/react";
import { ActionNoticeToast } from "./ActionNoticeToast";

const meta = {
  title: "Shell/ActionNoticeToast",
  component: ActionNoticeToast,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ActionNoticeToast>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Success: Story = {
  args: { actionNotice: { tone: "success", text: "Settings saved." } },
};

export const Recovery: Story = {
  args: {
    actionNotice: {
      tone: "error",
      text: "Speech recognition failed. Check your transcription provider in Settings → Models & Providers.",
    },
  },
};

export const Pending: Story = {
  args: {
    actionNotice: { tone: "info", text: "Loading voice model…", busy: true },
  },
};

export const Hidden: Story = { args: { actionNotice: null } };
