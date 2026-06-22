import type { Meta, StoryObj } from "@storybook/react";
import type { HistoryCard } from "./chat-history-swiper";
import { ChatHistorySwiper } from "./chat-history-swiper";

const meta = {
  title: "Chat/Widgets/ChatHistorySwiper",
  component: ChatHistorySwiper,
  tags: ["autodocs"],
  argTypes: {
    onSelect: { action: "select" },
    onReset: { action: "reset" },
    onUndoClear: { action: "undoClear" },
  },
} satisfies Meta<typeof ChatHistorySwiper>;

export default meta;
type Story = StoryObj<typeof meta>;

const cards: HistoryCard[] = [
  {
    id: "h1",
    title: "Plan my week",
    subtitle: "12 messages · scheduling",
    timestamp: "Mon 09:14",
  },
  {
    id: "h2",
    title: "Debug deploy",
    subtitle: "7 messages · cloud",
    timestamp: "Sun 18:02",
  },
  {
    id: "h3",
    title: "Draft launch post",
    subtitle: "21 messages · writing",
    timestamp: "Fri 11:30",
  },
  {
    id: "h4",
    title: "Voice setup",
    subtitle: "4 messages · voice",
    timestamp: "Thu 08:45",
  },
];

export const Single: Story = {
  args: {
    items: [cards[0]],
    activeIndex: 0,
    clearedItem: null,
    onSelect: () => {},
    onReset: () => {},
    onUndoClear: () => {},
  },
};

export const Multi: Story = {
  args: {
    items: cards,
    activeIndex: 1,
    clearedItem: null,
    onSelect: () => {},
    onReset: () => {},
    onUndoClear: () => {},
  },
};

export const AfterClearUndo: Story = {
  args: {
    items: cards.slice(1),
    activeIndex: 0,
    clearedItem: cards[0],
    onSelect: () => {},
    onReset: () => {},
    onUndoClear: () => {},
  },
};
