/**
 * Storybook states for the Chat Attachment Strip chat composite used by shared
 * conversation and composer surfaces.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ChatAttachmentStrip } from "./chat-attachment-strip";
import type { ChatAttachmentItem } from "./chat-types";

const sampleItems: ChatAttachmentItem[] = [
  {
    id: "att-1",
    name: "sunset.png",
    alt: "Sunset over the ocean",
    src: "https://placehold.co/64x64/ff7849/ffffff?text=1",
  },
  {
    id: "att-2",
    name: "diagram.png",
    alt: "Architecture diagram",
    src: "https://placehold.co/64x64/4f46e5/ffffff?text=2",
  },
  {
    id: "att-3",
    name: "screenshot.png",
    alt: "App screenshot",
    src: "https://placehold.co/64x64/059669/ffffff?text=3",
  },
];

const meta = {
  title: "Composites/Chat/ChatAttachmentStrip",
  component: ChatAttachmentStrip,
  tags: ["autodocs"],
  argTypes: {
    variant: { control: "select", options: ["default", "game-modal"] },
    onRemove: { action: "removed" },
  },
  args: {
    items: sampleItems,
    variant: "default",
    onRemove: () => {},
  },
} satisfies Meta<typeof ChatAttachmentStrip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SingleAttachment: Story = {
  args: { items: [sampleItems[0]] },
};

export const GameModal: Story = {
  args: { variant: "game-modal" },
};

export const CustomRemoveLabel: Story = {
  args: {
    removeLabel: (item) => `Discard ${item.name}`,
  },
};

export const MixedMedia: Story = {
  args: {
    items: [
      sampleItems[0],
      {
        id: "att-audio",
        name: "interview-recording.wav",
        alt: "Interview recording",
        src: "data:audio/wav;base64,",
        kind: "audio",
      },
      {
        id: "att-video",
        name: "walkthrough.mp4",
        alt: "Product walkthrough",
        src: "data:video/mp4;base64,",
        kind: "video",
      },
      {
        id: "att-document",
        name: "project-brief.pdf",
        alt: "Project brief",
        src: "data:application/pdf;base64,",
        kind: "document",
      },
    ],
  },
};

export const Overflowing: Story = {
  args: {
    items: [
      ...sampleItems,
      ...sampleItems.map((item) => ({
        ...item,
        id: `${item.id}-copy`,
      })),
    ],
  },
  decorators: [
    (Story) => (
      <div className="w-64">
        <Story />
      </div>
    ),
  ],
};

export const Empty: Story = {
  args: { items: [] },
};
