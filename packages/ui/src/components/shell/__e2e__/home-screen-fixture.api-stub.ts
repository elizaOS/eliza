// Stub `../../api` for the home-screen e2e: just the client methods HomeScreen uses.
export const client = {
  getInboxChats: async () => ({
    chats: [
      { id: "c1", source: "imessage", worldLabel: "iMessage", title: "Alex Rivera", lastMessageText: "see you at 5, bring the deck", lastMessageAt: Date.now() - 120000, messageCount: 4 },
      { id: "c2", source: "telegram", worldLabel: "Telegram", title: "Eng standup", lastMessageText: "deploy is green ✅", lastMessageAt: Date.now() - 1800000, messageCount: 12 },
      { id: "c3", source: "discord", worldLabel: "Discord", title: "milady", lastMessageText: "gm", lastMessageAt: Date.now() - 5400000, messageCount: 99 },
    ],
    count: 3,
  }),
};
