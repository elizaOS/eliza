import type { Meta, StoryObj } from "@storybook/react";
import { ShareButtons } from "./share-buttons";

const meta = {
  title: "CloudUI/Share/ShareButtons",
  component: ShareButtons,
  tags: ["autodocs"],
  argTypes: {
    url: { control: "text" },
    title: { control: "text" },
    description: { control: "text" },
  },
  args: {
    url: "https://eliza.example.com/agents/showcase",
    title: "Check out this Eliza agent",
    description: "A friendly autonomous agent built on elizaOS.",
  },
} satisfies Meta<typeof ShareButtons>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithoutDescription: Story = {
  args: {
    url: "https://eliza.example.com/blog/launch",
    title: "elizaOS launch announcement",
    description: undefined,
  },
};

export const LongTitle: Story = {
  args: {
    url: "https://eliza.example.com/posts/very-long-title-share-test",
    title:
      "A surprisingly long title that demonstrates how share buttons wrap when paired with extended descriptive copy",
    description:
      "An equally long description to verify the share intent URLs encode correctly across providers.",
  },
};

export const ConstrainedWidth: Story = {
  args: {
    url: "https://eliza.example.com/agents/narrow",
    title: "Narrow container demo",
    description: "Forces the flex-wrap layout to break onto multiple rows.",
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 280, padding: 12 }}>
        <Story />
      </div>
    ),
  ],
};
