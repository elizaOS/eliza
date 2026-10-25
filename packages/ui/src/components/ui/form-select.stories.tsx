/**
 * Storybook stories for the form-select primitive.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { FormSelect, FormSelectItem } from "./form-select";

const meta = {
  title: "Primitives/FormSelect",
  component: FormSelect,
  tags: ["autodocs"],
  argTypes: {
    placeholder: { control: "text" },
    defaultOpen: { control: "boolean" },
    disabled: { control: "boolean" },
  },
  args: { placeholder: "Select a model", defaultOpen: false, disabled: false },
} satisfies Meta<typeof FormSelect>;

export default meta;
type Story = StoryObj<typeof meta>;

const items = (
  <>
    <FormSelectItem value="gpt-4o">GPT-4o</FormSelectItem>
    <FormSelectItem value="claude-opus">Claude Opus</FormSelectItem>
    <FormSelectItem value="claude-sonnet">Claude Sonnet</FormSelectItem>
    <FormSelectItem value="gemini-pro">Gemini Pro</FormSelectItem>
    <FormSelectItem value="llama-3">Llama 3</FormSelectItem>
  </>
);

export const Default: Story = {
  render: (args) => (
    <FormSelect {...args} aria-label="Model">
      {items}
    </FormSelect>
  ),
};

export const Open: Story = {
  args: { defaultOpen: true },
  render: Default.render,
};

export const WithValue: Story = {
  args: { defaultValue: "claude-opus" },
  render: Default.render,
};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: "gpt-4o" },
  render: Default.render,
};
