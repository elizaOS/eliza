/** Storybook fixture exercising the Avatar primitive (image + fallback); also feeds the story-gate render check. */
import type { Meta, StoryObj } from "@storybook/react";
import { Avatar, AvatarFallback, AvatarImage } from "./avatar";

const meta = {
  title: "Primitives/Avatar",
  component: Avatar,
  tags: ["autodocs"],
} satisfies Meta<typeof Avatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <Avatar {...args}>
      <AvatarImage src="https://github.com/elizaos.png" alt="elizaOS" />
      <AvatarFallback>EL</AvatarFallback>
    </Avatar>
  ),
};

export const Fallback: Story = {
  render: (args) => (
    <Avatar {...args}>
      <AvatarImage src="" alt="Broken" />
      <AvatarFallback>EL</AvatarFallback>
    </Avatar>
  ),
};

export const Large: Story = {
  render: (args) => (
    <Avatar {...args} className="size-16">
      <AvatarImage src="https://github.com/elizaos.png" alt="elizaOS" />
      <AvatarFallback>EL</AvatarFallback>
    </Avatar>
  ),
};

/** Image, fallback, and a larger size in one view. */
export const Group: Story = {
  render: (args) => (
    <div className="flex items-center gap-3">
      <Avatar {...args}>
        <AvatarImage src="https://github.com/elizaos.png" alt="elizaOS" />
        <AvatarFallback>EL</AvatarFallback>
      </Avatar>
      <Avatar {...args}>
        <AvatarImage src="" alt="Broken" />
        <AvatarFallback>AB</AvatarFallback>
      </Avatar>
      <Avatar {...args} className="size-16">
        <AvatarImage src="https://github.com/elizaos.png" alt="elizaOS" />
        <AvatarFallback>EL</AvatarFallback>
      </Avatar>
    </div>
  ),
};
