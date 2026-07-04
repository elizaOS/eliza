/** Storybook stories for SetupField — default, with-error, with-success, centered, and no-label states. */

import type { Meta, StoryObj } from "@storybook/react";
import { Input } from "../ui/input";
import { SetupField } from "./setup-form-primitives";

const meta = {
  title: "Setup/SetupField",
  component: SetupField,
  tags: ["autodocs"],
  argTypes: {
    align: { control: "radio", options: ["left", "center"] },
    label: { control: "text" },
    description: { control: "text" },
    message: { control: "text" },
    messageTone: {
      control: "select",
      options: ["default", "danger", "success"],
    },
    controlId: { control: "text" },
  },
  args: {
    align: "left",
    label: "Agent name",
    description: "This is what your agent will be called everywhere.",
    controlId: "agent-name",
  },
  decorators: [
    (Story) => (
      <div style={{ width: 360, padding: 24, background: "#111" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SetupField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: ({ describedBy, invalid }) => (
      <Input
        id="agent-name"
        defaultValue="Eliza"
        aria-describedby={describedBy}
        aria-invalid={invalid}
      />
    ),
  },
};

export const WithError: Story = {
  args: {
    label: "Display name",
    description: "Shown in the chat header.",
    message: "Display name is required.",
    messageTone: "danger",
    controlId: "display-name",
    children: ({ describedBy, invalid }) => (
      <Input
        id="display-name"
        defaultValue=""
        aria-describedby={describedBy}
        aria-invalid={invalid}
      />
    ),
  },
};

export const WithSuccess: Story = {
  args: {
    label: "Handle",
    description: "Used as your unique identifier.",
    message: "Handle is available.",
    messageTone: "success",
    controlId: "handle",
    children: ({ describedBy, invalid }) => (
      <Input
        id="handle"
        defaultValue="eliza"
        aria-describedby={describedBy}
        aria-invalid={invalid}
      />
    ),
  },
};

export const Centered: Story = {
  args: {
    align: "center",
    label: "Welcome",
    description: "Pick a name for your new agent to get started.",
    controlId: "welcome-name",
    children: ({ describedBy, invalid }) => (
      <Input
        id="welcome-name"
        defaultValue=""
        placeholder="Type a name..."
        aria-describedby={describedBy}
        aria-invalid={invalid}
      />
    ),
  },
};

export const NoLabel: Story = {
  args: {
    label: undefined,
    description: "Just a control with helper text — no label rendered.",
    controlId: "bare",
    children: ({ describedBy, invalid }) => (
      <Input
        id="bare"
        defaultValue=""
        placeholder="Bare field"
        aria-describedby={describedBy}
        aria-invalid={invalid}
      />
    ),
  },
};
