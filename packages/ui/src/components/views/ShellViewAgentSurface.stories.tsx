/**
 * Storybook states for ShellViewAgentSurface — the wrapper that makes a builtin
 * shell page agent-controllable. Stories render placeholder page content across
 * the gui / terminal / voice view types.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ShellViewAgentSurface } from "./ShellViewAgentSurface";

const meta = {
  title: "Views/ShellViewAgentSurface",
  component: ShellViewAgentSurface,
  tags: ["autodocs"],
  argTypes: {
    viewId: { control: "text" },
    viewType: {
      control: "select",
      options: ["gui", "terminal", "voice"],
    },
    children: { control: false },
  },
  args: {
    viewId: "settings",
    viewType: "gui",
    children: (
      <div className="p-6 rounded-md border border-border bg-card text-card-foreground">
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="text-sm text-muted-foreground mt-1">
          This view is wrapped in a shell agent surface so an agent can
          list-elements, click, and fill its controls by id.
        </p>
      </div>
    ),
  },
} satisfies Meta<typeof ShellViewAgentSurface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const CharacterView: Story = {
  args: {
    viewId: "character",
    children: (
      <div className="p-6 rounded-md border border-border bg-card text-card-foreground space-y-3">
        <h2 className="text-lg font-semibold">Character</h2>
        <label className="block text-sm">
          <span className="text-muted-foreground">Name</span>
          <input
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1"
            defaultValue="Eliza"
          />
        </label>
        <button
          type="button"
          className="rounded bg-primary px-3 py-1 text-primary-foreground text-sm"
          onClick={() => {}}
        >
          Save
        </button>
      </div>
    ),
  },
};

export const EmptyPage: Story = {
  args: {
    viewId: "empty-shell-view",
    children: (
      <div className="p-12 text-center text-sm text-muted-foreground">
        Nothing here yet.
      </div>
    ),
  },
};

export const TerminalSurface: Story = {
  args: {
    viewId: "terminal-shell",
    viewType: "gui",
    children: (
      <pre className="p-4 rounded-md bg-black text-green-400 font-mono text-xs whitespace-pre-wrap">
        {"$ eliza status\nagent: ready\nplugins: 12 loaded\n"}
      </pre>
    ),
  },
};
