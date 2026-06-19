import type { Meta, StoryObj } from "@storybook/react";
import { CreateTaskPopover } from "./create-task-popover";

const t = (_key: string, options?: Record<string, unknown>) =>
  (options?.defaultValue as string) ?? _key;

const meta = {
  title: "Composites/Chat/CreateTaskPopover",
  component: CreateTaskPopover,
  tags: ["autodocs"],
  argTypes: {
    chatInput: { control: "text" },
    disabled: { control: "boolean" },
    triggerVariant: {
      control: "select",
      options: [
        "default",
        "surface",
        "outline",
        "ghost",
        "secondary",
        "destructive",
        "link",
      ],
    },
    triggerClassName: { control: "text" },
    triggerIconClassName: { control: "text" },
    onCreateTask: { action: "create-task" },
  },
  args: {
    chatInput: "",
    disabled: false,
    triggerVariant: "surface",
    t,
    onCreateTask: () => {},
  },
  decorators: [
    (Story) => (
      <div className="flex min-h-[320px] items-end justify-end p-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CreateTaskPopover>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Disabled: Story = {
  args: {
    disabled: true,
  },
};

export const PrefilledFromChatInput: Story = {
  args: {
    chatInput:
      "Refactor the auth middleware to support multiple JWT issuers and add unit tests.",
  },
};

export const GhostTrigger: Story = {
  args: {
    triggerVariant: "ghost",
    triggerClassName: "h-9 w-9 shrink-0",
    triggerIconClassName: "h-3.5 w-3.5",
  },
};

export const OutlineTrigger: Story = {
  args: {
    triggerVariant: "outline",
  },
};
