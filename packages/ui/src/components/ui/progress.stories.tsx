/**
 * Storybook stories for the progress-bar primitive.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { Progress } from "./progress";

const meta = {
  title: "Primitives/Progress",
  component: Progress,
  tags: ["autodocs"],
  argTypes: {
    value: { control: { type: "range", min: 0, max: 100, step: 1 } },
  },
  args: { value: 50 },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Progress>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Empty: Story = { args: { value: 0 } };
export const Quarter: Story = { args: { value: 25 } };
export const ThreeQuarters: Story = { args: { value: 75 } };
export const Complete: Story = { args: { value: 100 } };
