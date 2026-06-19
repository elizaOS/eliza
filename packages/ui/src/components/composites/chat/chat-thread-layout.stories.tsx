import type { Meta, StoryObj } from "@storybook/react";
import { ChatThreadLayout } from "./chat-thread-layout";

const sampleMessages = (
  <div className="flex flex-col gap-3">
    <div className="self-start max-w-[70%] rounded-2xl bg-muted px-4 py-2 text-sm">
      Hey, I pulled up the schedule — you are free after 3pm today.
    </div>
    <div className="self-end max-w-[70%] rounded-2xl bg-accent px-4 py-2 text-sm text-accent-foreground">
      Perfect, book the 3:30 slot then.
    </div>
    <div className="self-start max-w-[70%] rounded-2xl bg-muted px-4 py-2 text-sm">
      Done. Calendar invite sent and the room is reserved.
    </div>
  </div>
);

const sampleComposer = (
  <div className="border-t border-border bg-background/80 px-4 py-3">
    <div className="flex items-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-sm text-muted-foreground">
      Type a message...
    </div>
  </div>
);

const sampleFooter = (
  <div className="px-4 py-1 text-center text-xs text-muted-foreground">
    Agent may make mistakes. Verify important info.
  </div>
);

const meta = {
  title: "Composites/Chat/ChatThreadLayout",
  component: ChatThreadLayout,
  tags: ["autodocs"],
  argTypes: {
    variant: { control: "select", options: ["default", "game-modal"] },
    composerHeight: { control: { type: "number", min: 0, max: 200 } },
    imageDragOver: { control: "boolean" },
    gameModalComposerGapPx: { control: { type: "number", min: 0, max: 64 } },
    messagesTestId: { control: "text" },
  },
  args: {
    variant: "default",
    composerHeight: 0,
    imageDragOver: false,
    children: sampleMessages,
    composer: sampleComposer,
  },
  decorators: [
    (Story) => (
      <div className="flex h-[480px] w-[420px] flex-col overflow-hidden rounded-lg border border-border bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ChatThreadLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithFooterStack: Story = {
  args: {
    footerStack: sampleFooter,
  },
};

export const ImageDragOver: Story = {
  args: {
    imageDragOver: true,
  },
};

export const EmptyThread: Story = {
  args: {
    children: (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        No messages yet. Say hello to get started.
      </div>
    ),
    composer: sampleComposer,
  },
};

export const GameModalVariant: Story = {
  args: {
    variant: "game-modal",
    composerHeight: 56,
    gameModalComposerGapPx: 18,
  },
  decorators: [
    (Story) => (
      <div className="relative h-[480px] w-[420px] overflow-hidden rounded-lg border border-border bg-gradient-to-b from-slate-900 to-slate-700">
        <Story />
      </div>
    ),
  ],
};
