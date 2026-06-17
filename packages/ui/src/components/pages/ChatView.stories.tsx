import type { Meta, StoryObj } from "@storybook/react";
import { mockApp } from "../../storybook/mock-providers.helpers";
import { ChatView } from "./ChatView";

const meta = {
  title: "Pages/ChatView",
  component: ChatView,
  parameters: { layout: "fullscreen" },
  decorators: [
    mockApp({
      agentStatus: {
        state: "running",
        agentName: "Ada",
        model: "gpt-4o-mini",
      },
    }),
  ],
  args: {
    variant: "default",
    hideComposer: false,
    onPtySessionClick: () => {},
  },
} satisfies Meta<typeof ChatView>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Agent is running with an inference model wired up. With no conversation
 * messages from the (absent) backend, the transcript shows the empty state and
 * a fully interactive composer.
 */
export const Default: Story = {};

/**
 * Agent runtime is still booting. The composer locks until the first
 * lifecycle activity arrives.
 */
export const AgentStarting: Story = {
  decorators: [
    mockApp({
      agentStatus: { state: "starting", agentName: "Ada" },
    }),
  ],
};

/**
 * Agent is up but no inference provider is configured — the composer is locked
 * and points the user toward Settings.
 */
export const MissingProvider: Story = {
  decorators: [
    mockApp({
      agentStatus: { state: "running", agentName: "Ada", model: undefined },
    }),
  ],
};

/**
 * Composer hidden — used on the chat tab when a shared continuous-chat overlay
 * provides the single input instead. The transcript still renders.
 */
export const ComposerHidden: Story = {
  args: { hideComposer: true },
};

/**
 * Compact game-modal layout, surfaced when chat is shown over a companion or
 * game viewer.
 */
export const GameModal: Story = {
  args: { variant: "game-modal" },
};
