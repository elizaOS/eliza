/**
 * Storybook states for the Shared chat widget across populated, empty, and
 * interaction-focused render states.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { EmptyWidgetState, WidgetSection } from "./shared";

const ListIcon = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <line x1="8" y1="6" x2="21" y2="6" />
    <line x1="8" y1="12" x2="21" y2="12" />
    <line x1="8" y1="18" x2="21" y2="18" />
    <line x1="3" y1="6" x2="3.01" y2="6" />
    <line x1="3" y1="12" x2="3.01" y2="12" />
    <line x1="3" y1="18" x2="3.01" y2="18" />
  </svg>
);

const InboxIcon = (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </svg>
);

const PlaceholderItems = (
  <ul className="space-y-1.5">
    <li className="rounded-md bg-card/40 px-2 py-1.5">Draft launch email</li>
    <li className="rounded-md bg-card/40 px-2 py-1.5">Review Q3 design doc</li>
    <li className="rounded-md bg-card/40 px-2 py-1.5">Confirm dinner Friday</li>
  </ul>
);

const meta = {
  title: "Chat/Widgets/Shared/WidgetSection",
  component: WidgetSection,
  tags: ["autodocs"],
  argTypes: {
    title: { control: "text" },
    testId: { control: "text" },
    onTitleClick: { action: "title-clicked" },
  },
  args: {
    title: "Today",
    testId: "widget-section-demo",
    icon: ListIcon,
    children: PlaceholderItems,
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 320 }} className="rounded-lg bg-bg p-3">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WidgetSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithAction: Story = {
  args: {
    title: "Tasks",
    action: (
      <button
        type="button"
        className="rounded-sm bg-card/60 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted hover:text-txt"
      >
        + Add
      </button>
    ),
  },
};

export const ClickableTitle: Story = {
  args: {
    title: "Inbox",
    icon: InboxIcon,
    onTitleClick: () => {},
    children: (
      <p className="text-muted">
        Three new messages from the design review thread.
      </p>
    ),
  },
};

export const LongTitleTruncates: Story = {
  args: {
    title: "An extremely long widget heading that should truncate gracefully",
    children: PlaceholderItems,
  },
};

export const EmptyState: StoryObj<typeof EmptyWidgetState> = {
  render: (args) => <EmptyWidgetState {...args} />,
  args: {
    icon: InboxIcon,
    title: "Nothing here yet",
    description: "New items will show up as soon as the agent finds them.",
  },
};

export const EmptyStateWithAction: StoryObj<typeof EmptyWidgetState> = {
  render: (args) => <EmptyWidgetState {...args} />,
  args: {
    icon: ListIcon,
    title: "No tasks for today",
    description: "Add one to get started.",
    children: (
      <button
        type="button"
        className="self-center rounded-md bg-card/60 px-3 py-1 text-xs text-txt hover:bg-card"
      >
        Create task
      </button>
    ),
  },
};
