/** Storybook stories for ConversationsSidebar over a seeded app-context conversation set (fixed clock for stable relative-time buckets). */

import type { Meta, StoryObj } from "@storybook/react";
import type { Conversation } from "../../api/client-types-chat";
import { seedAppValue } from "../../state/app-store";
import type { AppContextValue } from "../../state/types";
import { AppContext } from "../../state/useApp";
import { ConversationsSidebar } from "./ConversationsSidebar";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 5, 23, 12, 0, 0);

function conv(id: string, title: string, ageDays: number): Conversation {
  const iso = new Date(NOW - ageDays * DAY_MS).toISOString();
  return { id, title, roomId: `room-${id}`, createdAt: iso, updatedAt: iso };
}

const CONVERSATIONS: Conversation[] = [
  conv("conv-a", "Planning the launch sequence", 0),
  conv("conv-b", "Billing reconciliation thread", 0),
  conv("conv-c", "Deploy incident retro", 1),
  conv("conv-d", "Quarterly roadmap review", 9),
];

// Seed the app store (the source `useAppSelectorShallow` / `useAppSelector`
// read from) with a static, render-safe value so the sidebar populates without
// a live AppProvider. The `t` shim returns the supplied defaultValue.
const appValue = new Proxy({} as AppContextValue, {
  get(_target, prop) {
    switch (prop) {
      case "conversations":
        return CONVERSATIONS;
      case "activeConversationId":
        return "conv-a";
      case "activeInboxChat":
      case "activeTerminalSessionId":
        return null;
      case "unreadConversations":
        return new Set(["conv-c"]);
      case "tab":
        return "chat";
      case "uiLanguage":
        return "en";
      case "t":
        return (key: string, options?: { defaultValue?: string }) =>
          options?.defaultValue ?? key;
      default:
        // Every handler / setter the sidebar reads is a no-op in the story.
        return () => {};
    }
  },
});

seedAppValue(appValue);

const meta = {
  title: "Conversations/ConversationsSidebar",
  component: ConversationsSidebar,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <AppContext.Provider value={appValue}>
        <div className="flex h-[640px] bg-bg text-txt">
          <Story />
        </div>
      </AppContext.Provider>
    ),
  ],
} satisfies Meta<typeof ConversationsSidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Mobile: Story = {
  args: { mobile: true, onClose: () => {} },
};

export const GameModal: Story = {
  args: { variant: "game-modal" },
  decorators: [
    (Story) => (
      <div className="flex h-[640px] w-[360px] bg-black/80 p-3">
        <Story />
      </div>
    ),
  ],
};
