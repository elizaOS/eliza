/** Canonical radio-group states and labelled selection behavior. */
import type { Meta, StoryObj } from "@storybook/react";
import { RadioGroup, RadioGroupItem } from "./radio-group";

const meta = {
  title: "Primitives/RadioGroup",
  component: RadioGroup,
  tags: ["autodocs"],
} satisfies Meta<typeof RadioGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <RadioGroup defaultValue="local" aria-label="Storage location">
      <label htmlFor="radio-local" className="flex items-center gap-2 text-sm">
        <RadioGroupItem id="radio-local" value="local" /> Local
      </label>
      <label htmlFor="radio-cloud" className="flex items-center gap-2 text-sm">
        <RadioGroupItem id="radio-cloud" value="cloud" /> Cloud
      </label>
      <label
        htmlFor="radio-managed"
        className="flex items-center gap-2 text-sm text-muted"
      >
        <RadioGroupItem id="radio-managed" value="managed" disabled /> Managed
      </label>
    </RadioGroup>
  ),
};
