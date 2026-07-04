/**
 * Storybook stories for `ChatView`. Runs against `mockApp` (no backend); sample
 * messages use a fixed epoch (`NOW`) so story-gate screenshots stay byte-stable.
 */
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import type { ConversationMessage } from "../../api/client-types-chat";
import { ConversationMessagesCtx } from "../../state/ConversationMessagesContext.hooks";
import { mockApp } from "../../storybook/mock-providers.helpers";
import { ChatView } from "./ChatView";

const NOW = 1_700_000_000_000;
const SAMPLE_MESSAGES: ConversationMessage[] = [
  {
    id: "u1",
    role: "user",
    text: "can you deploy the worker?",
    timestamp: NOW - 40000,
  },
  {
    id: "a1",
    role: "assistant",
    text: "Deploying the provisioning worker now — building the image…",
    timestamp: NOW - 30000,
  },
  {
    id: "u2",
    role: "user",
    text: "thanks! and what's my October invoice?",
    timestamp: NOW - 20000,
  },
  {
    id: "a2",
    role: "assistant",
    text: "Your October invoice total is $420.",
    timestamp: NOW - 10000,
  },
];

/** Seed the (otherwise backendless) transcript so the reset button shows. */
function withMessages(messages: ConversationMessage[]): Decorator {
  return (Story) => (
    <ConversationMessagesCtx.Provider
      value={{ conversationMessages: messages }}
    >
      <Story />
    </ConversationMessagesCtx.Provider>
  );
}

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

/**
 * #8930 — with a populated conversation, the RotateCcw reset button appears in
 * the composer header row (visible only when there are messages to clear).
 * Clicking it resets to a fresh greeted thread without returning to the old one.
 */
export const WithResetButton: Story = {
  decorators: [withMessages(SAMPLE_MESSAGES)],
};

/**
 * #8930 — immediately after a reset the transcript is empty, so the reset
 * button is hidden again (nothing to clear) and the empty state shows.
 */
export const AfterReset: Story = {
  decorators: [withMessages([])],
};
