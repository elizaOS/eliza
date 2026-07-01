import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { client } from "../../../api/client";
import type {
  Conversation,
  ConversationMessage,
} from "../../../api/client-types-chat";
import { mockApp } from "../../../storybook/mock-providers.helpers";
import { MessagesWidget } from "./messages";

/**
 * The frontpage Messages widget (#9143) reads `state.conversations` via
 * `useAppSelector`, then fetches each conversation's messages with
 * `client.getConversationMessages(id)` to keep only NAMED conversations the
 * agent has actually responded in (a real user→assistant exchange — never empty
 * drafts or greeting-only conversations). There is no backend in Storybook, so
 * a `respondsToEach` decorator stubs `getConversationMessages` to return a real
 * exchange for every conversation; the widget renders nothing until at least one
 * qualifies (the #9226 "no empty placeholder" contract).
 *
 * Relative timestamps are rendered via `formatRelativeTime` (Date.now-based);
 * the story-gate's frozen clock keeps these byte-stable across runs.
 */
function conversation(
  over: Partial<Conversation> & { id: string },
): Conversation {
  return {
    title: "Untitled",
    roomId: `room-${over.id}`,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...over,
  };
}

function exchange(userText: string): ConversationMessage[] {
  return [
    { id: "u", role: "user", text: userText, timestamp: 1 },
    { id: "a", role: "assistant", text: "Sure — here you go.", timestamp: 2 },
  ];
}

// The widget renders nothing synchronously, then resolves qualification in an
// effect (after the decorator returns). The stub must therefore stay installed
// for the render lifetime; each story installs its own before rendering.

/** Every conversation reports a real exchange (so each one qualifies). */
function respondsToEach(messagesById?: Record<string, string>): Decorator {
  return (Story) => {
    client.getConversationMessages = async (id: string) => ({
      messages: exchange(messagesById?.[id] ?? "Can you help me with this?"),
    });
    return <Story />;
  };
}

const recent: Conversation[] = [
  conversation({
    id: "c1",
    title: "Trip planning for Lisbon",
    updatedAt: "2024-01-08T11:55:00.000Z",
  }),
  conversation({
    id: "c2",
    title: "Quarterly budget review",
    updatedAt: "2024-01-08T09:30:00.000Z",
  }),
  conversation({
    id: "c3",
    title: "Weekend recipe ideas",
    updatedAt: "2024-01-06T18:00:00.000Z",
  }),
  conversation({
    id: "c4",
    title: "Standup notes",
    updatedAt: "2024-01-02T08:15:00.000Z",
  }),
];

const meta = {
  title: "Chat/Widgets/MessagesWidget",
  component: MessagesWidget,
  tags: ["autodocs"],
  args: { pluginId: "messages" },
} satisfies Meta<typeof MessagesWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Several recent, answered conversations with mixed relative timestamps. */
export const Populated: Story = {
  decorators: [respondsToEach(), mockApp({ conversations: recent })],
};

/** A single answered conversation — the smallest non-empty render. */
export const SingleConversation: Story = {
  decorators: [respondsToEach(), mockApp({ conversations: [recent[0]] })],
};

/**
 * A conversation the agent answered but whose title is a server default
 * ("New Chat") — the name is derived from its latest user message instead.
 */
export const DerivedName: Story = {
  decorators: [
    respondsToEach({
      derived: "Help me outline the launch announcement for next week",
    }),
    mockApp({
      conversations: [
        conversation({
          id: "derived",
          title: "New Chat",
          updatedAt: "2024-01-08T11:00:00.000Z",
        }),
      ],
    }),
  ],
};

/** Long titles must truncate cleanly without breaking the row layout. */
export const LongTitles: Story = {
  decorators: [
    respondsToEach(),
    mockApp({
      conversations: [
        conversation({
          id: "long-1",
          title:
            "Draft the full incident retrospective covering the database failover, the customer-facing outage timeline, and every follow-up action item we agreed on",
          updatedAt: "2024-01-08T11:00:00.000Z",
        }),
        conversation({
          id: "long-2",
          title:
            "Research summary: comparing on-device inference backends across the M3, M4, and M5 runtimes with memory and latency tradeoffs",
          updatedAt: "2024-01-07T22:00:00.000Z",
        }),
      ],
    }),
  ],
};

/** Non-ASCII titles (RTL, CJK, emoji) must render without mojibake. */
export const UnicodeTitles: Story = {
  decorators: [
    respondsToEach(),
    mockApp({
      conversations: [
        conversation({
          id: "u1",
          title: "会議のまとめ 🗒️",
          updatedAt: "2024-01-08T10:00:00.000Z",
        }),
        conversation({
          id: "u2",
          title: "خطة السفر إلى لشبونة ✈️",
          updatedAt: "2024-01-08T09:00:00.000Z",
        }),
        conversation({
          id: "u3",
          title: "Café résumé — déjà vu 🇫🇷",
          updatedAt: "2024-01-07T20:00:00.000Z",
        }),
      ],
    }),
  ],
};
