import type { Meta, StoryObj } from "@storybook/react";
import { Alert, AlertDescription, AlertTitle } from "./alert";

const meta = {
  title: "Primitives/Alert",
  component: Alert,
  tags: ["autodocs"],
  argTypes: {
    variant: { control: "select", options: ["default", "destructive"] },
  },
  args: { variant: "default" },
} satisfies Meta<typeof Alert>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <Alert {...args}>
      <AlertTitle>Heads up</AlertTitle>
      <AlertDescription>
        Your changes have been saved and will sync shortly.
      </AlertDescription>
    </Alert>
  ),
};

export const Destructive: Story = {
  args: { variant: "destructive" },
  render: (args) => (
    <Alert {...args}>
      <AlertTitle>Something went wrong</AlertTitle>
      <AlertDescription>
        We couldn't complete that request. Please try again.
      </AlertDescription>
    </Alert>
  ),
};

export const TitleOnly: Story = {
  render: (args) => (
    <Alert {...args}>
      <AlertTitle>Update available</AlertTitle>
    </Alert>
  ),
};
