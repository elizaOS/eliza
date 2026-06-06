import type { Meta, StoryObj } from "@storybook/react";
import { EditableAccountLabel } from "./EditableAccountLabel";

const meta = {
  title: "Accounts/EditableAccountLabel",
  component: EditableAccountLabel,
  tags: ["autodocs"],
  argTypes: {
    value: { control: "text" },
    disabled: { control: "boolean" },
    inputAriaLabel: { control: "text" },
    editTitle: { control: "text" },
    className: { control: "text" },
    inputClassName: { control: "text" },
  },
  args: {
    value: "Primary Wallet",
    disabled: false,
    inputAriaLabel: "Account label",
    editTitle: "Click to rename",
    onSubmit: () => {},
  },
} satisfies Meta<typeof EditableAccountLabel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LongLabel: Story = {
  args: {
    value: "My Very Long Account Label That Should Truncate Nicely",
    className: "max-w-[200px]",
  },
};

export const Disabled: Story = {
  args: {
    value: "Read-only Account",
    disabled: true,
  },
};

export const CustomLabels: Story = {
  args: {
    value: "Treasury",
    inputAriaLabel: "Treasury name",
    editTitle: "Rename treasury",
  },
};

export const RejectsSubmission: Story = {
  args: {
    value: "Always Reverts",
    onSubmit: async () => {
      throw new Error("Save failed");
    },
  },
};
