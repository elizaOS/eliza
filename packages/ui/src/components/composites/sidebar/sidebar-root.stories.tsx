import type { Meta, StoryObj } from "@storybook/react";
import { Sidebar } from "./sidebar-root";

const sampleItems = [
  "Design review",
  "Launch planning",
  "Standup notes",
  "Roadmap draft",
];

const sampleChildren = (
  <div className="flex flex-col gap-1 px-2 py-1">
    <h2 className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-muted">
      Conversations
    </h2>
    {sampleItems.map((label) => (
      <button
        key={label}
        type="button"
        className="rounded-sm px-2 py-1.5 text-left text-sm text-txt hover:bg-black/10"
      >
        {label}
      </button>
    ))}
  </div>
);

const sampleHeader = (
  <div className="flex items-center justify-between">
    <span className="text-sm font-medium text-txt">Workspace</span>
    <span className="text-xs text-muted">3 agents</span>
  </div>
);

const sampleFooter = (
  <button
    type="button"
    className="rounded-sm border border-border px-3 py-1.5 text-xs text-txt hover:bg-black/10"
  >
    New chat
  </button>
);

const meta = {
  title: "Composites/Sidebar/Sidebar",
  component: Sidebar,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "inline-radio",
      options: ["default", "mobile", "game-modal"],
    },
    collapsible: { control: "boolean" },
    defaultCollapsed: { control: "boolean" },
    resizable: { control: "boolean" },
    mobileTitle: { control: false },
    mobileMeta: { control: false },
    header: { control: false },
    footer: { control: false },
    children: { control: false },
  },
  args: {
    variant: "default",
    collapsible: false,
    defaultCollapsed: false,
    resizable: false,
    header: sampleHeader,
    footer: sampleFooter,
    children: sampleChildren,
  },
  decorators: [
    (Story) => (
      <div className="flex h-[480px] w-[360px] bg-canvas p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Sidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Collapsible: Story = {
  args: {
    collapsible: true,
  },
};

export const StartCollapsed: Story = {
  args: {
    collapsible: true,
    defaultCollapsed: true,
  },
};

export const Mobile: Story = {
  args: {
    variant: "mobile",
    mobileTitle: (
      <span className="text-sm font-medium text-txt">Conversations</span>
    ),
    mobileMeta: "Tap a thread to open",
    onMobileClose: () => {},
  },
};

export const GameModal: Story = {
  args: {
    variant: "game-modal",
  },
};

export const Empty: Story = {
  args: {
    header: sampleHeader,
    children: (
      <p className="px-3 py-8 text-center text-sm text-muted">
        No conversations yet
      </p>
    ),
    footer: undefined,
  },
};
