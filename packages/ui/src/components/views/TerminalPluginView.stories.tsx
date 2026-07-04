/**
 * Storybook states for TerminalPluginView — the TUI plugin-view surface — across
 * command/endpoint counts and the no-commands default fallback.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { TerminalPluginView } from "./TerminalPluginView";

const meta = {
  title: "Views/TerminalPluginView",
  component: TerminalPluginView,
  tags: ["autodocs"],
  argTypes: {
    id: { control: "text" },
    label: { control: "text" },
    description: { control: "text" },
    commands: { control: "object" },
    endpoints: { control: "object" },
  },
  args: {
    id: "diagnostics",
    label: "Diagnostics Terminal",
    description: "Run diagnostic capabilities exposed by the agent.",
    commands: ["get-state", "get-text", "refresh"],
    endpoints: [],
  },
} satisfies Meta<typeof TerminalPluginView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithEndpoints: Story = {
  args: {
    id: "router",
    label: "Router Console",
    description: "Inspect routing tables and active sessions.",
    commands: ["list-routes", "flush-cache", "ping-upstream", "tail-logs"],
    endpoints: ["/api/router/status", "/api/router/sessions"],
  },
};

export const ManyCommands: Story = {
  args: {
    id: "ops",
    label: "Ops Toolkit",
    description: "Operational capabilities for live debugging.",
    commands: [
      "get-state",
      "get-text",
      "refresh",
      "snapshot",
      "replay-last",
      "clear-buffer",
      "export-transcript",
    ],
    endpoints: ["/api/ops/health"],
  },
};

export const NoCommandsProvided: Story = {
  args: {
    id: "default-fallback",
    label: "Fallback Terminal",
    description: "When no commands are provided, defaults are used.",
    commands: undefined,
    endpoints: undefined,
  },
};

export const SingleCommand: Story = {
  args: {
    id: "minimal",
    label: "Minimal Terminal",
    description: "A view exposing only a single capability.",
    commands: ["ping"],
    endpoints: ["/api/minimal/ping"],
  },
};
