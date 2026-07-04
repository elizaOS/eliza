/**
 * Storybook states for generated view hero tiles, including deterministic
 * palette selection, pinned built-in palettes, and icon fallbacks.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { GeneratedViewHero } from "./GeneratedViewHero";

/**
 * Renders the hero inside a card-shaped, aspect-ratio box so the gradient fill,
 * oversized icon artwork, and centered glyph read the way they do in the grid.
 * `group` enables the group-hover scale baked into the component.
 */
function CardFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="group aspect-[16/10] w-64 overflow-hidden rounded-xl border border-white/10">
      {children}
    </div>
  );
}

const meta = {
  title: "Pages/GeneratedViewHero",
  component: GeneratedViewHero,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="p-6">
        <CardFrame>
          <Story />
        </CardFrame>
      </div>
    ),
  ],
  argTypes: {
    viewId: { control: "text" },
    icon: { control: "text" },
    label: { control: "text" },
    compact: { control: "boolean" },
  },
  args: {
    viewId: "chat",
    icon: "MessageSquare",
    label: "Chat",
    compact: false,
  },
} satisfies Meta<typeof GeneratedViewHero>;

export default meta;
type Story = StoryObj<typeof meta>;

// Signature orange — the hand-pinned palette for the `chat` builtin id.
export const Default: Story = {};

// Amber/gold pinned palette via the `character` builtin id.
export const CharacterView: Story = {
  args: {
    viewId: "character",
    icon: "Bot",
    label: "Character",
  },
};

// Terracotta pinned palette via the `automations` builtin id.
export const AutomationsView: Story = {
  args: {
    viewId: "automations",
    icon: "Zap",
    label: "Automations",
  },
};

// Unpinned id → deterministic FNV-1a hash → palette/shape/pattern selection.
export const HashedPalette: Story = {
  args: {
    viewId: "my-custom-dashboard-view",
    icon: "LayoutDashboard",
    label: "Custom Dashboard",
  },
};

// No matching lucide icon → first-letter fallback glyph from the label.
export const LetterFallback: Story = {
  args: {
    viewId: "unknown-letter-view",
    icon: null,
    label: "Workspace",
  },
};

// Remote image icon path instead of a lucide name.
export const ImageIcon: Story = {
  args: {
    viewId: "image-icon-view",
    icon: "https://placehold.co/96x96/png",
    label: "Image View",
  },
};

// Compact mode shrinks the artwork + foreground disc for dense layouts.
export const Compact: Story = {
  args: {
    viewId: "views-manager",
    icon: "LayoutGrid",
    label: "Views",
    compact: true,
  },
  decorators: [
    (Story) => (
      <div className="p-6">
        <div className="group aspect-square w-36 overflow-hidden rounded-lg border border-white/10 shadow">
          <Story />
        </div>
      </div>
    ),
  ],
};
