/** Storybook state for the ConfigFieldErrors control primitive (the stacked field-error list). */
import type { Meta, StoryObj } from "@storybook/react";
import { ConfigFieldErrors } from "./config-control-primitives";

const meta = {
  title: "ConfigUi/ConfigFieldErrors",
  component: ConfigFieldErrors,
  tags: ["autodocs"],
  argTypes: {
    errors: { control: "object" },
  },
  args: {
    errors: ["This field is required"],
  },
} satisfies Meta<typeof ConfigFieldErrors>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const MultipleErrors: Story = {
  args: {
    errors: [
      "Value must be at least 8 characters",
      "Value must contain a number",
      "Value must contain a special character",
    ],
  },
};

export const SingleError: Story = {
  args: {
    errors: ["Invalid API key format"],
  },
};

export const EmptyErrors: Story = {
  args: {
    errors: [],
  },
};

export const Undefined: Story = {
  args: {
    errors: undefined,
  },
};
