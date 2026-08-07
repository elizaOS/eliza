/** Open shell-assistant phases and the dialog's close interaction. */

import type { Meta, StoryObj } from "@storybook/react";
import { assert } from "../../storybook/home-widget-decorator";
import { AssistantOverlay } from "./AssistantOverlay";

let closeCount = 0;

const meta = {
  title: "Shell/AssistantOverlay",
  component: AssistantOverlay,
  parameters: { layout: "fullscreen" },
  args: {
    phase: "summoned",
    onClose: () => {
      closeCount += 1;
    },
    children: (
      <div className="flex h-full flex-col gap-3 p-6">
        <h2 className="text-lg font-semibold">Assistant conversation</h2>
        <p className="text-sm text-muted">
          The active chat surface is hosted inside this modal shell.
        </p>
        <button type="button">Focusable conversation control</button>
      </div>
    ),
  },
} satisfies Meta<typeof AssistantOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Summoned: Story = {
  play: async ({ canvasElement }) => {
    closeCount = 0;
    const close = canvasElement.querySelector(
      'button[aria-label="Close assistant"]',
    );
    assert(close instanceof HTMLButtonElement, "close control is rendered");
    close.click();
    assert(closeCount === 1, "close interaction reaches the shell owner");
  },
};

export const Listening: Story = { args: { phase: "listening" } };
export const Responding: Story = { args: { phase: "responding" } };
