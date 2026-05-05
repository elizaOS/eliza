import type { Meta, StoryObj } from "@storybook/react";

import { NewActionButton } from "../index";

const meta = {
  title: "Composites/NewActionButton",
  component: NewActionButton,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta<typeof NewActionButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { children: "New conversation" },
  decorators: [
    (Story) => (
      <div className="w-72">
        <Story />
      </div>
    ),
  ],
};

export const AddSkill: Story = {
  args: { children: "+ Add skill" },
  decorators: [
    (Story) => (
      <div className="w-72">
        <Story />
      </div>
    ),
  ],
};

export const Disabled: Story = {
  args: { children: "New item", disabled: true },
  decorators: [
    (Story) => (
      <div className="w-72">
        <Story />
      </div>
    ),
  ],
};
