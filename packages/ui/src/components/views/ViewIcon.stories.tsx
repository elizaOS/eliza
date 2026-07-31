/**
 * Storybook states for ViewIcon covering each resolution path: a named lucide
 * glyph, an image source (URL / data URI), the keyword fallback, and a size
 * override via className.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ViewIcon } from "./ViewIcon";

const meta = {
  title: "Views/ViewIcon",
  component: ViewIcon,
  tags: ["autodocs"],
  argTypes: {
    icon: { control: "text" },
    label: { control: "text" },
    className: { control: "text" },
  },
  args: { icon: "MessageSquare", label: "Messages", className: "h-5 w-5" },
} satisfies Meta<typeof ViewIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A known Lucide icon name resolved from the internal registry. */
export const NamedIcon: Story = {};

/** An image source (URL or data URI) renders an <img> instead of a glyph. */
export const ImageSource: Story = {
  args: {
    icon: "https://avatars.githubusercontent.com/u/130973801?s=200&v=4",
    label: "elizaOS",
  },
};

/** Unknown / missing icon falls back to a keyword-inferred glyph from the label. */
export const LetterFallback: Story = {
  args: { icon: null, label: "Wallet" },
};

/** Larger size via className override. */
export const LargeIcon: Story = {
  args: { icon: "Bot", label: "Agent", className: "h-10 w-10" },
};
