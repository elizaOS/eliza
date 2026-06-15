import type { Meta, StoryObj } from "@storybook/react";
import { AppWorkspaceChrome } from "./AppWorkspaceChrome";

const navPlaceholder = (
  <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border/40 bg-card/80 px-4 text-sm">
    <span className="font-medium text-txt">Workspace</span>
    <span className="text-muted">/ Inbox</span>
  </div>
);

const mainPlaceholder = (
  <div className="flex flex-1 flex-col gap-4 overflow-auto p-6">
    <h1 className="text-2xl font-semibold text-txt">Inbox</h1>
    <p className="text-muted">
      Main pane content area. This is the primary surface a workspace page
      renders into.
    </p>
    <div className="grid gap-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="rounded-md border border-border/40 bg-card/60 p-3"
        >
          <div className="text-sm font-medium text-txt">Item {i + 1}</div>
          <div className="text-xs text-muted">
            Placeholder row demonstrating layout flow.
          </div>
        </div>
      ))}
    </div>
  </div>
);

const chatPlaceholder = (
  <div className="flex h-full min-h-0 flex-col">
    <div className="flex h-10 shrink-0 items-center border-b border-border/40 px-3 text-sm font-medium text-txt">
      Page chat
    </div>
    <div className="flex flex-1 flex-col gap-2 overflow-auto p-3 text-sm">
      <div className="self-start rounded-md bg-card/70 px-3 py-2 text-txt">
        Hello — what would you like to do?
      </div>
      <div className="self-end rounded-md bg-accent/30 px-3 py-2 text-txt">
        Summarize today's inbox.
      </div>
    </div>
    <div className="border-t border-border/40 p-2">
      <input
        className="w-full rounded-sm border border-border/40 bg-bg/60 px-2 py-1 text-sm outline-none"
        placeholder="Message…"
      />
    </div>
  </div>
);

const meta = {
  title: "Workspace/AppWorkspaceChrome",
  component: AppWorkspaceChrome,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  argTypes: {
    chatCollapsed: { control: "boolean" },
    chatDefaultCollapsed: { control: "boolean" },
    chatDisabled: { control: "boolean" },
    hideCollapseButton: { control: "boolean" },
  },
  decorators: [
    (Story) => (
      <div className="flex h-[600px] w-full bg-bg text-txt">
        <Story />
      </div>
    ),
  ],
  args: {
    nav: navPlaceholder,
    main: mainPlaceholder,
    chat: chatPlaceholder,
    onToggleChat: () => {},
  },
} satisfies Meta<typeof AppWorkspaceChrome>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ChatCollapsed: Story = {
  args: {
    chatCollapsed: true,
  },
};

export const ChatDisabled: Story = {
  args: {
    chatDisabled: true,
  },
};

export const NoNav: Story = {
  args: {
    nav: undefined,
  },
};

export const HiddenCollapseButton: Story = {
  args: {
    hideCollapseButton: true,
  },
};
