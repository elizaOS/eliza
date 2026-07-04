/**
 * Storybook stories for the scroll-area primitive (custom scrollbar container).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ScrollArea, ScrollBar } from "./scroll-area";

const meta = {
  title: "Primitives/ScrollArea",
  component: ScrollArea,
  tags: ["autodocs"],
} satisfies Meta<typeof ScrollArea>;

export default meta;
type Story = StoryObj<typeof meta>;

const TAGS = Array.from({ length: 40 }, (_, i) => `Item ${i + 1}`);

export const Vertical: Story = {
  render: () => (
    <ScrollArea className="h-48 w-56 rounded-md border">
      <div className="p-4">
        {TAGS.map((tag) => (
          <div key={tag} className="py-1 text-sm">
            {tag}
          </div>
        ))}
      </div>
    </ScrollArea>
  ),
};

export const Horizontal: Story = {
  render: () => (
    <ScrollArea className="w-72 rounded-md border whitespace-nowrap">
      <div className="flex gap-3 p-4">
        {TAGS.slice(0, 12).map((tag) => (
          <div
            key={tag}
            className="flex h-24 w-24 shrink-0 items-center justify-center rounded-md border text-sm"
          >
            {tag}
          </div>
        ))}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  ),
};

export const LongText: Story = {
  render: () => (
    <ScrollArea className="h-40 w-80 rounded-md border">
      <p className="p-4 text-sm leading-relaxed">
        {TAGS.map((tag) => `${tag} is a placeholder line of content. `).join(
          "",
        )}
      </p>
    </ScrollArea>
  ),
};
